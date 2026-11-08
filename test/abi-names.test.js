import { test } from "node:test";
import assert from "node:assert/strict";

import { artifactNamesForContractKey } from "../src/core/abi-names.ts";

// protocol's own test checks that every alias names a contract its source declares
test("a standby key resolves to StandbyAdapter, its underlying key to the adapter it wraps", () => {
  for (const adapter of ["LayerZero", "Axelar", "Chainlink", "Hyperlane"]) {
    const key = adapter.charAt(0).toLowerCase() + adapter.slice(1);
    assert.deepEqual(artifactNamesForContractKey(`${key}Standby`), ["StandbyAdapter"]);
    assert.deepEqual(artifactNamesForContractKey(`${key}StandbyUnderlying`), [`${adapter}Adapter`]);
  }
});
