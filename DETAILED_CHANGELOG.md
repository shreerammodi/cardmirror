# Detailed Changelog

In-depth release notes for CardMirror. Each entry covers the
behavior, rationale, and (where useful) the implementation context
behind a change. For a shorter, jargon-free summary of what's new
in each release, see `CHANGELOG.md`.

## Unreleased

- **Single-doc scroll container migrated from `body` to `#app`.**
  Diagnosis: a multi-trace investigation (Mac Electron, Mac Chrome,
  Linux Chrome, with and without `--enable-skia-graphite`) plus a
  layer-tree audit on macOS pinned single-doc's continuous heavy
  `UpdateLayer` cost during scrolling to the document being the
  rootScroller. The DevTools Layers panel showed `#document` at
  2206 × 558272 px, ~4.9 GB nominal memory, compositing reason
  *"Is the document.rootScroller. Is a scrollable overflow element
  using accelerated scrolling."* Every scroll position change
  triggered a recomposition of that giant layer. Trace-data
  signature: 10 big (>100 ms) `UpdateLayer` events spread across
  a 13 s scroll session in single-doc vs. zero in multi-pane
  (which already used the bounded `.pmd-pane-body` scroller).

  Fix: scope a new `body:not(.pmd-multi-doc) #app` rule that pins
  `#app` to the chrome-clipped viewport rectangle via
  `position: fixed` (top/left/right/bottom set from the existing
  `--ribbon-height` / `--nav-width` / `--status-bar-height`
  tokens) and gives it `overflow-y: auto` + `overscroll-behavior:
  contain`. The editor + comments column scroll *inside* `#app`;
  `body` stops being the rootScroller; the composited scrollable
  layer is bounded by `#app`'s viewport-sized box instead of the
  doc-content height. Multi-doc layout is untouched — it has its
  own `body.pmd-multi-doc #app` rule that already pins height and
  manages overflow via per-pane `.pmd-pane-body` scrollers.

  Companion changes:
  - `body.pmd-speech-banner-visible:not(.pmd-multi-doc) #app` now
    adjusts `top:` instead of `margin-top:` (multi-doc never
    surfaces the banner, so this is single-doc-only).
  - The dark-chrome-light-document background paint extends to
    `#app` (was `.pmd-pane-editor` + `.pmd-pane-body` previously) —
    container backgrounds in `overflow: auto` cover the full
    scrollable extent at every scroll position, so any gap below
    the editor's content extent now reads as light rather than
    dark.
  - `index.ts` reset path: `appEl.scrollTop = 0` replaces
    `window.scrollTo(0, 0)` in the doc-open scroll-to-top sequence.
  - `precise-scroll.ts` `desiredTop` now reads from the nearest
    scrolling-overflow ancestor's `getBoundingClientRect()` instead
    of `window.innerHeight`. Falls back to viewport bounds when
    no scroller is found (tests, detached nodes). This keeps the
    convergence math working across single-doc (`#app`), multi-pane
    (`.pmd-pane-body`), and any future container.

  Verified end-to-end: typecheck + 683 tests pass. Most scroll-
  path call sites needed no changes — `tr.scrollIntoView()` (the
  PM Transaction method) walks up from the selection's DOM to
  find the nearest scrolling ancestor; element-level `scrollIntoView`
  does the same; `drag-editor-surface.ts`'s host-relative math
  was already 0 in single-doc and stays so.

- **Keyboard Shortcuts cheat sheet caught up with the keybindings
  registry.** The `GROUPS` array in `src/editor/reference-ui.ts`
  was hand-maintained and had drifted behind the registry — alpha.2
  added twenty-some new bindable commands (the twelve previously
  click-only ribbon actions plus `zoomIn` / `zoomOut` / `zoomReset` /
  `chromeScaleUp` / `chromeScaleDown` / `chromeScaleReset` /
  `togglePaintbrushHighlight` / `togglePaintbrushShading` /
  `openFind` / `openFindReplace` / `openFindByProximity` /
  `toggleNavPane`) and none of them appeared in the cheat sheet.
  Two changes:

  1. **Expanded GROUPS to cover every `RIBBON_COMMAND_ID`.** Added
     three new categories — `Color pickers & menus`, `Find`,
     `Zoom & scale` — and slotted the missing commands into
     existing categories (`save` and `toggleAutosave` into File,
     `insertImage` into Editing utilities, paintbrush toggles into
     Highlight tools, the picker openers into the new Color pickers
     & menus group, etc.).
  2. **Module-init drift guard** asserts every `RIBBON_COMMAND_ID`
     appears in exactly one group. Throws on load if anyone adds a
     new command to the registry and forgets the cheat-sheet
     update, or accidentally lists the same command in two groups.
     Error message names the missing / duplicated / extra ids so
     the fix is obvious from the stack trace.

  Verified end-to-end via CDP: 86 rows across 17 groups (was 14
  groups and a smaller subset before; the previous version was
  missing ~26 commands). Module init returned `ok` rather than
  throwing, confirming the assertion accepts the current registry.
  Unbound commands continue to display `—` (we briefly shipped
  `(no shortcut)` instead; reverted at user request because it was
  too noisy with ~46 unbound commands).

- **New setting: Format nav pane entries by type** (Settings →
  Appearance, default on). Wishlist follow-up to the dark-mode
  nav-pane flatten-to-white tweak: some users find the per-level
  font weight cascade (700 → 600 → 500 → normal) and the analytic-
  blue label accent noisy and prefer a uniform list keyed only on
  indentation. Implementation:
  - New `formatNavPaneByType: boolean` field on `Settings`,
    default `true`, sanitized in `loadSettings` so missing-or-
    truthy is treated as on and explicit-`false` as off.
  - `SETTING_METADATA` entry under category `appearance` next to
    `showDocNameChip`, so it lands in Settings → Appearance with
    the other nav / chrome toggles.
  - `applyFormatNavPaneByType(on)` in `index.ts` toggles
    `html.pmd-nav-flat` (class present when the toggle is OFF;
    parallels `pmd-doc-name-chip-on` / `pmd-nav-hidden`). Called
    at module init and from the settings subscriber so live
    toggling works.
  - CSS rules in `style.css` near the existing per-level rules:
    when `html.pmd-nav-flat` is set, `.pmd-nav-level-{1,2,3,4}`
    collapse to `font-weight: normal`, `font-size: 0.85rem`,
    `color: var(--pmd-c-text)`, and
    `.pmd-nav-type-analytic .pmd-nav-label` inherits instead of
    forcing the analytic-blue accent. Padding-left rules are
    untouched — indentation is the surviving hierarchy cue.
  - The dark-mode nav-pane-flatten-to-white rule still wins
    inside dark mode because it carries the higher-specificity
    `:root[data-theme="dark"] :is(.pmd-nav-panel, .pmd-multi-nav)`
    chain — both rules want uniform color anyway, so the cascade
    interaction is by design.
  Verified end-to-end via CDP on the 1NC v. Dartmouth doc: with
  `pmd-nav-flat` set, level-1 / 2 / 3 entries all report
  `font-weight: 400`, `font-size: 13.6px`; default state has 700 /
  600 / 500.

- **Scroll chaining from the nav pane no longer bleeds into the
  editor.** With the pointer over the nav pane, scrolling past its
  top or bottom limit would propagate the leftover wheel delta to
  the body's scroll container (single-doc) or the multi-pane row.
  Once the browser picked the editor as the gesture's scroll
  target, reversing direction kept scrolling the editor until the
  user paused fully and started a new gesture. Fix: add
  `overscroll-behavior: contain` on the two `overflow-y: auto`
  containers that own the nav and pane scrolls — `.pmd-nav-list`
  and `.pmd-pane-body` (multi-pane). `contain` cuts the scroll
  chain at the element's boundary, which also kills the "sticky
  target" follow-up because the chain never starts. Single-doc
  editor scrolls on the body / html, which has no ancestor scroll
  container to chain into, so no symmetric change needed there.
  Verified: `getComputedStyle(.pmd-nav-list).overscrollBehaviorY ===
  "contain"` post-fix.

- **Dark mode: end-to-end readability guarantee on imported docs.**
  Reported against the Health Care Topic Area Paper and 1NC v.
  Dartmouth CG docxs: with Settings → Appearance → Theme: Dark
  and "Apply theme to the document area" enabled, large swaths
  of body text were invisible (literal black on dark), shading-
  background text was invisible (themed white on yellow shading
  from Verbatim's `HighlightToBackgroundColor` macro), and
  hyperlinks were either browser-default `#0000EE` blue or
  Word's `#0563C1` — neither readable on `#1a1a1a`. Four
  coordinated changes in `src/schema/marks.ts` and
  `src/editor/style.css`:

  1. **`font_color="000000"` skip-inline-style.** The
     `000000` sentinel emits only `data-color="000000"` (no
     `style="color: #000000"`). The run inherits the
     surrounding text color: near-black via `--pmd-c-text` in
     light mode, `#e6e6e6` in dark mode, whatever the user
     picked in the per-token-override panel.

  2. **`colorBand(hex)` helper + `data-color-band` /
     `data-shading-band` attributes.** New exported helper
     classifies a 6-hex RGB into `dark` (perceived luminance
     `(0.299r + 0.587g + 0.114b) / 255 < 0.4`) or `light`.
     `font_color` and `shading` `toDOM` each emit a band
     attribute on the rendered span. Threshold tuned so the
     common Word sentinels — `000000` (lum 0), `0563C1`
     hyperlink blue (~0.32), dark grays / reds — land in
     `dark`, and mid-gray (`888888` ~0.53) onward stays
     `light` (user-intentional choices preserved).

  3. **Shading mandates contrast like highlight does.** CSS:
     `.ProseMirror [data-shading-band="light"] { color: #000; }`
     and the dark counterpart. Mirrors the per-named-color
     rules on `.pmd-highlight` for arbitrary hex shading.
     Always-on (not dark-mode-gated) because shading is doc
     data and needs contrast in any theme.

  4. **`--pmd-c-link` token + dark-band override + container
     scoping.** Light mode `#0563C1` (matches Word); dark
     mode `#7AB0FF` (bright sky blue, ~0.71 luminance).
     `.ProseMirror a` uses the token with `!important` so it
     beats the canonical Word-blue `font_color` marks Word
     stamps onto hyperlink runs. In dark mode + apply-to-doc,
     `[data-color-band="dark"]` falls back to `--pmd-c-text`
     via `!important`, catching dark-band font_color marks
     anywhere in the doc. Three higher-specificity rules
     reverse the override inside `.pmd-highlight`,
     `[data-shading-band]`, and `<a>` so those containers'
     mandated colors win (otherwise the override would make
     yellow-shaded text white-on-yellow, etc.).

  Round-trip unchanged: exporter reads `attrs.color`,
  importer / `parseDOM` read `data-color` / `data-shading`,
  neither touches inline style or `data-*-band`.

  Verified end-to-end via CDP on the 1NC v. Dartmouth doc:
  108/108 shading runs compute high-contrast (`color: #000` on
  the yellow shading), all 503 highlight runs compute
  high-contrast per their named highlight, 9/16 link runs
  render in sky blue and 7 render black because they sit
  inside `.pmd-highlight` spans where black-on-yellow contrast
  takes priority over link visibility (acceptable — the
  highlight rule already preserves readability and the link
  is still clickable). Six new test cases in
  `tests/schema/schema.test.ts` lock the contracts: the
  `000000` style skip, the `data-color-band` luminance buckets
  (`000000`/`0563C1`/`FF0000` → `dark`; `888888`/`FFFFFF`/
  `FFFF00` → `light`), and the shading band attribute on
  `toDOM`.

- **Underline color matches text color inside highlights and
  shading.** Follow-up to the dark-mode-readability work above.
  `.pmd-underline` / `.pmd-emphasis` are outer to highlight /
  shading in the mark stack (underline_mark at schema position 117,
  highlight at 311, shading at 271 — earlier-defined marks render
  outermost in the DOM). The text-decoration line is painted by the
  outermost element, and its `text-decoration-color` defaults to
  that element's `color` — which in dark mode is the themed light
  body text. So an underlined-highlighted run renders as black text
  on yellow (correct), with a white underline cutting through it
  (wrong). Added two `:has()` rule sets in `style.css` that set
  `text-decoration-color` on `.pmd-underline` / `.pmd-emphasis` (and
  `.pmd-cite` under the `citeUnderlined` flag) when they contain a
  highlight or shading band: black for light-band containers
  (yellow / green / cyan / magenta / red / lightGray highlight,
  `data-shading-band="light"`), white for dark-band containers
  (blue / darkBlue / darkCyan / darkGreen / darkMagenta / darkRed
  / darkYellow / darkGray / black highlight, `data-shading-band="dark"`).
  Verified on 1NC v. Dartmouth: 232 underline-inside-highlight/shading
  spans now paint `rgb(0, 0, 0)` underlines (correct against the
  yellow backgrounds in that doc); plain underlines outside any
  band still paint with themed body color so they read as light on
  the dark surface.

- **Native form controls render in dark mode.** The body-font
  dropdown in Settings → Appearance was painting its `<select>`
  with `var(--pmd-c-bg)` (dark in dark mode) but had no explicit
  text `color`, and the dropdown popup was being drawn by the
  browser in its OS-default light style — black option text on
  white in a UI surrounded by dark chrome. Two fixes: (1) set
  `color: var(--pmd-c-text)` on `.pmd-body-font-select` so the
  collapsed value is readable; (2) declare `color-scheme: dark`
  on `:root[data-theme="dark"]` so the browser draws every
  native form control (popup option lists, scrollbars, native
  date/color pickers, etc.) in its dark variant. Not gated on
  apply-to-document — native form controls only appear in chrome
  surfaces, never inside the ProseMirror editor, so the
  doc-area-stays-light mode doesn't need a light counterpart.
  Verified: `getComputedStyle(html).colorScheme === "dark"` and
  the select reports `color: rgb(230, 230, 230)` /
  `background: rgb(26, 26, 26)` in dark mode.

- **Sky-blue hyperlink color is now gated on apply-to-document.**
  Follow-up to the readability-guarantee work: the dark-mode
  `--pmd-c-link: #7AB0FF` override was set at `:root[data-theme=
  "dark"]` scope and so applied to the editor whenever the theme
  was dark — including when "Apply theme to the document area" was
  OFF and the document was rendering as light paper. Word's
  canonical hyperlink blue (`#0563C1`) is the right color against
  a white doc, so the sky-blue override leaked the wrong palette.
  Fix: add `--pmd-c-link: #0563C1` to the existing
  `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
  .pmd-pane-editor)` rule that already re-declares the other light-
  mode tokens for the editor scope when apply-to-doc is off. The
  chrome scope keeps `#7AB0FF` in dark mode (no chrome surface
  actually uses the token, but the symmetry is correct). Verified
  via CDP: dark + off → editor link computes `rgb(5, 99, 193)`;
  dark + on → editor link computes `rgb(122, 176, 255)`.

- **"Dark chrome, light document" mode actually paints the document
  area white, across the full scroll, in both single-doc and
  multi-pane.** The CSS rule that scopes light-mode-token
  redeclarations inside `:is(#editor, .pmd-pane-editor)` under
  `:root[data-theme="dark"]:not([data-theme-doc="dark"])` redefined
  `--pmd-c-bg: #fff` at the editor scope, but nothing in that rule
  applied the token to the editor's own paint — `#editor` /
  `.pmd-pane-editor` carry no `background` declaration of their own,
  so they inherited body's `background: var(--pmd-c-bg)` which
  resolves to `#1a1a1a` in dark mode. The editor read as black-on-
  dark even though the user explicitly opted OUT of "Apply theme to
  the document area." Two coordinated paints land the fix:

  1. **`background: var(--pmd-c-bg)` on `:is(#editor, .pmd-pane-editor)`**
     within the same scoped rule, so the scoped `--pmd-c-bg: #fff`
     actually applies to the editor's box. This covers single-doc
     entirely — `body` is its scroller, `#editor` sits inside the
     flex layout, and `#editor`'s painted box extends with the
     content.

  2. **`background: #fff` on `.pmd-pane-body`** in the same scoped
     rule. Multi-pane's per-pane editor surface (`.pmd-pane-editor`)
     is sized `height: 100%` of its parent `.pmd-pane-body` — which
     is the `overflow-y: auto` scroller bounded to the pane's
     viewport. So `.pmd-pane-editor`'s painted white box only
     covered the visible viewport portion; ProseMirror content
     overflows past that box and the dark `.pmd-pane-body` showed
     through under the overflowed content as the user scrolled.
     Painting `.pmd-pane-body` itself covers the full scrollable
     extent (container backgrounds in `overflow: auto` paint behind
     the visible viewport at every scroll position).

  The body / ribbon / nav / status-bar chrome around the editor
  stays dark because their backgrounds resolve `--pmd-c-bg` from
  the root scope (`#1a1a1a`) — the redeclare only escapes into the
  editor scope. Per-token Accessibility-panel overrides of
  `--pmd-c-bg` still win for single-doc because the `#editor`
  paint uses the token, not a literal hex.

- **Nav pane reads in solid white in dark mode.** The per-level grey
  cascade (level-4 → `--pmd-c-text-muted`, level-1/2/3 → inherited
  body text) and the analytic-blue label (`--pmd-color-analytic`)
  rendered as inconsistent dim entries against the dark chrome
  surface, and the "No headings." empty-state message disappeared
  into the background at `--pmd-c-text-faint` (#7a7a7a in dark
  mode). Added a dark-mode-scoped block that sets `color:
  var(--pmd-c-text-strong)` on the nav-panel container, the empty
  state, the level-4 entries, and the analytic label / hover —
  covering both single-doc (`.pmd-nav-panel`) and multi-pane
  (`.pmd-multi-nav`) layouts. Light mode is unchanged. The
  in-flight wishlist item "Setting: disable nav-pane formatting"
  will let users opt out of the per-type formatting in light mode
  too when shipped; this fix is the dark-mode-specific tactical
  flatten.

- **Web-edition Open button: selection no longer silently dropped.**
  Clicking the 📂 button on the web edition would open the OS
  file picker, let the user pick a file, then do nothing. `Ctrl-O`
  worked on the same page. Root cause: `BrowserHost.openOnce` had
  a focus-event-plus-200ms-setTimeout heuristic to detect
  cancellation — when the dialog closed and the window regained
  focus, the timer fired 200ms later and checked `input.files`.
  If the browser hadn't populated `input.files` by then (which
  varies with the previously-focused element — the button vs.
  editor — and with OS dialog implementation), the timer
  resolved the promise to `null`, then the actual `change` event
  fired but ran into `settled=true` and dropped on the floor.
  Keyboard `Mod-O` happened to win the race; mouse-button click
  reliably lost it on Chrome 148+ on Linux and on Zen (Firefox
  fork). Fix: replace the focus-and-timeout polling with the
  native `cancel` event (Chrome 113+, Firefox 91+, Safari 16.4+),
  which fires only when the user actually dismisses the picker
  without picking. No race. The byte-identical code in alpha.1
  was already buggy; nothing changed in this file between
  releases — what likely shifted was timing pressure elsewhere
  on the page (timer UI mount, dark-mode boot, find-replace
  decorations) that pushed the focus event past the
  `input.files` population threshold often enough that the
  symptom started manifesting reliably.

## 0.1.0-alpha.2 — 2026-05-20

- **Nav-pane navigation: dramatically faster on big docs.**
  Clicking a heading in the nav pane used to pay a full-doc
  layout pass on every click — about 2 seconds on a 2000-card
  debate file, paid regardless of whether the destination was
  already on screen. The scroll algorithm now does an optimistic
  `scrollIntoView` against whatever layout state already exists,
  then iteratively refines (up to 10 frames) when cv:auto's
  placeholder heights caused the first try to land imprecisely.
  Result: clicks where the target heading is already visible
  cost a few ms; clicks into fresh regions of the doc pay only
  what cv:auto would have charged anyway for materializing the
  destination, instead of re-laying-out the entire doc each
  time. The per-keystroke editing-perf win from cv:auto is
  preserved end-to-end (we no longer flip it off at all).
- **Chrome scale — Mod-Alt-= / Mod-Alt-- / Mod-Alt-0.** Three
  new keybindable commands (`chromeScaleUp` / `chromeScaleDown`
  / `chromeScaleReset`) that scale the whole window — chrome
  AND doc content together — the same way the browser's built-
  in Ctrl-+ chord does. On Electron this drives Chromium's
  `webFrame.setZoomFactor`, so layout reflows at the new
  factor rather than just resizing pixels. Helpful on high-DPI
  displays where the chrome reads too small, or low-DPI where
  it crowds the editor. No-op on the web edition (use the
  browser's own page-zoom). No ribbon button — keyboard-only
  (the chord is shown in Settings → Keybindings and can be
  rebound). The editor's existing `Mod--` / `Mod-=` zoom stays
  separate, so you can dial doc content size up or down on top
  of the page-zoom factor.
- **Bug fix — Nav-pane drag drop-back precision.** When you grab
  a heading in the nav pane, the pane inserts thin drop-indicator
  bars between every entry to show valid drop slots. The cursor
  still followed the pickup pill, but the pile-of-indicators
  above the source heading pushed the source's slot down out from
  under the cursor — so releasing without moving (a "drop it back
  where it came from" gesture) landed the heading in a sibling
  slot instead. The source `<li>` now anchors at its original
  screen-Y for the duration of the drag, so a no-move release
  reliably drops back into the original slot. Other entries
  still shift down by the full indicator stack, so the nav pane
  still visibly expands at drag-start (the affordance you'd
  expect).
- **Bug fix — Multi-pane → single-window switch was losing open
  docs.** Toggling from the three-pane workspace back to one-doc-
  per-window only restored the active pane; the others were
  silently dropped. Root cause was a journal-write race: two IPC
  writes to the same crash-recovery file could land at once,
  producing a valid-JSON-then-garbage file that the post-reload
  reader threw out as corrupt. Writes are now serialized per uid
  and committed via an atomic rename, so journals stay valid even
  under concurrent edit-debounce + mode-switch traffic.
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
  sync via BroadcastChannel — open the timer in two windows
  AND the visibility toggle in lockstep too: arming the panel
  in one window opens it in every CardMirror window. New
  Settings → Appearance entries:
  **Timer profile** (High school 3/5/8 + 8 min prep, College
  3/6/9 + 10 min prep, Pomodoro 25/15/5). Each profile's
  three preset durations and prep length are independently
  editable in Settings — pick a profile, then dial the four
  numbers to whatever your league actually uses. Switching
  profiles refills the prep clocks to that profile's total.
  **Compact timer layout** (drops the preset buttons, tucks
  Reset under Start). **Flash timer when countdown is low**
  (flashes the display red as remaining drops below 5 / 3 / 1
  seconds; the flash thresholds are editable too). **Prep
  side label** (Both / Text / Color) — controls how the Aff /
  Neg sides are labeled, with a color-only mode for a quieter
  panel.
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

  Surfaces beyond the floating bar:
  - **Expandable results panel** below the bar — toggles open
    via a chevron, lists every match with surrounding context,
    and clicking an entry jumps to it. Open/closed state
    persists per session via `findResultsExpanded`.
  - **Nav-pane integration** — outline entries whose subtree
    contains a match get a small accent decoration, so you can
    see at a glance which sections of the doc match the current
    query without scrolling through results.
  - **Scope** — search can be restricted to a range (e.g. the
    current selection) instead of the whole doc. Toggling the
    scope chip clears it.
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
  on-screen on small / tiled / split-screen layouts. Ribbon
  panels hide progressively when there's literally no room left.
  The cascade is 11 steps, least-essential first: character
  styles → structural styles → doc-name chip → format menu →
  table / image / sub / sup / strike cluster → font-size step
  buttons → highlight + shading + font color panel → comments
  toggle + add-comment → file-ops buttons (Open / New / Save /
  Autosave) → read-mode + nav-pane toggle → settings gear +
  keyboard-shortcut button. The timer toggle (⏱) stays outside
  the cascade so it's always reachable mid-round. The hide/show
  is measurement-driven (not media-query breakpoints), so it
  adapts to chrome scale, OS font size, and which panels are
  even visible to begin with.
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
