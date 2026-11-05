// Task 341 test worker: aborts on designated inputs (mimicking the native
// 0xc0000409 sharp crash on Windows) and delegates every other request to the
// real ops so a "next request succeeds" assertion exercises the true pipeline.
import {
  encodeVideoPosterOp,
  metadataOp,
  paletteOp,
  perceptualHashOp,
  pixelDigestOp,
} from "../../lib/image-decode-ops.js";

function send(message) {
  const electronPort = process.parentPort;
  if (electronPort) {
    electronPort.postMessage(message);
    return;
  }
  if (typeof process.send === "function") process.send(message);
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.type !== "image-decode" || typeof message.requestId !== "string") return;
  const described = typeof message.input === "string"
    ? message.input
    : message.input instanceof Uint8Array ? Buffer.from(message.input).toString("latin1") : "";
  if (described.includes("crash-me")) {
    process.abort();
  }
  const options = message.options && typeof message.options === "object" ? message.options : {};
  let result;
  switch (message.op) {
    case "pixelDigest": result = await pixelDigestOp(message.input, options); break;
    case "metadata": result = await metadataOp(message.input, options); break;
    case "perceptualHash": result = await perceptualHashOp(message.input); break;
    case "palette": result = await paletteOp(message.input, options); break;
    case "encodeVideoPoster": result = await encodeVideoPosterOp(message.input, options); break;
    default:
      send({ type: "image-decode-result", requestId: message.requestId, ok: false, error: `Unknown image decode operation: ${String(message.op || "")}` });
      return;
  }
  send({ type: "image-decode-result", requestId: message.requestId, ok: true, result });
}

const electronPort = process.parentPort;
if (electronPort) {
  electronPort.on("message", (event) => { void handle(event.data); });
} else {
  process.on("message", (message) => { void handle(message); });
  process.on("disconnect", () => { process.exit(0); });
}
