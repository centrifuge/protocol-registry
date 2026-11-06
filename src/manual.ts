/**
 * The body of POST /runs, checked into run parameters. It lives apart from the Worker entry, which
 * imports cloudflare:workers, so that the checks are testable under Node.
 */

import type { RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import { isValidIpfsHash } from "./io/ipfs.ts";
import type { RunParams } from "./workflow.ts";

export interface ManualRun {
  kind: "preview" | "publish";
  networks?: Network[];
  mode?: RegistryMode;
  /** Build on this CID instead of the live tip; needs exactly one network. */
  sourceCid?: string;
  allowPartialChain?: boolean;
  allowHistoryDrop?: boolean;
  /** Preview only: the commit to generate from (a publish always takes the branch head). */
  sha?: string;
}

/** The parameters of the run, or why the body is refused. */
export function manualParams(body: ManualRun): RunParams | string {
  if (body.kind !== "preview" && body.kind !== "publish")
    return `kind must be "preview" or "publish"`;
  if (body.networks && !body.networks.every((n) => NETWORKS.includes(n))) {
    return `networks must be among ${NETWORKS.join(", ")}`;
  }
  if (body.mode && !["auto", "delta", "patch", "full"].includes(body.mode)) {
    return `mode must be one of auto, delta, patch, full`;
  }
  // Validation refuses it anyway; saying so here spares a run
  if (body.mode === "full" && (body.networks ?? NETWORKS).includes("mainnet")) {
    return `a full snapshot replaces the published chain, which only testnet does: pass "networks": ["testnet"]`;
  }
  if (body.sourceCid && (!isValidIpfsHash(body.sourceCid) || body.networks?.length !== 1)) {
    return `sourceCid must be a CID, with exactly one network`;
  }
  if (body.sha && body.kind === "publish") return `a publish always generates from the branch head`;
  return {
    kind: body.kind,
    reason: "manual",
    ...(body.sha && { sha: body.sha }),
    ...(body.networks && { networks: body.networks }),
    ...(body.mode && { mode: body.mode }),
    ...(body.sourceCid && { sourceCid: body.sourceCid }),
    ...(body.allowPartialChain && { allowPartialChain: true }),
    ...(body.allowHistoryDrop && { allowHistoryDrop: true }),
  };
}
