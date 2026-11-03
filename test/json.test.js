import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJson } from "../src/core/json.ts";
import { LayerVerificationError } from "../src/core/layer-verification-error.ts";
import { layerFromBytes } from "../src/core/verify.ts";
import { MAINNET_HEAD, realLayerBytes } from "./helpers.js";

const RUNTIMES_WITHOUT_SOURCE_TEXT = [
  ["JSON.rawJSON is missing", "rawJSON", () => undefined],
  [
    "JSON.parse drops the reviver's source text",
    "parse",
    (parse) => (text, reviver) => parse(text, reviver && ((key, value) => reviver(key, value))),
  ],
];

for (const [name, property, replace] of RUNTIMES_WITHOUT_SOURCE_TEXT) {
  test(`parseJson and layerFromBytes refuse to run when ${name}, with a plain error`, async () => {
    const original = JSON[property];
    JSON[property] = replace(original);
    try {
      assert.throws(() => parseJson("1"), /source text/);
      await assert.rejects(
        () => layerFromBytes(MAINNET_HEAD, realLayerBytes(MAINNET_HEAD)),
        (error) => !(error instanceof LayerVerificationError) && /source text/.test(error.message),
      );
    } finally {
      JSON[property] = original;
    }
  });
}
