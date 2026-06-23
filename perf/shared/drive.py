#!/usr/bin/env python3
"""
Input driver + run orchestrator for the perf suite.

Everything is expressed as a *named sequence* of steps in the config (see
perf/config.example.json). A step is one of:

    {"mark": true}                 flip the sync marker + log a timestamp (this is
                                    where a measured interval STARTS; the analyzer
                                    pairs it with the next content-stable frame, or
                                    with the following mark for scroll windows)
    {"key": ["command","o"]}       press a hotkey chord
    {"type": "..."}                type text (use "<DOC>" to substitute --doc)
    {"click": [x, y]}              click at absolute screen coords
    {"move":  [x, y]}              move the mouse (no click)
    {"scroll": {"clicks": -3, "count": 120, "interval_ms": 16}}
                                    a scroll burst: `count` wheel events of
                                    `clicks` each, every `interval_ms`
    {"sleep_ms": 800}              wait

The marker is controlled over a FIFO so cold-launch shell scripts flip it the
same way. Input uses pyautogui (`pip install pyautogui`).

Usage:
    # discover click coordinates (move mouse, read the printout):
    python3 drive.py coords

    # run a named sequence N times, logging marks to out/events.jsonl:
    python3 drive.py run --config perf/config.json --seq cardmirror_scroll \
        --trials 10 --doc "/path/to/5mb.docx" --out perf/out

Pair the recording (capture_*.sh/ps1) with this and analyze with analyze.py.
"""

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _require_pyautogui():
    try:
        import pyautogui  # noqa
        return pyautogui
    except Exception:
        sys.exit("pyautogui not installed — run: pip3 install pyautogui")


class Marker:
    """Owns the marker subprocess + its FIFO. Flip is fire-and-forget."""

    def __init__(self, fifo: str):
        self.fifo = fifo
        self.proc = None
        if os.path.exists(fifo):
            os.remove(fifo)
        os.mkfifo(fifo)
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(HERE, "marker.py"), "--fifo", fifo]
        )
        # Give the window time to map + the reader to open the FIFO.
        time.sleep(1.0)
        self._w = os.open(fifo, os.O_WRONLY)

    def flip(self) -> None:
        os.write(self._w, b"FLIP\n")

    def close(self) -> None:
        try:
            os.write(self._w, b"QUIT\n")
        except OSError:
            pass
        if self.proc:
            try:
                self.proc.wait(timeout=2)
            except Exception:
                self.proc.kill()
        try:
            os.remove(self.fifo)
        except OSError:
            pass


def run_step(step: dict, pg, marker: Marker, doc: str, log) -> None:
    if step.get("mark"):
        # Flip the marker and immediately stamp wall-clock. The video's marker
        # frame is authoritative; this log row carries the trial/label.
        marker.flip()
        log(time.perf_counter())
        return
    if "key" in step:
        pg.hotkey(*step["key"])
    elif "type" in step:
        pg.typewrite(step["type"].replace("<DOC>", doc), interval=0.01)
    elif "click" in step:
        pg.click(step["click"][0], step["click"][1])
    elif "move" in step:
        pg.moveTo(step["move"][0], step["move"][1])
    elif "scroll" in step:
        s = step["scroll"]
        clicks = int(s.get("clicks", -3))
        count = int(s.get("count", 100))
        interval = float(s.get("interval_ms", 16)) / 1000.0
        for _ in range(count):
            pg.scroll(clicks)
            time.sleep(interval)
    if "sleep_ms" in step:
        time.sleep(step["sleep_ms"] / 1000.0)


def cmd_run(args) -> int:
    pg = _require_pyautogui()
    pg.FAILSAFE = False  # don't abort on corner; we move deliberately
    cfg = json.load(open(args.config))
    seqs = cfg.get("sequences", {})
    if args.seq not in seqs:
        sys.exit(f"no sequence '{args.seq}' in config (have: {', '.join(seqs)})")
    seq = seqs[args.seq]
    fifo = cfg.get("fifo", "/tmp/cmperf.fifo")
    os.makedirs(args.out, exist_ok=True)
    events_path = os.path.join(args.out, "events.jsonl")

    print(f"Sequence '{args.seq}' x{args.trials}.  Switch to the target app NOW.")
    for n in range(int(cfg.get("countdown", 5)), 0, -1):
        print(f"  starting in {n}…", end="\r", flush=True)
        time.sleep(1)
    print(" " * 30, end="\r")

    marker = Marker(fifo)
    mark_i = 0
    with open(events_path, "a") as f:
        def log_mark(seq_name, trial):
            nonlocal mark_i
            def _log(t):
                nonlocal mark_i
                f.write(json.dumps({
                    "t": t, "seq": seq_name, "trial": trial, "mark": mark_i,
                }) + "\n")
                f.flush()
                mark_i += 1
            return _log
        try:
            for trial in range(args.trials):
                for step in seq:
                    run_step(step, pg, marker, args.doc, log_mark(args.seq, trial))
                time.sleep(cfg.get("between_trials_ms", 800) / 1000.0)
        finally:
            marker.close()
    print(f"Done. Marks logged to {events_path}. Now run analyze.py on the recording.")
    return 0


def cmd_coords(_args) -> int:
    pg = _require_pyautogui()
    print("Move the mouse to a target; Ctrl-C to stop.")
    try:
        while True:
            x, y = pg.position()
            print(f"  x={x:5d}  y={y:5d}", end="\r", flush=True)
            time.sleep(0.05)
    except KeyboardInterrupt:
        print()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--config", required=True)
    r.add_argument("--seq", required=True)
    r.add_argument("--trials", type=int, default=10)
    r.add_argument("--doc", default="")
    r.add_argument("--out", default="perf/out")
    r.set_defaults(fn=cmd_run)
    c = sub.add_parser("coords")
    c.set_defaults(fn=cmd_coords)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
