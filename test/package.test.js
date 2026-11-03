import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import { readCoreImports } from "../scripts/core-imports.ts";

const ENTRY = fileURLToPath(new URL("../src/core/index.ts", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

/** "multiformats/cid" is the package "multiformats"; "@scope/name/sub" is "@scope/name". */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const isBuiltin = (specifier) =>
  specifier.startsWith("node:") || builtinModules.includes(packageName(specifier));

const { specifiers } = readCoreImports(ENTRY);

test("the package depends on exactly the packages the core imports, at the root's pins", () => {
  const root = readJson("../package.json");
  const published = readJson("../packages/registry-core/package.json");
  const rootPins = { ...root.devDependencies, ...root.dependencies };

  const imported = [...new Set(specifiers.map(packageName))].sort();
  const expected = Object.fromEntries(imported.map((name) => [name, rootPins[name]]));

  assert.deepEqual(published.dependencies, expected);
  for (const [name, pin] of Object.entries(expected)) {
    assert.match(pin, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, got ${pin}`);
  }
});

test("the core imports no Node built-in, so it runs wherever the caller's runtime does", () => {
  assert.deepEqual(specifiers.filter(isBuiltin), []);
});
