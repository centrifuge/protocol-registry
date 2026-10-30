/**
 * Smoke check for `@centrifuge/registry-core`: builds the package, packs it, installs the tarball
 * into a fresh directory outside the repository and runs `check-package-consumer.mjs` there, so
 * what is asserted is what a consumer receives, not what the repository holds.
 *
 * Also compiles a small consumer against the packed declarations under the module resolutions
 * consumers use. Needs the network (npm installs the package's dependencies). Its temporary
 * directory is removed afterwards unless `KEEP_SMOKE_DIR` is set, for debugging a failure.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { readCoreImports } from "./core-imports.ts";

const repoRoot = join(import.meta.dirname, "..");
const packageDir = join(repoRoot, "packages", "registry-core");
const coreDir = join(repoRoot, "src", "core");

// node10 resolution ignores exports and finds the types through types; the other two read exports.
const TYPE_CHECKS = [
  { module: "esnext", moduleResolution: "bundler" },
  { module: "nodenext", moduleResolution: "nodenext" },
  { module: "commonjs", moduleResolution: "node10" },
];

const CONSUMER_SOURCE = `import {
  LayerVerificationError,
  NETWORKS,
  collectRegistryChain,
  isAncestor,
  layerFromBytes,
} from "@centrifuge/registry-core";
import type { CollectedChain, FetchLayer, Layer, Network } from "@centrifuge/registry-core";

const fetchLayer: FetchLayer = async (cid) => layerFromBytes(cid, new Uint8Array());

export function walk(tip: Layer): Promise<CollectedChain> {
  return collectRegistryChain(tip, { fetchLayer });
}
export const check = (head: string, ancestor: string): Promise<boolean> =>
  isAncestor(head, ancestor, fetchLayer);
export const networks: readonly Network[] = NETWORKS;
export const refused = (error: unknown): boolean => error instanceof LayerVerificationError;
`;

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** The files `tsc` emits for the modules the entry point reaches, relative to `dist`. */
function expectedDistFiles(): string[] {
  const { files } = readCoreImports(join(coreDir, "index.ts"));
  return files
    .flatMap((file) => {
      const module = relative(coreDir, file).replace(/\.ts$/, "");
      return [`${module}.js`, `${module}.d.ts`];
    })
    .sort();
}

function compileConsumer(consumerDir: string): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  writeFileSync(join(consumerDir, "use.ts"), CONSUMER_SOURCE);
  for (const { module, moduleResolution } of TYPE_CHECKS) {
    console.log(`compiling a consumer with module ${module}, moduleResolution ${moduleResolution}`);
    // Only the es2023 lib, no DOM and no @types/node: the declarations need nothing more.
    run(
      process.execPath,
      [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "es2023"]
        .concat(["--lib", "es2023", "--module", module, "--moduleResolution", moduleResolution])
        .concat(["--ignoreDeprecations", "6.0", "use.ts"]),
      consumerDir,
    );
  }
}

function smoke(workDir: string): void {
  const packDir = join(workDir, "pack");
  const consumerDir = join(workDir, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumerDir);

  run("pnpm", ["pack", "--pack-destination", packDir], packageDir);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected one tarball in ${packDir}, found ${tarballs}`);
  }

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "registry-core-smoke", private: true, type: "module" }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", join(packDir, tarballs[0]!)], consumerDir);

  compileConsumer(consumerDir);

  // The file is copied in so its bare import resolves from the consumer's node_modules.
  copyFileSync(
    join(repoRoot, "scripts", "check-package-consumer.mjs"),
    join(consumerDir, "check.mjs"),
  );
  run(
    process.execPath,
    [
      "check.mjs",
      join(repoRoot, "test", "fixtures", "layers"),
      JSON.stringify(expectedDistFiles()),
    ],
    consumerDir,
  );
}

run("pnpm", ["build:package"], repoRoot);

const workDir = mkdtempSync(join(tmpdir(), "registry-core-smoke-"));
try {
  smoke(workDir);
} finally {
  if (process.env.KEEP_SMOKE_DIR) console.log(`kept ${workDir}`);
  else rmSync(workDir, { recursive: true, force: true });
}
