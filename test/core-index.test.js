import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as core from "../src/core/index.ts";

const VALUES = [
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

const TYPES = [
  "AccumulatedChain",
  "AccumulatedState",
  "AddressHistory",
  "AddressHistoryDiff",
  "AddressSummary",
  "AddressRecord",
  "CollectOptions",
  "CollectedChain",
  "ContractEntry",
  "FetchLayer",
  "IsAncestorOptions",
  "Layer",
  "LayerChain",
  "Network",
  "RetiredByChain",
  "RetiredEntry",
];

test("the core entry point exports exactly the public values", () => {
  assert.deepEqual(Object.keys(core).sort(), VALUES);
});

test("the core entry point exports exactly the public values and types, however declared", () => {
  // Types are erased at runtime, so the checker lists the module's exports in every export form.
  const entry = fileURLToPath(new URL("../src/core/index.ts", import.meta.url));
  const program = ts.createProgram([entry], {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2023,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const names = checker.getExportsOfModule(symbol).map(({ name }) => name);

  assert.deepEqual(names.sort(), [...VALUES, ...TYPES].sort());
});

test("the entry point re-exports the Worker's functions rather than copies", async () => {
  const chain = await import("../src/core/chain.ts");
  assert.equal(core.collectRegistryChain, chain.collectRegistryChain);
  assert.equal(core.slimLayer, chain.slimLayer);
});

test("the entry point exports the class verifyLayer throws", async () => {
  await assert.rejects(() => core.verifyLayer("x", new Uint8Array()), core.LayerVerificationError);
});
