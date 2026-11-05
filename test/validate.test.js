import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRegistry } from "../src/core/validate.ts";

const live = { version: "v3.3.0", chains: {} };

function unlinked(network) {
  return { network, version: "v3.3.0", previousRegistry: null, chains: {}, abis: {} };
}

const linkErrors = (report) =>
  report.errors.filter((e) => e.path === "previousRegistry.ipfsHash").map((e) => e.message);

for (const [name, input, expected] of [
  [
    "a testnet full snapshot replaces the live chain, with a warning",
    { registry: unlinked("testnet"), liveTip: live, fullSnapshot: true },
    { errors: [], warning: /replaces the published testnet chain/ },
  ],
  [
    "a mainnet full snapshot is refused while a registry is live",
    { registry: unlinked("mainnet"), liveTip: live, fullSnapshot: true },
    { errors: [/would cut off the published mainnet chain/] },
  ],
  [
    "an unlinked layer nobody asked to be a snapshot is an orphan",
    { registry: unlinked("testnet"), liveTip: live, fullSnapshot: false },
    { errors: [/would be an orphan/] },
  ],
  [
    "a full snapshot with nothing live needs no link",
    { registry: unlinked("mainnet"), liveTip: null, fullSnapshot: true },
    { errors: [] },
  ],
]) {
  test(name, () => {
    const report = validateRegistry({ liveChain: null, envChains: {}, ...input });

    const errors = linkErrors(report);
    assert.equal(errors.length, expected.errors.length);
    expected.errors.forEach((pattern, i) => assert.match(errors[i], pattern));
    if (expected.warning) {
      assert.ok(report.warnings.some((w) => expected.warning.test(w.message)));
    }
  });
}
