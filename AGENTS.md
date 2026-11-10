# Development Notes

## Architecture: one codebase, two packages

The source (`src/`, TypeScript ESM) targets GNOME Shell **45+**. A second package compatible with **GNOME 40–44** is generated automatically from the ESM build via an AST-ish transformer (`scripts/build-legacy-gjs.mjs`). **There is no legacy branch**: all changes go in `src/` only.

### Build outputs

| Target | Command | Artifact | `metadata.json` |
| --- | --- | --- | --- |
| GNOME 45+ (ESM) | `make build-esm` | `dist/` → `linux-usage.zip` | `shell-version` 45+ |
| GNOME 40–44 (legacy GJS) | `make build-legacy` | `dist-pre45/` → `linux-usage-pre45.zip` | `shell-version` pre-45 |
| Both | `make all` / `make pack` | — | — |

`make build-legacy` depends on `make build-esm`: it copies `dist/` to `dist-pre45/` and rewrites each `.js`.

### What `build-legacy-gjs.mjs` does

- `import … from "gi://Gtk?version=4.0"` → `imports.gi.versions.Gtk = "4.0"; const … = imports.gi.Gtk;`
- `import … from "./foo.js"` → `imports.foo` with a `getCurrentExtension().imports.foo` fallback
- `import … from "resource:///org/gnome/shell/…"` → `imports.…`
- `export function|class|const|let` → global declarations (`var`, `function`)
- `Extension.lookupByURL(import.meta.url)` → `extensionUtils.getCurrentExtension()`
- `Me.getSettings(…)` → `extensionUtils.getSettings(…)`
- `extension.js`, `prefs.js`, `preferences-app.js` are replaced by hard-coded legacy wrappers

### Constraints to stay legacy-compatible

The transformer is intentionally simple. Avoid in `src/`:
- `export *`, `export default` (outside the patterns already handled), `export { foo } from …`
- Dynamic `import()`, top-level `await`
- Named imports with nested destructuring
- New specifiers not handled in `resolveImportTarget` (`scripts/build-legacy-gjs.mjs:163`)

After any non-trivial change, build both targets and verify the zips.

## Reloading the extension after a change

Pick based on the target being tested:

```bash
make install-esm     # GNOME 45+
# or
make install-legacy  # GNOME 40-44
```

Both run `gnome-extensions install --force` then disable/enable.

If GNOME does not reload cleanly:

```bash
gnome-extensions reset "linux-usage@KinanLak.github.io"
gnome-extensions enable "linux-usage@KinanLak.github.io"
```

On GNOME 40 (the owner's machine, ordi-86: Rocky 9, shell 40.10 on X11), only `make install-legacy` works: the ESM build fails at load with `SyntaxError: import declarations may only appear at top level of a module`. After a failed load, disable/enable and `reset` are not enough, GNOME caches the failure: restart the shell. It refuses `systemctl restart`, but systemd relaunches it after a kill, and X11 apps survive:

```bash
kill "$(systemctl --user show org.gnome.Shell@x11.service -p MainPID --value)"
```

Open the standalone preferences window directly:

```bash
gjs ~/.local/share/gnome-shell/extensions/linux-usage@KinanLak.github.io/preferences-app.js
```

## Pre-commit checks

```bash
bun run check   # typecheck + lint + build:all
```

## macOS port (`macos/`)

A separate SwiftUI menu bar app (Swift package + Makefile, macOS 14+), isolated from the GNOME build: nothing in `src/`, the root `Makefile` or `bun run check` touches it. See `macos/README.md`.

- It doesn't reuse the TypeScript: `macos/Sources/LinuxUsage/Providers/` is a Swift port of `src/helper/`, and `UI/` mirrors `ui/popup.ts` and `prefs-widget/prefs.ts`. When provider parsing, statuses, messages or popup behavior change in `src/`, port the change to `macos/` (and the other way around).
- Build and check: `cd macos && make app` (universal, ad-hoc signed) and `make snapshot` for the provider JSON.
- UI without credentials: `make dev ARGS="--sample --open-popup"` (debug-only flags).
