import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { abiBundles } from "../scripts/abi-bundles.ts";

/** A bucket over a map of key → text that records every key it is asked for. */
function fakeBucket(objects) {
  const fetched = [];
  return {
    fetched,
    objects,
    fetchObject: async (key) => {
      fetched.push(key);
      if (!(key in objects)) throw new Error("The specified key does not exist.");
      return objects[key];
    },
  };
}

const manifest = (commit, artifacts = ["Hub"]) =>
  JSON.stringify({ tag: "v3.3.0", commit, builtAt: "2026-10-01T00:00:00Z", artifacts });

test("a bundle is fetched once and kept while the tag points at the commit it was built from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abis-"));
  const bucket = fakeBucket({
    "abis/v3.3.0/manifest.json": manifest("aaa", ["Hub", "Spoke"]),
    "abis/v3.3.0/Hub.json": '[{"name":"hub"}]',
    "abis/v3.3.0/Spoke.json": '[{"name":"spoke"}]',
  });
  let commit = "aaa";
  const open = () => abiBundles({ dir, tagCommit: () => commit, fetchObject: bucket.fetchObject });

  assert.deepEqual(await open()("v3.3.0", "Hub"), [{ name: "hub" }]);
  assert.deepEqual(await open()("v3.3.0", "Hub"), [{ name: "hub" }]);
  assert.deepEqual(bucket.fetched, ["abis/v3.3.0/manifest.json", "abis/v3.3.0/Hub.json"]);

  // The tag moved and was rebuilt: nothing built from the old commit survives
  commit = "bbb";
  bucket.objects["abis/v3.3.0/manifest.json"] = manifest("bbb", ["Spoke"]);
  assert.equal(await open()("v3.3.0", "Hub"), null);
  assert.equal(existsSync(join(dir, "v3.3.0", "Hub.json")), false);
});

test("a tag without a bundle built from its commit is refused, naming how to build it", async () => {
  for (const [label, objects, expected] of [
    ["no bundle", {}, /Could not read the ABI bundle for v3.3.0 .* key does not exist/],
    [
      "built before the tag moved",
      { "abis/v3.3.0/manifest.json": manifest("aaa") },
      /built from aaa, but the tag points at bbb/,
    ],
  ]) {
    const bucket = fakeBucket(objects);
    const abiAt = abiBundles({
      dir: mkdtempSync(join(tmpdir(), "abis-")),
      tagCommit: () => "bbb",
      fetchObject: bucket.fetchObject,
    });
    await assert.rejects(abiAt("v3.3.0", "Hub"), expected, label);
    await assert.rejects(
      abiAt("v3.3.0", "Hub"),
      /gh workflow run build-abis.yml -R centrifuge\/protocol-internal -f tag=v3.3.0/,
      label,
    );
  }
});

test("an artifact the bundle does not list is missing, without asking R2 for it", async () => {
  const bucket = fakeBucket({ "abis/v3.3.0/manifest.json": manifest("aaa", ["Hub"]) });
  const abiAt = abiBundles({
    dir: mkdtempSync(join(tmpdir(), "abis-")),
    tagCommit: () => "aaa",
    fetchObject: bucket.fetchObject,
  });

  assert.equal(await abiAt("v3.3.0", "StandbyAdapter"), null);
  assert.deepEqual(bucket.fetched, ["abis/v3.3.0/manifest.json"]);
});
