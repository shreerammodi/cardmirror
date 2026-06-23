#!/usr/bin/env python3
"""
Frame analysis for the perf suite (the apples-to-apples measurement).

Given a screen recording that contains (a) the sync marker and (b) the document
content, it measures — identically for CardMirror, Mac Word, and Windows Word:

  open / nav :  marker-flip  ->  content RENDERED AND SETTLED
                ("settled" = after the load activity, the content region stops
                 changing for K consecutive frames)

  scroll     :  between a START flip and an END flip, smoothness + latency:
                start_latency_ms (flip -> first on-screen motion),
                motion_ratio (fraction of frames that actually changed),
                max_stall_ms (longest gap with no visual change while scrolling),
                capture_fps (ceiling imposed by the recording; for true frame
                rate use PresentMon on Windows / Instruments on macOS).

First find your two ROIs (in VIDEO pixels — note Retina capture is often 2x):

    python3 analyze.py probe --video rec.mov          # writes frame0.png + dims

Then:

    python3 analyze.py run --video rec.mov --mode open \
        --marker-roi 0,0,160,160 --content-roi 300,400,1200,300 --out open.csv
"""

import argparse
import csv
import json
import statistics as st
import sys

import cv2
import numpy as np


def roi(spec: str):
    x, y, w, h = (int(v) for v in spec.split(","))
    return x, y, w, h


def crop(frame, r):
    x, y, w, h = r
    return frame[y:y + h, x:x + w]


def frame_times_and_marker(video, marker_r):
    """One pass: per-frame timestamp (ms) and the marker ROI's grey mean."""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        sys.exit(f"cannot open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 60.0
    ts, mk = [], []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        pos = cap.get(cv2.CAP_PROP_POS_MSEC)
        ts.append(pos if pos and pos > 0 else i * 1000.0 / fps)
        mk.append(float(crop(g, marker_r).mean()))
        i += 1
    cap.release()
    return np.array(ts), np.array(mk), fps


def content_diffs(video, content_r):
    """Per-frame mean-abs-diff of the content ROI vs the previous frame."""
    cap = cv2.VideoCapture(video)
    diffs = [0.0]
    prev = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        c = cv2.cvtColor(crop(frame, content_r), cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev is not None:
            diffs.append(float(np.abs(c - prev).mean()))
        prev = c
    cap.release()
    return np.array(diffs)


def find_flips(marker_means, flip_thresh):
    d = np.abs(np.diff(marker_means))
    return [int(i + 1) for i in np.where(d > flip_thresh)[0]]


def settle_after(flip, diffs, ts, active_thresh, stable_thresh, k):
    """From `flip`, wait for load activity (>active_thresh) then K calm frames."""
    n = len(diffs)
    i = flip
    while i < n and diffs[i] <= active_thresh:   # wait until rendering starts
        i += 1
    started = i
    calm = 0
    while i < n:
        if diffs[i] <= stable_thresh:
            calm += 1
            if calm >= k:
                settled = i - k + 1
                return ts[settled] - ts[flip], started, settled
        else:
            calm = 0
        i += 1
    return None, started, None


def summarize(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    if not vals:
        return {}
    vals.sort()
    return {
        "n": len(vals),
        "median": round(st.median(vals), 1),
        "p90": round(vals[min(len(vals) - 1, int(0.9 * len(vals)))], 1),
        "min": round(vals[0], 1),
        "max": round(vals[-1], 1),
    }


def cmd_probe(args):
    cap = cv2.VideoCapture(args.video)
    ok, frame = cap.read()
    if not ok:
        sys.exit("cannot read first frame")
    h, w = frame.shape[:2]
    cv2.imwrite("frame0.png", frame)
    print(f"video {w}x{h} @ {cap.get(cv2.CAP_PROP_FPS):.1f} fps, "
          f"{int(cap.get(cv2.CAP_PROP_FRAME_COUNT))} frames")
    print("wrote frame0.png — open it and read off your marker/content ROIs "
          "(x,y,w,h in these pixels).")
    cap.release()


def cmd_run(args):
    marker_r, content_r = roi(args.marker_roi), roi(args.content_roi)
    ts, mk, fps = frame_times_and_marker(args.video, marker_r)
    diffs = content_diffs(args.video, content_r)
    flips = find_flips(mk, args.flip_thresh)
    if not flips:
        sys.exit("no marker flips detected — check --marker-roi and --flip-thresh")
    rows = []

    if args.mode in ("open", "nav"):
        for trial, flip in enumerate(flips):
            dt, started, settled = settle_after(
                flip, diffs, ts, args.active_thresh, args.stable_thresh, args.stable_frames)
            rows.append({"trial": trial, "flip_frame": flip,
                         "settled_frame": settled, "ms": round(dt, 1) if dt else None})
        metric = "ms"
        print(f"\n{args.mode}: marker-flip -> content settled (ms)")
    else:  # scroll: pair flips as (start, end)
        for trial, (s, e) in enumerate(zip(flips[0::2], flips[1::2])):
            win = diffs[s:e]
            wts = ts[s:e]
            moving = win > args.motion_thresh
            # start latency: flip -> first motion
            first_motion = next((j for j, m in enumerate(moving) if m), None)
            start_lat = (wts[first_motion] - wts[0]) if first_motion is not None else None
            # longest run of non-moving frames (a stall) inside the active scroll
            max_stall, run = 0.0, 0
            for j in range(1, len(moving)):
                if not moving[j]:
                    run += (wts[j] - wts[j - 1])
                    max_stall = max(max_stall, run)
                else:
                    run = 0
            rows.append({
                "trial": trial, "window_ms": round(wts[-1] - wts[0], 1),
                "frames": len(win), "motion_ratio": round(float(moving.mean()), 3),
                "start_latency_ms": round(start_lat, 1) if start_lat is not None else None,
                "max_stall_ms": round(max_stall, 1),
                "capture_fps": round(fps, 1),
            })
        metric = "max_stall_ms"
        print("\nscroll: smoothness within each START->END window")
        print("(capture_fps is the recording ceiling; use PresentMon/Instruments "
              "for true frame rate)")

    if args.out:
        with open(args.out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"per-trial rows -> {args.out}")
    for r in rows:
        print("  " + json.dumps(r))
    if args.mode in ("open", "nav"):
        print("summary:", summarize(rows, "ms"))
    else:
        for kk in ("motion_ratio", "start_latency_ms", "max_stall_ms", "window_ms"):
            print(f"summary {kk}:", summarize(rows, kk))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe"); p.add_argument("--video", required=True); p.set_defaults(fn=cmd_probe)
    r = sub.add_parser("run")
    r.add_argument("--video", required=True)
    r.add_argument("--mode", choices=["open", "nav", "scroll"], required=True)
    r.add_argument("--marker-roi", required=True)
    r.add_argument("--content-roi", required=True)
    r.add_argument("--flip-thresh", type=float, default=25.0)
    r.add_argument("--active-thresh", type=float, default=6.0)
    r.add_argument("--stable-thresh", type=float, default=1.5)
    r.add_argument("--stable-frames", type=int, default=6)
    r.add_argument("--motion-thresh", type=float, default=1.5)
    r.add_argument("--out", default="")
    r.set_defaults(fn=cmd_run)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
