/**
 * What a GitHub webhook delivery asks for, decided from the payload alone so the decision is
 * testable without the network:
 *
 *   - a push to the source branch that touches env/ → publish from that commit. GitHub lists at
 *     most 20 commits in a push payload, so a larger push whose only env/ change is beyond the
 *     20th is ignored here; the cron publishes it within six hours
 *   - a pull request into the source branch → a preview on its head commit (a check run), if its
 *     files touch env/; that is checked against the PR's file list before any check is posted
 *   - a check run re-requested from the PR page → the same preview again
 */

import { CHECK_NAME } from "./io/github.ts";

export interface RouteConfig {
  sourceRepo: string;
  sourceBranch: string;
}

export type Route =
  | { type: "publish"; sha: string; reason: string }
  | { type: "preview"; pr: number; headSha: string }
  | { type: "ignore"; reason: string };

interface PushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

/**
 * Whether a changed path can change what the registry publishes: anything under env/ except the
 * connections viewer, which only reads the configs.
 */
export const touchesRegistryInputs = (path: string) =>
  path.startsWith("env/") && !path.startsWith("env/connections_viewer.");

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
    default:
      return { type: "ignore", reason: `${event} event` };
  }
}
