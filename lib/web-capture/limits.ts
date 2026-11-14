// Web capture upload size limits moved out of web-capture-ingest.ts (task 410). Pure moves; no behavior changes.
export const WEB_CAPTURE_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WEB_CAPTURE_MAX_VIDEO_BYTES = 96 * 1024 * 1024;
export const WEB_CAPTURE_MAX_IMAGE_PIXELS = 40_000_000;
export const WEB_CAPTURE_MAX_BODY_BYTES = Math.ceil(Math.max(WEB_CAPTURE_MAX_IMAGE_BYTES, WEB_CAPTURE_MAX_VIDEO_BYTES) / 3) * 4 + 1024 * 1024;
// Task 314: the JSON entry now only has to fit base64 IMAGES (15 MiB → ~20 MiB
// expanded) plus a 1 MiB metadata margin. Videos are refused here with
// WEB_CAPTURE_USE_BINARY_UPLOAD so the extension can fall back to the binary
// envelope or the chunked upload instead of buffering a ~128 MiB JSON string.
export const WEB_CAPTURE_MAX_JSON_BODY_BYTES = Math.ceil(WEB_CAPTURE_MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
// Task 314: global bound on capture request bytes buffered at once. Reading a
// body is the unauthenticated-to-429 phase — the ingest concurrency cap only
// applies after the body is fully parsed — so N concurrent large captures
// could previously buffer without bound. Reservations come from Content-Length
// before a byte is read; a single request larger than the whole budget (only
// the binary video envelope can be) is admitted alone and starves the rest.
export const WEB_CAPTURE_INFLIGHT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
export const WEB_CAPTURE_BUSY_RETRY_AFTER_SECONDS = 5;
