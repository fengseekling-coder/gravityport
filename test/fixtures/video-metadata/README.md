# video-metadata fixtures

Small videos read by `test/video-metadata.test.mjs` through
`lib/video-metadata.ts`. CI has no ffmpeg: the tests only read these
committed files, so regenerate and re-commit them when the expected
metadata changes.

Generated with `ffmpeg` (ffmpeg 6.0, no
ffprobe on this machine) from `/tmp/vidfix`:

```sh
FFMPEG=ffmpeg
mkdir -p /tmp/vidfix && cd /tmp/vidfix

# moov in front (faststart), 72x128, 2 s
$FFMPEG -y -f lavfi -i testsrc=size=72x128:rate=10:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart faststart-72x128.mp4

# moov at the tail (default without faststart), same picture
$FFMPEG -y -f lavfi -i testsrc=size=72x128:rate=10:duration=2 \
  -c:v libx264 -pix_fmt yuv420p moov-late-72x128.mp4

# 90-degree display rotation in the tkhd matrix: metadata reader must
# swap 72x128 to 128x72
$FFMPEG -y -display_rotation 90 -i moov-late-72x128.mp4 -c copy rotated-90-72x128.mp4

# QuickTime MOV container, 72x128, 2 s
$FFMPEG -y -f lavfi -i testsrc=size=72x128:rate=10:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -f mov sample-72x128.mov

# High-detail (lossless) capture stand-in for ingest tests, which require
# more than the 64 KiB minimum video size: 72x128, 2 s, ~78 KB
$FFMPEG -y -f lavfi -i testsrc2=size=72x128:rate=30:duration=2 \
  -c:v libx264 -crf 0 -pix_fmt yuv420p -movflags +faststart capture-72x128.mp4

# Same picture style, twice the linear size: the "clearer version" side of the
# same-id video upgrade tests (144x256, 2 s, ~195 KB)
$FFMPEG -y -f lavfi -i testsrc2=size=144x256:rate=30:duration=2 \
  -c:v libx264 -crf 0 -pix_fmt yuv420p -movflags +faststart capture-144x256.mp4

# Not a parseable video: file cut off before its tail moov
head -c 600 moov-late-72x128.mp4 > truncated.mp4

cp faststart-72x128.mp4 moov-late-72x128.mp4 rotated-90-72x128.mp4 \
  sample-72x128.mov capture-72x128.mp4 capture-144x256.mp4 truncated.mp4 \
  <repo>/test/fixtures/video-metadata/
```
