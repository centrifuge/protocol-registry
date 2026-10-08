/**
 * One registry run, as a durable Workflow: every step retries on its own and keeps its result, so a
 * run that waits on an ABI build or an unreachable gateway resumes where it stopped.
 *
 *   commit → env check → ABIs → generate each network → preview: the PR's check run
 *                                                      → publish: pin, swap the dnslink, Slack
 *
 * A publish run is started by the Publisher (one at a time); a preview by a pull request.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { github, hostnames, runConfig } from "./config.ts";
import type { RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import { branchHead, completeCheckRun, type CheckRunOutput } from "./io/github.ts";
import { notifySlack } from "./io/publish.ts";
import { hasErrors, headline, previewMarkdown, type NetworkOutcome } from "./report.ts";
import {
  checkEnv,
  missingAbis,
  generateNetwork,
  loadEnv,
  pinNetwork,
  pointHostname,
  publishMode,
  TipMovedError,
  type GeneratedOutcome,
} from "./run.ts";

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

interface Published {
  network: Network;
  cid: string;
  served: boolean;
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

      // protocol-internal builds a tag's ABIs when the tag is pushed, in a few minutes; this waits
      // out a build in flight, and names the tag when there is none
      await step.do(
        "ensure ABIs",
        { retries: { limit: 30, delay: "2 minutes", backoff: "constant" }, timeout: "5 minutes" },
        async () => {
          const missing = await missingAbis(config, await loadEnv(config, sha));
          if (missing.length > 0) {
            throw new Error(
              `no ABI bundle for ${missing.join(", ")}: protocol-internal's build-abis.yml builds a ` +
                `tag when it is pushed; run it by hand for a tag pushed before it existed`,
            );
          }
        },
      );

      const outcomes: GeneratedOutcome[] = [];
      for (const network of networks) {
        outcomes.push(
          await step.do(
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
          ),
        );
      }

      const published: Published[] = [];
      const shadow: Network[] = [];
      if (params.kind === "publish" && !hasErrors(outcomes)) {
        const mode = publishMode(this.env.PUBLISH_MODE, config);
        for (const outcome of outcomes.filter((o) => o.publishable)) {
          if (mode === "shadow") {
            shadow.push(outcome.network);
            continue;
          }
          const cid = await step.do(`pin ${outcome.network}`, async () => {
            try {
              return await pinNetwork(config, runId, outcome, sha);
            } catch (error) {
              throw error instanceof TipMovedError ? new NonRetryableError(error.message) : error;
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
              throw error instanceof TipMovedError ? new NonRetryableError(error.message) : error;
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

  /** The check run of a preview, or the Slack message of a publish. */
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

    const hostname = (network: Network) => hostnames(this.env)[network];
    const lines: string[] = [];
    for (const { network, cid, served } of published) {
      lines.push(
        served
          ? `:white_check_mark: *${network}* published: \`${cid}\` → https://${hostname(network)}`
          : `:pushpin: *${network}* pinned, not served (PUBLISH_MODE is pin): https://centrifuge-files.mypinata.cloud/ipfs/${cid}`,
      );
    }
    for (const network of shadow) {
      lines.push(
        `:ghost: *${network}*: would publish (PUBLISH_MODE is shadow); the layer is at \`GET /runs/<run>/registry-${network}.json\``,
      );
    }
    if (failed) lines.push(`:x: *Registry publish refused* — ${title}`);

    // A reconcile that finds nothing to publish is the steady state, and not worth a message. One
    // that would say the same as the last (a refusal nobody acted on yet, a shadow or pinned layer
    // that stays unpublished) is not repeated either
    if (lines.length === 0) {
      await this.env.REGISTRY_BUCKET.delete(LAST_CRON_MESSAGE_KEY);
      return;
    }
    const message = `${lines.join("\n")}${failed ? `\n\`\`\`${markdown.slice(0, 2500)}\`\`\`` : ""}`;
    if (params.reason === "cron") {
      const last = await (await this.env.REGISTRY_BUCKET.get(LAST_CRON_MESSAGE_KEY))?.text();
      if (last === message) return;
      await this.env.REGISTRY_BUCKET.put(LAST_CRON_MESSAGE_KEY, message);
    }
    await notifySlack(
      this.env.SLACK_WEBHOOK_URL,
      `${message}\n_${params.reason}, \`${sha.slice(0, 9)}\` of ${this.env.SOURCE_BRANCH}, run \`${runId}\`_`,
    );
  }
}
