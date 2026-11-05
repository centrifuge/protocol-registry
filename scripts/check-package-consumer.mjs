/**
 * The assertions of the package smoke check (`check-package.ts`). It runs from the directory the
 * packed tarball was installed into, with the layer fixtures' directory and the JSON list of files
 * `dist` must hold as its arguments.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

import * as registry from "@centrifuge/registry-core";

const PACKAGE_DIR = join(process.cwd(), "node_modules", "@centrifuge", "registry-core");

const EXPORTED_VALUES = [
  "DEFAULT_MAX_DEPTH",
  "LayerVerificationError",
  "NETWORKS",
  "chainAddressHistory",
  "collectRegistryChain",
  "describeLayer",
  "diffAddressHistories",
  "flattenRegistryAbis",
  "flattenRegistryChain",
  "flattenRetired",
  "isAncestor",
  "isRegistryDocument",
  "layerFromBytes",
  "slimLayer",
  "verifyLayer",
];

// An import or export specifier that still names a TypeScript source file.
const TS_SPECIFIER = /\b(?:from|import)\s*\(?\s*["'][^"'\n]*\.[cm]?ts["']/;
// Above 2^53 no double holds the integer, so only the source text keeps its digits.
const UNSAFE_CHAIN_SELECTOR = /"chainSelector":\s*(\d{17,})/g;

function unsafeChainSelectors(text) {
  return [...text.matchAll(UNSAFE_CHAIN_SELECTOR)].map((match) => match[1]);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

function loadFixture(fixturesDir, name) {
  const cid = name.replace(/\.json\.gz$/, "");
  return { cid, bytes: new Uint8Array(gunzipSync(readFileSync(join(fixturesDir, name)))) };
}

function flipByte(bytes, offset) {
  const tampered = new Uint8Array(bytes);
  tampered[offset] ^= 0x01;
  return tampered;
}

async function assertRefused({ cid, bytes }) {
  await assert.rejects(
    () => registry.verifyLayer(cid, flipByte(bytes, 10)),
    (error) => error instanceof registry.LayerVerificationError && error.cid === cid,
  );
}

const [fixturesDir, expectedDistJson] = process.argv.slice(2);
const expectedDistFiles = JSON.parse(expectedDistJson);
const names = readdirSync(fixturesDir).sort();
const rawName = names.find(
  (name) =>
    name.startsWith("bafkrei") &&
    unsafeChainSelectors(gunzipSync(readFileSync(join(fixturesDir, name))).toString()).length > 0,
);
const dagPbName = names.find((name) => name.startsWith("bafybei"));
assert.ok(rawName, "no raw fixture carries a chainSelector above 2^53");
assert.ok(dagPbName, "no dag-pb fixture");

assert.deepEqual(Object.keys(registry).sort(), EXPORTED_VALUES);
// CommonJS callers load the ES module with require (Node 22.12 and later).
const required = createRequire(import.meta.url)("@centrifuge/registry-core");
assert.deepEqual(Object.keys(required).sort(), EXPORTED_VALUES);

assert.deepEqual(readdirSync(PACKAGE_DIR).sort(), ["LICENSE", "dist", "package.json"]);
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
assert.deepEqual(Object.keys(manifest.dependencies), ["multiformats"]);
const distDir = join(PACKAGE_DIR, "dist");
const shipped = filesUnder(distDir);
assert.deepEqual(shipped.map((file) => relative(distDir, file)).sort(), expectedDistFiles);
for (const file of shipped.filter((name) => /\.(js|d\.ts)$/.test(name))) {
  assert.doesNotMatch(readFileSync(file, "utf8"), TS_SPECIFIER, `${file} imports a .ts file`);
}

const raw = loadFixture(fixturesDir, rawName);
const dagPb = loadFixture(fixturesDir, dagPbName);
await registry.verifyLayer(raw.cid, raw.bytes);
await registry.verifyLayer(dagPb.cid, dagPb.bytes);
await assertRefused(raw);
await assertRefused(dagPb);

const text = new TextDecoder().decode(raw.bytes);
const selectors = unsafeChainSelectors(text);
const layer = await registry.layerFromBytes(raw.cid, raw.bytes);
const rewritten = JSON.stringify(layer);
for (const digits of selectors) {
  assert.ok(rewritten.includes(`"chainSelector":${digits}`), `chainSelector ${digits} changed`);
}

console.log(
  `registry-core smoke ok: ${Object.keys(registry).length} exports, ${shipped.length} files shipped, ` +
    `raw ${raw.cid} and dag-pb ${dagPb.cid} verified, ${selectors.length} chain selectors intact`,
);
