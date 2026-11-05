/**
 * A layer that cannot be used: its bytes are not what the CID addresses, the CID is not one this
 * library verifies, or the verified bytes are not a registry layer (`layerFromBytes`). Thrown from
 * a `fetchLayer`, it makes the walk fatal; let it propagate unwrapped, since the walk recognises it
 * by class. A mismatch may be one gateway's fault: retry the next gateway before letting it escape.
 */
export class LayerVerificationError extends Error {
  /** The CID that was being verified, as given. */
  readonly cid: string;

  constructor(cid: string, reason: string) {
    super(`layer ${cid} failed verification: ${reason}`);
    this.name = "LayerVerificationError";
    this.cid = cid;
  }
}
