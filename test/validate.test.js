import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRegistry } from "../src/core/validate.ts";
import { layer } from "./helpers.js";

/** A complete live chain base → mid → tip, as collectRegistryChain returns it, with the CIDs it implies. */
function liveChainOf(versions = ["v3.3.0", "v3.3.0", null], extra = {}) {
  const [base, mid, tip] = versions;
  return {
    layers: [
      layer({ version: base, previousRegistry: null }),
      layer({ version: mid, previousCid: "bafybase" }),
      layer({ version: tip, previousCid: "bafymid" }),
    ],
    accumulated: {},
    accumulatedAbis: new Set(),
    complete: true,
    stoppedAt: null,
    reason: null,
    fatal: false,
    ...extra,
  };
}

function unlinked(network) {
  return { network, version: "v3.3.0", previousRegistry: null, chains: {}, abis: {} };
}

const linkErrors = (report) =>
  report.errors.filter((e) => e.path === "previousRegistry.ipfsHash").map((e) => e.message);

for (const [name, input, expected] of [
  [
    "a testnet full snapshot replaces the live chain, with a warning",
    { registry: unlinked("testnet"), liveCid: "bafytip", fullSnapshot: true },
    { errors: [], warning: /replaces the published testnet chain/ },
  ],
  [
    "a mainnet full snapshot is refused while a registry is live",
    { registry: unlinked("mainnet"), liveCid: "bafytip", fullSnapshot: true },
    { errors: [/would cut off the published mainnet chain/] },
  ],
  [
    "an unlinked layer nobody asked to be a snapshot is an orphan",
    { registry: unlinked("testnet"), liveCid: "bafytip", fullSnapshot: false },
    { errors: [/would be an orphan/] },
  ],
  [
    "a full snapshot with nothing live needs no link",
    { registry: unlinked("mainnet"), liveCid: null, fullSnapshot: true },
    { errors: [] },
  ],
]) {
  test(name, () => {
    const report = validateRegistry({ liveChain: liveChainOf(), envChains: {}, ...input });

    const errors = linkErrors(report);
    assert.equal(errors.length, expected.errors.length);
    expected.errors.forEach((pattern, i) => assert.match(errors[i], pattern));
    if (expected.warning) {
      assert.ok(report.warnings.some((w) => expected.warning.test(w.message)));
    }
  });
}

test("a layer links to the live tip, or it would cut the chain", () => {
  const linked = (link) => ({
    network: "mainnet",
    version: "v3.3.0",
    previousRegistry: { version: "v3.3.0", ipfsHash: link },
    chains: {},
    abis: {},
  });
  const partial = liveChainOf(undefined, {
    complete: false,
    reason: "could not fetch bafybase",
  });
  partial.layers = partial.layers.slice(1); // the walk stopped before the base

  for (const [link, liveChain, expected] of [
    ["bafytip", liveChainOf(), []],
    ["bafymid", liveChainOf(), [/1 layer\(s\) below the live tip/]], // orphans the tip
    ["bafybase", liveChainOf(), [/2 layer\(s\) below the live tip/]],
    ["bafyelse", liveChainOf(), [/not in the published mainnet chain/]],
    ["bafybase", partial, [/2 layer\(s\) below the live tip/]], // the layer the walk stopped at
    ["bafyelse", partial, [/Cannot tell whether bafyelse/]],
    ["bafyelse", null, []], // nothing live: there is no chain to cut
  ]) {
    const report = validateRegistry({
      registry: linked(link),
      liveCid: liveChain ? "bafytip" : null,
      liveChain,
      envChains: {},
    });
    const errors = linkErrors(report);
    assert.equal(errors.length, expected.length, `${link}: ${errors.join("\n")}`);
    expected.forEach((pattern, i) => assert.match(errors[i], pattern));
  }
});

test("a version below the live chain's is refused, unless the run asked for a full snapshot", () => {
  const versionErrors = (report) =>
    report.errors.filter((e) => e.path === "version").map((e) => e.message);
  const registry = (version, previousRegistry = { version: "v3.3.0", ipfsHash: "bafytip" }) => ({
    network: "testnet",
    version,
    previousRegistry,
    chains: {},
    abis: {},
  });

  for (const [name, input, expected] of [
    [
      "a lower delta",
      { registry: registry("v3.2.0") },
      [/lower than the live testnet registry's v3.3.0/],
    ],
    ["a lower patch version", { registry: registry("v3.2.9") }, [/lower than/]],
    ["the same version", { registry: registry("v3.3.0") }, []],
    ["a higher version", { registry: registry("v3.4.0") }, []],
    ["a patch layer, which carries no version", { registry: registry(null) }, []],
    [
      "a lower full snapshot the run asked for",
      { registry: registry("v3.2.0", null), fullSnapshot: true },
      [],
    ],
    [
      "a lower delta on a chain that names no version",
      { registry: registry("v3.2.0"), liveChain: liveChainOf([null, null, null]) },
      [],
    ],
    ["a lower delta with nothing live", { registry: registry("v3.2.0"), liveCid: null }, []],
  ]) {
    // The live tip is a patch: the version compared against is the newest one the chain names
    const report = validateRegistry({
      liveCid: "bafytip",
      liveChain: liveChainOf(["v3.2.0", "v3.3.0", null]),
      envChains: {},
      ...input,
    });
    const errors = versionErrors(report);
    assert.equal(errors.length, expected.length, `${name}: ${errors.join("\n")}`);
    expected.forEach((pattern, i) => assert.match(errors[i], pattern));
  }
});
