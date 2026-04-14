# Development Notes

## Architecture : une codebase, deux packages

Le code source (`src/`, TypeScript ESM) cible GNOME Shell **45+**. Un second package compatible **GNOME 40–44** est généré automatiquement à partir du build ESM via un transformateur AST-ish (`scripts/build-legacy-gjs.mjs`). **Il n'y a pas de branche legacy** : toute modification se fait dans `src/` uniquement.

### Sorties de build

| Cible | Commande | Artefact | `metadata.json` |
| --- | --- | --- | --- |
| GNOME 45+ (ESM) | `make build-esm` | `dist/` → `linux-usage.zip` | `shell-version` 45+ |
| GNOME 40–44 (legacy GJS) | `make build-legacy` | `dist-pre45/` → `linux-usage-pre45.zip` | `shell-version` pré-45 |
| Les deux | `make all` / `make pack` | — | — |

`make build-legacy` dépend de `make build-esm` : il copie `dist/` vers `dist-pre45/` puis réécrit chaque `.js`.

### Ce que fait `build-legacy-gjs.mjs`

- `import … from "gi://Gtk?version=4.0"` → `imports.gi.versions.Gtk = "4.0"; const … = imports.gi.Gtk;`
- `import … from "./foo.js"` → `imports.foo` avec fallback `getCurrentExtension().imports.foo`
- `import … from "resource:///org/gnome/shell/…"` → `imports.…`
- `export function|class|const|let` → déclarations globales (`var`, `function`)
- `Extension.lookupByURL(import.meta.url)` → `extensionUtils.getCurrentExtension()`
- `Me.getSettings(…)` → `extensionUtils.getSettings(…)`
- `extension.js`, `prefs.js`, `preferences-app.js` remplacés par des wrappers legacy codés en dur

### Contraintes pour rester compatible legacy

Le transformateur est volontairement simple. À éviter dans `src/` :
- `export *`, `export default` (hors patterns déjà gérés), `export { foo } from …`
- `import()` dynamique, top-level `await`
- Imports nommés avec destructuring imbriqué
- Nouveaux specifiers non gérés dans `resolveImportTarget` (`scripts/build-legacy-gjs.mjs:163`)

Après toute modif non triviale, builder les deux cibles et vérifier les zips.

## Reload extension après changement

Choisir selon la cible testée :

```bash
make install-esm     # GNOME 45+
# ou
make install-legacy  # GNOME 40–44
```

Les deux exécutent `gnome-extensions install --force` puis disable/enable.

Si GNOME ne recharge pas proprement :

```bash
gnome-extensions reset "linux-usage@KinanLak.github.io"
gnome-extensions enable "linux-usage@KinanLak.github.io"
```

Ouvrir la fenêtre de préférences standalone directement :

```bash
gjs ~/.local/share/gnome-shell/extensions/linux-usage@KinanLak.github.io/preferences-app.js
```

## Checks avant commit

```bash
bun run check   # typecheck + lint + build:all
```
