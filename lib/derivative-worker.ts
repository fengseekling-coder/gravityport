import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaletteColor } from "./image-palette.js";

const DEFAULT_CONCURRENCY = 2;
const MAX_CLAIM_BACKOFF_MS = 30000;
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const DERIVATIVE_PROCESSOR_PATH = fileURLToPath(new URL("./derivative-processor.js", import.meta.url));

interface DerivativeJob {
  project_id?: string;
  asset_id?: string;
  original_path?: string;
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
}

interface DerivativeStore {
  derivativesAvailable?: boolean;
  claimDerivativeJob(): Promise<DerivativeJob | null>;
  completeDerivativeJob(job: DerivativeJob, result: Record<string, unknown>): Promise<void>;
  isAssetActive?(projectId: string, assetId: string): Promise<boolean>;
  withAssetLifecycleLock?<T>(projectId: string, assetId: string, task: () => Promise<T>): Promise<T>;
}

interface DerivativeWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  readonly active: number;
}

interface DerivativeProcessorResult extends Record<string, unknown> {
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  /** Dominant colors of the 400px thumbnail, largest share first; [] when none could be computed. */
  palette: PaletteColor[];
  processorPid: number;
}

interface DerivativeProcessor {
  process(job: DerivativeJob): Promise<DerivativeProcessorResult>;
  close(): Promise<void>;
  readonly pid: number | null;
}

interface ProcessorTransport {
  readonly pid: number | null;
  send(message: Record<string, unknown>): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal?: string | null) => void): void;
  onError(listener: (error: unknown) => void): void;
}

async function createProcessorTransport(): Promise<ProcessorTransport> {
  const runtimeProcess = process as NodeJS.Process & { type?: string };
  if (process.versions.electron && runtimeProcess.type === "browser") {
    const { utilityProcess } = await import("electron");
    const child = utilityProcess.fork(DERIVATIVE_PROCESSOR_PATH, [], {
      stdio: "ignore",
      serviceName: "GravityPort Image Processor",
    });
    return {
      get pid() { return child.pid || null; },
      send(message) { child.postMessage(message); },
      kill() { child.kill(); },
      onMessage(listener) { child.on("message", listener); },
      onExit(listener) { child.once("exit", (code) => listener(code, null)); },
      onError(listener) { child.on("error", listener); },
    };
  }

  const child = fork(DERIVATIVE_PROCESSOR_PATH, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return {
    get pid() { return child.pid || null; },
    send(message) {
      if (!child.connected) throw new Error("Derivative processor IPC channel is closed.");
      child.send(message);
    },
    kill() { child.kill(); },
    onMessage(listener) { child.on("message", listener); },
    onExit(listener) { child.once("exit", listener); },
    onError(listener) { child.on("error", listener); },
  };
}

export function createDerivativeProcessor(): DerivativeProcessor {
  let transport: ProcessorTransport | null = null;
  let starting: Promise<ProcessorTransport> | null = null;
  let generation = 0;
  const pending = new Map<string, {
    resolve: (result: DerivativeProcessorResult) => void;
    reject: (error: Error) => void;
  }>();

  function rejectPending(error: Error) {
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) request.reject(error);
  }

  function bindTransport(next: ProcessorTransport, boundGeneration: number) {
    next.onMessage((message) => {
      if (boundGeneration !== generation || !message || typeof message !== "object" || Array.isArray(message)) return;
      const response = message as Record<string, unknown>;
      if (response.type !== "derivative-result" || typeof response.requestId !== "string") return;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (response.ok === true && response.result && typeof response.result === "object") {
        request.resolve(response.result as DerivativeProcessorResult);
      } else {
        request.reject(new Error(String(response.error || "Derivative processor failed.")));
      }
    });
    next.onExit((code, signal) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      rejectPending(new Error(`Derivative processor exited unexpectedly${code != null ? ` (code ${code})` : signal ? ` (${signal})` : ""}.`));
    });
    next.onError((error) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      rejectPending(new Error(`Derivative processor failed: ${error instanceof Error ? error.message : String(error)}`));
      try { next.kill(); } catch {}
    });
  }

  async function ensureTransport(): Promise<ProcessorTransport> {
    if (transport) return transport;
    if (!starting) {
      const boundGeneration = ++generation;
      starting = createProcessorTransport().then((next) => {
        if (boundGeneration !== generation) {
          try { next.kill(); } catch {}
          throw new Error("Derivative processor startup was superseded.");
        }
        transport = next;
        bindTransport(next, boundGeneration);
        return next;
      }).finally(() => {
        if (boundGeneration === generation) starting = null;
      });
    }
    return starting;
  }

  return {
    async process(job) {
      const child = await ensureTransport();
      const requestId = randomUUID();
      return new Promise<DerivativeProcessorResult>((resolveResult, rejectResult) => {
        pending.set(requestId, { resolve: resolveResult, reject: rejectResult });
        try {
          child.send({
            type: "process-derivative",
            requestId,
            job: {
              original_path: String(job.original_path || ""),
              previewPath: job.previewPath,
              mediumPath: job.mediumPath,
              thumbnailPath: job.thumbnailPath,
            },
          });
        } catch (error) {
          pending.delete(requestId);
          rejectResult(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async close() {
      const child = transport || await starting?.catch(() => null) || null;
      generation += 1;
      transport = null;
      starting = null;
      rejectPending(new Error("Derivative processor was stopped."));
      if (!child) return;
      await new Promise<void>((resolveClose) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveClose();
        };
        child.onExit(() => finish());
        try { child.kill(); } catch { finish(); }
        setTimeout(finish, 1000).unref?.();
      });
    },
    get pid() {
      return transport?.pid || null;
    },
  };
}

/**
 * Drains SQLite-backed derivative jobs without loading native image decoders
 * into the MOSA runtime process. Image decoding lives in a disposable child
 * process, so a native crash fails the current jobs instead of taking down the
 * library service.
 */
export function createDerivativeWorker(options: {
  store?: DerivativeStore;
  concurrency?: number;
  idleDelayMs?: number;
  maxClaimBackoffMs?: number;
  processor?: DerivativeProcessor;
} = {}): DerivativeWorker {
  const store = options.store;
  const processor = options.processor || createDerivativeProcessor();
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY));
  const idleDelayMs = Math.max(250, Number(options.idleDelayMs) || 1000);
  const maxClaimBackoffMs = Math.min(Math.max(1, Number(options.maxClaimBackoffMs) || MAX_CLAIM_BACKOFF_MS), MAX_CLAIM_BACKOFF_MS);
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = 0;
  let claimFailures = 0;
  let stopWaiters: Array<() => void> = [];

  function settleStopWaiters(): void {
    if (!stopped || active !== 0 || stopWaiters.length === 0) return;
    const waiters = stopWaiters;
    stopWaiters = [];
    for (const resolveStop of waiters) resolveStop();
  }

  function claimRetryDelayMs(): number {
    // Exponential backoff per consecutive claim failure, capped at 30s. A
    // single transient failure retries after the normal idle delay.
    return Math.min(idleDelayMs * 2 ** Math.max(0, claimFailures - 1), maxClaimBackoffMs);
  }

  async function schedule(): Promise<void> {
    if (stopped || !store) return;
    while (active < concurrency && !stopped) {
      let job: DerivativeJob | null = null;
      try {
        job = await store.claimDerivativeJob();
      } catch (error) {
        // A failed claim (e.g. SQLITE_BUSY while another process writes the
        // library) must never surface as an unhandled rejection: schedule()
        // runs fire-and-forget (void), so a throw here would take down the
        // whole runtime process. Log, back off, and let the timer below retry.
        claimFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[MOSA] derivative job claim failed (consecutive: ${claimFailures}); retrying in ${claimRetryDelayMs()}ms: ${message}`);
        break;
      }
      claimFailures = 0;
      if (!job) break;
      active += 1;
      processDerivativeJob(store, job, { processor })
        .catch((error) => {
          // A failed complete (e.g. SQLITE_BUSY while another process writes
          // the library) stays fire-and-forget — the stale-claim recycle
          // re-queues the job — but it must leave a trace, otherwise a job
          // that never completes is invisible.
          const code = typeof error?.code === "string" ? ` ${error.code}` : "";
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[MOSA] derivative job complete failed for ${job.project_id ?? "?"}/${job.asset_id ?? "?"}${code}: ${message}`);
        })
        .finally(() => {
          active -= 1;
          settleStopWaiters();
          void schedule();
        });
    }
    if (!stopped && active === 0) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void schedule(), claimFailures > 0 ? claimRetryDelayMs() : idleDelayMs);
    }
  }

  return {
    start() {
      if (!store?.derivativesAvailable || !stopped) return;
      stopped = false;
      claimFailures = 0;
      void schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active !== 0) await new Promise<void>((resolveStop) => stopWaiters.push(resolveStop));
      await processor.close();
    },
    wake() {
      if (!stopped) void schedule();
    },
    get active() {
      return active;
    },
  };
}

export async function processDerivativeJob(
  store: DerivativeStore,
  job: DerivativeJob,
  options: { processor?: DerivativeProcessor } = {},
): Promise<Record<string, unknown>> {
  const processor = options.processor || createDerivativeProcessor();
  const ownsProcessor = !options.processor;
  const run = async (): Promise<Record<string, unknown>> => {
    const projectId = String(job.project_id || "default");
    const assetId = String(job.asset_id || "");
    if (assetId && store.isAssetActive && !await store.isAssetActive(projectId, assetId)) {
      return { ok: false, skipped: true, error: "Asset is no longer active." };
    }
    if (VIDEO_EXTENSIONS.has(extname(String(job.original_path || "")).toLowerCase())) {
      const error = "Video assets are served as original media; derivative generation is skipped.";
      await store.completeDerivativeJob(job, { error });
      return { ok: false, error, skipped: true };
    }
    let result: DerivativeProcessorResult;
    try {
      result = await processor.process(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.completeDerivativeJob(job, { error: message });
      return { ok: false, error: message };
    }
    await store.completeDerivativeJob(job, result);
    return { ok: true, ...result };
  };
  const projectId = String(job.project_id || "default");
  const assetId = String(job.asset_id || "");
  try {
    return await (assetId && store.withAssetLifecycleLock
      ? store.withAssetLifecycleLock(projectId, assetId, run)
      : run());
  } finally {
    if (ownsProcessor) await processor.close();
  }
}
