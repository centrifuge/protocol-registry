/**
 * Whether the Publisher keeps waiting for its active run.
 *
 * The Publisher learns that a run ended by polling its Workflow instance's status. A read fails when
 * Workflows is briefly unreachable, but also when the instance is gone for good: an operator deleted
 * it (`wrangler workflows instances delete`), or it outlived the instance retention. Only the first
 * deserves another poll. Waiting forever on the others blocks every publish with no alert, so the
 * wait is bounded, and a run past the bound is given up on: recorded as lost, and the pending run
 * starts. Pure, so the bound is table-tested; the Publisher does what it decides.
 */

/** Consecutive failed status reads, carried on the active run between polls. */
export interface UnreadableStatus {
  /** When the first of them happened. */
  since: number;
  attempts: number;
  /** The last read's error. */
  error: string;
}

export type StatusRead =
  { ok: true; status: string; error?: string } | { ok: false; error: string };

export type Verdict =
  | { action: "poll"; unreadable?: UnreadableStatus }
  | { action: "ended"; status: string; error?: string }
  | { action: "lost"; error: string };

/** How long consecutive failed reads are retried before the run is given up on. */
export const UNREADABLE_FOR_MS = 30 * 60_000;
/** A run older than this is given up on at the first failed read. */
export const RUN_MAX_AGE_MS = 24 * 60 * 60_000;

/** The statuses a Workflow instance does not leave. "unknown" is an instance Workflows cannot account for. */
const ENDED = new Set(["complete", "errored", "terminated", "unknown"]);

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * Given the active run, the status read just made and the time, what the Publisher does next: poll
 * again (storing the failed reads so far, if any), record the run as ended with the status read, or
 * give the run up as lost.
 */
export function verdict(
  run: { startedAt: number; unreadable?: UnreadableStatus },
  read: StatusRead,
  now: number,
): Verdict {
  if (read.ok) {
    if (!ENDED.has(read.status)) return { action: "poll" };
    const error =
      read.error ??
      (read.status === "unknown" ? "Workflows reports the run as unknown" : undefined);
    return { action: "ended", status: read.status, ...(error && { error }) };
  }

  const unreadable: UnreadableStatus = {
    since: run.unreadable?.since ?? now,
    attempts: (run.unreadable?.attempts ?? 0) + 1,
    error: read.error,
  };
  const failingFor = now - unreadable.since;
  if (failingFor >= UNREADABLE_FOR_MS) {
    return {
      action: "lost",
      error: `its status could not be read for ${minutes(failingFor)} (${unreadable.attempts} reads): ${read.error}`,
    };
  }
  if (now - run.startedAt >= RUN_MAX_AGE_MS) {
    return {
      action: "lost",
      error: `it started ${minutes(now - run.startedAt)} ago and its status cannot be read: ${read.error}`,
    };
  }
  return { action: "poll", unreadable };
}
