#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const [target = "esm", sourcePath, destinationPath] = process.argv.slice(2);

if (!sourcePath || !destinationPath) {
  throw new Error("Usage: write-metadata.mjs <esm|legacy> <source> <destination>");
}

const source = JSON.parse(await fs.readFile(path.resolve(sourcePath), "utf8"));

source["shell-version"] = target === "legacy" ? ["40", "41", "42", "43", "44"] : ["45", "46", "47", "48", "49"];

await fs.mkdir(path.dirname(path.resolve(destinationPath)), { recursive: true });
await fs.writeFile(path.resolve(destinationPath), `${JSON.stringify(source, null, 2)}\n`);
