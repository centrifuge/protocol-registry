/**
 * Turns a Forge build of protocol-internal at one tag into the ABI bundle the Worker reads:
 * `<out>/<Artifact>.json` per artifact plus `<out>/manifest.json` (see src/io/abis.ts).
 *
 *     node scripts/build-abi-bundle.ts <protocol-internal checkout> <tag> <commit> <out dir>
 *
 * Artifacts are taken from `out/` and then `out-ir/` (the `ir` profile, e.g. OnchainPM), each in
 * sorted directory order, skipping test sources. When two sources define an artifact of the same name
 * the first one wins: the order the generator this replaces looked them up in.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, tag, commit, outDir] = process.argv.slice(2);
if (!root || !tag || !commit || !outDir) {
  console.error("usage: node scripts/build-abi-bundle.ts <checkout> <tag> <commit> <out dir>");
  process.exit(2);
}

const abis = new Map<string, unknown[]>();
for (const buildDir of ["out", "out-ir"]) {
  const base = join(root, buildDir);
  if (!existsSync(base)) continue;
  for (const sourceDir of readdirSync(base).sort()) {
    if (sourceDir.endsWith(".t.sol") || sourceDir === "build-info") continue;
    const dir = join(base, sourceDir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
      continue; // not a directory
    }
    for (const file of files.sort()) {
      const name = file.slice(0, -".json".length);
      if (abis.has(name)) continue;
      const artifact = JSON.parse(readFileSync(join(dir, file), "utf8")) as { abi?: unknown };
      if (Array.isArray(artifact.abi)) abis.set(name, artifact.abi);
    }
  }
}

if (abis.size === 0) {
  console.error(`No artifacts under ${root}/out: was forge build run?`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [name, abi] of abis) {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(abi));
}
const manifest = { tag, commit, builtAt: new Date().toISOString(), artifacts: [...abis.keys()] };
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${abis.size} artifacts for ${tag} (${commit}) in ${outDir}`);
