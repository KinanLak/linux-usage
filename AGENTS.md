# Development Notes

## Reload extension after changes

If only the GNOME extension changed:

```bash
./scripts/install-extension.sh
gnome-extensions disable linux-usage@kinanl
gnome-extensions enable linux-usage@kinanl
```

If the helper also changed:

```bash
./scripts/install-helper.sh
./scripts/install-extension.sh
gnome-extensions disable linux-usage@kinanl
gnome-extensions enable linux-usage@kinanl
```

If GNOME did not reload the extension cleanly:

```bash
gnome-extensions reset linux-usage@kinanl
gnome-extensions enable linux-usage@kinanl
```

To open the standalone preferences window directly:

```bash
gjs ~/.local/share/gnome-shell/extensions/linux-usage@kinanl/preferences-app.js
```
