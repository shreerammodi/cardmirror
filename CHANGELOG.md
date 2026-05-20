# Changelog

User-facing release notes for CardMirror. Each entry lists the
behavior, features, or bug fixes a release brought; rationale and
internal refactors live in commit messages, not here.

## Unreleased

- **Accessibility — Reduce motion.** Settings → Accessibility →
  Reduce motion: System / On / Off. System (default) follows the
  OS `prefers-reduced-motion` preference. On flattens all
  animations and transitions in the UI (drag-pickup vacuum,
  popover slides, save-flash pulse, smooth scrolls) to effectively
  instant. Off forces full motion even when the OS asks for
  reduced — useful for users on an OS where the setting is
  always-on but they prefer animations in this app.
- **Accessibility — Body-font readability presets.** The Settings
  → Appearance → Body font dropdown now groups options by
  category, with "Recommended for readability" leading. Three
  bundled SIL OFL fonts ship with the app so every install has
  a readability-tuned choice regardless of what's on the host OS:
  **Atkinson Hyperlegible** (Braille Institute; designed for low
  vision, disambiguated letter pairs), **Lexend** (Font Bureau;
  the readability-tuned sans-serif with the strongest positive
  reading-speed evidence among "dyslexia fonts"), and
  **OpenDyslexic** (weighted-bottom shapes; preferred by some
  dyslexic readers — independent studies have NOT shown
  reading-speed improvements vs. Arial, but the option is
  popular). The British Dyslexia Association's 2023 endorsed
  system sans-serifs (Verdana, Tahoma, Comic Sans MS) follow
  when installed; remaining groups are "Microsoft Office
  defaults", "Apple defaults", "Open-source / cross-platform",
  and "Generic". Groups whose fonts aren't available are hidden.
- **"Open with CardMirror" actually opens the file on desktop.**
  `.docx` and `.cmir` are now registered file associations in the
  electron-builder config, so the installers wire up CardMirror
  as a right-click "Open with…" target (and as the default-app
  candidate for both extensions). The main process gained a
  single-instance lock plus open-file / second-instance / argv
  handling so double-clicking a registered file in Finder /
  Explorer / a file manager opens that file in CardMirror —
  spawning a new window when the app is already running, or
  launching directly into the file if the app wasn't open. Web
  edition unchanged.
- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. New ⏱ button in the right side of the ribbon
  (next to ⚙) toggles a timer panel into the ribbon's left edge.
  The panel has a big speech-timer display, Start/Pause, three
  speech-duration presets (default 9/6/3 minutes), Aff and Neg
  prep clocks (default 10 minutes each, blue and red), and a
  Reset column that re-fills the prep balances. Click a preset
  to load it (paused — hit ▶ to start). Click Aff or Neg to make
  that side's prep clock the active countdown. Type into the big
  display while paused to set a custom duration. Prep balances
  persist across closes; speech timer doesn't. Cross-window
  sync via BroadcastChannel — open the timer in two windows and
  they stay in lockstep. New Settings → Appearance entries:
  **Timer profile** (High school 3/5/8 + 8 min prep, College
  3/6/9 + 10 min prep, Pomodoro 25/15/5, Custom), **Compact
  timer layout** (drops the preset buttons, tucks Reset under
  Start), and **Flash timer when countdown is low** (flashes the
  display red as remaining drops below 5 / 3 / 1 seconds).
- **"About this install" block at the bottom of Settings →
  General.** A read-only diagnostic section below a divider
  showing app version, host (Desktop / Web), operating system,
  and the full user-agent string — easy to copy-paste into a bug
  report. On desktop, two action buttons live underneath:
  **Check for updates** (mirrors Help → Check for Updates…,
  toast surfaces the result) and **Open crash dumps folder**
  (mirrors the Help-menu item) so both actions are now reachable
  from Settings.
- **Every ribbon action is now bindable.** Twelve previously
  click-only ribbon actions are now registered commands in the
  keybinding registry, available in Settings → Keybindings. None
  ship with a default binding — they're all already reachable via
  the ribbon, so a default chord would just be noise. The new
  bindable commands: increase / decrease font size by 1 pt,
  apply font color, open settings, toggle paragraph integrity,
  open each color picker dropdown (highlight / shading / font
  color), open the font-size picker, and open the doc / card /
  table tools menus.
- **Active doc filename in a ribbon pill (opt-in).** New Settings
  → Appearance → "Show doc name in ribbon" toggle (default off).
  When on, the active doc's filename appears as a pill centered in
  the ribbon between the comments toggle and the settings button.
  Useful on platforms / layouts where the OS title bar isn't
  visible: tiling window managers without decorations,
  hidden-title-bar themes, web edition embedded in another page,
  etc. Long filenames ellipsis-truncate with the full name in the
  tooltip. The chip hides when there's no filename yet
  (untitled / fresh doc before Save-As), in multi-pane mode (each
  per-pane chip already shows the slot's doc), and falls out of
  the ribbon's progressive-hide cascade between paragraph styles
  and the format-menu cluster when the ribbon runs out of room.
- **Multi-pane window title summarizes all open slots.** The OS
  window title in multi-pane mode used to show just the focused
  doc's filename. It now shows every non-empty slot's filename
  joined by `·` — e.g. "Foo · Bar — CardMirror" — so the title
  bar conveys the whole workspace at a glance rather than
  changing with every focus shift. Single-doc mode unchanged.
- **Fixed: Copy Last Cite now finds cite_mark text you just
  applied.** Adding the cite mark to a word in a body paragraph
  is supposed to promote that paragraph to a `cite_paragraph`
  (the cite classifier plugin does this automatically). But the
  classifier was gated on a "did the doc change?" range that
  excluded mark-only transactions — `AddMarkStep` doesn't shift
  any positions, so its step-map was empty and the classifier
  bailed early. Result: the paragraph stayed a regular
  `paragraph`, and Copy Last Cite fell through to whatever older
  `cite_paragraph` it could find further up the doc. The same
  silent-skip affected the named-style normalizer (it would
  miss underline/cite/emphasis conflicts created via mark-add
  transactions). Both now see mark-only transactions.
- **F8 / Apply Cite Style now expands to the word at the cursor**
  when there's no selection — matching the behavior F10 / Apply
  Emphasis Style already had. Previously pressing F8 with the
  cursor in a word silently did nothing; users had to double-click
  to select the word first.
- **Fixed: Nav-pane / find-bar jumps land precisely on big docs.**
  Cards use `content-visibility: auto` with a 200 px placeholder
  height, so `scrollIntoView` to a heading far down a long doc
  used to compute the target's position from placeholder heights
  and land tens of pixels off. The jump path now flips every
  cv:auto card and heading to `content-visibility: visible` via
  an editor-level class, forces a synchronous layout pass so the
  browser commits real heights, scrolls, and iterates a small
  refinement loop until the target's screen position stops moving.
  The class is removed at the end of the loop so cv:auto resumes
  skipping off-screen content for the editing hot path. Trade-off:
  every click pays a brief pause (full-doc layout, 200–500 ms on
  a 2000-card doc) for first-try precision. Applies to both
  nav-pane clicks and find-bar next-match navigation.
- **Fixed: Underline / Emphasis font-size settings were dead.**
  Settings → Styles → font size for the Underline and Emphasis
  styles did write a CSS variable, but no CSS rule consumed it, so
  the change was silently dropped. The marks now pick up
  `--pmd-size-underline` / `--pmd-size-emphasis` and behave like the
  other per-style size knobs.
- **Image alt text is now editable and round-trips through Word.**
  Three changes that ship together:
  - Right-clicking an image shows a new **Edit alt text…** menu item
    (above the AI options, always enabled). Opens a multi-line dialog
    pre-filled with the current alt text; saving writes the new value
    back to the image node and survives docx export.
  - The OOXML importer now reads `wp:docPr@descr` (with `pic:cNvPr@descr`
    as a fallback for older producers) into `image.attrs.alt`. Previously
    the importer dropped alt text on the floor; exporting was the only
    half of the round-trip that worked.
  - The AI alt-text generator now updates `image.attrs.alt` as well as
    inserting the visible `[ALT TEXT: …]` bracket. If the image already
    has alt text on its attribute, the AI command pops a dialog
    showing the existing alt text and offers **Keep current** (copy it
    to a bracket below the image, no API call) or **Regenerate with
    AI** (overwrite both the attribute and the bracket).
- **Dark mode.** Settings → Appearance → Theme: Light / Dark /
  System (default). System mode tracks the OS-level
  `prefers-color-scheme` and switches live when the user changes
  their system appearance. Sibling toggle, **Apply theme to the
  document area**, defaults off — the chrome (ribbon, nav, status
  bar, settings panels) follows the dark theme but the document
  itself stays light / paper-like. Flip on for full dark. User
  per-token color overrides win over either theme via inline
  style on `<html>`.
- **Accessibility settings section** (new tab, far right of the
  Settings dialog).
  - Highlight + shading display overrides moved here from
    Appearance. Replaced the single-color picker with **1–3
    ordered slots** that map to source colors by usage
    frequency. Slot 1 → most-common color in the doc, slot 2 →
    second-most-common, last slot = catch-all for everything
    else. Frequency ranking is incremental + debounced, and
    inactive when only one slot is set, so big docs don't pay
    perf cost unless they're using the multi-color feature.
  - **Per-token color overrides** panel: every UI color in the
    interface (background, borders, accent, hover, status, find
    decorations, table chrome, etc.) is overridable with a
    color picker + alpha slider. Reset-per-row + reset-all
    affordances. Overrides win over the active theme and any
    future preset (high-contrast, colorblind-friendly, etc.).
- **Cursor-position color readout** on the status bar. Visible
  only when an override is on. Shows the ACTUAL stored colors on
  the run at the cursor ("Hl: Yellow · Sh: Protected Grey") so
  you don't lose awareness of what's encoded in the doc while
  the override hides it from view.
- New setting: **default file format for new docs**. Pick `.docx`
  (default — Word- / Verbatim-compatible) or `.cmir` (CardMirror's
  native format, enables autosave); the Save-As dialog defaults to
  that format for any doc that doesn't yet have an on-disk handle.
  Existing files on disk still re-save in whatever format they were
  opened from.
- New setting: **jump to doc top when read mode toggles**. Off by
  default (today's stay-put behavior). When on, toggling read mode
  in either direction scrolls to the top of the doc and places the
  cursor at the start.
- Zoom in / out / reset and the highlight / shading paint-mode
  toggles are now registered ribbon commands, so users can bind
  them to keys via Settings → Keybindings. Default bindings:
  `Mod-=` for zoom in, `Mod--` for zoom out; `zoomReset` and the
  paintbrush toggles ship unbound (`Mod-0` is a browser-level
  reset that Chromium won't always let the page intercept, so the
  status-bar reset button remains the discoverable affordance).
- Keyboard-shortcut command labels (Settings → Keybindings) now
  use consistent title casing across the board.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar in
  the upper-right with case-sensitive and whole-word toggles,
  next / prev navigation, a match count, Replace, and Replace
  All. Every match is highlighted in light yellow; the
  currently-active one gets a stronger orange band. Escape
  closes and restores editor focus.

  Result ordering:
  - **Ctrl-F** (categorized): hits in headings come first, then
    tags, then cites, then everything else. Within each group,
    the closest match to your cursor ranks first (cursor counts
    as the top — matches after wrap around to matches before).
    The category priority is reorderable in Settings → General.
  - **Alt-F** (proximity-only): ignores categories — just orders
    by proximity to the cursor.
  - **Ctrl-H** opens the find+replace bar with the same
    categorized ordering as Ctrl-F.

  (Nav-pane-integrated find UI is still on the wishlist; the
  floating bar is the current shape.)
- Re-pressing a heading shortcut (F4 / F5 / F6 / F7 / Mod-F7 /
  Mod-F8) on a paragraph that already has that heading style now
  strips the paragraph's indentation while keeping the heading
  style and all other formatting intact, instead of being a
  no-op.
- Opening a doc now starts both the editor and the nav pane
  scrolled to the top, instead of inheriting the previous doc's
  scroll position.
- A "New document" window spawned while CardMirror is already
  running no longer offers to "recover" the docs you have open
  in other windows. Only the first window of an app session
  surfaces the startup-recovery sidebar.
- The navigation pane can now be hidden. Three ways to toggle:
  the new ☰ button in the View tools section of the ribbon, the
  × close button in the top-right of the nav pane itself, and a
  small pull-tab pinned to the left edge of the viewport (only
  visible when the nav pane is hidden). State is per-window; in
  multi-doc mode the toggle applies to all panes' nav at once.
- The word-count selection button (Σ) moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter — same family of question, fewer ribbon buttons.
- Zoom-strip controls (zoom in/out/reset + word-count) are
  slightly smaller and stay centered on the bar.
- Triple-click + drag now extends the selection paragraph-by-
  paragraph (instead of switching back to character-level on the
  first move). Matches Word and most browsers' contenteditable
  default.
- Right-clicking a link now opens a context menu (Open Link /
  Copy Link Address / Edit Link… / Remove Link). Open routes
  through the OS default browser via `shell.openExternal` on
  desktop; Edit reuses the in-app text prompt; Remove strips the
  link mark while preserving the text. Non-link right-clicks
  pass through to the browser / image context menu as before.
- Paint mode (highlight / shading paintbrush) now shows an I-beam
  precision cursor with a small swatch of the active color, so
  you can target characters precisely AND see which color the
  next paint will apply. Picking a new color while paint mode is
  armed updates the cursor live.
- Text selection inside the editor is now translucent (~30%
  alpha) instead of fully opaque, so the underlying highlight,
  shading, and other colors show through. Side effect: you can
  now tell at a glance whether selected text is currently
  highlighted (F11) — the highlight color shows through the
  selection overlay instead of being hidden by it.
- Clicking an image now shows a visible selected state — a 2px
  accent outline so it's obvious the click registered before
  pressing Delete / Copy. Unsupported-format placeholder spans
  also get a subtle background tint when selected.
- The caret no longer hides behind the fixed ribbon (top) or
  status bar (bottom) after Enter / arrow / new-heading actions.
  The browser's auto-scroll-into-view now reserves space for both
  fixed bars via `scroll-padding`.
- Legacy Verbatim character-style ids are now recognized on import
  — pre-modern distributions used `StyleBoldUnderline` for the
  underline mark and `StyleStyleBold12pt` for the cite mark. Files
  from those distributions (e.g. 2013-14 era debate evidence) now
  import with their underlining and cites intact instead of
  silently losing them. Export still normalizes to the current
  styleIds, so re-saving an old file cleans up the rStyle output.
- The AI alt-text generator now ships surrounding context with the
  image — the enclosing card's tag and cite, plus the paragraphs
  immediately before and after the image — so descriptions reflect
  what the image is *doing* in the argument instead of generic
  "a chart with bars" captions.
- Shift-F3 (cycle case) now keeps the selection after each press,
  so the user can re-press to advance to the next case state
  (lower → UPPER → Title → lower) without re-selecting.
- Speech-doc designation now uses the same warm-gold accent in both
  single-window multi-window mode (the banner under the ribbon) and
  single-window multi-pane mode (the per-pane chip), so the "this
  is the speech doc" affordance reads the same regardless of window
  topology.
- The window can now shrink to any size — the previous 800×600
  Electron floor is gone, so the status bar (zoom strip) stays
  on-screen on small / tiled / split-screen layouts. Ribbon panels
  hide progressively when there's literally no room left,
  least-essential first: character styles → structural styles →
  table / image / sub / sup / strike cluster → paragraph integrity
  toggle → font-size step buttons. Settings and keyboard-shortcut
  buttons stay visible as long as possible. The hide/show is
  measurement-driven (not media-query breakpoints), so it adapts
  to chrome scale, OS font size, and which panels are even
  visible to begin with.
- Ribbon cleanup: the plain-paste toggle (`T`) is hidden on desktop
  (F2 reads the clipboard directly there — no armed state to show),
  and the autosave toggle (⏱) is hidden on the web edition
  (autosave requires an on-disk file handle, which the browser
  can't provide).

## 0.1.0-alpha.1 — 2026-05-16

First downloadable preview of CardMirror. **This is an alpha.**
Expect bugs, missing features, and occasional breakage. Don't use
it for tournament-day work yet; keep a Verbatim copy of anything
important.

What works:

- Open and save Microsoft Word `.docx` files. Round-trips against
  Verbatim-format docs.
- Native `.cmir` format for lossless save / restore (no Word
  conversion costs, autosave-eligible).
- Verbatim-parity editing model: Pocket / Hat / Block / Tag /
  Analytic / Undertag styles, F-key shortcuts, condense /
  uncondense / case-toggle, emphasis / underline / highlight,
  shrink, send-to-speech, paste-as-plain.
- Multi-doc workspace — pick between a three-pane single-window
  layout or one window per doc.
- Send-to-speech across windows in multi-window mode.
- Per-doc read mode and autosave.
- Crash-recovery journal — unsaved drafts come back on next
  launch.
- Word-style left navigation pane: outline view, multi-select,
  drag-reorder.

Not in this release (planned):

- Full-text and schema-aware search across open docs / the
  evidence library on disk.
- Transclusion (live-linked content from a source doc).
- Cross-window drag-and-drop. (Cross-pane drag within multi-pane
  mode works.)

Operational:

- **Crash dumps** are collected locally to disk only — never
  uploaded anywhere. If CardMirror crashes and you want to send
  a report, open *Help → Open Crash Dumps Folder* and attach
  the minidump to a GitHub issue.
- **Auto-update**: on launch, CardMirror checks GitHub Releases
  for a newer version and downloads it in the background. When
  one's ready, a dialog asks whether to restart now or install
  on next quit. *Help → Check for Updates…* triggers the same
  check on demand.

Platforms:

- **macOS** — `.dmg` for Intel (x64) and Apple Silicon (arm64).
- **Windows** — NSIS installer (`.exe`) for x64.
- **Linux** — `.AppImage` (distribution-agnostic) and `.pacman`
  (Arch-native; install with `sudo pacman -U file.pacman`) for
  x64.

Known gaps:

- Desktop builds are unsigned. First-launch warnings on
  Windows (SmartScreen) and macOS (Gatekeeper) require a
  right-click → Open. See README.
