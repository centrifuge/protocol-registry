/**
 * The protocol-registry Worker: keeps registry.centrifuge.io and registry.testnet.centrifuge.io in
 * step with protocol-internal's env configs on the release branch.
 *
 *   POST /webhooks/github     the GitHub App's deliveries (see ./webhook.ts for what each one does)
 *   POST /runs                a manual run (bearer MANUAL_TRIGGER_TOKEN), see ./manual.ts
 *   GET  /runs/<id>           a run's status and report
 *   GET  /runs/<id>/<file>    a run's generated registry-<network>.json or .validation.json
 *   GET  /status              the publisher: active run, pending run, recent history
 *
 * The cron reconciles every six hours, so a missed delivery or a failed run is retried unprompted.
 */

import { github } from "./config.ts";
import { createCheckRun, pullRequestFiles, verifyWebhookSignature } from "./io/github.ts";
import { manualParams, type ManualRun } from "./manual.ts";
import { route, touchesRegistryInputs } from "./webhook.ts";
import type { RunParams } from "./workflow.ts";

import { Publisher } from "./publisher.ts";

export { Publisher };
export { RegistryRun } from "./workflow.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// `wrangler types` without the runtime types leaves the namespace untyped
const publisher = (env: Env) =>
  (env.PUBLISHER as DurableObjectNamespace<Publisher>).getByName("publisher");

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MANUAL_TRIGGER_TOKEN) return false;
  const given = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${env.MANUAL_TRIGGER_TOKEN}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
    return json({ error: "bad signature" }, 401);
  }
  const event = request.headers.get("X-GitHub-Event") ?? "";
  const delivery = request.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();
  const decision = route(event, JSON.parse(body), {
    sourceRepo: env.SOURCE_REPO,
    sourceBranch: env.SOURCE_BRANCH,
  });

  switch (decision.type) {
    case "publish":
      return json(await publisher(env).request({ kind: "publish", reason: decision.reason }), 202);
    case "preview": {
      const gh = github(env);
      // A PR that cannot change the registry gets no check at all, rather than one saying so
      const files = await pullRequestFiles(gh, env.SOURCE_REPO, decision.pr);
      if (!files.some(touchesRegistryInputs)) {
        return json({ ignored: `PR #${decision.pr} does not touch env/` }, 202);
      }
      const checkRunId = await createCheckRun(gh, env.SOURCE_REPO, decision.headSha, {
        title: "Generating",
        summary: "Generating the registry layers this pull request would publish…",
      });
      const id = `preview-${decision.pr}-${decision.headSha.slice(0, 12)}-${delivery.slice(0, 8)}`;
      await env.REGISTRY_RUN.create({
        id,
        params: {
          kind: "preview",
          reason: `PR #${decision.pr}`,
          sha: decision.headSha,
          pr: { number: decision.pr, checkRunId },
        } satisfies RunParams,
      });
      return json({ started: id }, 202);
    }
    case "ignore":
      return json({ ignored: decision.reason }, 202);
  }
}

async function handleRuns(request: Request, env: Env, path: string[]): Promise<Response> {
  if (!(await authorized(request, env))) return json({ error: "not found" }, 404);

  if (request.method === "POST" && path.length === 0) {
    let body: ManualRun;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const params = manualParams(body);
    if (typeof params === "string") return json({ error: params }, 400);
    if (params.kind === "publish") return json(await publisher(env).request(params), 202);
    const id = `preview-manual-${Date.now().toString(36)}`;
    await env.REGISTRY_RUN.create({ id, params });
    return json({ started: id }, 202);
  }

  if (request.method === "GET" && path.length === 1) {
    const [id] = path;
    const status = await (await env.REGISTRY_RUN.get(id)).status();
    const report = await env.REGISTRY_BUCKET.get(`runs/${id}/report.md`);
    return json({ id, ...status, report: (await report?.text()) ?? null });
  }

  if (
    request.method === "GET" &&
    path.length === 2 &&
    /^registry-(mainnet|testnet)(\.validation)?\.json$/.test(path[1])
  ) {
    const object = await env.REGISTRY_BUCKET.get(`runs/${path[0]}/${path[1]}`);
    return object
      ? new Response(object.body, { headers: { "Content-Type": "application/json" } })
      : json({ error: "not found" }, 404);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [first, ...rest] = url.pathname.split("/").filter(Boolean);

    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      return handleWebhook(request, env);
    }
    if (first === "runs") return handleRuns(request, env, rest);
    if (request.method === "GET" && url.pathname === "/status") {
      if (!(await authorized(request, env))) return json({ error: "not found" }, 404);
      return json(await publisher(env).status());
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller, env): Promise<void> {
    await publisher(env).request({ kind: "publish", reason: "cron" });
  },
} satisfies ExportedHandler<Env>;
