#!/usr/bin/env python3
"""
On-screen sync marker.

A small always-on-top borderless square that flips colour on command. Its job is
to stamp the *exact* moment an input is dispatched INTO the screen recording, so
the analyzer can read input-time and response-time off the same video timeline
with no clock sync between driver and recorder.

It is controlled through a FIFO (named pipe) so BOTH the Python driver (warm
runs) and a shell script (cold launches) can flip it the same way:

    mkfifo /tmp/cmperf.fifo
    python3 marker.py --fifo /tmp/cmperf.fifo &
    echo FLIP  > /tmp/cmperf.fifo     # toggle (e.g. right before launching Word)
    echo QUIT  > /tmp/cmperf.fifo

Commands (one per line): FLIP toggles, ON / OFF force a state, QUIT exits.

Place it OUTSIDE the content region you measure (default: top-left corner).
Standalone preview with no FIFO:  python3 marker.py
"""

import argparse
import os
import tkinter as tk

IDLE = "#202020"     # near-black
ACTIVE = "#00ff66"   # bright green: a large, unambiguous delta for the analyzer
SIZE = 80
MARGIN = 8


class Marker:
    def __init__(self, x: int, y: int, size: int, fifo: str | None):
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.geometry(f"{size}x{size}+{x}+{y}")
        self.canvas = tk.Canvas(self.root, width=size, height=size,
                                highlightthickness=0, bg=IDLE)
        self.canvas.pack()
        self.active = False
        self.fifo_fd = None
        if fifo:
            # Non-blocking read end; the writer side opens/closes per command.
            self.fifo_fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
            self._buf = b""
            self.root.after(1, self._poll)

    def _set(self, active: bool) -> None:
        self.active = active
        self.canvas.configure(bg=ACTIVE if active else IDLE)
        self.root.update_idletasks()

    def _apply(self, cmd: str) -> None:
        cmd = cmd.strip().upper()
        if cmd == "FLIP":
            self._set(not self.active)
        elif cmd == "ON":
            self._set(True)
        elif cmd == "OFF":
            self._set(False)
        elif cmd == "QUIT":
            self.root.destroy()

    def _poll(self) -> None:
        try:
            chunk = os.read(self.fifo_fd, 4096)
            if chunk:
                self._buf += chunk
                while b"\n" in self._buf:
                    line, self._buf = self._buf.split(b"\n", 1)
                    self._apply(line.decode("utf-8", "ignore"))
        except BlockingIOError:
            pass
        except OSError:
            pass
        if self.root.winfo_exists():
            self.root.after(1, self._poll)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fifo", default=None)
    ap.add_argument("--x", type=int, default=MARGIN)
    ap.add_argument("--y", type=int, default=MARGIN)
    ap.add_argument("--size", type=int, default=SIZE)
    args = ap.parse_args()
    m = Marker(args.x, args.y, args.size, args.fifo)
    m.root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
