import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETIRED_FILE,
  allEnvFiles,
  envFilesOf,
  envTreeOf,
  isNetworkConfig,
  registryPointer,
  retirementsOf,
  versionAliasesOf,
} from "../src/core/env.ts";
import { validateEnvFile, validateEnvTree } from "../src/core/env-schema.ts";
import { versionTagCandidates } from "../src/core/versions.ts";

const CONFIG = JSON.stringify({ network: { chainId: 1 } });

/** Builds env/<directory>/ with the given network configs and, optionally, one more file. */
function envWith(directory, networks, extra = {}) {
  const files = {};
  for (const network of networks) files[`${directory}/${network}.json`] = CONFIG;
  for (const [name, content] of Object.entries(extra)) files[`${directory}/${name}`] = content;
  return envTreeOf(files);
}

function validConfig(overrides = {}) {
  return {
    network: {
      chainId: 1,
      environment: "mainnet",
      namespace: "0x926702C7f1af679a8f99A40af8917DDd82fD6F6c",
    },
    contracts: {
      root: {
        address: "0x7Ed48C31f2fdC40d37407cBaBf0870B2b688368f",
        blockNumber: 22924235,
        version: "3",
      },
    },
    ...overrides,
  };
}

test("only network configs count as network configs", () => {
  assert.equal(isNetworkConfig("versions.json"), false);
  assert.equal(isNetworkConfig("connections.json"), false);
  assert.equal(isNetworkConfig("registry.json"), false);
  assert.equal(isNetworkConfig(RETIRED_FILE), false);
  assert.equal(isNetworkConfig("base-sepolia.json"), true);
});

test("a missing pointer means each registry publishes its id-less directory", () => {
  const tree = envTreeOf({ "mainnet/ethereum.json": CONFIG, "testnet/sepolia.json": CONFIG });
  assert.deepEqual(registryPointer(tree), { mainnet: "mainnet", testnet: "testnet" });
});

test("the pointer selects which deployment a registry publishes", () => {
  const tree = envTreeOf({
    "registry.json": JSON.stringify({ testnet: "testnet-rev2" }),
    "mainnet/ethereum.json": CONFIG,
    "testnet/sepolia.json": CONFIG,
    "testnet-rev2/sepolia.json": CONFIG,
    "testnet-rev2/base-sepolia.json": CONFIG,
    "testnet-rev2/connections.json": "{}",
  });

  assert.deepEqual(envFilesOf(tree, "testnet"), [
    "testnet-rev2/base-sepolia.json",
    "testnet-rev2/sepolia.json",
  ]);
  assert.equal(allEnvFiles(tree).length, 4, "every deployment record, published or not");
});

test("the pointer must name an existing directory of the same environment", () => {
  const base = { "mainnet/ethereum.json": CONFIG, "testnet/sepolia.json": CONFIG };
  assert.throws(
    () =>
      registryPointer(
        envTreeOf({ ...base, "registry.json": JSON.stringify({ testnet: "mainnet" }) }),
      ),
    /not a testnet environment/,
  );
  assert.throws(
    () =>
      registryPointer(
        envTreeOf({ ...base, "registry.json": JSON.stringify({ testnet: "testnet-rev9" }) }),
      ),
    /does not exist/,
  );
});

test("a directory without versions.json declares no aliases", () => {
  assert.deepEqual(versionAliasesOf(envWith("testnet", ["sepolia"]), "testnet"), {});
});

test("versionAliasesOf reads the tags table", () => {
  const tree = envWith("testnet-rev2", [], {
    "versions.json": JSON.stringify({ tags: { "v3.3": "v3.3.0-rc2" } }),
  });
  assert.deepEqual(versionAliasesOf(tree, "testnet-rev2"), { "v3.3": "v3.3.0-rc2" });
});

test("versionAliasesOf rejects a malformed file", () => {
  const aliases = (json) =>
    versionAliasesOf(envWith("testnet", [], { "versions.json": json }), "testnet");
  assert.throws(() => aliases("{"), /invalid JSON/);
  assert.throws(
    () => aliases(JSON.stringify({ versions: { "v3.3": "v3.3.0-rc2" } })),
    /unknown key "versions"/,
  );
  assert.throws(() => aliases(JSON.stringify({ tags: { "v3.3": "" } })), /non-empty git tag/);
  assert.throws(
    () => aliases(JSON.stringify({ tags: { "v3.3": "v3.3" } })),
    /point it at the release tag/,
  );
});

test("an alias replaces the candidates rather than heading them", () => {
  assert.deepEqual(versionTagCandidates("v3.3", { "v3.3": "v3.3.0-rc2" }), ["v3.3.0-rc2"]);
});

test("a version the aliases do not name resolves as before", () => {
  const aliases = { "v3.3": "v3.3.0-rc2" };
  assert.deepEqual(versionTagCandidates("v3.1", aliases), ["v3.1", "v3.1.0"]);
  assert.deepEqual(versionTagCandidates("3", aliases), ["3", "v3", "3.0", "v3.0"]);
  assert.deepEqual(versionTagCandidates("v3.1"), ["v3.1", "v3.1.0"]);
});

test("a directory without retired.json declares nothing", () => {
  assert.deepEqual(retirementsOf(envWith("mainnet", ["ethereum"]), "mainnet"), {});
});

test("retirementsOf returns the declarations keyed by network name", () => {
  const declared = {
    ethereum: { "v3.2.0": { endBlock: 25900000, reason: "All pools migrated to v3.3" } },
    base: { "v3.2.0": { endBlock: 41900000 } },
  };
  const tree = envWith("mainnet", ["ethereum", "base", "arbitrum"], {
    [RETIRED_FILE]: JSON.stringify(declared),
  });
  assert.deepEqual(retirementsOf(tree, "mainnet"), declared);
});

test("a retired network that has no config in the directory is an error, never a skip", () => {
  // A typo would otherwise retire nothing and say so only in a log line
  const tree = envWith("mainnet", ["ethereum"], {
    [RETIRED_FILE]: JSON.stringify({ etherium: { "v3.2.0": { endBlock: 1 } } }),
  });
  assert.throws(
    () => retirementsOf(tree, "mainnet"),
    /"etherium" matches no network config in env\/mainnet\/ \(known: ethereum\)/,
  );
});

test("retirementsOf rejects a malformed file", () => {
  const retired = (json) =>
    retirementsOf(envWith("mainnet", ["ethereum"], { [RETIRED_FILE]: json }), "mainnet");
  assert.throws(() => retired("{"), /invalid JSON/);
  assert.throws(() => retired("[]"), /must be a JSON object of network name/);
  assert.throws(
    () => retired(JSON.stringify({ ethereum: 5 })),
    /"ethereum" must be an object of registry version or address/,
  );
});

test("validateEnvFile accepts a well-formed config", () => {
  assert.deepEqual(validateEnvFile("mainnet/ethereum.json", JSON.stringify(validConfig())), []);
});

test("validateEnvFile refuses retirements inside a network config", () => {
  const errors = validateEnvFile(
    "mainnet/ethereum.json",
    JSON.stringify(validConfig({ retired: {} })),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Declare retirements in env\/<environment>\/retired.json/);
});

test("validateEnvFile catches a config filed under the wrong environment", () => {
  const errors = validateEnvFile("testnet/ethereum.json", JSON.stringify(validConfig()));
  assert.match(
    errors.join("\n"),
    /"network.environment" is "mainnet" but the file sits in env\/testnet\//,
  );
});

test("validateEnvFile refuses deployment metadata in a config", () => {
  // The chain's start block is derived from the contracts' blockNumbers, so a deploymentInfo block
  // would be a second source of truth that nothing reads
  const config = validConfig({ deploymentInfo: { "deploy:protocol": { startBlock: 22924200 } } });
  assert.match(
    validateEnvFile("mainnet/ethereum.json", JSON.stringify(config)).join("\n"),
    /Unknown top-level key "deploymentInfo"/,
  );
});

test("validateEnvFile requires every contract to record an integer blockNumber", () => {
  const address = "0x7Ed48C31f2fdC40d37407cBaBf0870B2b688368f";
  for (const [label, root, expected] of [
    ["missing", { address, version: "3" }, /contracts.root.blockNumber: must be an integer/],
    ["a string", { address, blockNumber: "22924235" }, /must be an integer, got "22924235"/],
    ["fractional", { address, blockNumber: 1.5 }, /must be an integer, got 1.5/],
    [
      "a bare address",
      address,
      /contracts.root: must be an object with "address" and "blockNumber"/,
    ],
  ]) {
    const config = validConfig({ contracts: { root } });
    assert.match(
      validateEnvFile("mainnet/ethereum.json", JSON.stringify(config)).join("\n"),
      expected,
      label,
    );
  }
});

test("validateEnvTree reports a malformed retired.json before checking any config", () => {
  const tree = envTreeOf({
    "mainnet/ethereum.json": JSON.stringify(validConfig()),
    "mainnet/retired.json": JSON.stringify({ ethereum: { "v3.2": { endBlock: 1 } } }),
    "testnet/sepolia.json": CONFIG,
  });

  const report = validateEnvTree(tree);

  assert.match(report.fatal, /key must be a published registry version/);
  assert.equal(report.checked, 0);
});

test("validateEnvTree checks every deployment record, published or not", () => {
  const tree = envTreeOf({
    "mainnet/ethereum.json": JSON.stringify(validConfig()),
    "testnet/sepolia.json": JSON.stringify(
      validConfig({ network: { chainId: 11155111, environment: "testnet" } }),
    ),
  });

  const report = validateEnvTree(tree);

  assert.equal(report.fatal, null);
  assert.equal(report.checked, 2);
  assert.deepEqual(
    report.files.map(({ file }) => file),
    ["testnet/sepolia.json"],
    "the testnet config has no namespace",
  );
});
