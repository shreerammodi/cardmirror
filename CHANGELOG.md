# Changelog

User-facing release notes for CardMirror. Brief summaries of what
changes in each release, written for users of the editor. For
in-depth rationale and implementation context behind each entry,
see `DETAILED_CHANGELOG.md`.

## Unreleased

### Added

- **Setting: Format nav pane entries by type** (Settings →
  Appearance, on by default). Turn off for a uniform nav-pane
  list where only indentation conveys hierarchy — no bold
  top-level headings, no analytic-blue accent, no per-level
  size shifts. Display-only; the underlying doc is untouched.

### Fixed

- **Keyboard Shortcuts cheat sheet now lists every bindable
  action.** The reference modal was hand-maintained and had
  fallen behind the keybindings registry — twenty-plus
  commands added in alpha.2 (zoom, chrome scale, paintbrush
  toggles, find, font color, the four picker openers, the
  three tools menus, and several others) weren't appearing.
  Now drives off the full registry and won't silently drift
  out of sync again.
- **Scrolling past the nav pane's top or bottom no longer
  scrolls the editor.** The wheel-event chain now stops at the
  nav pane's boundary, which also fixes the follow-up bug where
  reversing scroll direction kept scrolling the editor instead
  of the nav pane.
- **Open button on the web edition no longer silently drops your
  selection.** Clicking the 📂 Open button, picking a file, and
  ending up with nothing loaded — while `Ctrl-O` worked on the
  same page — was a race in the file-picker cancellation
  detection. Fixed by switching to the native `cancel` event.
- **Dark mode now guarantees readable text everywhere.** Three
  related fixes that together make dark-mode-with-apply-to-doc
  actually usable on real Verbatim docs:
  - Runs that Word writes with an explicit "default black" color
    (`w:color="000000"`) used to stay literally black, leaving
    large swaths of body text invisible against the dark
    surface. Now they inherit the themed text color and flip
    light.
  - Shading (Verbatim's "protected highlight" — yellow, grey,
    etc.) now forces text contrast like highlights already did:
    black on light shading, white on dark shading, regardless
    of theme.
  - Hyperlinks use a bright sky blue in dark mode (Word's
    `#0563C1` is too dark to read on a dark background).
  - Beyond those: any text color you (or Word) wrote that's
    too dark to read against the dark surface — Word's
    hyperlink blue, deep grays, dark reds — falls back to the
    themed text color. Turn off "Apply theme to the document
    area" if you'd rather see the original colors.
  - Underlines under highlighted / shaded text now match the
    text color (black on light backgrounds, white on dark),
    instead of staying themed-white and cutting through the
    black text like a faded slash.
  - The nav pane flattens to white in dark mode — the
    per-level greys and analytic-blue cues read as
    inconsistent against the dark chrome.
  - "Dark chrome, light document" mode (dark theme with
    "Apply theme to the document area" OFF — the default)
    now actually paints the document area white. Previously
    the editor element had no background of its own and was
    showing the dark chrome's color through it, defeating
    the whole point of leaving "apply to document" off.
  - Multi-pane in the same "Dark chrome, light document"
    mode kept the white background only for the first viewport
    when scrolling a long doc — the rest scrolled into dark.
    Now stays white across the full scrollable extent.

## 0.1.0-alpha.2 — 2026-05-20

### Added

- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. Toggle with the ⏱ button in the ribbon. Includes
  a big speech-timer display with start / pause, three speech-
  duration presets, Aff and Neg prep clocks, and a reset column.
  Type into the display while paused to set a custom duration.
  State syncs across windows. Configurable in Settings →
  Appearance: profile (High School / College / Pomodoro) with
  per-profile editable durations, compact layout, low-time flash
  with editable thresholds, and prep-side label style (Both /
  Text / Color).
- **Dark mode** (Settings → Appearance → Theme: Light / Dark /
  System). The document area stays light by default; flip
  "Apply theme to the document area" for full dark.
- **Chrome scale chord** (`Mod-Alt-=` / `Mod-Alt--` /
  `Mod-Alt-0`) scales the whole window the way your browser's
  `Ctrl-+` zoom does. Independent of the editor zoom
  (`Mod-=` / `Mod--`), so you can fine-tune content size on top.
  Keyboard-only — rebind in Settings → Keybindings.
- **Open with CardMirror from your file manager.** `.docx` and
  `.cmir` are registered as CardMirror file types at install
  time. Double-clicking a file in Finder / Explorer / your Linux
  file manager opens it in CardMirror — spawning a new window if
  the app's already running.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar
  with case-sensitive and whole-word toggles, next / prev
  navigation, a match count, Replace, and Replace All. Every
  match highlights in light yellow with the active match in a
  stronger orange. Three result orderings: categorized (Ctrl-F:
  headings → tags → cites → body, with the category priority
  reorderable in Settings → General), proximity-only (Alt-F),
  and the same categorized order in replace mode (Ctrl-H). The
  bar's expandable results panel lists every match at a glance.
  The nav pane decorates outline entries whose subtree contains
  a match. Find can be scoped to a selection.
- **Editable image alt text** — right-click an image →
  Edit alt text… opens a dialog. Alt text now round-trips
  through `.docx` import and export (the importer used to drop
  it). The AI alt-text generator also updates the image's alt
  attribute and asks before regenerating existing alt text.
- **Active doc filename in a ribbon pill** (opt-in, Settings →
  Appearance → "Show doc name in ribbon"). Useful where the OS
  title bar isn't visible — tiling window managers, hidden-title
  themes, embedded web edition.
- **Multi-pane window title shows every open slot**, joined by
  `·` — e.g. "Foo · Bar — CardMirror" — instead of just the
  focused doc's name.
- **Show / hide the nav pane.** Three ways to toggle: the ☰
  button in the ribbon, the × in the nav-pane header, or a small
  pull-tab on the left edge of the viewport (visible only when
  the nav pane is hidden). Per-window state.
- **Right-click on a hyperlink** opens a context menu — Open
  Link, Copy Link Address, Edit Link…, Remove Link.
- **About this install in Settings → General** — version, host,
  OS, and full user-agent for bug reports. On desktop, includes
  Check for updates and Open crash dumps folder buttons.
- **Every ribbon action is now keybindable** in Settings →
  Keybindings. Twelve previously click-only actions joined the
  registry: font-size step up / down, apply font color, open
  settings, toggle paragraph integrity, the four color/size
  picker dropdowns, and the doc / card / table tools menus.
- **Zoom and paintbrush toggles are keybindable.** Defaults:
  Mod-= zoom in, Mod-- zoom out. The reset chord and paintbrush
  toggles ship unbound (assign them yourself if you want).

### Accessibility

- **Reduce motion** (Settings → Accessibility). System (follows
  OS preference) / On / Off. Flattens UI animations.
- **Readability-tuned body fonts.** Three SIL-OFL fonts ship
  with CardMirror: **Atkinson Hyperlegible**, **Lexend**, and
  **OpenDyslexic**. Plus the British Dyslexia Association's
  endorsed system sans-serifs (Verdana, Tahoma, Comic Sans MS)
  when installed on your OS. Settings → Appearance → Body font
  groups options by category with the readability options
  leading.
- **Highlight + shading display overrides** with 1–3 ordered
  slots. Slot 1 remaps the most-common color in the doc, slot 2
  the next-most-common, last slot is a catch-all.
- **Per-token color overrides** for every UI color (background,
  borders, accent, hover, etc.) with reset-per-row + reset-all
  controls. Overrides win over the active theme.
- **Cursor-position color readout** in the status bar — when an
  override is active, shows the actual stored colors at the
  cursor so you know what's encoded in the doc even when the
  override is hiding it.

### Changed

- **Nav-pane heading clicks are dramatically faster on big
  docs.** Clicks where the heading is already visible are nearly
  instant. First click into a fresh part of the doc no longer
  adds a multi-second pause on top of the unavoidable rendering
  cost. (Previously every click cost ~2 seconds on a 2000-card
  file.)
- **Re-pressing a heading shortcut** (F4 / F5 / F6 / F7 /
  Mod-F7 / Mod-F8) on a paragraph that already has that style
  strips the paragraph's indentation while keeping the style.
  Was a no-op before.
- **F8 / Apply Cite Style** now expands to the word at the
  cursor when there's no selection — matching F10's behavior.
- **Shift-F3 (cycle case)** keeps the selection across cycles,
  so you can re-press to advance lower → UPPER → Title → lower.
- **Triple-click + drag** extends the selection paragraph-by-
  paragraph (was: collapsed back to character-level on first
  drag move).
- **Text-selection background is translucent** — highlights,
  shading, and other colored backgrounds show through. You can
  now tell at a glance whether selected text is highlighted.
- **Selected images** show a 2 px accent outline so it's
  obvious the click registered.
- **Paint mode cursor** is an I-beam with a small swatch of the
  active paint color in the corner. Picking a different color
  while paint mode is armed updates the cursor live.
- **Caret stays visible** after Enter / arrow keys / new-
  heading actions. The browser's auto-scroll-into-view now
  respects the fixed ribbon and status bar.
- **Window adapts to any size.** The 800×600 floor is gone, so
  the status bar stays visible on small / tiled / split-screen
  layouts. Ribbon panels hide progressively in a deterministic
  order when the ribbon runs out of room; settings,
  keyboard-shortcut, read-mode, and nav-pane buttons hide last.
- **New setting: default file format for new docs** — `.docx`
  (default) or `.cmir`. Affects the Save-As default for any doc
  that doesn't yet have an on-disk handle.
- **New setting: jump to doc top on read-mode toggle**, off by
  default. When on, toggling read mode scrolls to the top and
  places the cursor at the doc's start.
- **Word-count selection button (Σ)** moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter.
- **Speech-doc designation** uses the same warm-gold accent in
  both multi-window mode (the banner under the ribbon) and
  multi-pane mode (the per-pane chip).
- **Ribbon cleanup**: the plain-paste toggle (`T`) is hidden on
  desktop where F2 reads the clipboard directly. The autosave
  toggle is hidden on the web edition where autosave can't fire.
- **Keyboard-shortcut command labels** in Settings →
  Keybindings use consistent title casing throughout.

### Fixed

- **Toggling multi-pane → single-window mode no longer silently
  drops open docs.** Some panes' contents were lost on the
  switch back to one-doc-per-window.
- **Picking up a nav-pane heading and releasing without moving
  drops it back where it came from.** Used to land in a sibling
  slot.
- **Copy Last Cite now finds cite-marked text you just
  applied.** Previously, applying the cite style via marking
  text (rather than a paragraph style change) didn't promote
  the paragraph, so Copy Last Cite fell back to an older cite.
- **Underline / Emphasis font-size settings take effect.** The
  per-style size sliders for these two styles were silently
  ignored before.
- **Files from 2013–14-era Verbatim distributions import with
  underline / cite formatting intact.** Those distributions
  used older character-style ids that CardMirror used to skip
  silently.
- **AI alt-text descriptions reflect what the image is doing in
  the argument.** Generations now include the enclosing card's
  tag and cite, plus the paragraphs immediately before and
  after the image, instead of producing generic captions.
- **"New document" while CardMirror is already running no
  longer offers to recover docs from other windows.** Only the
  first window of an app session surfaces the startup-recovery
  sidebar.
- **Opening a doc starts both the editor and nav pane scrolled
  to the top** instead of inheriting the previous doc's scroll
  position.

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
