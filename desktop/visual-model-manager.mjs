import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { discoverVisualModelPacks } from "../lib/visual-model-pack.mjs";

const SETTINGS_SCHEMA = "mosa.visual-model-settings/1";

export function createVisualModelManager({
  userDataDir,
  runtimeAvailable = false,
  probeRuntime = null,
  discoverPacks = discoverVisualModelPacks,
} = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw new Error("Visual model manager requires Electron userData.");
  const settingsPath = join(baseDir, "visual-model-settings.json");
  let cache = null;
  // Probe results are cached per pack identity so Settings refreshes do not
  // repeatedly spawn the inference runtime. In-flight probes are shared.
  let probeCache = null; // { key, promise?, result? }
  let probeInFlight = null;

  async function runProbe(activePack) {
    const key = activePack ? `${activePack.id}@${activePack.revision}` : "";
    if (probeCache && probeCache.key === key && probeCache.result) return probeCache.result;
    if (probeInFlight) return probeInFlight;
    const probePromise = (async () => {
      if (typeof probeRuntime === "function") {
        try {
          return await probeRuntime(activePack);
        } catch (error) {
          return { ok: false, reason: "runtime-unavailable", message: error?.message || "Visual runtime probe failed." };
        }
      }
      return { ok: runtimeAvailable === true, reason: "runtime-unavailable" };
    })();
    probeInFlight = probePromise;
    try {
      const result = await probePromise;
      // Failed probes are not cached permanently: the next forced refresh may
      // retry after the user fixes the environment.
      if (result?.ok) probeCache = { key, result };
      return result;
    } finally {
      probeInFlight = null;
    }
  }

  async function refresh() {
    const [discovery, settings] = await Promise.all([
      discoverPacks({ userDataDir: baseDir }),
      readSettings(settingsPath),
    ]);
    const selected = discovery.packs.find((pack) =>
      pack.id === settings.active_pack_id && pack.revision === settings.active_revision);
    const active = selected || discovery.packs[0] || null;
    const enabled = settings.enabled === true && Boolean(active);
    let state;
    let probe = null;
    if (!active) {
      state = "not-installed";
    } else if (!enabled) {
      state = "disabled";
    } else if (typeof probeRuntime === "function" || runtimeAvailable === true) {
      state = "loading";
      probe = await runProbe(active);
      if (probe?.ok) {
        state = "ready";
      } else if (probe?.reason === "error") {
        state = "error";
      } else {
        state = "runtime-unavailable";
      }
    } else {
      state = "runtime-unavailable";
    }
    cache = {
      mode: "mosa-local",
      state,
      installed: discovery.packs.length > 0,
      enabled,
      runtime_available: state === "ready",
      active_pack: active ? summarizePack(active) : null,
      packs: discovery.packs.map(summarizePack),
      invalid_packs: discovery.invalid,
      model_pack_root: discovery.root,
      probe: probe ? { ok: probe.ok === true, reason: probe.reason || null, message: probe.message || null } : null,
    };
    return structuredClone(cache);
  }

  return {
    async state({ refresh: force = false } = {}) {
      if (!cache || force) return refresh();
      return structuredClone(cache);
    },

    async setEnabled(enabled) {
      const current = await refresh();
      if (enabled && !current.active_pack) {
        const error = new Error("Install a verified GravityPort visual model pack before enabling local visual search.");
        error.code = "VISUAL_MODEL_NOT_INSTALLED";
        throw error;
      }
      const settings = await readSettings(settingsPath);
      settings.enabled = enabled === true;
      if (current.active_pack) {
        settings.active_pack_id = current.active_pack.id;
        settings.active_revision = current.active_pack.revision;
      }
      await writeSettings(settingsPath, settings);
      return refresh();
    },

    async selectPack(id, revision) {
      const current = await refresh();
      const selected = current.packs.find((pack) => pack.id === String(id || "") && pack.revision === String(revision || ""));
      if (!selected) {
        const error = new Error("Requested GravityPort visual model pack is not installed or failed verification.");
        error.code = "VISUAL_MODEL_PACK_NOT_FOUND";
        throw error;
      }
      const settings = await readSettings(settingsPath);
      settings.active_pack_id = selected.id;
      settings.active_revision = selected.revision;
      await writeSettings(settingsPath, settings);
      return refresh();
    },

    // Settings snapshot consumed by the service runtime for the same host.
    async runtimeConfig() {
      const settings = await readSettings(settingsPath);
      const discovery = await discoverPacks({ userDataDir: baseDir });
      const selected = discovery.packs.find((pack) =>
        pack.id === settings.active_pack_id && pack.revision === settings.active_revision);
      const active = selected || discovery.packs[0] || null;
      return {
        enabled: settings.enabled === true && Boolean(active),
        active_pack_id: active ? active.id : "",
        active_revision: active ? active.revision : "",
      };
    },

    async cleanupInactivePacks() {
      const settings = await readSettings(settingsPath);
      const discovery = await discoverPacks({ userDataDir: baseDir });
      const selected = discovery.packs.find((pack) =>
        pack.id === settings.active_pack_id && pack.revision === settings.active_revision);
      const active = selected || discovery.packs[0] || null;
      if (!active) return { removed: [] };
      const removed = [];
      for (const pack of discovery.packs) {
        if (pack.pack_dir === active.pack_dir || pack.id !== active.id) continue;
        await rm(pack.pack_dir, { recursive: true, force: true });
        removed.push(pack.pack_dir);
      }
      if (removed.length) cache = null;
      return { removed };
    },
  };
}

function summarizePack(pack) {
  return {
    id: pack.id,
    revision: pack.revision,
    embedding_dimension: pack.embedding_dimension,
    total_bytes: pack.total_bytes,
    license: pack.license,
    pack_dir: pack.pack_dir,
  };
}

async function readSettings(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.schema !== SETTINGS_SCHEMA) return defaultSettings();
    return {
      ...defaultSettings(),
      enabled: parsed.enabled === true,
      active_pack_id: String(parsed.active_pack_id || ""),
      active_revision: String(parsed.active_revision || ""),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return defaultSettings();
    throw error;
  }
}

async function writeSettings(path, settings) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify({
    schema: SETTINGS_SCHEMA,
    enabled: settings.enabled === true,
    active_pack_id: String(settings.active_pack_id || ""),
    active_revision: String(settings.active_revision || ""),
  }, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

function defaultSettings() {
  return {
    schema: SETTINGS_SCHEMA,
    enabled: false,
    active_pack_id: "",
    active_revision: "",
  };
}
