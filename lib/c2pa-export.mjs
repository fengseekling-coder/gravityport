import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveInstalledC2paToolPath } from "./c2pa-helper-pack.mjs";
import { preflightC2paProductionSigner } from "./c2pa-production-signer.mjs";
import {
  buildAssetProvenanceBundle,
  MOSA_C2PA_ASSERTION_LABEL,
} from "./provenance-bundle.mjs";

const execFileAsync = promisify(execFile);

export const MOSA_C2PA_ASSERTION_SCHEMA = "mosa.c2pa.assertion/1";
export const C2PA_TRAINED_ALGORITHMIC_MEDIA = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
export const C2PA_SIGNING_MODES = Object.freeze({
  development: "development-test",
  production: "production",
});

const GENERATED_SOURCE_TYPES = new Set([
  "web-chatgpt",
  "web-gemini",
  "web-flow",
  "web-google-ai-studio",
  "codex-generated",
  "grok-generated",
  "cowart-generated",
]);

export function buildMosaC2paManifest({
  provenance,
  title = "",
  productVersion = "",
  digitalSourceType = "",
} = {}) {
  const normalized = normalizeProvenancePayload(provenance);
  const sourceType = String(digitalSourceType || inferDigitalSourceType(normalized.bundle)).trim();
  if (!sourceType) {
    throw c2paError(
      "C2PA digital source type is unknown. GravityPort will not guess whether an imported asset was AI-generated.",
      "C2PA_DIGITAL_SOURCE_TYPE_UNKNOWN",
    );
  }
  const version = String(productVersion || "").trim();
  const createdAt = normalized.bundle?.asset?.created_at;
  const createdAction = {
    action: "c2pa.created",
    digitalSourceType: sourceType,
    ...(isIsoDateTime(createdAt) ? { when: new Date(createdAt).toISOString() } : {}),
  };

  return {
    claim_generator: version ? `GravityPort/${version}` : "GravityPort",
    claim_generator_info: [{
      name: "GravityPort",
      ...(version ? { version } : {}),
    }],
    ...(title ? { title: basename(String(title)) } : {}),
    assertions: [
      {
        label: "c2pa.actions.v2",
        data: {
          actions: [createdAction],
          allActionsIncluded: true,
        },
      },
      {
        label: MOSA_C2PA_ASSERTION_LABEL,
        data: {
          schema: normalized.schema,
          provenance: normalized.bundle,
        },
      },
    ],
  };
}

export async function exportAssetContentCredential({
  store,
  projectId = "default",
  assetId,
  outputPath,
  includePrompts = true,
  productVersion = "",
  digitalSourceType = "",
  signingMode = C2PA_SIGNING_MODES.development,
  signerPath = "",
  userDataDir = "",
  c2paToolPath = "",
  toolRunner = runC2paTool,
  signerPreflight = preflightC2paProductionSigner,
} = {}) {
  if (!store || typeof store.getAsset !== "function") throw new Error("C2PA export requires an asset store.");
  const asset = await store.getAsset(projectId, assetId);
  const inputPath = String(asset?.image_path || "").trim();
  if (!inputPath) throw c2paError("Asset has no managed media path to sign.", "C2PA_ASSET_MEDIA_MISSING");
  const provenance = await buildAssetProvenanceBundle(store, projectId, assetId, { includePrompts });
  return exportContentCredential({
    inputPath,
    outputPath,
    provenance,
    productVersion,
    digitalSourceType,
    signingMode,
    signerPath,
    userDataDir,
    c2paToolPath,
    toolRunner,
    signerPreflight,
  });
}

export async function exportContentCredential({
  inputPath,
  outputPath,
  provenance,
  productVersion = "",
  digitalSourceType = "",
  signingMode = C2PA_SIGNING_MODES.development,
  signerPath = "",
  userDataDir = "",
  c2paToolPath = "",
  toolRunner = runC2paTool,
  signerPreflight = preflightC2paProductionSigner,
} = {}) {
  const input = resolveRequiredPath(inputPath, "input asset");
  const output = resolveRequiredPath(outputPath, "output asset");
  if (input === output) {
    throw c2paError("C2PA export must write a new file and must never overwrite the library original.", "C2PA_OUTPUT_MUST_DIFFER");
  }
  if (normalizeMediaExtension(input) !== normalizeMediaExtension(output)) {
    throw c2paError("C2PA export output must preserve the input media file extension.", "C2PA_OUTPUT_EXTENSION_MISMATCH");
  }
  const inputStat = await stat(input).catch(() => null);
  if (!inputStat?.isFile()) throw c2paError("C2PA input asset does not exist or is not a file.", "C2PA_INPUT_MISSING");
  const existingOutput = await stat(output).catch(() => null);
  if (existingOutput) throw c2paError("C2PA export output already exists.", "C2PA_OUTPUT_EXISTS");

  const mode = normalizeSigningMode(signingMode);
  const signer = String(signerPath || "").trim();
  if (mode === C2PA_SIGNING_MODES.production && !signer) {
    throw c2paError(
      "Production C2PA export requires an external subprocess signer; local/private-key manifest signing is not allowed.",
      "C2PA_PRODUCTION_SIGNER_REQUIRED",
    );
  }
  const signerInfo = mode === C2PA_SIGNING_MODES.production
    ? await signerPreflight({ signerPath: signer })
    : null;

  const manifest = buildMosaC2paManifest({
    provenance,
    title: basename(input),
    productVersion,
    digitalSourceType,
  });
  assertManifestContainsNoPrivateKeyMaterial(manifest);
  const toolPath = await resolveC2paToolPath({ c2paToolPath, userDataDir });

  await mkdir(dirname(output), { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "mosa-c2pa-"));
  const manifestPath = join(workDir, "manifest.json");
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const args = [input, "--manifest", manifestPath, "--output", output];
    if (mode === C2PA_SIGNING_MODES.production) args.push("--signer-path", signerInfo.executable);
    const environment = sanitizedC2paEnvironment();
    const signResult = await toolRunner(toolPath, args, { env: environment, operation: "sign" });

    const outputStat = await stat(output).catch(() => null);
    if (!outputStat?.isFile() || outputStat.size <= 0) {
      throw c2paError("C2PA tool completed without creating a non-empty signed output asset.", "C2PA_OUTPUT_MISSING");
    }

    const inspection = await inspectContentCredential({
      assetPath: output,
      c2paToolPath: toolPath,
      toolRunner,
      env: environment,
    });
    if (!inspection.hasMosaAssertion) {
      throw c2paError("Signed asset does not contain the MOSA provenance assertion.", "C2PA_MOSA_ASSERTION_MISSING");
    }
    return {
      inputPath: input,
      outputPath: output,
      manifest,
      signing: {
        mode,
        signer: mode === C2PA_SIGNING_MODES.production ? "external-subprocess" : "c2patool-built-in-development-test-certificate",
        trust: mode === C2PA_SIGNING_MODES.production ? "external-signer-not-trust-verified" : "development-test-certificate",
        ...(signerInfo ? { preflight: signerInfo } : {}),
      },
      verification: inspection,
      tool: {
        stderr: String(signResult?.stderr || "").trim(),
      },
    };
  } catch (error) {
    if (error?.code !== "C2PA_OUTPUT_EXISTS") await rm(output, { force: true }).catch(() => {});
    throw normalizeToolError(error, toolPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectContentCredential({
  assetPath,
  userDataDir = "",
  c2paToolPath = "",
  toolRunner = runC2paTool,
  env = sanitizedC2paEnvironment(),
} = {}) {
  const asset = resolveRequiredPath(assetPath, "signed asset");
  const toolPath = await resolveC2paToolPath({ c2paToolPath, userDataDir });
  const result = await toolRunner(toolPath, [asset], { env, operation: "inspect" });
  const report = parseC2paJsonReport(result?.stdout);
  const labels = collectAssertionLabels(report);
  return {
    hasActiveManifest: Boolean(report?.active_manifest || report?.activeManifest),
    hasMosaAssertion: labels.includes(MOSA_C2PA_ASSERTION_LABEL),
    assertionLabels: labels,
    validationStatuses: collectValidationStatuses(report),
    report,
  };
}

export async function resolveC2paToolPath({ c2paToolPath = "", userDataDir = "" } = {}) {
  const explicit = String(c2paToolPath || process.env.MOSA_C2PATOOL_PATH || "").trim();
  if (explicit) return explicit;
  const installed = String(userDataDir || "").trim()
    ? await resolveInstalledC2paToolPath({ userDataDir })
    : "";
  return installed || "c2patool";
}

export async function runC2paTool(binary, args, { env = sanitizedC2paEnvironment(), timeoutMs = 60_000 } = {}) {
  const executable = String(binary || "").trim();
  if (!executable) throw c2paError("c2patool executable path is required.", "C2PA_TOOL_REQUIRED");
  try {
    return await execFileAsync(executable, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw c2paError(`c2patool was not found: ${executable}`, "C2PA_TOOL_NOT_FOUND", { cause: error });
    }
    throw c2paError(
      `c2patool failed: ${String(error?.stderr || error?.message || error).trim()}`,
      "C2PA_TOOL_FAILED",
      { cause: error },
    );
  }
}

export function sanitizedC2paEnvironment(env = process.env) {
  const clean = { ...env };
  // MOSA never passes local private-key material into c2patool. Development
  // mode deliberately uses c2patool's built-in test signer; production mode
  // requires --signer-path so the private key stays inside a signer process.
  delete clean.C2PA_PRIVATE_KEY;
  delete clean.C2PA_SIGN_CERT;
  delete clean.C2PATOOL_SETTINGS;
  return clean;
}

export function inferDigitalSourceType(bundle = {}) {
  const sourceType = String(bundle?.asset?.source_type || "").trim();
  if (GENERATED_SOURCE_TYPES.has(sourceType)) return C2PA_TRAINED_ALGORITHMIC_MEDIA;
  const generationIds = bundle?.generation_history?.generation_ids;
  if (Array.isArray(generationIds) && generationIds.length > 0) return C2PA_TRAINED_ALGORITHMIC_MEDIA;
  const events = bundle?.generation_history?.events;
  if (Array.isArray(events) && events.length > 0) return C2PA_TRAINED_ALGORITHMIC_MEDIA;
  return "";
}

function normalizeProvenancePayload(provenance) {
  const bundle = provenance?.bundle || provenance?.c2pa_assertion?.data || provenance;
  if (!bundle || typeof bundle !== "object" || bundle.schema !== "mosa.provenance.bundle/1") {
    throw c2paError("C2PA export requires a GravityPort provenance bundle.", "C2PA_PROVENANCE_INVALID");
  }
  return {
    schema: provenance?.c2pa_assertion?.schema || MOSA_C2PA_ASSERTION_SCHEMA,
    bundle,
  };
}

function normalizeSigningMode(value) {
  const mode = String(value || "").trim();
  if (mode === C2PA_SIGNING_MODES.development || mode === C2PA_SIGNING_MODES.production) return mode;
  throw c2paError("Unsupported C2PA signing mode.", "C2PA_SIGNING_MODE_INVALID");
}

function normalizeMediaExtension(path) {
  const extension = extname(path).toLowerCase();
  return extension === ".jpeg" ? ".jpg" : extension;
}

function resolveRequiredPath(value, label) {
  const path = String(value || "").trim();
  if (!path) throw c2paError(`C2PA ${label} path is required.`, "C2PA_PATH_REQUIRED");
  return resolve(path);
}

function assertManifestContainsNoPrivateKeyMaterial(manifest) {
  const serialized = JSON.stringify(manifest);
  if (/"(?:private_key|sign_cert)"\s*:/i.test(serialized) || /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/i.test(serialized)) {
    throw c2paError("C2PA manifest must not contain local private-key or signing-certificate material.", "C2PA_PRIVATE_KEY_MATERIAL_FORBIDDEN");
  }
}

function parseC2paJsonReport(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw c2paError("c2patool returned an empty inspection report.", "C2PA_INSPECTION_EMPTY");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
    }
  }
  throw c2paError("c2patool inspection output is not valid JSON.", "C2PA_INSPECTION_INVALID_JSON");
}

function collectAssertionLabels(value, labels = new Set()) {
  if (!value || typeof value !== "object") return [...labels].sort();
  if (Array.isArray(value)) {
    for (const item of value) collectAssertionLabels(item, labels);
    return [...labels].sort();
  }
  if (typeof value.label === "string" && value.label.trim()) labels.add(value.label.trim());
  for (const child of Object.values(value)) collectAssertionLabels(child, labels);
  return [...labels].sort();
}

function collectValidationStatuses(value, statuses = []) {
  if (!value || typeof value !== "object") return statuses;
  if (Array.isArray(value)) {
    for (const item of value) collectValidationStatuses(item, statuses);
    return statuses;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "validation_status" || key === "validationStatus") && Array.isArray(child)) statuses.push(...child);
    else collectValidationStatuses(child, statuses);
  }
  return statuses;
}

function isIsoDateTime(value) {
  return typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value));
}

function normalizeToolError(error, binary) {
  if (String(error?.code || "").startsWith("C2PA_")) return error;
  if (error?.code === "ENOENT") return c2paError(`c2patool was not found: ${binary}`, "C2PA_TOOL_NOT_FOUND", { cause: error });
  return c2paError(String(error?.message || error), "C2PA_EXPORT_FAILED", { cause: error });
}

function c2paError(message, code, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}
