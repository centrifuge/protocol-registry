import { test } from "node:test";
import assert from "node:assert/strict";

import { envTreeOf } from "../src/core/env.ts";
import { RefusedError } from "../src/core/generate.ts";
import { unixfsFileRoot } from "../src/core/verify.ts";
import { versionTagErrors } from "../src/core/version-tags.ts";
import { appJwt, verifyWebhookSignature } from "../src/io/github.ts";
import { dnslinkCid } from "../src/io/publish.ts";
import { manualParams } from "../src/manual-run.ts";
import { hostnameReport, publishCheck, publishLines, toPublish } from "../src/report.ts";
import {
  checkHostname,
  generateNetwork,
  HostnameDriftError,
  PinMismatchError,
  pinNetwork,
  pointHostname,
  publishMode,
  TipMovedError,
} from "../src/run.ts";
import { route, touchesRegistryInputs } from "../src/webhook.ts";
import {
  MAINNET_HEAD,
  MAINNET_HEAD_PARENT,
  fakeFetch,
  flipByte,
  realLayerBytes,
} from "./helpers.js";

const config = { sourceRepo: "centrifuge/protocol-internal", sourceBranch: "live-v3.3" };
const repository = { full_name: config.sourceRepo };

function push(paths, extra = {}) {
  return {
    repository,
    ref: "refs/heads/live-v3.3",
    after: "abcdef1234567890",
    pusher: { name: "dev" },
    commits: [{ added: [], modified: paths, removed: [] }],
    ...extra,
  };
}

test("a push to the source branch that touches env/ publishes", () => {
  assert.deepEqual(route("push", push(["env/mainnet/ethereum.json"]), config), {
    type: "publish",
    sha: "abcdef1234567890",
    reason: "push of abcdef123 by dev",
  });
});

test("pushes that cannot change the registry are ignored", () => {
  assert.equal(route("push", push(["src/core/Hub.sol"]), config).type, "ignore");
  assert.equal(route("push", push(["env/connections_viewer.html"]), config).type, "ignore");
  assert.equal(
    route("push", push(["env/mainnet/ethereum.json"], { ref: "refs/heads/main" }), config).type,
    "ignore",
  );
  assert.equal(
    route("push", { ...push(["env/x.json"]), repository: { full_name: "someone/fork" } }, config)
      .type,
    "ignore",
  );
});

test("a push GitHub lists no commits for still publishes", () => {
  // A force push back to an older commit can change env without a commit in the payload
  assert.equal(route("push", push([], { commits: [] }), config).type, "publish");
});

test("a pull request into the source branch is previewed on its head", () => {
  const payload = {
    repository,
    action: "synchronize",
    pull_request: { number: 7, base: { ref: "live-v3.3" }, head: { sha: "headsha" } },
  };
  assert.deepEqual(route("pull_request", payload, config), {
    type: "preview",
    pr: 7,
    headSha: "headsha",
  });
  assert.equal(route("pull_request", { ...payload, action: "closed" }, config).type, "ignore");
  assert.equal(
    route(
      "pull_request",
      { ...payload, pull_request: { ...payload.pull_request, base: { ref: "main" } } },
      config,
    ).type,
    "ignore",
  );
});

test("re-requesting the check previews the PR again", () => {
  const payload = {
    repository,
    action: "rerequested",
    check_run: {
      name: "Registry preview",
      head_sha: "h",
      pull_requests: [{ number: 9, base: { ref: "live-v3.3" } }],
    },
  };
  assert.deepEqual(route("check_run", payload, config), { type: "preview", pr: 9, headSha: "h" });
});

test("only paths under env/ that feed the registry count as registry changes", () => {
  assert.equal(touchesRegistryInputs("env/mainnet/ethereum.json"), true);
  assert.equal(touchesRegistryInputs("env/mainnet/retired.json"), true);
  assert.equal(touchesRegistryInputs("env/registry.json"), true);
  assert.equal(touchesRegistryInputs("env/connections_viewer.html"), false);
  assert.equal(touchesRegistryInputs("src/core/hub/Hub.sol"), false);
  assert.equal(touchesRegistryInputs("environment.md"), false);
});

test("a tag being created starts nothing: protocol builds its ABIs on push", () => {
  const payload = { repository, ref_type: "tag", ref: "v3.3.0" };
  assert.equal(route("create", payload, config).type, "ignore");
});

async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("webhook signatures verify only with the right secret and body", async () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const signature = await sign("secret", body);

  assert.equal(await verifyWebhookSignature("secret", body, signature), true);
  assert.equal(await verifyWebhookSignature("other", body, signature), false);
  assert.equal(await verifyWebhookSignature("secret", `${body} `, signature), false);
  assert.equal(await verifyWebhookSignature("secret", body, null), false);
  assert.equal(await verifyWebhookSignature("secret", body, "sha256=zz"), false);
});

test("the App JWT is RS256-signed by the App key and expires within ten minutes", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;

  const jwt = await appJwt("12345", pem, 1_700_000_000_000);
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.equal(claims.iss, "12345");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  await assert.rejects(
    () => appJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    /PKCS#1/,
  );
});

test("versionTagErrors resolves each version through its directory's aliases", async () => {
  const tree = (files) =>
    envTreeOf({
      "testnet/sepolia.json": JSON.stringify({
        network: { chainId: 11155111, environment: "testnet" },
        contracts: {
          hub: { address: "0x0000000000000000000000000000000000000001", version: "v3.3" },
        },
      }),
      ...files,
    });
  const deps = { tagExists: async (tag) => ["v3.3.0-rc4", "v3.2.0"].includes(tag) };
  const aliases = (tags) => ({ "testnet/versions.json": JSON.stringify({ tags }) });

  assert.deepEqual(await versionTagErrors(tree(aliases({ "v3.3": "v3.3.0-rc4" })), deps), []);
  assert.match(
    (await versionTagErrors(tree(aliases({ "v3.3": "v3.3.0-rc4", "v3.9": "v3.2.0" })), deps)).join(
      "\n",
    ),
    /"tags.v3.9" .* redirects nothing/,
  );
  assert.match((await versionTagErrors(tree({}), deps)).join("\n"), /version "v3.3" → no git tag/);
});

function fakeGateway(initial) {
  const state = { cid: initial, sets: [] };
  return {
    state,
    currentCid: async () => state.cid,
    setCid: async (_hostname, cid) => {
      state.sets.push(cid);
      state.cid = cid;
    },
  };
}

const hostnames = { mainnet: "registry.centrifuge.io", testnet: "registry.testnet.centrifuge.io" };

/** The Publisher's hostname records, in memory: network → the CID last pointed at. */
function fakeRecords(cids = {}) {
  const state = new Map(
    Object.entries(cids).map(([network, cid]) => [network, { cid, how: "published", at: 0 }]),
  );
  return {
    get: async (network) => state.get(network) ?? null,
    put: async (network, record) => {
      state.set(network, record);
    },
  };
}

/** A run's config as the hostname steps see it: the hostname serves `liveCid`. */
function hostnameConfig(liveCid, recorded = {}) {
  const silent = { info() {}, warn() {}, error() {} };
  return {
    gateway: fakeGateway(liveCid),
    hostnames,
    hostnameRecords: fakeRecords(recorded),
    log: silent,
  };
}

const recordedCid = async (config) => (await config.hostnameRecords.get("mainnet"))?.cid ?? null;

test("pointHostname swaps the dnslink when the tip is the one the layer was generated against, and records it", async () => {
  const config = hostnameConfig("tip", { mainnet: "tip" });
  await pointHostname(config, { network: "mainnet", liveCid: "tip" }, "new");
  assert.deepEqual(config.gateway.state.sets, ["new"]);
  assert.equal(await recordedCid(config), "new");
});

test("pointHostname refuses when something else published in between", async () => {
  // Swapping anyway would orphan the other publish: its layer would no longer be in the chain
  const config = hostnameConfig("someone-else", { mainnet: "tip" });
  await assert.rejects(
    () => pointHostname(config, { network: "mainnet", liveCid: "tip" }, "new"),
    TipMovedError,
  );
  assert.deepEqual(config.gateway.state.sets, []);
});

test("pointHostname only records the CID on a retry after the swap landed", async () => {
  const config = hostnameConfig("new", { mainnet: "tip" });
  await pointHostname(config, { network: "mainnet", liveCid: "tip" }, "new");
  assert.deepEqual(config.gateway.state.sets, []);
  assert.equal(await recordedCid(config), "new");
});

test("a publish run refuses and alerts when a hostname serves a CID the Worker did not publish", async () => {
  // Someone holding the Web3 token pointed mainnet at their own layer
  const config = hostnameConfig("foreign", { mainnet: "published" });

  const check = await checkHostname(config, "mainnet", { mode: "live" });
  assert.match(check.drift, /serves foreign, not published/);
  assert.ok(hostnameReport([check], hostnames).includes(check.drift));

  // The layer generated on it does not publish; testnet, unaffected, still does
  const mainnet = {
    network: "mainnet",
    liveCid: "foreign",
    publishable: true,
    validation: { errors: [] },
    hostnameDrift: check.drift,
  };
  const testnet = { network: "testnet", publishable: true, validation: { errors: [] } };
  assert.deepEqual(
    toPublish([mainnet, testnet]).map((o) => o.network),
    ["testnet"],
  );

  // And the swap itself refuses it, for a run that checked before the hostname changed
  await assert.rejects(() => pointHostname(config, mainnet, "new"), HostnameDriftError);
  assert.deepEqual(config.gateway.state.sets, []);
  assert.equal(await recordedCid(config), "published");
});

test("acceptLiveCid accepts the CID the hostname serves, in a publish run only", async () => {
  // An operator pointed mainnet back at an earlier layer by hand
  const config = hostnameConfig("rollback", { mainnet: "bad" });

  for (const options of [
    { mode: null, acceptLiveCid: "rollback" }, // a preview reports, and writes nothing
    { mode: "live", acceptLiveCid: "other" }, // the hostname moved since the operator looked
  ]) {
    assert.ok((await checkHostname(config, "mainnet", options)).drift);
    assert.equal(await recordedCid(config), "bad");
  }

  const accepted = await checkHostname(config, "mainnet", {
    mode: "live",
    acceptLiveCid: "rollback",
  });
  assert.deepEqual([accepted.drift, accepted.recorded], [null, "accepted"]);
  await pointHostname(config, { network: "mainnet", liveCid: "rollback" }, "fix");
  assert.deepEqual(config.gateway.state.sets, ["fix"]);
});

test("a swap the Worker made counts as its own, even when its run stopped before seeing it land", async () => {
  const config = hostnameConfig("tip", { mainnet: "tip" });
  const { setCid } = config.gateway;
  config.gateway.setCid = async (hostname, cid) => {
    await setCid(hostname, cid);
    throw new Error("timed out");
  };
  await assert.rejects(
    () => pointHostname(config, { network: "mainnet", liveCid: "tip" }, "new"),
    /timed out/,
  );

  // A preview meanwhile sees no drift and writes nothing; the next publish run records the swap
  assert.equal((await checkHostname(config, "mainnet", { mode: null })).drift, null);
  assert.equal(await recordedCid(config), "tip");
  assert.equal((await checkHostname(config, "mainnet", { mode: "pin" })).drift, null);
  assert.equal(await recordedCid(config), "new");
});

test("with no record yet, only a live publish run records what the hostname serves", async () => {
  for (const [mode, recorded] of [
    ["live", "seeded"],
    ["pin", null],
    ["shadow", null],
    [null, null],
  ]) {
    const config = hostnameConfig("tip");
    const check = await checkHostname(config, "mainnet", { mode });
    assert.deepEqual([check.drift, check.recorded], [null, recorded], `mode ${mode}`);
    assert.equal(await recordedCid(config), recorded && "tip");
  }
});

test("publishing stays in shadow unless PUBLISH_MODE says otherwise and the credentials are there", () => {
  const none = { pinataJwt: null, gateway: null };
  const pinOnly = { pinataJwt: "jwt", gateway: null };
  const both = { pinataJwt: "jwt", gateway: fakeGateway("tip") };

  assert.equal(publishMode(undefined, both), "shadow");
  assert.equal(publishMode("shadow", both), "shadow");
  assert.equal(publishMode("true", both), "shadow", "an unknown value is shadow, not live");
  assert.equal(publishMode("pin", pinOnly), "pin");
  assert.equal(publishMode("live", both), "live");
  // A stage without its credentials refuses rather than silently doing less
  assert.throws(() => publishMode("pin", none), /PINATA_JWT is not set/);
  assert.throws(() => publishMode("live", pinOnly), /CLOUDFLARE_API_TOKEN is not set/);
});

test("pointHostname cannot change a hostname without the Web3 token", async () => {
  await assert.rejects(
    () =>
      pointHostname({ gateway: null, hostnames }, { network: "mainnet", liveCid: "tip" }, "new"),
    /CLOUDFLARE_API_TOKEN is not set/,
  );
});

test("dnslinkCid reads the CID from the _dnslink TXT record", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        Answer: [
          {
            type: 16,
            data: '"dnslink=/ipfs/bafkreig62ekjinmxgc47a262ohy7l3vk7r4xqibbdi3xmhdqgknbfx4xpi"',
          },
        ],
      }),
    };
  };

  assert.equal(
    await dnslinkCid("registry.centrifuge.io", fetchImpl),
    "bafkreig62ekjinmxgc47a262ohy7l3vk7r4xqibbdi3xmhdqgknbfx4xpi",
  );
  assert.match(calls[0], /name=_dnslink\.registry\.centrifuge\.io&type=TXT/);
  assert.equal(await dnslinkCid("x", async () => ({ ok: true, json: async () => ({}) })), null);
});

test("each network publishes on its own outcome: one's errors never hold back the other", () => {
  const ok = { network: "mainnet", publishable: true, validation: { errors: [] } };
  const orphan = { network: "testnet", publishable: false, validation: { errors: [{}] } };
  const refused = { network: "testnet", publishable: false, refused: "tip unreachable" };
  const unchanged = { network: "testnet", publishable: false, validation: { errors: [] } };

  for (const [outcomes, expected] of [
    [[ok, orphan], ["mainnet"]],
    [[ok, refused], ["mainnet"]],
    [[ok, unchanged], ["mainnet"]],
    [[orphan], []],
  ]) {
    assert.deepEqual(
      toPublish(outcomes).map((o) => o.network),
      expected,
    );
  }
});

test("a publish says one line per network it published or refused, without the detail", () => {
  const hostnames = {
    mainnet: "registry.centrifuge.io",
    testnet: "registry.testnet.centrifuge.io",
  };
  const addresses = Array.from({ length: 430 }, (_, i) => `  - 11155111 Spoke 0x${i}`).join("\n");
  const dropsHistory = {
    network: "testnet",
    refused: `A full snapshot would drop 430 published contract(s) that are neither in env nor retired:\n${addresses}\n  Retire them first.`,
  };
  const orphan = {
    network: "testnet",
    validation: {
      errors: [{ path: "previousRegistry.ipfsHash", message: "A live registry exists. Details." }],
    },
  };
  const unchanged = { network: "mainnet", validation: { errors: [] } };
  const drifted = {
    ...unchanged,
    hostnameDrift:
      "mainnet: registry.centrifuge.io serves foreign, not published, the CID the Worker last pointed it at. Something other than the Worker changed it.",
  };
  const served = { network: "mainnet", cid: "bafkreiabc", served: true };

  for (const [input, expected] of [
    [{ outcomes: [unchanged, dropsHistory] }, [/testnet .*refused: .*would drop 430 .*retired$/]],
    [
      { outcomes: [orphan] },
      [/testnet .*refused: 1 .*error.*previousRegistry\.ipfsHash.*exists\.$/],
    ],
    [
      { outcomes: [unchanged, dropsHistory], published: [served] },
      [
        /mainnet .*published: `bafkreiabc` → https:\/\/registry\.centrifuge\.io$/,
        /testnet .*refused/,
      ],
    ],
    [
      { envProblems: ["env/testnet/base.json: no chainId\nmore"] },
      [/env\/ has 1 problem.*chainId$/],
    ],
    [{ outcomes: [drifted] }, [/mainnet .*refused: .*serves foreign, not published, .*at\.$/]],
    [{ outcomes: [unchanged] }, []],
  ]) {
    const lines = publishLines({
      outcomes: [],
      envProblems: [],
      published: [],
      shadow: [],
      hostnames,
      ...input,
    });
    assert.equal(lines.length, expected.length);
    expected.forEach((pattern, i) => assert.match(lines[i], pattern));
  }
});

test("a manual publish neither hides the push's check nor marks the release branch red", () => {
  for (const [reason, refused, expected] of [
    ["push of abcdef123 by dev", false, { name: "Registry publish", conclusion: "success" }],
    ["cron", true, { name: "Registry publish", conclusion: "failure" }],
    ["manual", false, { name: "Registry publish (manual)", conclusion: "success" }],
    ["manual", true, { name: "Registry publish (manual)", conclusion: "neutral" }],
  ]) {
    assert.deepEqual(publishCheck(reason, refused), expected);
  }
});

/** An R2 bucket in memory, holding text or bytes by key. */
function fakeBucket(objects = {}) {
  const store = new Map(Object.entries(objects));
  const bytesOf = (value) => (typeof value === "string" ? new TextEncoder().encode(value) : value);
  return {
    store,
    get: async (key) => {
      if (!store.has(key)) return null;
      const bytes = bytesOf(store.get(key));
      return {
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

/** The run's config past the hostname steps: an empty bucket, a GitHub that has every tag. */
function runConfigOf(liveCid, objects = {}) {
  return {
    ...hostnameConfig(liveCid),
    gh: async () => ({}),
    bucket: fakeBucket(objects),
    sourceRepo: "centrifuge/protocol-internal",
    pinataJwt: "jwt",
  };
}

/** Routes every fetch of a test to `impl`, which the test may swap. */
function mockFetch(t) {
  const holder = { impl: fakeFetch({}).fetchImpl };
  t.mock.method(globalThis, "fetch", (...args) => holder.impl(...args));
  return holder;
}

const mainnetEnv = envTreeOf({
  "mainnet/ethereum.json": JSON.stringify({
    network: { chainId: 1, environment: "mainnet" },
    contracts: {
      hub: {
        address: "0x0000000000000000000000000000000000000001",
        blockNumber: 1,
        version: "v3.3.0",
      },
    },
  }),
});

test("a tip that cannot be read refuses generation in every mode, for good when its bytes are not the CID's", async (t) => {
  const fetchImpl = mockFetch(t);
  const tampered = flipByte(realLayerBytes(MAINNET_HEAD_PARENT), 10);

  for (const mode of ["auto", "delta", "patch", "full"]) {
    for (const source of [{}, { sourceCid: MAINNET_HEAD_PARENT }]) {
      const tip = source.sourceCid ?? MAINNET_HEAD;
      const generate = () =>
        generateNetwork(runConfigOf(MAINNET_HEAD), "run", "mainnet", mainnetEnv, {
          mode,
          ...source,
        });

      // Every gateway is down: the step retries
      fetchImpl.impl = fakeFetch({}).fetchImpl;
      await assert.rejects(
        generate,
        (error) => error instanceof RefusedError && error.retryable && error.message.includes(tip),
        `${mode} ${tip} while IPFS is down`,
      );

      // Every gateway serves bytes that are not the tip's: nothing to retry, nothing to publish
      fetchImpl.impl = fakeFetch({
        [MAINNET_HEAD]: tampered,
        [MAINNET_HEAD_PARENT]: tampered,
      }).fetchImpl;
      const outcome = await generate();
      assert.equal(outcome.publishable, false, `${mode} ${tip} tampered`);
      assert.ok(outcome.refused.includes(tip), outcome.refused);
    }
  }
});

test("a pin whose CID does not name the layer the Worker sent is refused, before any hostname moves", async (t) => {
  const text = JSON.stringify({ network: "mainnet", version: "v3.3.0", chains: {} });
  const own = (await unixfsFileRoot(new TextEncoder().encode(text))).toString();
  const forms = [];
  const pinata = { cid: own };
  mockFetch(t).impl = async (_url, init) => {
    forms.push(init.body);
    return { ok: true, json: async () => ({ data: { cid: pinata.cid } }) };
  };
  const config = runConfigOf("tip", { "runs/r/registry-mainnet.json": text });
  const outcome = { network: "mainnet", liveCid: "tip" };

  assert.equal(await pinNetwork(config, "r", outcome, "sha"), own);
  assert.equal(forms[0].get("cid_version"), "v1"); // the profile verifyLayer rebuilds

  for (const other of [MAINNET_HEAD, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]) {
    pinata.cid = other;
    await assert.rejects(
      () => pinNetwork(config, "r", outcome, "sha"),
      (error) => error instanceof PinMismatchError && error.message.includes(other),
    );
  }
});

test("POST /runs refuses what a run would refuse, and what a run could not tell", () => {
  const cid = MAINNET_HEAD;
  for (const [body, accepted] of [
    [{ kind: "preview" }, true],
    [{ kind: "deploy" }, false],
    [{ kind: "publish", networks: ["devnet"] }, false],
    [{ kind: "publish", mode: "snapshot" }, false],
    [{ kind: "publish", mode: "full" }, false], // both networks, so mainnet
    [{ kind: "publish", mode: "full", networks: ["mainnet"] }, false],
    [{ kind: "publish", mode: "full", networks: ["testnet"] }, true],
    [{ kind: "preview", sourceCid: cid }, false], // needs the one network to build on it
    [{ kind: "preview", sourceCid: cid, networks: ["mainnet", "testnet"] }, false],
    [{ kind: "preview", sourceCid: "not-a-cid", networks: ["mainnet"] }, false],
    [{ kind: "preview", sourceCid: cid, networks: ["mainnet"] }, true],
    [{ kind: "preview", sha: "abc123" }, true],
    [{ kind: "publish", sha: "abc123" }, false],
    [{ kind: "publish", acceptLiveCid: cid, networks: ["mainnet"] }, true],
    [{ kind: "publish", acceptLiveCid: cid }, false],
    [{ kind: "preview", acceptLiveCid: cid, networks: ["mainnet"] }, false],
  ]) {
    const result = manualParams(body);
    assert.equal(typeof result === "object", accepted, `${JSON.stringify(body)}: ${result}`);
  }

  // What a run receives: only what the body set, and a false flag is not a flag
  assert.deepEqual(
    manualParams({
      kind: "publish",
      networks: ["testnet"],
      mode: "full",
      allowHistoryDrop: true,
      allowPartialChain: false,
    }),
    {
      kind: "publish",
      reason: "manual",
      networks: ["testnet"],
      mode: "full",
      allowHistoryDrop: true,
    },
  );
});
