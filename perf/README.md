# CardMirror performance study

Methodology + tooling to compare CardMirror against **Microsoft Word** (macOS and
Windows, natively) on three operations:

1. **Open** a 5 MB Verbatim `.docx`
2. **Scroll** a 5 MB Verbatim `.docx`
3. **Navigate** — click a heading in the nav pane that's far from the viewport

There are two independent things in this folder:

- **`shared/` + `word/`** — an *apples-to-apples, black-box* comparison rig that
  measures all three apps the same way (by what the screen shows). This is what
  produces the Word-vs-CardMirror numbers for the blog.
- **The in-app Benchmark** (Settings → *Benchmark*, built into CardMirror) — a
  game-style suite that runs a battery of in-editor actions and reports rich
  self-instrumented metrics (FPS, frame-time percentiles, op timings). Great for
  CardMirror's own numbers and for cross-validating the black-box rig. It is
  **not** part of the apples-to-apples comparison (Word can't run it).

## Why black-box (pixels, not APIs)

Word is closed, so the only methodology that's identical across all three apps is
**screen capture + frame analysis**: trigger an input, record the screen at high
FPS, and find the frame where the content is rendered and settled. It captures
the whole pipeline (incl. GPU compositing) and measures *user-perceived*
performance. Word's automation (`Documents.Open` returning, AppleScript `open`)
returns *before* layout/pagination finishes, so it undercounts — we use it only
as a labelled cross-check.

A small always-on-top **sync marker** is flipped at the exact moment of input, so
input-time and response-time are read off the *same* video — no clock sync
needed.

## Standardized scenario

- **View:** Word in **Web Layout** (continuous scroll — the closest analog to
  CardMirror's web view) for all three ops. Same `.docx`, same window size, same
  zoom %, same monitor/refresh/scaling.
- **Launch:** measure both **warm** (app already running, open the doc) and
  **cold** (app closed, launch + open — includes app start). Report separately.
- **Controls:** GPU acceleration on for both; file pre-read once (warm) so disk
  I/O isn't a confound; Word's spell/grammar/autosave left at defaults (state
  it); plugged in, no thermal throttling between runs.
- **Trials:** ≥10 per cell; report **median + p90**, discard the warm-up run.
- **Refresh-rate caveat:** sustained FPS is capped by the panel. On 60 Hz both
  apps cap at 60 and the differentiators are **frame-time consistency / dropped
  frames / input-to-photon latency** — lead with those. Use a 120 Hz+ panel if
  you want to show sustained-FPS headroom.

## Operation → metric

| Op     | Black-box metric (all apps)                                  | Better frame-rate source        |
|--------|--------------------------------------------------------------|---------------------------------|
| Open   | marker-flip → content rendered + settled (ms)                | —                               |
| Scroll | start-latency, motion-ratio, max-stall, capture-fps ceiling  | PresentMon (Win) / Instruments (Mac) |
| Nav    | click → target heading stable in viewport (ms)               | —                               |

## How to run (black-box rig)

Requires `python3`, `opencv-python`, `numpy`, `ffmpeg`, and `pyautogui`
(`pip3 install pyautogui opencv-python numpy`). Grant **Screen Recording**
permission to your terminal.

```bash
cp perf/config.example.json perf/config.json     # then fill coords + doc path

# 1. find your nav-pane click coords (move mouse, read the printout)
python3 perf/shared/drive.py coords

# 2. start a recording (separate terminal), then immediately drive the op
perf/shared/capture_mac.sh perf/out/cm_scroll.mov 14 60          # macOS
python3 perf/shared/drive.py run --config perf/config.json \
    --seq cardmirror_scroll --trials 10 --doc "/path/5mb.docx" --out perf/out

# 3. pick ROIs from a sample frame, then analyze
python3 perf/shared/analyze.py probe --video perf/out/cm_scroll.mov
python3 perf/shared/analyze.py run --video perf/out/cm_scroll.mov --mode scroll \
    --marker-roi 0,0,160,160 --content-roi 600,800,2000,500 --out perf/out/cm_scroll.csv
```

Repeat with `--seq word_scroll` (and the open/nav sequences) against Word. For
Word frame rate and the COM/AppleScript cross-checks, see **`word/`**.

## Files

```
perf/
  README.md                 this file (the protocol)
  config.example.json       sequences (steps per op) + coords/doc to fill in
  shared/
    marker.py               always-on-top sync marker (FIFO-controlled)
    drive.py                input driver + run orchestrator (step sequences)
    analyze.py              OpenCV: marker flips, content-settled, scroll smoothness
    capture_mac.sh          ffmpeg avfoundation capture
    capture_win.ps1         ffmpeg gdigrab/ddagrab capture
  word/
    mac/                    AppleScript/cliclick open (warm+cold) + Instruments notes
    win/                    PresentMon capture + VBA open/nav timing + CSV parser
```
