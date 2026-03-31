#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const rootDir = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(rootDir, "ts", "extension");
const staticDir = path.join(rootDir, "extension");
const distDir = path.join(rootDir, "dist");
const compilerOptions = loadCompilerOptions();

if (process.argv.includes("--clean")) {
  await fs.rm(distDir, { recursive: true, force: true });
  process.exit(0);
}

await fs.rm(distDir, { recursive: true, force: true });
await copyStaticExtensionFiles(staticDir, distDir);

const sourceFiles = await collectTypeScriptFiles(sourceDir);

for (const sourceFile of sourceFiles) {
  const sourceText = await fs.readFile(sourceFile, "utf8");
  const result = ts.transpileModule(sourceText, {
    compilerOptions,
    fileName: sourceFile,
    reportDiagnostics: true,
  });

  if (result.diagnostics?.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, formatHost()));

  const relativePath = path.relative(sourceDir, sourceFile);
  const outputFile = path.join(distDir, relativePath.replace(/\.ts$/, ".js"));
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, result.outputText);

  if (sourceText.startsWith("#!")) await fs.chmod(outputFile, 0o755);
}

async function copyStaticExtensionFiles(sourcePath, destinationPath) {
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  await fs.mkdir(destinationPath, { recursive: true });

  for (const entry of entries) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);

    if (entry.isDirectory()) {
      await copyStaticExtensionFiles(sourceEntry, destinationEntry);
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".js")) continue;
    if (entry.name === "gschemas.compiled") continue;

    await fs.copyFile(sourceEntry, destinationEntry);
  }
}

function loadCompilerOptions() {
  const configPath = path.join(rootDir, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);

  if (error) throw new Error(ts.formatDiagnosticsWithColorAndContext([error], formatHost()));

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, rootDir);

  if (parsed.errors.length)
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost()));

  return {
    ...parsed.options,
    module: ts.ModuleKind.Preserve,
  };
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
