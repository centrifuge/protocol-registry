import { test } from "node:test";
import assert from "node:assert/strict";

import { envTreeOf } from "../src/core/env.ts";
import { generateRegistry, RefusedError } from "../src/core/generate.ts";
import { layer } from "./helpers.js";

const NAMESPACE = "0x926702C7f1af679a8f99A40af8917DDd82fD6F6c";
const HUB = "0x0000000000000000000000000000000000000001";
const SPOKE = "0x0000000000000000000000000000000000000002";

const silent = { info() {}, warn() {}, error() {} };
const deps = { log: silent, tagExists: async () => true, abiAt: async () => [] };

function envOf(contracts) {
  return envTreeOf({
    "mainnet/ethereum.json": JSON.stringify({
      network: { chainId: 1, environment: "mainnet", namespace: NAMESPACE },
      contracts,
    }),
    "testnet/sepolia.json": JSON.stringify({
      network: { chainId: 11155111, environment: "testnet", namespace: NAMESPACE },
    }),
  });
}

test("a chain starts at the earliest block env records, not the earliest the layer carries", async () => {
  const published = layer({
    version: "v3.3.0",
    chains: { 1: { contracts: { hub: { address: HUB, blockNumber: 100, txHash: null } } } },
  });
  published.abis = { Hub: [] };
  const env = envOf({
    hub: { address: HUB, blockNumber: 100, version: "v3.3.0" },
    spoke: { address: SPOKE, blockNumber: 200, version: "v3.3.0" },
  });

  const { registry } = await generateRegistry(
    {
      network: "mainnet",
      env,
      tip: { cid: "bafytip", layer: published },
      fetchLayer: async () => null,
      mode: "delta",
    },
    deps,
  );

  assert.deepEqual(Object.keys(registry.chains[1].contracts), ["spoke"]);
  assert.deepEqual(registry.chains[1].deployment, { startBlock: 100 });
  assert.equal("deploymentInfo" in registry, false);
});

test("a contract env records without a block number refuses generation", async () => {
  const env = envOf({
    hub: { address: HUB, blockNumber: 100, version: "v3.3.0" },
    spoke: { address: SPOKE, version: "v3.3.0" },
  });

  await assert.rejects(
    generateRegistry(
      { network: "mainnet", env, tip: null, fetchLayer: async () => null, mode: "full" },
      deps,
    ),
    (error) =>
      error instanceof RefusedError && /spoke has no numeric blockNumber/.test(error.message),
  );
});

// Layers written since protocol-internal#430 carry no deploymentInfo, so a null-version patch tip
// names no version at all
function withoutDeploymentInfo(doc) {
  delete doc.deploymentInfo;
  return doc;
}

for (const [mode, link] of [
  ["delta", { version: "v3.3.0", ipfsHash: "bafytip" }],
  ["patch", { version: "v3.3.0", ipfsHash: "bafytip" }],
  ["full", null],
]) {
  test(`a ${mode} layer on a null-version patch tip links ${link ? "to its CID" : "to nothing"}`, async () => {
    const base = withoutDeploymentInfo(
      layer({
        version: "v3.3.0",
        previousRegistry: null,
        chains: { 1: { contracts: { hub: { address: HUB, blockNumber: 100, txHash: null } } } },
      }),
    );
    base.abis = { Hub: [] };
    const tip = withoutDeploymentInfo(
      layer({ version: null, previousCid: "bafybase", previousVersion: "v3.3.0", chains: {} }),
    );
    const env = envOf({
      hub: { address: HUB, blockNumber: 100, version: "v3.3.0" },
      spoke: { address: SPOKE, blockNumber: 200, version: "v3.3.0" },
    });

    const { registry } = await generateRegistry(
      {
        network: "mainnet",
        env,
        tip: { cid: "bafytip", layer: tip },
        fetchLayer: async (cid) => (cid === "bafybase" ? base : null),
        mode,
      },
      deps,
    );

    assert.deepEqual(registry.previousRegistry, link);
  });
}
