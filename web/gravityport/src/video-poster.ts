/**
 * Video poster generation (task 248).
 *
 * Only the Electron renderer can decode video (the app ships no ffmpeg and
 * the library server may run as plain Node), so the renderer picks a poster
 * frame from an offscreen <video> + <canvas> and uploads it to
 * POST /api/assets/:project/:id/poster, which re-encodes it to the thumbnail
 * tier and stores it as thumbnails/<id>.webp. After the SSE "derivatives"
 * flush the gallery reloads and the card renders the poster as <img>.
 *
 * Frame picking avoids the classic "black intro" poster: candidates are
 * sampled at a few timestamps and the first frame that is neither too dark
 * nor flat colour wins; if none qualifies, the brightest sample is used.
 */

// A frame whose mean luma (Rec.709, 0–255) is below this reads as a
// black/faded intro. testsrc2-style colour frames sit far above 100; black
// 0, a half-faded intro gradient lands around 8–20.
export const POSTER_MIN_MEAN_LUMA = 32;

// A frame whose luma variance is below this is essentially a solid colour
// (black, white, colour card). Real content frames vary by thousands; solid
// frames by < 1. 24 keeps faded-but-textured frames eligible.
export const POSTER_MIN_LUMA_VARIANCE = 24;

// Canvas width used to score candidate frames. Small on purpose: seek is the
// expensive part, the luma statistics do not need more pixels.
const POSTER_ANALYSIS_WIDTH = 128;

// Output width matches the image thumbnail tier in lib/derivative-processor.ts
// (size: 400, quality: 78); the server re-encodes to exactly that anyway, so
// this only avoids uploading more bytes than needed.
const POSTER_OUTPUT_WIDTH = 400;
const POSTER_OUTPUT_QUALITY = 0.9;

// Per-seek and whole-extraction budgets. A healthy local seek lands in tens
// of ms; these bounds only cut off broken/slow-decoding files.
const SEEK_TIMEOUT_MS = 4000;
const EXTRACT_TIMEOUT_MS = 12000;

export type FrameLumaStats = { mean: number; variance: number };

/** Mean and variance of Rec.709 luma over an RGBA pixel buffer. */
export function frameLumaStats(pixels: ArrayLike<number>): FrameLumaStats {
  const count = Math.floor(pixels.length / 4);
  if (count <= 0) return { mean: 0, variance: 0 };
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    total += 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
  }
  const mean = total / count;
  let squaredDiff = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const luma = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
    squaredDiff += (luma - mean) * (luma - mean);
  }
  return { mean, variance: squaredDiff / count };
}

export type PosterSample<T> = { time: number; frame: T; stats: FrameLumaStats };

/**
 * Picks the poster sample: the first sample that is neither too dark nor flat
 * colour, else the brightest one. Returns null only when there are no
 * samples at all (nothing decoded).
 */
export function selectPosterSample<T>(samples: PosterSample<T>[]): T | null {
  if (!samples.length) return null;
  for (const sample of samples) {
    if (sample.stats.mean >= POSTER_MIN_MEAN_LUMA && sample.stats.variance >= POSTER_MIN_LUMA_VARIANCE) {
      return sample.frame;
    }
  }
  let brightest = samples[0];
  for (const sample of samples) {
    if (sample.stats.mean > brightest.stats.mean) brightest = sample;
  }
  return brightest.frame;
}

/**
 * Candidate timestamps in try order: 1 s, then 10 % / 25 % / 50 % of the
 * duration, clamped into the playable range and de-duplicated. A missing or
 * unusable duration falls back to a single mid-early probe.
 */
export function posterSeekTimes(durationSeconds: number | null | undefined): number[] {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [0.5];
  const lastUsable = Math.max(0.05, duration - 0.15);
  const clamp = (value: number) => Math.min(Math.max(value, 0.05), lastUsable);
  const wanted = [1, duration * 0.1, duration * 0.25, duration * 0.5].map(clamp);
  const seen = new Set<string>();
  const times: number[] = [];
  for (const time of wanted) {
    const key = time.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(time);
  }
  return times;
}

export function isUsablePosterStats(stats: FrameLumaStats): boolean {
  return stats.mean >= POSTER_MIN_MEAN_LUMA && stats.variance >= POSTER_MIN_LUMA_VARIANCE;
}

function seekTo(video: HTMLVideoElement, time: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`video seek timeout at ${time}s`));
    }, timeoutMs);
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(video.error || new Error("video decode error")); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

function waitForMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<number> {
  if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve(video.duration);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("video metadata timeout")); }, timeoutMs);
    const onReady = () => {
      if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) return;
      cleanup();
      resolve(video.duration);
    };
    const onError = () => { cleanup(); reject(video.error || new Error("video load error")); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("durationchange", onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("durationchange", onReady);
    video.addEventListener("error", onError);
  });
}

/**
 * Extracts a poster image for `videoUrl`. Resolves with a WebP blob, or null
 * when the video cannot be decoded, has no usable frame, or the extraction
 * blows the time budget — callers keep the existing video-frame thumbnail in
 * that case, so null is a normal outcome, not an error.
 */
export async function extractVideoPoster(videoUrl: string, durationHint: number | null): Promise<Blob | null> {
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = videoUrl;
  const analysis = document.createElement("canvas");
  const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
  try {
    if (!analysisContext) return null;
    const duration = await Promise.race([
      waitForMetadata(video, SEEK_TIMEOUT_MS).catch(() => 0),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), SEEK_TIMEOUT_MS)),
    ]);
    const times = posterSeekTimes(duration > 0 ? duration : durationHint);
    const samples: PosterSample<number>[] = [];
    for (const time of times) {
      if (Date.now() >= deadline) break;
      const budget = Math.min(SEEK_TIMEOUT_MS, deadline - Date.now());
      try {
        await seekTo(video, time, Math.max(100, budget));
      } catch {
        break;
      }
      if (video.videoWidth <= 0 || video.videoHeight <= 0) break;
      if (analysis.width !== POSTER_ANALYSIS_WIDTH
        || analysis.height !== Math.max(1, Math.round(POSTER_ANALYSIS_WIDTH * video.videoHeight / video.videoWidth))) {
        analysis.width = POSTER_ANALYSIS_WIDTH;
        analysis.height = Math.max(1, Math.round(POSTER_ANALYSIS_WIDTH * video.videoHeight / video.videoWidth));
      }
      analysisContext.drawImage(video, 0, 0, analysis.width, analysis.height);
      const pixels = analysisContext.getImageData(0, 0, analysis.width, analysis.height).data;
      samples.push({ time, frame: time, stats: frameLumaStats(pixels) });
      // Early exit: the first usable frame is the poster, no need to sample on.
      if (isUsablePosterStats(samples[samples.length - 1].stats)) break;
    }
    const chosenTime = selectPosterSample(samples);
    if (chosenTime === null) return null;
    // Re-seek only when the chosen frame is not the one currently shown.
    if (Math.abs(video.currentTime - chosenTime) > 0.01) {
      await seekTo(video, chosenTime, Math.max(100, deadline - Date.now()));
    }
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const output = document.createElement("canvas");
    output.width = Math.min(POSTER_OUTPUT_WIDTH, video.videoWidth);
    output.height = Math.max(1, Math.round(output.width * video.videoHeight / video.videoWidth));
    const outputContext = output.getContext("2d");
    if (!outputContext) return null;
    outputContext.drawImage(video, 0, 0, output.width, output.height);
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/webp", POSTER_OUTPUT_QUALITY));
    return blob || null;
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export type VideoPosterTarget = {
  id: string;
  project_id: string;
  thumbnail_url: string;
  duration_seconds: number | null;
};

/**
 * Serial background queue for poster extraction. One video at a time keeps
 * the renderer off the decode path while the gallery scrolls; each asset is
 * attempted at most once per run (success or failure), so a broken or
 * unsupported file never loops.
 */
export class VideoPosterQueue {
  private readonly queue: VideoPosterTarget[] = [];
  private readonly queued = new Set<string>();
  private readonly attempted = new Set<string>();
  private running = false;
  private stopped = false;

  constructor(private readonly upload: (target: VideoPosterTarget, blob: Blob) => Promise<void>) {}

  /** Returns true when the target was actually queued (not a duplicate). */
  enqueue(target: VideoPosterTarget): boolean {
    if (this.stopped) return false;
    const key = `${target.project_id}/${target.id}`;
    if (this.queued.has(key) || this.attempted.has(key)) return false;
    this.queued.add(key);
    this.queue.push(target);
    void this.drain();
    return true;
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const target = this.queue.shift()!;
        const key = `${target.project_id}/${target.id}`;
        this.queued.delete(key);
        // Mark the attempt the moment work starts, not when it finishes:
        // a second enqueue for the same asset must never slip in between
        // (the gallery effect re-runs when the masonry window settles).
        this.attempted.add(key);
        try {
          const blob = await extractVideoPoster(target.thumbnail_url, target.duration_seconds);
          if (blob) await this.upload(target, blob);
        } catch {
          // Extraction and upload failures are final for this run; the card
          // keeps its video-frame thumbnail and no retry is scheduled.
        }
      }
    } finally {
      this.running = false;
    }
  }
}
