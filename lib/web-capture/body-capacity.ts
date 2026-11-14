// In-flight capture request body capacity control moved out of web-capture-ingest.ts (task 410). Pure moves; no behavior changes.
import { WEB_CAPTURE_BUSY_RETRY_AFTER_SECONDS, WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES } from "./limits.js";

interface IngestBodyReservation { bytes: number; released: boolean }
const inflightIngestBodies = new Set<IngestBodyReservation>();

function inflightIngestBodyBytes(): number {
  let total = 0;
  for (const reservation of inflightIngestBodies) total += reservation.bytes;
  return total;
}

/**
 * Reserves `contentLength` bytes of the global in-flight budget before the
 * route reads anything. Throws (413 / 503) without consuming the request body
 * when the declared size is unusable or the budget is exhausted; the returned
 * release() is idempotent and must run in a finally. `res` is only used to
 * attach Retry-After to the 503. A missing or non-numeric Content-Length is
 * refused outright: every capture client (fetch with a concrete body) sends
 * one, and without it neither the entry cap nor the global budget is
 * enforceable before the bytes arrive.
 */
export function reserveIngestBodyCapacity(
  req: { headers: { "content-length"?: string | string[] | undefined } },
  res: { setHeader(name: string, value: string): void },
  entryMaxBytes: number,
  oversizeCode = "WEB_CAPTURE_BODY_TOO_LARGE",
): () => void {
  const raw = req.headers["content-length"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const contentLength = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : -1;
  if (contentLength < 0) {
    const e = new Error("Web capture requests must declare Content-Length.") as Error & { statusCode: number; code: string };
    e.statusCode = 413;
    e.code = "WEB_CAPTURE_CONTENT_LENGTH_REQUIRED";
    throw e;
  }
  if (contentLength > entryMaxBytes) {
    const e = new Error("Web capture request body exceeds the supported size limit.") as Error & { statusCode: number; code: string };
    e.statusCode = 413;
    e.code = oversizeCode;
    throw e;
  }
  const already = inflightIngestBodyBytes();
  const oversizeAlone = contentLength > WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES;
  if (already + contentLength > WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES && !(oversizeAlone && already === 0)) {
    res.setHeader("Retry-After", String(WEB_CAPTURE_BUSY_RETRY_AFTER_SECONDS));
    const e = new Error("Web capture is busy; retry shortly.") as Error & { statusCode: number; code: string };
    e.statusCode = 503;
    e.code = "WEB_CAPTURE_BUSY";
    throw e;
  }
  const reservation: IngestBodyReservation = { bytes: contentLength, released: false };
  inflightIngestBodies.add(reservation);
  return () => {
    if (reservation.released) return;
    reservation.released = true;
    inflightIngestBodies.delete(reservation);
  };
}

/** Test hook: drains all reservations (never used by the runtime itself). */
export function resetIngestBodyCapacityForTests(): void {
  inflightIngestBodies.clear();
}
