/**
 * What a GitHub webhook delivery asks for, decided from the payload alone so the decision is
 * testable without the network:
 *
 *   - a push to the source branch that touches env/ → publish from that commit
 *   - a pull request into the source branch → a preview on its head commit (a check run)
 *   - a check run re-requested from the PR page → the same preview again
 *   - a tag created in the source repository → build its ABIs ahead of the first run needing them
 */

import { CHECK_NAME } from "./io/github.ts";

export interface RouteConfig {
  sourceRepo: string;
  sourceBranch: string;
}

export type Route =
  | { type: "publish"; sha: string; reason: string }
  | { type: "preview"; pr: number; headSha: string }
  | { type: "build-abis"; tag: string }
  | { type: "ignore"; reason: string };

interface PushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

/** The viewer only reads the configs, so nothing it changes can change what the registry publishes. */
const touchesRegistryInputs = (path: string) =>
  path.startsWith("env/") && !path.startsWith("env/connections_viewer.");

/** v3, v3.1.0, v3.3.0-rc4: the tags a contract version resolves to. */
const RELEASE_TAG = /^v\d+(\.\d+){0,2}(-[0-9A-Za-z.]+)?$/;

const PREVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

// Payloads are GitHub's; only the fields read here are typed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function route(event: string, payload: any, config: RouteConfig): Route {
  const repo = payload?.repository?.full_name;
  if (repo !== config.sourceRepo) return { type: "ignore", reason: `event from ${repo}` };

  switch (event) {
    case "push": {
      if (payload.ref !== `refs/heads/${config.sourceBranch}`) {
        return { type: "ignore", reason: `push to ${payload.ref}` };
      }
      if (payload.deleted) return { type: "ignore", reason: "branch deleted" };
      const commits: PushCommit[] = payload.commits ?? [];
      const paths = commits.flatMap((c) => [
        ...(c.added ?? []),
        ...(c.modified ?? []),
        ...(c.removed ?? []),
      ]);
      // A push GitHub lists no commits for (a force push to an older commit) may still change env
      if (commits.length > 0 && !paths.some(touchesRegistryInputs)) {
        return { type: "ignore", reason: "push does not touch env/" };
      }
      return {
        type: "publish",
        sha: payload.after,
        reason: `push of ${String(payload.after).slice(0, 9)} by ${payload.pusher?.name ?? "unknown"}`,
      };
    }
    case "pull_request": {
      if (!PREVIEW_ACTIONS.has(payload.action))
        return { type: "ignore", reason: `pull_request ${payload.action}` };
      const pr = payload.pull_request;
      if (pr?.base?.ref !== config.sourceBranch)
        return { type: "ignore", reason: `PR into ${pr?.base?.ref}` };
      return { type: "preview", pr: pr.number, headSha: pr.head.sha };
    }
    case "check_run": {
      const run = payload.check_run;
      if (payload.action !== "rerequested" || run?.name !== CHECK_NAME) {
        return { type: "ignore", reason: `check_run ${payload.action}` };
      }
      const pr = run.pull_requests?.find(
        (p: { base?: { ref?: string } }) => p.base?.ref === config.sourceBranch,
      );
      if (!pr)
        return { type: "ignore", reason: "re-requested check has no PR into the source branch" };
      return { type: "preview", pr: pr.number, headSha: run.head_sha };
    }
    case "create": {
      if (payload.ref_type !== "tag")
        return { type: "ignore", reason: `created ${payload.ref_type}` };
      // Release tags only: env changes also tag deploy-<version>-<timestamp>, which no config names
      if (!RELEASE_TAG.test(payload.ref)) return { type: "ignore", reason: `tag ${payload.ref}` };
      return { type: "build-abis", tag: payload.ref };
    }
    default:
      return { type: "ignore", reason: `${event} event` };
  }
}
