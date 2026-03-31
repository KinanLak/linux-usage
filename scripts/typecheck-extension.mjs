#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const rootDir = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(rootDir, "ts", "extension");
const ambientFile = path.join(rootDir, "ts", "ambient.d.ts");
const compilerOptions = loadCompilerOptions();
const sourceFiles = await collectTypeScriptFiles(sourceDir);
let failed = false;

for (const sourceFile of sourceFiles) {
  const program = ts.createProgram([ambientFile, sourceFile], {
    ...compilerOptions,
    noEmit: true,
    module: ts.ModuleKind.Preserve,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (!diagnostics.length) continue;

  failed = true;
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost()));
}

if (failed) process.exit(1);

function loadCompilerOptions() {
  const configPath = path.join(rootDir, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);

  if (error) throw new Error(ts.formatDiagnosticsWithColorAndContext([error], formatHost()));

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, rootDir);

  if (parsed.errors.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost()));

  return parsed.options;
}

async function collectTypeScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }

  return files.sort();
}

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => "\n",
  };
}
