import {
  encodeVideoPosterOp,
  metadataOp,
  paletteOp,
  perceptualHashOp,
  pixelDigestOp,
} from "./image-decode-ops.js";
import type { MetadataOptions, PosterOptions } from "./image-decode-ops.js";

/**
 * Entry point of the disposable image-decode child process (task 341). Every
 * sharp decode of user images runs here, so a native crash in libvips fails
 * the in-flight requests instead of taking down the MOSA runtime process.
 * The parent side lives in image-decode-client.ts; the request/response
 * envelope mirrors derivative-worker.ts.
 */

interface ImageDecodeRequest {
  type: "image-decode";
  requestId: string;
  op: string;
  input: Buffer | string;
  options?: Record<string, unknown>;
}

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const OPERATIONS: Record<string, (input: Buffer | string, options: Record<string, unknown>) => Promise<unknown>> = {
  pixelDigest: (input, options) => pixelDigestOp(input, options as { limitInputPixels?: number }),
  metadata: (input, options) => metadataOp(input, options as MetadataOptions),
  perceptualHash: (input) => perceptualHashOp(input),
  palette: (input, options) => paletteOp(input, options as { limitInputPixels?: number }),
  encodeVideoPoster: (input, options) => encodeVideoPosterOp(input, options as PosterOptions),
};

async function handleMessage(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const request = message as Partial<ImageDecodeRequest>;
  if (request.type !== "image-decode" || typeof request.requestId !== "string" || !request.requestId) return;
  const operation = OPERATIONS[request.op || ""];
  if (!operation) {
    sendToParent({
      type: "image-decode-result",
      requestId: request.requestId,
      ok: false,
      error: `Unknown image decode operation: ${String(request.op || "")}`,
    });
    return;
  }
  try {
    const result = await operation(
      normalizeInput(request.input),
      request.options && typeof request.options === "object" && !Array.isArray(request.options) ? request.options : {},
    );
    sendToParent({ type: "image-decode-result", requestId: request.requestId, ok: true, result });
  } catch (error) {
    sendToParent({
      type: "image-decode-result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Structured clone may deliver a plain Uint8Array; normalizing to Buffer is a
 * copy only when the bytes did not arrive as one. */
function normalizeInput(value: unknown): Buffer | string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  throw new Error("Image decode input must be a file path or bytes.");
}

function sendToParent(message: unknown) {
  const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
  if (electronPort) {
    electronPort.postMessage(message);
    return;
  }
  if (typeof process.send === "function") process.send(message);
}

const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
if (electronPort) {
  electronPort.on("message", (event) => { void handleMessage(event.data); });
} else {
  process.on("message", (message) => { void handleMessage(message); });
  // child_process.fork: when the parent goes away the IPC channel closes —
  // exit instead of lingering as an orphan holding sharp's thread pool.
  process.on("disconnect", () => { process.exit(0); });
}
