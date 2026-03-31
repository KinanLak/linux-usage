# Extension bundle

Use `scripts/install-extension.sh` for local development installs.

`npm run build:extension` assembles the local runtime bundle in `dist/`.

`make pack` compiles schemas in `dist/` and writes the reviewable zip bundle here.

Later this directory can hold a zip bundle created from `dist/` that matches GNOME extension distribution expectations.
