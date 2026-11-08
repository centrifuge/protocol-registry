/**
 * One registry run, as a durable Workflow: every step retries on its own and keeps its result, so a
 * run that waits on an ABI build or an unreachable gateway resumes where it stopped.
 *
 *   hostname check → commit → env check → ABIs → generate each network
 *     → preview: the PR's check run
 *     → publish: pin, swap the dnslink, the commit's check run, Slack
 *
 * A publish run is started by the Publisher (one at a time); a preview by a pull request.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { github, hostnames, runConfig } from "./config.ts";
import type { RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import {
  branchHead,
  completeCheckRun,
  createCompletedCheckRun,
  type CheckRunOutput,
} from "./io/github.ts";
import { notifySlack } from "./io/publish.ts";
import {
  hasErrors,
  headline,
  hostnameReport,
  previewMarkdown,
  publishCheck,
  publishLines,
  toPublish,
  type NetworkOutcome,
  type Published,
} from "./report.ts";
import {
  checkEnv,
  checkHostname,
  missingAbis,
  generateNetwork,
  HostnameDriftError,
  loadEnv,
  pinNetwork,
  pointHostname,
  publishMode,
  TipMovedError,
  type GeneratedOutcome,
} from "./run.ts";

/** A publish that met another publisher's change stops for good: a retry would meet it again. */
const stopsForGood = (error: unknown) =>
  error instanceof TipMovedError || error instanceof HostnameDriftError
    ? new NonRetryableError(error.message)
    : error;

export interface RunParams {
  kind: "preview" | "publish";
  /** Why the run started, for the report: "push of abc123 by …", "cron", "manual". */
  reason: string;
  /** The commit to generate from; a publish without one takes the source branch head. */
  sha?: string;
  /** A preview for a pull request reports on this check run. */
  pr?: { number: number; checkRunId: number };
  networks?: Network[];
  mode?: RegistryMode;
  sourceCid?: string;
  allowPartialChain?: boolean;
  allowHistoryDrop?: boolean;
  /** Publish only: the CID the one network's hostname serves, accepted as the one to publish on. */
  acceptLiveCid?: string;
}

export interface RunResult {
  sha: string;
  outcomes: NetworkOutcome[];
  envProblems: string[];
  /** Pinned layers; `served` once the hostname points at them (PUBLISH_MODE live). */
  published: Published[];
  /** PUBLISH_MODE shadow: what would have been published. */
  shadow: Network[];
}

const reportKey = (runId: string) => `runs/${runId}/report.md`;
const LAST_CRON_MESSAGE_KEY = "state/last-cron-message.txt";

export class RegistryRun extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<RunResult> {
    const params = event.payload;
    const runId = event.instanceId;
    const config = runConfig(this.env);
    const networks = params.networks ?? [...NETWORKS];

    try {
      const mode = params.kind === "publish" ? publishMode(this.env.PUBLISH_MODE, config) : null;

      // First, so a hostname changed outside the Worker is reported even when env/ or the ABIs stop
      // the run before it generates anything
      const hostnameChecks = await step.do("check hostnames", () =>
        Promise.all(
          networks.map((network) =>
            checkHostname(config, network, { mode, acceptLiveCid: params.acceptLiveCid }),
          ),
        ),
      );
      const hostnameMessage = mode ? hostnameReport(hostnameChecks, config.hostnames) : "";
      if (hostnameMessage) {
        await step.do("report hostnames", () =>
          notifySlack(
            this.env.SLACK_WEBHOOK_URL,
            `${hostnameMessage}\n_${params.reason}, run \`${runId}\`_`,
          ),
        );
      }

      const sha = await step.do(
        "resolve commit",
        async () =>
          params.sha ?? branchHead(config.gh, this.env.SOURCE_REPO, this.env.SOURCE_BRANCH),
      );

      const envProblems = await step.do("check env", async () =>
        checkEnv(config, await loadEnv(config, sha)),
      );
      if (envProblems.length > 0) {
        await step.do("report env problems", () =>
          this.report(params, runId, sha, [], envProblems),
        );
        return { sha, outcomes: [], envProblems, published: [], shadow: [] };
      }

      // protocol builds a tag's ABIs when the tag is pushed, in a few minutes; this waits
      // out a build in flight, and names the tag when there is none
      await step.do(
        "ensure ABIs",
        { retries: { limit: 30, delay: "2 minutes", backoff: "constant" }, timeout: "5 minutes" },
        async () => {
          const missing = await missingAbis(config, await loadEnv(config, sha));
          if (missing.length > 0) {
            throw new Error(
              `no ABI bundle for ${missing.join(", ")}: protocol's build-abis.yml builds a ` +
                `tag when it is pushed; run it by hand for a tag pushed before it existed`,
            );
          }
        },
      );

      const outcomes: GeneratedOutcome[] = [];
      for (const [i, network] of networks.entries()) {
        const outcome = await step.do(
          `generate ${network}`,
          {
            retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
            timeout: "10 minutes",
          },
          async () =>
            generateNetwork(config, runId, network, await loadEnv(config, sha), {
              mode: params.mode,
              sourceCid: params.sourceCid,
              allowPartialChain: params.allowPartialChain,
              allowHistoryDrop: params.allowHistoryDrop,
            }),
        );
        // A drifted network is still generated, so the report shows what accepting it would publish
        const { drift } = hostnameChecks[i];
        outcomes.push(drift ? { ...outcome, hostnameDrift: drift } : outcome);
      }

      const published: Published[] = [];
      const shadow: Network[] = [];
      if (mode) {
        for (const outcome of toPublish(outcomes)) {
          if (mode === "shadow") {
            shadow.push(outcome.network);
            continue;
          }
          const cid = await step.do(`pin ${outcome.network}`, async () => {
            try {
              return await pinNetwork(config, runId, outcome, sha);
            } catch (error) {
              throw stopsForGood(error);
            }
          });
          if (mode === "pin") {
            published.push({ network: outcome.network, cid, served: false });
            continue;
          }
          await step.do(`point ${config.hostnames[outcome.network]} at ${cid}`, async () => {
            try {
              await pointHostname(config, outcome, cid);
            } catch (error) {
              throw stopsForGood(error);
            }
          });
          published.push({ network: outcome.network, cid, served: true });
        }
      }

      await step.do("report", () =>
        this.report(params, runId, sha, outcomes, [], published, shadow),
      );
      return { sha, outcomes, envProblems: [], published, shadow };
    } catch (error) {
      await step.do("report failure", async () => {
        const message = (error as Error).message;
        if (params.pr) {
          await this.complete(params.pr.checkRunId, "failure", {
            title: "Registry preview failed",
            summary: `The run stopped before it could preview this pull request:\n\n> ${message}\n\nRun \`${runId}\`; re-run the check to try again.`,
          });
        } else {
          await notifySlack(
            this.env.SLACK_WEBHOOK_URL,
            `:x: *Registry ${params.kind} failed* (${params.reason})\n>${message.replace(/\n/g, "\n>")}\nRun \`${runId}\``,
          );
        }
      });
      throw error;
    }
  }

  private async complete(id: number, conclusion: "success" | "failure", output: CheckRunOutput) {
    await completeCheckRun(github(this.env), this.env.SOURCE_REPO, id, conclusion, output);
  }

  /** The check run of a preview; for a publish, a check run on the commit and a Slack message. */
  private async report(
    params: RunParams,
    runId: string,
    sha: string,
    outcomes: NetworkOutcome[],
    envProblems: string[],
    published: Published[] = [],
    shadow: Network[] = [],
  ): Promise<void> {
    const markdown = previewMarkdown(outcomes, envProblems);
    await this.env.REGISTRY_BUCKET.put(reportKey(runId), markdown);
    const failed = envProblems.length > 0 || hasErrors(outcomes);
    const title = envProblems.length > 0 ? "env/ has problems" : headline(outcomes);

    if (params.pr) {
      await this.complete(params.pr.checkRunId, failed ? "failure" : "success", {
        title,
        summary: `${markdown}---\n*Preview of \`${sha.slice(0, 9)}\` against the live registries. Publishing happens when this merges into \`${this.env.SOURCE_BRANCH}\`.*`,
      });
      return;
    }
    if (params.kind === "preview") return; // a manual preview is read from GET /runs/<id>

    const lines = publishLines({
      outcomes,
      envProblems,
      published,
      shadow,
      hostnames: hostnames(this.env),
    });

    // A reconcile that finds nothing to publish is the steady state, and not worth a message. One
    // that would say the same as the last (a refusal nobody acted on yet, a shadow or pinned layer
    // that stays unpublished) is not repeated either
    if (lines.length === 0) {
      await this.env.REGISTRY_BUCKET.delete(LAST_CRON_MESSAGE_KEY);
      return;
    }
    const message = lines.join("\n");
    if (params.reason === "cron") {
      const last = await (await this.env.REGISTRY_BUCKET.get(LAST_CRON_MESSAGE_KEY))?.text();
      if (last === message) return;
    }

    // Slack carries one line per network; the full report goes where anyone with access to the
    // source repository can read it
    let details: string;
    try {
      const url = await createCompletedCheckRun(
        github(this.env),
        this.env.SOURCE_REPO,
        sha,
        publishCheck(params.reason, failed),
        {
          title,
          summary: `${message}\n\n${markdown}---\n*Publish run \`${runId}\` (${params.reason}), from \`${sha.slice(0, 9)}\` of \`${this.env.SOURCE_BRANCH}\`.*`,
        },
      );
      details = `<${url}|Full report>`;
    } catch (error) {
      // The publish is done by now: a report GitHub did not take must not fail the run
      console.error(`Could not create the publish check run: ${(error as Error).message}`);
      details = `Full report: \`GET /runs/${runId}\` (the GitHub check run could not be created)`;
    }
    await notifySlack(
      this.env.SLACK_WEBHOOK_URL,
      `${message}\n${details}\n_${params.reason}, \`${sha.slice(0, 9)}\` of ${this.env.SOURCE_BRANCH}, run \`${runId}\`_`,
    );
    // Recorded once sent, so a retry after a failed post sends it
    if (params.reason === "cron")
      await this.env.REGISTRY_BUCKET.put(LAST_CRON_MESSAGE_KEY, message);
  }
}
