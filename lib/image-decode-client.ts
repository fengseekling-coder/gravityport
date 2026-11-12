import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaletteColor } from "./image-palette.js";

/**
 * Task 341: parent-side client for the disposable image-decode child process.
 * The Electron main process (and any other runtime that used to call sharp
 * inline) sends decode requests here instead, so a native crash in libvips —
 * sharp-win32-*.node aborting with 0xc0000409 on Windows — fails the affected
 * request instead of the whole App.
 *
 * Transport shape mirrors createProcessorTransport in derivative-worker.ts:
 * Electron main processes fork the worker through utilityProcess.fork;
 * everywhere else (standalone services, the background capture process,
 * tests) falls back to child_process.fork — with `serialization: "advanced"`
 * because pixel bytes and encoded poster buffers ride the same channel,
 * which JSON serialization cannot carry.
 *
 * Failure policy:
 * - child exit/crash: every pending request rejects with IMAGE_DECODER_CRASHED;
 *   the next call lazily restarts the child.
 * - per-request timeout (default 60s): the child is killed and the pending
 *   requests reject with IMAGE_DECODER_TIMEOUT; the next call restarts.
 * - the same input crashing twice rejects immediately for the rest of this
 *   run (per client instance), so one poisoned image cannot loop restarts.
 */

export const IMAGE_DECODER_CRASHED = "IMAGE_DECODER_CRASHED";
export const IMAGE_DECODER_TIMEOUT = "IMAGE_DECODER_TIMEOUT";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CRASHES_PER_INPUT = 2;
const MAX_BANNED_INPUTS = 1000;
const IMAGE_DECODE_WORKER_PATH = fileURLToPath(new URL("./image-decode-worker.js", import.meta.url));

type DecodeInput = Buffer | string;
type ImageDecodeOp = "pixelDigest" | "metadata" | "perceptualHash" | "palette" | "encodeVideoPoster";

export interface ImageDecodeClientOptions {
  /** Per-request wall-clock budget; also settable via MOSA_IMAGE_DECODE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Worker entry point override, also settable via MOSA_IMAGE_DECODE_WORKER_PATH (tests). */
  workerPath?: string;
}

export interface ImageDecoder {
  pixelDigest(input: DecodeInput, options?: { limitInputPixels?: number }): Promise<string>;
  metadata(input: DecodeInput, options?: { failOn?: "none" | "truncated" | "error" | "warning"; limitInputPixels?: number | boolean }): Promise<Record<string, unknown>>;
  perceptualHash(input: DecodeInput): Promise<string>;
  palette(input: DecodeInput, options?: { limitInputPixels?: number }): Promise<PaletteColor[]>;
  encodeVideoPoster(input: DecodeInput, options?: { width?: number; quality?: number; limitInputPixels?: number }): Promise<Buffer>;
}

interface DecodeError extends Error {
  code?: string;
}

interface Transport {
  readonly pid: number | null;
  send(message: Record<string, unknown>): void;
  kill(): void;
  /** Keep the child's IPC in the event loop while requests are in flight. */
  ref(): void;
  /** Park the idle decoder so it never keeps a drained runtime alive. */
  unref(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal?: string | null) => void): void;
  onError(listener: (error: unknown) => void): void;
}

async function createDecodeTransport(workerPath: string): Promise<Transport> {
  const runtimeProcess = process as NodeJS.Process & { type?: string };
  if (process.versions.electron && runtimeProcess.type === "browser") {
    const { utilityProcess } = await import("electron");
    const child = utilityProcess.fork(workerPath, [], {
      stdio: "ignore",
      serviceName: "GravityPort Image Decoder",
    });
    return {
      get pid() { return child.pid || null; },
      send(message) { child.postMessage(message); },
      kill() { child.kill(); },
      // Electron's utilityProcess has no event-loop handle to manage: the
      // main process exits through app lifecycle, not through a drained loop.
      ref() {},
      unref() {},
      onMessage(listener) { child.on("message", listener); },
      onExit(listener) { child.once("exit", (code) => listener(code, null)); },
      onError(listener) { child.on("error", listener); },
    };
  }

  const child = fork(workerPath, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  return {
    get pid() { return child.pid || null; },
    send(message) {
      if (!child.connected) throw new Error("Image decoder IPC channel is closed.");
      child.send(message);
    },
    kill() { child.kill(); },
    ref() {
      child.ref();
      child.channel?.ref?.();
    },
    unref() {
      // The idle decoder must not keep the parent's event loop alive (task
      // 341): a runtime with nothing else pending — a short-lived test
      // process, a service shutting down — must be able to exit with the
      // decoder parked. The worker exits on "disconnect" when the parent
      // goes away.
      child.unref();
      child.channel?.unref?.();
    },
    onMessage(listener) { child.on("message", listener); },
    onExit(listener) { child.once("exit", listener); },
    onError(listener) { child.on("error", listener); },
  };
}

export interface ImageDecodeClient extends ImageDecoder {
  /** Stops the child if one is running; used by tests and process shutdown. */
  close(): Promise<void>;
  readonly pid: number | null;
}

export function createImageDecodeClient(options: ImageDecodeClientOptions = {}): ImageDecodeClient {
  const optionsWorkerPath = options.workerPath;
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? process.env.MOSA_IMAGE_DECODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  let transport: Transport | null = null;
  let starting: Promise<Transport> | null = null;
  let generation = 0;
  const pending = new Map<string, {
    op: ImageDecodeOp;
    input: DecodeInput;
    resolve: (result: unknown) => void;
    reject: (error: DecodeError) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  const crashCounts = new Map<string, number>();
  const banned = new Set<string>();

  function decodeError(code: string, message: string): DecodeError {
    const error = new Error(message) as DecodeError;
    error.code = code;
    return error;
  }

  function describeInput(input: DecodeInput): string {
    return typeof input === "string" ? basename(input) : "buffer";
  }

  /** Crash identity: paths compare directly; byte inputs hash once — but only
   * when a crash has already been recorded for byte inputs, so the common
   * path never pays a digest per call. */
  function inputKey(op: ImageDecodeOp, input: DecodeInput, force = false): string {
    if (typeof input === "string") return `${op}|path:${input}`;
    if (!force && crashCounts.size === 0) return "";
    const digest = createHash("sha256").update(input).digest("hex");
    return `${op}|bytes:${digest}`;
  }

  function assertNotBanned(op: ImageDecodeOp, input: DecodeInput): void {
    if (banned.size === 0) return;
    const key = inputKey(op, input);
    if (key && banned.has(key)) {
      throw decodeError(IMAGE_DECODER_CRASHED, `Image decode refused for an input that already crashed the decoder twice: ${describeInput(input)}`);
    }
  }

  function recordCrash(op: ImageDecodeOp, input: DecodeInput): void {
    // force: the first crash of a byte input must still be counted, or the
    // empty-table shortcut in inputKey would never let a byte input get banned.
    const key = inputKey(op, input, true);
    if (!key) return;
    const count = (crashCounts.get(key) || 0) + 1;
    crashCounts.set(key, count);
    if (count >= MAX_CRASHES_PER_INPUT) {
      banned.add(key);
      if (banned.size > MAX_BANNED_INPUTS) {
        const oldest = banned.values().next().value;
        if (oldest) banned.delete(oldest);
      }
      console.warn(`[MOSA] image decoder input banned after ${count} crashes (op=${op}, file=${describeInput(input)}); further decodes of it fail fast this run`);
    }
  }

  /** Settles one request and parks the transport (unref) once nothing is
   * pending, so an idle decoder never keeps a drained event loop alive. */
  function settleRequest(requestId: string, act: (entry: { reject: (error: DecodeError) => void; resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> | null }) => void): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (pending.size === 0) transport?.unref();
    act(entry);
    return true;
  }

  function rejectPending(error: DecodeError): void {
    const requests = [...pending.values()];
    pending.clear();
    transport?.unref();
    for (const request of requests) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }

  function dropTransport(): void {
    if (!transport) return;
    const doomed = transport;
    transport = null;
    try { doomed.kill(); } catch {}
  }

  function bindTransport(next: Transport, boundGeneration: number) {
    next.onMessage((message) => {
      if (boundGeneration !== generation || !message || typeof message !== "object" || Array.isArray(message)) return;
      const response = message as Record<string, unknown>;
      if (response.type !== "image-decode-result" || typeof response.requestId !== "string") return;
      settleRequest(response.requestId, (request) => {
        if (response.ok === true) {
          request.resolve(response.result);
        } else {
          request.reject(decodeError(IMAGE_DECODER_CRASHED, String(response.error || "Image decode failed.")));
        }
      });
    });
    next.onExit((code, signal) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      const crashedRequests = [...pending.values()];
      for (const request of crashedRequests) recordCrash(request.op, request.input);
      rejectPending(decodeError(IMAGE_DECODER_CRASHED, `Image decoder exited unexpectedly${code != null ? ` (code ${code})` : signal ? ` (${signal})` : ""}.`));
      const described = crashedRequests.length
        ? `op=${crashedRequests.map((request) => request.op).slice(0, 3).join(",")} file=${describeInput(crashedRequests[0].input)}`
        : "no pending request";
      console.warn(`[MOSA] image decoder child process crashed (exit code ${code ?? signal ?? "unknown"}, ${described}); pending requests rejected, next call restarts it`);
    });
    next.onError((error) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      rejectPending(decodeError(IMAGE_DECODER_CRASHED, `Image decoder failed: ${error instanceof Error ? error.message : String(error)}`));
      try { next.kill(); } catch {}
    });
  }

  async function ensureTransport(): Promise<Transport> {
    if (transport) return transport;
    if (!starting) {
      // The worker path is resolved per fork so test harnesses (and the
      // MOSA_IMAGE_DECODE_WORKER_PATH escape hatch) can inject a worker even
      // after this client instance was constructed.
      const workerPath = optionsWorkerPath || process.env.MOSA_IMAGE_DECODE_WORKER_PATH || IMAGE_DECODE_WORKER_PATH;
      const boundGeneration = ++generation;
      starting = createDecodeTransport(workerPath).then((next) => {
        if (boundGeneration !== generation) {
          try { next.kill(); } catch {}
          throw new Error("Image decoder startup was superseded.");
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

  async function request<T>(op: ImageDecodeOp, input: DecodeInput, opOptions: Record<string, unknown> | undefined, postProcess?: (result: unknown) => T): Promise<T> {
    assertNotBanned(op, input);
    const child = await ensureTransport();
    // Requests in flight must hold the event loop (they are its only live
    // handle in short-lived processes); settleRequest parks it again.
    child.ref();
    const requestId = randomUUID();
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const entry = {
        op,
        input,
        resolve: (result: unknown) => resolveRequest((postProcess ? postProcess(result) : result) as T),
        reject: rejectRequest,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      entry.timer = setTimeout(() => {
        console.warn(`[MOSA] image decode timed out after ${timeoutMs}ms (op=${op}, file=${describeInput(input)}); stopping the decoder child`);
        generation += 1;
        starting = null;
        dropTransport();
        settleRequest(requestId, (timedOut) => timedOut.reject(decodeError(IMAGE_DECODER_TIMEOUT, `Image decode timed out after ${timeoutMs}ms (op=${op}, file=${describeInput(input)}).`)));
        rejectPending(decodeError(IMAGE_DECODER_TIMEOUT, `Image decoder child was stopped after a ${timeoutMs}ms timeout.`));
      }, timeoutMs);
      pending.set(requestId, entry);
      try {
        child.send({ type: "image-decode", requestId, op, input, options: opOptions || {} });
      } catch (error) {
        settleRequest(requestId, (failed) => failed.reject(decodeError(IMAGE_DECODER_CRASHED, error instanceof Error ? error.message : String(error))));
      }
    });
  }

  return {
    pixelDigest(input, opOptions) {
      return request<string>("pixelDigest", input, opOptions, (result) => String(result ?? ""));
    },
    metadata(input, opOptions) {
      return request<Record<string, unknown>>("metadata", input, opOptions, (result) => {
        if (!result || typeof result !== "object" || Array.isArray(result)) return {};
        return result as Record<string, unknown>;
      });
    },
    perceptualHash(input) {
      return request<string>("perceptualHash", input, undefined, (result) => String(result ?? ""));
    },
    palette(input, opOptions) {
      return request<PaletteColor[]>("palette", input, opOptions, (result) => (Array.isArray(result) ? result as PaletteColor[] : []));
    },
    encodeVideoPoster(input, opOptions) {
      return request<Buffer>("encodeVideoPoster", input, opOptions, (result) => {
        if (Buffer.isBuffer(result)) return result;
        if (result instanceof Uint8Array) return Buffer.from(result);
        return Buffer.alloc(0);
      });
    },
    async close() {
      generation += 1;
      const child = transport;
      transport = null;
      starting = null;
      rejectPending(decodeError(IMAGE_DECODER_CRASHED, "Image decoder was stopped."));
      if (!child) return;
      // Hold the event loop while waiting for the exit event: after a settle
      // the child is parked unref'd, and an unref'd child plus an unref'd
      // fallback timer would let the loop drain before exit is observed.
      child.ref();
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

let inProcessOpsPromise: Promise<typeof import("./image-decode-ops.js")> | null = null;
let inProcessMode = false;
const moduleDecoder = createImageDecodeClient();

/** Opt the module-level decoder into in-process execution. The derivative
 * child process calls this at startup: it already owns sharp in its own
 * disposable process, so forking a decoder grandchild would only add
 * serialization cost. Callers must invoke it before the first decode. */
export function useInProcessImageDecoder(): void {
  inProcessMode = true;
}

function inProcessOpsModule(): Promise<typeof import("./image-decode-ops.js")> {
  if (!inProcessOpsPromise) inProcessOpsPromise = import("./image-decode-ops.js");
  return inProcessOpsPromise;
}

/** Module-level decoder used by every library call site. Runs in-process once
 * useInProcessImageDecoder() was called, otherwise talks to the child. */
export const imageDecoder: ImageDecoder & { readonly pid: number | null } = {
  async pixelDigest(input, options) {
    if (inProcessMode) return (await inProcessOpsModule()).pixelDigestOp(input, options);
    return moduleDecoder.pixelDigest(input, options);
  },
  async metadata(input, options) {
    if (inProcessMode) return (await inProcessOpsModule()).metadataOp(input, options ?? {});
    return moduleDecoder.metadata(input, options);
  },
  async perceptualHash(input) {
    if (inProcessMode) return (await inProcessOpsModule()).perceptualHashOp(input);
    return moduleDecoder.perceptualHash(input);
  },
  async palette(input, options) {
    if (inProcessMode) return (await inProcessOpsModule()).paletteOp(input, options);
    return moduleDecoder.palette(input, options);
  },
  async encodeVideoPoster(input, options) {
    if (inProcessMode) return (await inProcessOpsModule()).encodeVideoPosterOp(input, options ?? {});
    return moduleDecoder.encodeVideoPoster(input, options);
  },
  get pid() {
    return inProcessMode ? null : moduleDecoder.pid;
  },
};
