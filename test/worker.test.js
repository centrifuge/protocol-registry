import { test } from "node:test";
import assert from "node:assert/strict";

import { envTreeOf } from "../src/core/env.ts";
import { versionTagErrors } from "../src/core/version-tags.ts";
import { appJwt, compareSource, verifyWebhookSignature } from "../src/io/github.ts";
import { pointHostname, TipMovedError } from "../src/run.ts";
import { route } from "../src/webhook.ts";

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

test("only release tags start an ABI build", () => {
  const create = (ref) => route("create", { repository, ref_type: "tag", ref }, config);
  assert.deepEqual(create("v3.3.0"), { type: "build-abis", tag: "v3.3.0" });
  assert.equal(create("v3.3.0-rc4").type, "build-abis");
  assert.equal(create("v3").type, "build-abis");
  assert.equal(create("deploy-v3.3-1759000000").type, "ignore");
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

/** A GitHub API over a map of git trees, keyed by sha or ref. */
function fakeTrees(trees) {
  return async (_method, path) => {
    const ref = decodeURIComponent(path.split("/git/trees/")[1]);
    if (!trees[ref]) throw Object.assign(new Error("404"), { status: 404, name: "GitHubError" });
    return trees[ref];
  };
}

test("compareSource compares trees directly, ignoring src/spell", async () => {
  const root = (src) => ({ sha: `root-${src}`, tree: [{ path: "src", type: "tree", sha: src }] });
  const gh = fakeTrees({
    "v3.3.0": root("srcA"),
    deployed: root("srcB"),
    srcA: {
      sha: "srcA",
      tree: [
        { path: "core", type: "tree", sha: "c1" },
        { path: "spell", type: "tree", sha: "s1" },
      ],
    },
    srcB: {
      sha: "srcB",
      tree: [
        { path: "core", type: "tree", sha: "c1" },
        { path: "spell", type: "tree", sha: "s2" },
      ],
    },
    drifted: root("srcC"),
    srcC: {
      sha: "srcC",
      tree: [
        { path: "core", type: "tree", sha: "c2" },
        { path: "spell", type: "tree", sha: "s1" },
      ],
    },
  });

  assert.deepEqual(await compareSource(gh, "r", "v3.3.0", "deployed"), {
    checked: true,
    differing: [],
  });
  assert.deepEqual(await compareSource(gh, "r", "v3.3.0", "drifted"), {
    checked: true,
    differing: ["src/core"],
  });
});

test("versionTagErrors holds an aliased tag to the source the deployment recorded", async () => {
  const config = (version, gitCommit) =>
    JSON.stringify({
      network: { chainId: 11155111, environment: "testnet" },
      contracts: { hub: { address: "0x0000000000000000000000000000000000000001", version } },
      deploymentInfo: { "deploy:protocol": { gitCommit } },
    });
  const tree = (files) =>
    envTreeOf({ "testnet/sepolia.json": config("v3.3", "abc1234"), ...files });
  const deps = (differing) => ({
    tagExists: async (tag) => ["v3.3.0-rc4", "v3.2.0"].includes(tag),
    compareSource: async () => ({ checked: true, differing }),
  });
  const aliases = (tags) => ({ "testnet/versions.json": JSON.stringify({ tags }) });

  assert.deepEqual(await versionTagErrors(tree(aliases({ "v3.3": "v3.3.0-rc4" })), deps([])), []);
  assert.match(
    (await versionTagErrors(tree(aliases({ "v3.3": "v3.3.0-rc4" })), deps(["src/core"]))).join(
      "\n",
    ),
    /source differs from the deployed commit abc1234 \(src\/core\)/,
  );
  assert.match(
    (
      await versionTagErrors(tree(aliases({ "v3.3": "v3.3.0-rc4", "v3.9": "v3.2.0" })), deps([]))
    ).join("\n"),
    /"tags.v3.9" .* redirects nothing/,
  );
  assert.match(
    (await versionTagErrors(tree({}), deps([]))).join("\n"),
    /version "v3.3" → no git tag/,
  );
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

test("pointHostname swaps the dnslink when the tip is the one the layer was generated against", async () => {
  const gateway = fakeGateway("tip");
  await pointHostname({ gateway, hostnames }, { network: "mainnet", liveCid: "tip" }, "new");
  assert.deepEqual(gateway.state.sets, ["new"]);
});

test("pointHostname refuses when something else published in between", async () => {
  // Swapping anyway would orphan the other publish: its layer would no longer be in the chain
  const gateway = fakeGateway("someone-else");
  await assert.rejects(
    () => pointHostname({ gateway, hostnames }, { network: "mainnet", liveCid: "tip" }, "new"),
    TipMovedError,
  );
  assert.deepEqual(gateway.state.sets, []);
});

test("pointHostname is a no-op on a retry after the swap landed", async () => {
  const gateway = fakeGateway("new");
  await pointHostname({ gateway, hostnames }, { network: "mainnet", liveCid: "tip" }, "new");
  assert.deepEqual(gateway.state.sets, []);
});
