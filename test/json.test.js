import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJson } from "../src/core/json.ts";

const SELECTOR = "5009297550715157269";

test("parseJson keeps an integer above 2^53 exact through stringify", () => {
  const parsed = parseJson(`{"chainSelector":${SELECTOR}}`);

  assert.equal(JSON.stringify(parsed), `{"chainSelector":${SELECTOR}}`);
});

test("parseJson refuses to run without JSON.rawJSON rather than round integers", () => {
  const original = JSON.rawJSON;
  JSON.rawJSON = undefined;
  try {
    assert.throws(() => parseJson(`{"chainSelector":${SELECTOR}}`), /source text/);
  } finally {
    JSON.rawJSON = original;
  }
});

test("parseJson refuses to run when JSON.parse drops the reviver's source text", () => {
  const original = JSON.parse;
  JSON.parse = (text, reviver) => original(text, reviver && ((key, value) => reviver(key, value)));
  try {
    assert.throws(() => parseJson(`{"chainSelector":${SELECTOR}}`), /source text/);
  } finally {
    JSON.parse = original;
  }
});
