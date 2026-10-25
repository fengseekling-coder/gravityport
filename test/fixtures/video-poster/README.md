# video-poster fixtures

`black-intro.mp4` — 640x360 (16:9), 4 s, H.264 + faststart.
The first 1.5 s is a pure-black clip, the remaining 2.5 s is colourful
`testsrc2` noise. Used by the video-poster unit tests and e2e flow to prove
the renderer's frame picker skips the black intro.

The app itself never depends on ffmpeg; the committed file is the fixture.
Regenerate and re-commit only if the expected metadata changes.

Generated with `/Users/azhuilab/.local/node/bin/ffmpeg` (ffmpeg 6.0, no
ffprobe on this machine):

```sh
FFMPEG=/Users/azhuilab/.local/node/bin/ffmpeg
$FFMPEG -y \
  -f lavfi -i "color=black:s=640x360:r=15:d=1.5" \
  -f lavfi -i "testsrc2=s=640x360:r=15:d=2.5" \
  -filter_complex "[0][1]concat=n=2:v=1:a=0" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  <repo>/test/fixtures/black-intro.mp4
```
