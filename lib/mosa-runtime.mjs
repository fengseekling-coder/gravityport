import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore, mimeTypeForFile, SUPPORTED_MEDIA_EXTENSIONS } from "./asset-store.mjs";
import { createCodexImageBridge } from "./codex-image-bridge.js";
import { createCowartBridgeManager } from "./cowart-bridge-manager.js";
import { createCowartCanvasDiscovery } from "./cowart-canvas-discovery.js";
import { createCowartProjectRegistry } from "./cowart-project-registry.js";
import { createGrokMediaBridge } from "./grok-media-bridge.js";
import { isWebCaptureApiPath } from "./api/bridge-routes.mjs";
import {
  isAllowedIngestOrigin,
  isAllowedLocalOrigin,
  isApprovedExtensionOrigin,
  isAuthorizedMosaClientRequest,
  mosaBrowserClientCookieHeader,
  mosaClientTokenFingerprint,
  normalizeMosaClientToken,
  parseAllowedIngestOrigins,
  requiresMosaClientToken,
} from "./server-security.js";
import { createDerivativeWorker } from "./derivative-worker.js";
import { getBuildIdentity } from "./build-identity.mjs";
import { acquireMosaRuntimeLock } from "./runtime-lock.js";
import { cleanupWebCaptureTemp, createWebCaptureIngest } from "./web-capture-ingest.js";
import { handleApiRequest } from "./api-routes.mjs";
import { pipeStreamToResponse, sendJson } from "./http-response.mjs";
import { cleanupOrphanStagedFiles, importStagingDir } from "./import-staging.mjs";
import { createLibraryChangeStream } from "./library-change-stream.mjs";
import { DEFAULT_MOSA_PORT, MOSA_RESERVED_PRODUCTION_PORTS, normalizeMosaPort } from "./runtime-defaults.mjs";
import { parseDisabledBridges } from "./runtime-bridges.mjs";
import { createVisualEmbeddingRuntime } from "./visual-embedding-runtime.mjs";
import { validateRuntimeIsolation } from "./runtime-isolation-guard.mjs";
import { defaultLibraryDir, legacyDefaultLibraryDir, resolveLibraryLocation } from "./library-location.mjs";
import { resolveSourceLocations } from "./source-locations.js";
import { createPinterestClient } from "./pinterest/client.mjs";

const moduleDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: https://i.pinimg.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
].join("; ");
let managerDir;
let cowartProjectDir;
let projectRoot;
let port;
let libraryDir;
let codexImagesDir;
let codexSessionsDir;
let cowartCanvasDir;
let cowartRegistryPath;
let grokSessionsDir;
let webCaptureOrigins;
let runtimeLock;
let store;
let cowartProjectRegistry;
let cowartBridge;
let codexBridge;
let grokBridge;
let webCaptureIngest;
let webCapturePairingEnabled;
let cowartCanvasDiscovery;
let derivativeWorker;
let libraryChangeStream;
let trashPurgeTimer = null;
let trashPurgeNow = null;
let appDir;
let runtimeBuildIdentity = null;
// BUG-01 fix: exact import staging root trusted for the desktop shell's
// staged imports; null outside Electron so the default boundary is unchanged.
let importStagingRoot = null;
let server;
let activeRuntime = null;
let shutdownPromise = null;
let startupInProgress = false;
let bridgeStartupTask = null;
let cancelBridgeStartup = null;
let bridgeAbortController = null;
let maintenanceStartTimer = null;
const DEFAULT_BRIDGE_START_DELAY_MS = 1000;
const DEFAULT_MAINTENANCE_START_DELAY_MS = 1800;
// Maintenance barrier: settles once the post-listen historical orphan
// derivative sweep is done and the derivative worker may start. Shutdown
// awaits it before closing resources.
let derivativeMaintenanceSettled = null;
let actualUserData = null;
let clientToken = "";
let visualRelationshipService = null;
let visualEmbeddingRuntime = null;
let pinterest = null;

/**
 * Starts the HTTP server, bridge watchers, and derivative worker without
 * installing process signal handlers. CLI and desktop hosts own their own
 * shutdown policy through the returned stop function.
 */
export async function startMosaRuntime(options = {}) {
  if (activeRuntime || startupInProgress) {
    throw new Error("A GravityPort runtime is already active in this process.");
  }

  const env = options.env || process.env;
  // The isolation context resolved by the desktop shell (or the web server
  // CLI) carries the QA parameters through every layer; it wins over loose
  // per-call options so the same verified values reach the guard here.
  const isolation = options.isolationContext || {};
  managerDir = resolve(options.managerDir || join(moduleDir, ".."));
  cowartProjectDir = resolve(options.cowartProjectDir || managerDir);
  projectRoot = resolve(options.projectRoot || env.MOSA_PROJECT_DIR || join(managerDir, ".."));
  port = normalizeMosaPort(options.port ?? env.MOSA_PORT ?? DEFAULT_MOSA_PORT, { allowZero: true });
  // `libraryDir` always exists (resolved through the shared library-location
  // rules, so an untouched machine keeps ~/MOSA Library and only a machine
  // without any library defaults to the new ~/GravityPort Library) so SQLite
  // detection, the runtime lock, and health reporting keep working.
  // `explicitLibraryDir` records whether the caller actually configured a
  // location; the JSON store must only reroot its assets away from
  // managerDir/assets when this is set.
  const explicitLibraryDir = options.libraryDir || env.MOSA_LIBRARY_DIR || null;
  libraryDir = explicitLibraryDir
    ? resolve(explicitLibraryDir)
    : resolveLibraryLocation({ homeDir: homedir() }).libraryDir;
  ({ codexImagesDir, codexSessionsDir, cowartCanvasDir, cowartRegistryPath, grokSessionsDir } = resolveSourceLocations({
    env,
    overrides: {
      codexImagesDir: options.codexImagesDir,
      codexSessionsDir: options.codexSessionsDir,
      cowartCanvasDir: options.cowartCanvasDir,
      cowartRegistryPath: options.cowartRegistryPath,
      grokSessionsDir: options.grokSessionsDir,
    },
  }));
  webCaptureOrigins = parseAllowedIngestOrigins(options.webCaptureOrigins || env.MOSA_WEB_CAPTURE_ORIGINS);
  // Desktop enables silent pairing for the fixed allowlisted extension origins.
  // Headless/source runtimes remain disabled unless the owning process opts in.
  webCapturePairingEnabled = options.webCapturePairingEnabled === true;
  clientToken = normalizeMosaClientToken(options.clientToken || env.MOSA_CLIENT_TOKEN || randomBytes(32).toString("base64url"));
  // Web runtime serves the built GravityPort React UI by default.
  appDir = resolve(options.appDir || join(managerDir, "web", "gravityport", "dist"));
  // Freeze the identity of the code/UI pair this process started with. Static
  // assets are deliberately read from disk on every request, so without this
  // snapshot a long-lived old runtime could read a newly-written
  // build-identity.json later and falsely report itself as the new build.
  runtimeBuildIdentity = Object.freeze({ ...getBuildIdentity(appDir) });
  importStagingRoot = options.importStagingRoot ? resolve(options.importStagingRoot) : null;
  // `disabledBridges` is validated through the shared helper so the server CLI
  // and the desktop shell can never silently accept an unknown bridge name. An
  // explicit array wins over the MOSA_DISABLE_BRIDGES environment variable.
  const disabledBridges = parseDisabledBridges({
    explicit: options.disabledBridges,
    env,
  });
  const disabledBridgeSet = new Set(disabledBridges);
  const isBridgeEnabled = (name) => !disabledBridgeSet.has(name);
  shutdownPromise = null;
  startupInProgress = true;

  // ---- Runtime isolation guard: fail closed before any production write ----
  const guard = validateRuntimeIsolation({
    libraryDir: explicitLibraryDir,
    port,
    runtimeMode: isolation.runtimeMode ?? options.runtimeMode ?? env.MOSA_RUNTIME_MODE,
    qaRun: isolation.qaRun ?? options.qaRun ?? env.MOSA_QA_RUN,
    userData: isolation.expectedUserData ?? options.userData ?? env.MOSA_USER_DATA,
    actualUserData: isolation.actualUserData ?? options.actualUserData,
    argv: isolation.argv ?? options.argv ?? process.argv,
    defaultUserData: isolation.productionDefaultUserData,
    runtimeKind: isolation.runtimeKind,
    productionLibraryDir: [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())],
    productionPorts: MOSA_RESERVED_PRODUCTION_PORTS,
  });
  if (!guard.ok) {
    const err = new Error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
    err.code = "ERR_ISOLATION_GUARD";
    err.field = guard.field;
    startupInProgress = false;
    throw err;
  }

  actualUserData = isolation.actualUserData ?? options.actualUserData ?? env.MOSA_USER_DATA ?? null;
  visualRelationshipService = options.visualRelationshipService || null;

  try {
    runtimeLock = await acquireMosaRuntimeLock({ libraryDir });
    bridgeAbortController = new AbortController();
    store = createAssetStore({
      projectRoot,
      managerDir,
      libraryDir,
      explicitLibraryDir: explicitLibraryDir ? resolve(explicitLibraryDir) : null,
      assetsRoot: options.assetsRoot,
      generatedImagesDir: options.generatedImagesDir,
      codexImagesDir,
      cowartCanvasDir,
    });
    libraryChangeStream = createLibraryChangeStream({ store });
    // MOSA-local visual search is opt-in per host: the desktop shell passes
    // its userData + visual model settings, while headless runs stay off
    // unless explicitly configured. Construction is fail-closed; a failed or
    // missing runtime only disables the optional visual capability.
    if (options.visualModel?.userDataDir) {
      try {
        visualEmbeddingRuntime = await createVisualEmbeddingRuntime({
          store,
          libraryDir,
          userDataDir: resolve(options.visualModel.userDataDir),
          settings: options.visualModel.settings || null,
        });
        if (visualEmbeddingRuntime.service) {
          visualRelationshipService = visualEmbeddingRuntime.service;
        }
        if (visualEmbeddingRuntime.state === "ready") {
          visualEmbeddingRuntime.startChangePolling();
          visualEmbeddingRuntime.worker.start();
        }
      } catch (error) {
        // The optional visual capability must never take down library
        // startup; model-dependent routes fail closed without the service.
        visualEmbeddingRuntime = null;
        console.warn(`[MOSA] local visual runtime disabled: ${error?.message || error}`);
      }
    }
    // Browser/manual uploads use a server-owned staging directory below the
    // library assets root. Sweep only stale plain files there so cancelled or
    // interrupted imports cannot accumulate indefinitely.
    cleanupOrphanStagedFiles(importStagingDir(store.assetsRoot)).catch((error) => {
      console.warn(`[MOSA] browser import-staging orphan sweep failed: ${error?.message || error}`);
    });

    // Pinterest client: only create if actualUserData is available.
    if (actualUserData) {
      try {
        pinterest = createPinterestClient({ userDataDir: actualUserData });
      } catch (error) {
        pinterest = null;
        console.warn(`[MOSA] Pinterest client disabled: ${error?.message || error}`);
      }
    }

    cowartProjectRegistry = createCowartProjectRegistry({
    managerDir: cowartProjectDir,
    registryPath: cowartRegistryPath,
  });
  cowartBridge = createCowartBridgeManager({
    store,
    registry: cowartProjectRegistry,
    managerDir: cowartProjectDir,
    canvasDir: store.cowartCanvasDir,
  });
  codexBridge = createCodexImageBridge({
    store,
    imagesDir: store.codexImagesDir,
    sessionsDir: codexSessionsDir,
    signal: bridgeAbortController.signal,
  });
  grokBridge = createGrokMediaBridge({
    store,
    sessionsDir: grokSessionsDir,
    signal: bridgeAbortController.signal,
  });
  webCaptureIngest = createWebCaptureIngest({
    store,
    libraryDir,
    token: options.webCaptureToken || env.MOSA_WEB_CAPTURE_TOKEN,
    allowedOrigins: webCaptureOrigins,
    onLibraryChange: (projectId) => libraryChangeStream?.checkNow?.(projectId),
  });
  cleanupWebCaptureTemp(webCaptureIngest.tempRoot).catch((error) => {
    console.warn(`[MOSA] web-capture temp orphan sweep failed: ${error?.message || error}`);
  });
  if (typeof store.purgeExpiredTrash === "function") {
    const purgeStore = store;
    const purgeIngest = webCaptureIngest;
    let purgeTrashInFlight = null;
    const purgeTrash = () => {
      if (purgeTrashInFlight) return purgeTrashInFlight;
      purgeTrashInFlight = (async () => {
        await cleanupWebCaptureTemp(purgeIngest.tempRoot).catch((error) => {
          console.warn(`[MOSA] web-capture temp orphan sweep failed: ${error?.message || error}`);
        });
        if (typeof purgeStore.cleanupPermanentDeletionStaging === "function") {
          const staged = await purgeStore.cleanupPermanentDeletionStaging();
          if (staged?.failed) console.warn(`[MOSA] permanent-delete staging recovery deferred ${staged.failed} transaction(s).`);
        }
        let cursor = null;
        let removed = 0;
        let failed = 0;
        const changedProjects = new Set();
        do {
          const result = await purgeStore.purgeExpiredTrash({ cursor });
          removed += Number(result?.removed || 0);
          failed += Number(result?.failed || 0);
          for (const projectId of result?.projects || []) changedProjects.add(projectId);
          cursor = result?.nextCursor || null;
          // Yield between bounded database/file-system batches so a large
          // expired backlog never monopolizes the runtime event loop.
          if (cursor) await new Promise((resolveYield) => setImmediate(resolveYield));
        } while (cursor);
        if (failed) console.warn(`[MOSA] trash purge deferred ${failed} busy item(s); they will be retried.`);
        if (removed && typeof purgeIngest?.pruneReferences === "function" && typeof purgeStore.listReferencedAttachmentIds === "function") {
          for (const projectId of changedProjects) {
            const referencedIds = await purgeStore.listReferencedAttachmentIds(projectId);
            await purgeIngest.pruneReferences(projectId, referencedIds);
          }
        }
        return { removed, failed, projects: [...changedProjects] };
      })().finally(() => { purgeTrashInFlight = null; });
      return purgeTrashInFlight;
    };
    trashPurgeNow = purgeTrash;
    trashPurgeTimer = setInterval(() => {
      void purgeTrash().catch((error) => console.warn(`[MOSA] trash purge failed: ${error?.message || error}`));
    }, 60 * 60 * 1000);
    trashPurgeTimer.unref?.();
  }
  cowartCanvasDiscovery = createCowartCanvasDiscovery({
    sessionsDir: codexSessionsDir,
    managerDir: cowartProjectDir,
    dedicatedCanvasDir: store.cowartCanvasDir,
    knownProjectDirs: () => cowartBridge.sources().map((source) => source.projectDir),
    onDiscover: ({ projectDir }) => cowartBridge.addProject({ projectDir }),
  });
  derivativeWorker = createDerivativeWorker({ store });

  await store.ensureProject("default");
  // The derivative worker is started by startDerivativeMaintenance() once the
  // runtime is listening and the historical orphan sweep has settled, so
  // generation can never race the sweep's unreferenced-file check.
  server = createServer(async (req, res) => {
  try {
    if (shutdownPromise) {
      res.setHeader("Connection", "close");
      sendJson(res, 503, { error: "GravityPort runtime is shutting down." });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const activePort = boundPortFor(server, port);
    // DNS-rebinding guard: the origin checks below only protect cross-origin
    // requests, but a rebinding page is "same-origin" to this loopback service
    // and sends no Origin header at all. The Host header is the last line of
    // defense, so requests must name a loopback host on the actual bound port.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const hostPort = url.port ? Number(url.port) : 0;
    const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    if (!req.headers.host || !loopbackHost || (hostPort !== 0 && hostPort !== activePort)) {
      sendJson(res, 403, { error: "Forbidden host." });
      return;
    }
    const isWebCapturePairRoute = url.pathname === "/api/web-capture/pair";
    const isWebCaptureHealthRoute = url.pathname === "/api/health" && isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins);
    const isWebCaptureRoute = isWebCapturePairRoute || isWebCaptureHealthRoute || isWebCaptureApiPath(url.pathname);

    if (isWebCaptureRoute) {
      const originAllowed = isWebCapturePairRoute || isWebCaptureHealthRoute
        ? isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins)
        : isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins);
      if (!originAllowed) {
        sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
        return;
      }
      if (req.headers.origin) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Vary", "Origin");
      }
    } else if (!isAllowedLocalOrigin(req.headers.origin, activePort)) {
      sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }

    // Web-capture allows chrome-extension preflight; other routes stay same-origin only.
    if (req.method === "OPTIONS") {
      const webCapturePreflightAllowed = isWebCapturePairRoute || isWebCaptureHealthRoute
        ? isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins)
        : isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins);
      if (isWebCaptureRoute && webCapturePreflightAllowed) {
        res.statusCode = 204;
        if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-mosa-token");
        res.setHeader("Access-Control-Max-Age", "600");
        res.end();
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!isWebCaptureRoute && requiresMosaClientToken(req.method, url.pathname)) {
      if (!isAuthorizedMosaClientRequest(
        req.headers["x-mosa-client-token"],
        req.headers.cookie,
        clientToken,
        activePort,
      )) {
        sendJson(res, 401, { error: "Unauthorized MOSA client.", code: "MOSA_CLIENT_UNAUTHORIZED" });
        return;
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApiRequest({ req, res, url, context: apiContext() });
      if (!handled) sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (url.pathname.startsWith("/library/")) {
      await handleLibrary(req, res, url);
      return;
    }

    await handleStatic(res, url.pathname, activePort);
  } catch (error) {
    const statusCode = error instanceof URIError ? 400 : (Number(error?.statusCode) || 500);
    const internal = statusCode >= 500;
    if (internal) console.error("MOSA request failed:", error);
    const exposeMessage = !internal || error?.expose === true;
    const payload = { error: exposeMessage ? (error instanceof Error ? error.message : String(error)) : "Internal server error." };
    if (error instanceof URIError) payload.code = "MALFORMED_URL_ENCODING";
    if (error?.statusCode && error?.code) payload.code = error.code;
    // A streaming/static handler may have committed response headers before an
    // asynchronous failure reaches this outer boundary. Writing a second JSON
    // response would throw ERR_HTTP_HEADERS_SENT from inside the catch handler
    // itself, turning a single bad request into an unhandled rejection. Once a
    // response has started, terminate that response instead of trying to
    // replace its wire format.
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    sendJson(res, statusCode, payload);
  }
  });
  await listen(server, port);
  const boundPort = boundPortFor(server, port);
  const runtime = {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    libraryDir,
    storage: store?.storageKind || "json",
    productVersion: runtimeBuildIdentity?.productVersion,
    gitSha: runtimeBuildIdentity?.gitSha,
    uiFingerprint: runtimeBuildIdentity?.uiFingerprint,
    runtimeFingerprint: runtimeBuildIdentity?.runtimeFingerprint,
    distribution: runtimeBuildIdentity?.distribution,
    clientToken,
    stop: shutdown,
  };
  activeRuntime = runtime;
  scheduleBridgeStartup({
    isBridgeEnabled,
    delayMs: options.bridgeStartupDelayMs,
  });
  // Managed-file cleanup and historical orphan derivative reclamation are
  // maintenance, not a prerequisite for serving the library: both start only
  // after the runtime is listening so large/external libraries cannot turn
  // directory enumeration into startup latency, and neither may fail startup.
  schedulePostListenMaintenance(options.maintenanceStartDelayMs);
  server.once("error", (error) => {
    console.error(error);
    // shutdown() rejects when cleanup fails (AggregateError from store/lock
    // release); fire-and-forget here would otherwise become an unhandled
    // rejection and kill the process mid-teardown.
    void shutdown().catch((cleanupError) => {
      console.warn(`[MOSA] runtime cleanup after server error failed: ${cleanupError?.message || cleanupError}`);
    });
  });
  return runtime;
  } catch (error) {
    await cleanupRuntime();
    throw error;
  } finally {
    startupInProgress = false;
  }
}

function scheduleBridgeStartup({ isBridgeEnabled, delayMs } = {}) {
  const waitMs = Number.isFinite(Number(delayMs))
    ? Math.max(0, Number(delayMs))
    : DEFAULT_BRIDGE_START_DELAY_MS;
  const captured = {
    cowartBridge,
    cowartCanvasDiscovery,
    codexBridge,
    grokBridge,
  };
  let timer = null;
  let releaseGate;
  const gate = new Promise((resolveGate) => {
    releaseGate = resolveGate;
    timer = setTimeout(() => {
      timer = null;
      resolveGate(true);
    }, waitMs);
    timer.unref?.();
  });
  cancelBridgeStartup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    releaseGate(false);
  };

  const startOne = async (name, task) => {
    if (shutdownPromise) return false;
    try {
      await task();
      return true;
    } catch (error) {
      console.warn(`[MOSA] ${name} bridge startup failed; library remains available: ${error?.message || error}`);
      return false;
    }
  };

  bridgeStartupTask = gate.then(async (shouldStart) => {
    if (!shouldStart || shutdownPromise) return;
    const cowartSequence = async () => {
      let cowartReady = true;
      if (isBridgeEnabled?.("cowart")) {
        cowartReady = await startOne("Cowart", () => captured.cowartBridge.start());
      }
      if (cowartReady && isBridgeEnabled?.("cowartDiscovery")) {
        await startOne("Cowart discovery", () => captured.cowartCanvasDiscovery.start());
      }
    };
    await Promise.all([
      cowartSequence(),
      isBridgeEnabled?.("codex") ? startOne("Codex", () => captured.codexBridge.start()) : Promise.resolve(),
      isBridgeEnabled?.("grok") ? startOne("Grok", () => captured.grokBridge.start()) : Promise.resolve(),
    ]);
  }).finally(() => {
    bridgeStartupTask = null;
    cancelBridgeStartup = null;
  });
}

function schedulePostListenMaintenance(delayMs) {
  const waitMs = Number.isFinite(Number(delayMs))
    ? Math.max(0, Number(delayMs))
    : DEFAULT_MAINTENANCE_START_DELAY_MS;
  if (maintenanceStartTimer) clearTimeout(maintenanceStartTimer);
  maintenanceStartTimer = setTimeout(() => {
    maintenanceStartTimer = null;
    if (shutdownPromise || !store) return;
    if (trashPurgeNow) {
      void trashPurgeNow().catch((error) => console.warn(`[MOSA] trash purge failed: ${error?.message || error}`));
    }
    startDerivativeMaintenance();
    if (typeof store.cleanupOrphanedManagedFiles === "function") {
      const hasDerivativeSweep = typeof store.cleanupOrphanedDerivativeFiles === "function";
      void store.cleanupOrphanedManagedFiles({ includeDerivatives: !hasDerivativeSweep }).catch((error) => {
        console.warn(`[MOSA] managed-file orphan sweep failed: ${error?.message || error}`);
      });
    }
  }, waitMs);
  maintenanceStartTimer.unref?.();
}

// Historical orphan derivative reclamation is maintenance, never a startup
// prerequisite. The sweep runs only after the runtime is listening, so a large
// or external library can never pay an O(N) scan before serving requests, and
// a failed sweep is logged and skipped instead of failing the runtime. The
// derivative worker starts only once the sweep settles so generation can
// never race the sweep's unreferenced-file check; shutdown awaits the barrier
// before closing resources, which also cancels a not-yet-started worker.
function startDerivativeMaintenance() {
  const maintenanceStore = store;
  const maintenanceWorker = derivativeWorker;
  if (typeof maintenanceStore?.cleanupOrphanedDerivativeFiles !== "function") {
    maintenanceWorker?.start?.();
    return;
  }
  derivativeMaintenanceSettled = Promise.resolve()
    .then(() => maintenanceStore.cleanupOrphanedDerivativeFiles())
    .then((sweep) => {
      if (sweep?.removed > 0) console.warn(`[MOSA] reclaimed ${sweep.removed} orphan derivative file(s).`);
    })
    .catch((error) => {
      console.warn(`[MOSA] orphan derivative sweep failed; continuing without it: ${error?.message || error}`);
    })
    .then(() => {
      // Shutdown nulls derivativeWorker only after awaiting this barrier, and
      // a newer runtime lifecycle replaces the captured worker, so a stale
      // barrier can never start a worker it no longer owns.
      if (!shutdownPromise && derivativeWorker === maintenanceWorker) maintenanceWorker?.start?.();
    });
}

async function cleanupRuntime() {
  bridgeAbortController?.abort();
  if (maintenanceStartTimer) clearTimeout(maintenanceStartTimer);
  maintenanceStartTimer = null;
  cancelBridgeStartup?.();
  const bridgeStartup = bridgeStartupTask;
  if (bridgeStartup) {
    try { await bridgeStartup; } catch { /* integration startup failures are isolated. */ }
  }
  const maintenance = derivativeMaintenanceSettled;
  derivativeMaintenanceSettled = null;
  if (maintenance) {
    // Shutdown owns the in-flight maintenance barrier: the sweep reads the
    // store, so it must settle before resources close, and its completion
    // callback must observe the shutdown before it may start the worker.
    try { await maintenance; } catch { /* the barrier chain never rejects. */ }
  }
  const resources = {
    libraryChangeStream,
    derivativeWorker,
    visualEmbeddingRuntime,
    visualRelationshipService,
    grokBridge,
    codexBridge,
    cowartCanvasDiscovery,
    cowartBridge,
    store,
    runtimeLock,
    trashPurgeTimer,
  };
  if (trashPurgeTimer) clearInterval(trashPurgeTimer);
  derivativeWorker = null;
  libraryChangeStream = null;
  visualEmbeddingRuntime = null;
  trashPurgeTimer = null;
  trashPurgeNow = null;
  grokBridge = null;
  codexBridge = null;
  cowartCanvasDiscovery = null;
  cowartBridge = null;
  cowartProjectRegistry = null;
  webCaptureIngest = null;
  webCapturePairingEnabled = false;
  store = null;
  runtimeLock = null;
  importStagingRoot = null;
  runtimeBuildIdentity = null;
  actualUserData = null;
  clientToken = "";
  visualRelationshipService = null;
  pinterest = null;
  bridgeStartupTask = null;
  cancelBridgeStartup = null;
  bridgeAbortController = null;
  if (!server?.listening) server = null;

  const bridgeResults = await Promise.allSettled([
    () => resources.libraryChangeStream?.close?.(),
    () => resources.derivativeWorker?.stop?.(),
    () => resources.visualEmbeddingRuntime?.close?.(),
    () => resources.visualRelationshipService?.close?.(),
    () => resources.grokBridge?.stop?.(),
    () => resources.codexBridge?.stop?.(),
    () => resources.cowartCanvasDiscovery?.stop?.(),
    () => resources.cowartBridge?.stop?.(),
  ].map(async (cleanup) => cleanup()));
  // Cowart shutdown can still be importing an asset when stop() begins. Close
  // the store only after every bridge has drained its active reconciliation.
  const storageResults = await Promise.allSettled([
    () => resources.store?.close?.(),
    () => resources.runtimeLock?.release?.(),
  ].map(async (cleanup) => cleanup()));
  const results = [...bridgeResults, ...storageResults];
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((result) => result.reason), "GravityPort runtime cleanup failed.");
  }
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    // Finish the current import, but do not scan/hash every remaining asset
    // while Desktop is waiting for this runtime to release the library lock.
    bridgeAbortController?.abort();
    const serverToClose = server;
    server = null;
    try {
      // Long-lived SSE responses must be ended before http.Server.close()
      // begins waiting for active responses to finish. The rest of runtime
      // cleanup still happens after the server stops accepting new work.
      libraryChangeStream?.close?.();
      if (serverToClose?.listening) await closeServer(serverToClose);
    } finally {
      try {
        await cleanupRuntime();
      } finally {
        activeRuntime = null;
      }
    }
  })();
  return shutdownPromise;
}

function closeServer(serverInstance) {
  return new Promise((resolveClose, rejectClose) => {
    serverInstance.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}

function boundPortFor(serverInstance, fallbackPort) {
  const address = serverInstance.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}

function apiContext() {
  // Compute effectiveLibraryDir on-the-fly from store, which is module-level scope.
  // SQLite uses store.libraryDir; JSON fallback uses dirname(store.assetsRoot).
  const effectiveLibraryDir = store?.libraryDir || (store?.assetsRoot ? dirname(store.assetsRoot) : libraryDir);
  return {
    appDir,
    buildIdentity: runtimeBuildIdentity,
    clientToken,
    clientAuthFingerprint: mosaClientTokenFingerprint(clientToken),
    libraryDir: effectiveLibraryDir,
    actualUserData,
    grokSessionsDir,
    supportedMediaExtensions: SUPPORTED_MEDIA_EXTENSIONS,
    // BUG-01 fix: only the desktop shell's exact staging root is trusted for
    // asset creation; Web/server runs keep an empty array (unchanged default).
    trustedSourceRoots: importStagingRoot ? [importStagingRoot] : [],
    importStagingRoot,
    store,
    cowartBridge,
    codexBridge,
    grokBridge,
    webCaptureIngest,
    webCapturePairingEnabled,
    cowartCanvasDiscovery,
    derivativeWorker,
    libraryChangeStream,
    visualRelationshipService,
    pinterest,
    port: boundPortFor(server, port),
  };
}

function listen(serverInstance, requestedPort) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      serverInstance.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      serverInstance.off("error", onError);
      resolveListen();
    };
    serverInstance.once("error", onError);
    serverInstance.once("listening", onListening);
    serverInstance.listen(requestedPort, "127.0.0.1");
  });
}

async function handleLibrary(req, res, url) {
  const referenceMatch = /^\/library\/([^/]+)\/references\/([^/]+)$/.exec(url.pathname);
  if (referenceMatch) {
    try {
      const reference = await webCaptureIngest.readReference(decodeURIComponent(referenceMatch[1]), decodeURIComponent(referenceMatch[2]));
      res.statusCode = 200;
      res.setHeader("content-type", mimeTypeForFile(reference.fileName));
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      pipeStreamToResponse(reference.stream, res, {
        errorPayload: { error: "Reference attachment unavailable" },
      });
    } catch {
      sendJson(res, 404, { error: "Reference attachment not found" });
    }
    return;
  }
  const derivativeMatch = /^\/library\/([^/]+)\/(thumbnails|mediums|previews)\/([^/]+)\.webp$/.exec(url.pathname);
  if (derivativeMatch) {
    const kind = derivativeMatch[2] === "previews" ? "preview" : derivativeMatch[2] === "mediums" ? "medium" : "thumbnail";
    try {
      if (typeof store.derivativeReadStream !== "function") throw new Error("Derivatives unavailable.");
      const imageStream = await store.derivativeReadStream(decodeURIComponent(derivativeMatch[1]), decodeURIComponent(derivativeMatch[3]), kind);
      res.statusCode = 200;
      res.setHeader("content-type", "image/webp");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      pipeStreamToResponse(imageStream, res, {
        errorStatusCode: 404,
        errorPayload: { error: "Derivative not found" },
      });
    } catch {
      sendJson(res, 404, { error: "Derivative not found" });
    }
    return;
  }
  const match = /^\/library\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const fileName = decodeURIComponent(match[2]);
  const projectId = decodeURIComponent(match[1]);
  let fileInfo;
  try {
    if (typeof store.assetFileInfo !== "function") throw new Error("Asset file info unavailable.");
    fileInfo = await store.assetFileInfo(projectId, fileName);
  } catch {
    sendJson(res, 404, { error: "Asset not found" });
    return;
  }

  const size = Number(fileInfo?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    sendJson(res, 500, { error: "Asset size unavailable" });
    return;
  }
  const range = parseSingleByteRange(req.headers.range, size);
  res.setHeader("content-type", mimeTypeForFile(fileName));
  res.setHeader("Accept-Ranges", "bytes");
  // Library media are copied under unique asset filenames and never mutate in place.
  // Keep a loaded gallery item available for the inspector without another network round trip.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (range?.unsatisfiable) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const contentLength = range ? end - start + 1 : size;
  res.statusCode = range ? 206 : 200;
  res.setHeader("Content-Length", String(contentLength));
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }

  let imageStream;
  try {
    imageStream = await store.assetReadStream(projectId, fileName, range ? { start, end } : undefined);
  } catch {
    if (!res.headersSent) sendJson(res, 404, { error: "Asset not found" });
    else res.destroy();
    return;
  }
  pipeStreamToResponse(imageStream, res, {
    errorStatusCode: 404,
    errorPayload: { error: "Asset not found" },
  });
}

/**
 * Chromium's media stack only needs a single byte range for normal metadata,
 * playback, and seeking. Multiple ranges are intentionally rejected instead
 * of buffering multipart responses in the local runtime.
 */
function parseSingleByteRange(header, size) {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : String(header);
  if (!value.toLowerCase().startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return { unsatisfiable: true };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return { unsatisfiable: true };
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

function setBrowserClientCookie(res, activePort) {
  const cookie = mosaBrowserClientCookieHeader(clientToken, activePort);
  if (cookie) res.setHeader("Set-Cookie", cookie);
}

const STATIC_SUBDIRECTORIES = new Set(["assets", "fonts"]);

async function handleStatic(res, pathname, activePort) {
  // Static files live flat in appDir, plus an explicit allowlist of one-level
  // subdirectories that ship with the UI. Any other nested path is treated as
  // missing, and anything that escapes the app root (../, encoded traversals)
  // is refused.
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const segments = relativePath.split("/");
  const servable = segments.length === 1 || (segments.length === 2 && STATIC_SUBDIRECTORIES.has(segments[0]));
  const filePath = resolve(appDir, relativePath);
  if (filePath !== appDir && !filePath.startsWith(appDir + sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    if (!servable) throw new Error("Not a servable static path");
    const content = await readFile(filePath);
    res.statusCode = 200;
    const contentType = staticMime(filePath);
    res.setHeader("content-type", contentType);
    if (contentType.startsWith("text/html")) setBrowserClientCookie(res, activePort);
    // Explicit cache control for UI static files to prevent stale content issues.
    // index.html, CSS, JS, MJS, SVG etc. should be revalidated on each request
    // since they lack content hash in the URL (versioned URLs are a future optimization).
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.end(content);
  } catch {
    // SPA fallback for extensionless routes only. A missing /styles.css or
    // /module.mjs must 404 as itself — serving index.html under a 200 would
    // hand the browser an HTML document where it expects CSS/JS and turn a
    // broken reference into an unstyled, script-less page.
    if (extname(pathname)) {
      sendJson(res, 404, { error: `Not found: ${pathname}` });
      return;
    }
    const content = await readFile(join(appDir, "index.html"));
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    setBrowserClientCookie(res, activePort);
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.end(content);
  }
}

function staticMime(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
