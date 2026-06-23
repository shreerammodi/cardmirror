#!/usr/bin/env bash
# High-FPS screen capture for the perf suite (macOS, ffmpeg + avfoundation).
#
#   ./capture_mac.sh out.mov [seconds] [fps]
#
# Grant Screen Recording permission to your terminal first
# (System Settings > Privacy & Security > Screen Recording).
# List capture devices to find the screen index:
#   ffmpeg -f avfoundation -list_devices true -i ""
# Then set SCREEN below (often "Capture screen 0" => index after the colon).
#
# Notes:
#  - Retina capture is 2x: ROIs you give analyze.py are in these (2x) pixels.
#  - On a 60 Hz panel, on-screen FPS tops out at 60; capture at >=60 and rely on
#    PresentMon/Instruments for true frame rate. For scroll, capture as high as
#    the machine sustains (this writes raw-ish, fast-encoded frames).
set -euo pipefail
OUT="${1:-rec.mov}"
SECONDS_LEN="${2:-12}"
FPS="${3:-60}"
SCREEN="${SCREEN:-3}"   # avfoundation video device index for the screen

ffmpeg -y \
  -f avfoundation -capture_cursor 1 -framerate "$FPS" -i "${SCREEN}:none" \
  -t "$SECONDS_LEN" \
  -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p \
  "$OUT"
echo "wrote $OUT (${SECONDS_LEN}s @ ${FPS}fps target)"
