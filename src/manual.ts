/**
 * What `POST /runs` accepts, and the run it asks for, decided from the body alone so the rules are
 * testable without the Worker.
 */

import { CID } from "multiformats/cid";

import type { RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import type { RunParams } from "./workflow.ts";

/** POST /runs */
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
  /**
   * Publish only, one network: accept this CID, which the hostname must serve when the run starts, as
   * the one to publish on. Clears a hostname changed outside the Worker, such as a rollback.
   */
  acceptLiveCid?: string;
}

/**
 * Why `value` cannot name a layer, or null when it can. A layer is named by its CIDv1 in canonical
 * form, and verification (core/verify.ts) refuses any other spelling of the same CID, a CIDv0
 * included. Refusing it here spares a run that would retry a permanent refusal as an IPFS outage.
 */
function cidError(field: string, value: string): string | null {
  let parsed: CID;
  try {
    parsed = CID.parse(value);
  } catch {
    return `${field} is not a CID`;
  }
  if (parsed.version !== 1 || parsed.toString() !== value) {
    return `${field} must be a canonical CIDv1 (lower-case base32, as a layer is named), not ${value}`;
  }
  return null;
}

/** The run a body asks for, or the reason it is refused. */
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
  if (body.sourceCid) {
    const refused = cidError("sourceCid", body.sourceCid);
    if (refused) return refused;
    if (body.networks?.length !== 1) return `sourceCid needs exactly one network`;
  }
  if (body.sha && body.kind === "publish") return `a publish always generates from the branch head`;
  if (body.acceptLiveCid) {
    const refused = cidError("acceptLiveCid", body.acceptLiveCid);
    if (refused) return refused;
    if (body.kind !== "publish" || body.networks?.length !== 1) {
      return `acceptLiveCid needs a publish run with exactly one network`;
    }
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
