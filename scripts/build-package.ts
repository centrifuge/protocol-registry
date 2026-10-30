/**
 * Builds `@centrifuge/registry-core` into `packages/registry-core/dist`: the JavaScript and
 * declarations of `src/core/index.ts` and what it imports, and the repository's LICENSE beside the
 * manifest, which declares it.
 *
 * `tsc` rewrites `.ts` import specifiers in the JavaScript it emits but leaves them in the `.d.ts`
 * files, so they are rewritten here: a consumer's TypeScript then finds `./chain.d.ts` from
 * `./chain.js` under any module resolution.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const packageDir = join(repoRoot, "packages", "registry-core");
const distDir = join(packageDir, "dist");
// A relative specifier after `from`, `import(` or `import`, as a declaration file writes it.
const RELATIVE_TS_SPECIFIER = /(\b(?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]*)\.ts\2/g;

// A file removed from src/core must not linger in dist and be published.
rmSync(distDir, { recursive: true, force: true });

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(packageDir, "tsconfig.json")], {
  stdio: "inherit",
});

const declarations = readdirSync(distDir, { recursive: true, encoding: "utf8" }).filter((name) =>
  name.endsWith(".d.ts"),
);
for (const name of declarations) {
  const path = join(distDir, name);
  writeFileSync(path, readFileSync(path, "utf8").replace(RELATIVE_TS_SPECIFIER, "$1$2$3.js$2"));
}

copyFileSync(join(repoRoot, "LICENSE"), join(packageDir, "LICENSE"));
