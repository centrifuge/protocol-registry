/**
 * The body of `POST /runs`, checked into a run's parameters before a run starts. What a run would
 * refuse anyway is refused here too, so an operator hears it at once rather than from a report; what
 * a run could not tell (a `sha` on a publish, a CID for two networks) only here.
 */

import type { RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import { isValidIpfsHash } from "./io/ipfs.ts";
import type { RunParams } from "./workflow.ts";

export interface ManualRun {
  kind: "preview" | "publish";
  networks?: Network[];
  mode?: RegistryMode;
  /**
   * Build on this CID instead of the live tip; needs exactly one network. A publish refuses a layer
   * that links to any CID but the live one (see validateRegistry), so this previews.
   */
  sourceCid?: string;
  allowPartialChain?: boolean;
  allowHistoryDrop?: boolean;
  /** Preview only: the commit to generate from (a publish always takes the branch head). */
  sha?: string;
  /**
   * Publish only, one network: accept this CID, which the hostname must serve when the run starts, as
   * the one to publish on. Clears a hostname changed outside the Worker, such as a rollback.
   */
  acceptLiveCid?: string;
}

/** The run a body asks for, or why it gets none. */
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
  if (
    body.acceptLiveCid &&
    (body.kind !== "publish" || !isValidIpfsHash(body.acceptLiveCid) || body.networks?.length !== 1)
  ) {
    return `acceptLiveCid must be a CID, in a publish run with exactly one network`;
  }
  return {
    kind: body.kind,
    reason: "manual",
    ...(body.sha && { sha: body.sha }),
    ...(body.networks && { networks: body.networks }),
    ...(body.mode && { mode: body.mode }),
    ...(body.sourceCid && { sourceCid: body.sourceCid }),
    ...(body.allowPartialChain && { allowPartialChain: true }),
    ...(body.allowHistoryDrop && { allowHistoryDrop: true }),
    ...(body.acceptLiveCid && { acceptLiveCid: body.acceptLiveCid }),
  };
}
