# AUR `cardmirror-bin`

Reference copy of the AUR `cardmirror-bin` PKGBUILD. The actual
submission lives in a separate Git repo on `aur.archlinux.org`;
this folder is the canonical source we keep in version control so
edits go through normal PR review.

The PKGBUILD fetches the official upstream `.pacman` artifact —
`https://github.com/ant981228/cardmirror/releases/download/v${_origver}/cardmirror-${_origver}.pacman`
— and unpacks its payload into `$pkgdir`. The `.pacman` is itself
an Arch package (XZ-tar with /opt + /usr layout + .PKGINFO) that
electron-builder produces via `fpm`, so the AUR build is
effectively a thin redistribution.

### Why not the AppImage?

Earlier versions of this PKGBUILD bootstrapped from the AppImage
— extracted its squashfs into `/opt/cardmirror` and symlinked
`/usr/bin/cardmirror` → `/opt/cardmirror/AppRun`. That broke at
launch because AppRun is the AppImage runtime's own launcher
script; its path-resolution math
(`HERE="$(dirname "$(readlink -f "$0")")"`) only works from
inside the squashfs mount where `$APPDIR` is set. Extracted to a
regular directory, the resolution produces an empty `${HERE}`
and exec fails with `/cardmirror: No such file or directory`.
The upstream `.pacman` ships the real Electron binary at
`/opt/CardMirror/cardmirror` directly — no AppRun involved.

## First submission

You only do this once per package name. Skip to "Releasing an
update" if `cardmirror-bin` is already on AUR.

1. Create an AUR account at <https://aur.archlinux.org/register>
   if you don't have one. Add your SSH public key to the AUR
   profile — submissions go through SSH.
2. Clone the AUR git repo for the package name (it's created on
   first push):
   ```sh
   git clone ssh://aur@aur.archlinux.org/cardmirror-bin.git
   ```
3. Copy this folder's `PKGBUILD` into that clone.
4. Generate `.SRCINFO` (AUR requires it; auto-generated from
   PKGBUILD):
   ```sh
   makepkg --printsrcinfo > .SRCINFO
   ```
5. Sanity-test the build locally:
   ```sh
   makepkg -si
   ```
   This builds the package, installs it, and runs the .desktop
   integration. Confirm CardMirror launches from your app menu
   and from `cardmirror` in a terminal.
6. Commit + push:
   ```sh
   git add PKGBUILD .SRCINFO
   git commit -m "Initial import: cardmirror-bin 0.1.0_alpha.1-1"
   git push
   ```

## Releasing an update

For every new CardMirror release that should ship via AUR:

1. In this repo's `packaging/aur/PKGBUILD`, bump `_origver` to
   the new tag (without the `v` prefix) and reset `pkgrel=1`.
   Increment `pkgrel` instead of `_origver` for AUR-only changes
   (PKGBUILD fixes, dependency tweaks).
2. If you're enforcing checksums (recommended after the alpha
   stabilizes), run `updpkgsums` to refresh `sha256sums`.
3. Commit + open a PR to merge the bump.
4. Once merged, `cd` into your local AUR clone (`cardmirror-bin`):
   ```sh
   cp /path/to/cardmirror/packaging/aur/PKGBUILD .
   makepkg --printsrcinfo > .SRCINFO
   makepkg -si        # local install sanity test
   git add PKGBUILD .SRCINFO
   git commit -m "Update to ${_origver}"
   git push
   ```

## Notes on the two update paths

Users who install via this PKGBUILD have two ways to get a newer
CardMirror:

- **`yay -Syu` / `pamac upgrade`** — pulls a new PKGBUILD when
  `_origver` is bumped on AUR. Standard Arch flow.
- **In-app auto-updater** — CardMirror's main process checks
  GitHub Releases on launch (opt-in, off by default since
  alpha.3 — flip in Settings → General → "About this install"
  → "Check for updates on launch"). Found-update notification
  links to the GitHub release page so users can grab the new
  `.pacman` manually.

Both work. The in-app path notifies sooner (no waiting for the
AUR maintainer to bump `_origver`); the AUR path is more in
keeping with system-level package management. The in-app check
is off by default, so AUR-installed users won't see it unless
they explicitly enable it.
