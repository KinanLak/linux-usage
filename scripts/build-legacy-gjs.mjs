#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve(process.argv[2] || "dist-pre45");

for (const filePath of await collectJavaScriptFiles(distDir)) {
  const relativePath = path.posix.normalize(path.relative(distDir, filePath).split(path.sep).join("/"));

  if (relativePath.startsWith("helper/") || relativePath.startsWith("shared/")) continue;

  const wrapper = buildLegacyWrapper(relativePath);
  if (wrapper) {
    await fs.writeFile(filePath, wrapper);
    continue;
  }

  let source = await fs.readFile(filePath, "utf8");
  let shebang = "";

  if (source.startsWith("#!")) {
    const newlineIndex = source.indexOf("\n");
    shebang = source.slice(0, newlineIndex + 1);
    source = source.slice(newlineIndex + 1);
  }

  source = transformImports(source, relativePath);
  source = source.replace(
    /Extension\.lookupByURL\(import\.meta\.url\)/g,
    "(() => { try { return imports.misc.extensionUtils.getCurrentExtension(); } catch { return null; } })()",
  );
  source = source.replace(
    /ExtensionPreferences\.lookupByURL\(import\.meta\.url\)/g,
    "(() => { try { return imports.misc.extensionUtils.getCurrentExtension(); } catch { return null; } })()",
  );
  source = source.replace(/Me\.getSettings\(/g, "imports.misc.extensionUtils.getSettings(");
  source = source.replace(/^export\s+async\s+function\s+/gm, "async function ");
  source = source.replace(/^export\s+function\s+/gm, "function ");
  source = source.replace(/^export\s+const\s+([\w$]+)\s*=/gm, "var $1 =");
  source = source.replace(/^export\s+let\s+([\w$]+)\s*=/gm, "var $1 =");
  source = source.replace(/^export\s+class\s+([\w$]+)\s*\{/gm, "var $1 = class $1 {");
  source = source.replace(/^export\s+default\s+class\s+([\w$]+)\s*extends\s+[\w$.]+\s*\{/gm, "var $1 = class $1 {");
  source = source.replace(/^\s*export\s*\{\s*\};?\s*$/gm, "");

  await fs.writeFile(filePath, `${shebang}${source.trimEnd()}\n`);
}

async function collectJavaScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
  }

  return files.sort();
}

function buildLegacyWrapper(relativePath) {
  if (relativePath === "extension.js") {
    return `const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { LinuxUsageIndicator } = Me.imports.ui.popup;

class LinuxUsageExtension {
    constructor() {
        this._indicator = null;
    }

    enable() {
        this._indicator = new LinuxUsageIndicator(0.0, Me.metadata.name, true);
        Main.panel.addToStatusArea(Me.metadata.uuid, this._indicator, 1, "right");
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init() {
    return new LinuxUsageExtension();
}
`;
  }

  if (relativePath === "prefs.js") {
    return `const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const prefs = Me.imports["prefs-widget"].prefs;

function init() {}

function buildPrefsWidget() {
    return prefs.buildPrefsWidget(ExtensionUtils.getSettings("org.gnome.shell.extensions.linux-usage"), Me.path);
}
`;
  }

  if (relativePath === "preferences-app.js") {
    return `#!/usr/bin/gjs

imports.gi.versions.Gtk = "4.0";
imports.gi.versions.Adw = "1";

const Adw = imports.gi.Adw;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const System = imports.system;

const scriptPath = GLib.path_get_dirname(System.programInvocationName);
imports.searchPath.unshift(scriptPath);

const prefs = imports["prefs-widget"].prefs;

const app = new Adw.Application({
    application_id: "org.kinanl.LinuxUsage.Preferences",
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
});

let window = null;

app.connect("activate", () => {
    if (!window) {
        prefs.loadCss(scriptPath);
        window = prefs.buildStandaloneWindow(app, scriptPath);
        window.connect("close-request", () => {
            window = null;
            return false;
        });
    }

    window.present();
});

app.run([]);
`;
  }

  return null;
}

function transformImports(source, relativePath) {
  return source.replace(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm, (_line, clause, specifier) => {
    if (specifier === "resource:///org/gnome/shell/extensions/extension.js") return "";
    if (specifier === "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js") return "";

    const importTarget = resolveImportTarget(specifier, relativePath);
    return renderImportClause(clause.trim(), importTarget);
  });
}

function resolveImportTarget(specifier, relativePath) {
  if (specifier.startsWith("gi://")) {
    const [, library, version] = specifier.match(/^gi:\/\/([^?]+)(?:\?version=(.+))?$/) || [];
    if (!library) throw new Error(`Unsupported GI specifier: ${specifier}`);

    return {
      prelude: version ? `imports.gi.versions.${library} = ${JSON.stringify(version)};\n` : "",
      expression: `imports.gi.${library}`,
    };
  }

  if (["system", "cairo", "gettext"].includes(specifier)) {
    return {
      prelude: "",
      expression: `imports.${specifier}`,
    };
  }

  if (specifier.startsWith("resource:///org/gnome/shell/")) {
    const modulePath = specifier.replace("resource:///org/gnome/shell/", "").replace(/\.js$/, "");
    return {
      prelude: "",
      expression: `imports.${modulePath.replace(/\//g, ".")}`,
    };
  }

  if (specifier.startsWith("resource:///org/gnome/Shell/Extensions/js/")) {
    const modulePath = specifier.replace("resource:///org/gnome/Shell/Extensions/js/", "").replace(/\.js$/, "");
    return {
      prelude: "",
      expression: `imports.${modulePath.replace(/\//g, ".")}`,
    };
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const currentDir = path.posix.dirname(relativePath);
    const resolved = path.posix.normalize(path.posix.join(currentDir, specifier)).replace(/\.js$/, "");
    const importsPath = resolved.replace(/\//g, ".");

    return {
      prelude: "",
      expression: `(() => { try { return imports.${importsPath}; } catch { return imports.misc.extensionUtils.getCurrentExtension().imports.${importsPath}; } })()`,
    };
  }

  throw new Error(`Unsupported import specifier: ${specifier}`);
}

function renderImportClause(clause, importTarget) {
  const lines = [];
  if (importTarget.prelude) lines.push(importTarget.prelude.trimEnd());

  if (clause.startsWith("* as ")) {
    lines.push(`const ${clause.slice(5).trim()} = ${importTarget.expression};`);
    return lines.join("\n");
  }

  if (clause.startsWith("{")) {
    const bindings = clause
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const aliasMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
        return aliasMatch ? `${aliasMatch[1]}: ${aliasMatch[2]}` : part;
      })
      .join(", ");

    lines.push(`const { ${bindings} } = ${importTarget.expression};`);
    return lines.join("\n");
  }

  lines.push(`const ${clause} = ${importTarget.expression};`);
  return lines.join("\n");
}
