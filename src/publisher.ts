/**
 * Runs publishes one at a time.
 *
 * Two publishes computed against the same tip would both pin a layer pointing at it, and the second
 * dnslink swap would orphan the first. So every publish trigger (push, cron, manual) goes through this
 * single Durable Object: it starts a run when none is active, and otherwise keeps the trigger as the
 * one pending run, which starts when the active one ends. Triggers arriving meanwhile replace the
 * pending one — a run generates from the branch head, so the latest trigger covers the earlier ones —
 * except that a manual run, which may carry options, is not replaced by a push or the cron.
 *
 * Whether the active run has ended is polled with an alarm: a run that dies without reporting back
 * must not block publishing forever. Nor must one whose status cannot be read any more (its instance
 * deleted, or past the instance retention): ./liveness.ts bounds that wait, and a run past the bound
 * is recorded as lost and announced on Slack.
 *
 * It also keeps, per network, the CID the Worker last pointed the hostname at (HostnameRecord in
 * ./run.ts). That record is what tells a hostname changed with a leaked Web3 token from one the Worker
 * changed, so it lives here and not in R2: protocol's ABI workflow holds a token that writes
 * the bucket, and only this Worker's code writes Durable Object storage.
 */

import { DurableObject } from "cloudflare:workers";

import { NETWORKS, type Network } from "./core/types.ts";
import { notifySlack } from "./io/publish.ts";
import { verdict, type StatusRead, type UnreadableStatus } from "./liveness.ts";
import type { HostnameRecord } from "./run.ts";
import type { RunParams } from "./workflow.ts";

interface ActiveRun {
  id: string;
  params: RunParams;
  startedAt: number;
  /** Set while the run's status cannot be read; cleared by a read that works. */
  unreadable?: UnreadableStatus;
}

interface FinishedRun extends ActiveRun {
  status: string;
  finishedAt: number;
  error?: string;
}

export interface PublisherStatus {
  active: ActiveRun | null;
  pending: RunParams | null;
  history: FinishedRun[];
  hostnames: Partial<Record<Network, HostnameRecord>>;
}

const POLL_MS = 60_000;
const HISTORY = 20;
const hostnameKey = (network: Network) => `hostname/${network}`;

export class Publisher extends DurableObject<Env> {
  /** Starts a publish run, or queues it behind the active one. */
  async request(params: RunParams): Promise<{ started?: string; queued?: true }> {
    const active = await this.ctx.storage.get<ActiveRun>("active");
    if (!active) return { started: await this.start(params) };

    const pending = await this.ctx.storage.get<RunParams>("pending");
    const isManual = (p?: RunParams) => p?.reason.startsWith("manual") ?? false;
    if (!pending || !isManual(pending) || isManual(params)) {
      await this.ctx.storage.put("pending", params);
    }
    return { queued: true };
  }

  async status(): Promise<PublisherStatus> {
    const hostnames: PublisherStatus["hostnames"] = {};
    for (const network of NETWORKS) {
      const record = await this.hostnameRecord(network);
      if (record) hostnames[network] = record;
    }
    return {
      active: (await this.ctx.storage.get<ActiveRun>("active")) ?? null,
      pending: (await this.ctx.storage.get<RunParams>("pending")) ?? null,
      history: (await this.ctx.storage.get<FinishedRun[]>("history")) ?? [],
      hostnames,
    };
  }

  async hostnameRecord(network: Network): Promise<HostnameRecord | null> {
    return (await this.ctx.storage.get<HostnameRecord>(hostnameKey(network))) ?? null;
  }

  async putHostnameRecord(network: Network, record: HostnameRecord): Promise<void> {
    await this.ctx.storage.put(hostnameKey(network), record);
  }

  async alarm(): Promise<void> {
    const active = await this.ctx.storage.get<ActiveRun>("active");
    if (!active) return;

    let read: StatusRead;
    try {
      const status = await (await this.env.REGISTRY_RUN.get(active.id)).status();
      read = {
        ok: true,
        status: status.status,
        ...(status.error && { error: status.error.message }),
      };
    } catch (error) {
      read = { ok: false, error: (error as Error).message };
      console.warn(`Could not read the status of run ${active.id}: ${read.error}`);
    }

    const now = Date.now();
    const next = verdict(active, read, now);
    if (next.action === "poll") {
      if (next.unreadable || active.unreadable) {
        await this.ctx.storage.put("active", { ...active, unreadable: next.unreadable });
      }
      await this.ctx.storage.setAlarm(now + POLL_MS);
      return;
    }

    const finished: FinishedRun = {
      ...active,
      status: next.action === "ended" ? next.status : "lost",
      finishedAt: now,
      ...(next.error && { error: next.error }),
    };
    const history = (await this.ctx.storage.get<FinishedRun[]>("history")) ?? [];
    await this.ctx.storage.put("history", [finished, ...history].slice(0, HISTORY));
    await this.ctx.storage.delete("active");

    const pending = await this.ctx.storage.get<RunParams>("pending");
    if (pending) {
      await this.ctx.storage.delete("pending");
      await this.start(pending);
    }

    if (next.action === "lost") {
      // The run is already given up on; a message Slack did not take must not re-run this alarm
      try {
        await notifySlack(
          this.env.SLACK_WEBHOOK_URL,
          `:warning: *Registry publish run given up on* (${active.params.reason})\n>${next.error}\nRun \`${active.id}\`, started ${new Date(active.startedAt).toISOString()}. Publishing is no longer blocked by it.`,
        );
      } catch (error) {
        console.error(`Could not announce the lost run ${active.id}: ${(error as Error).message}`);
      }
    }
  }

  private async start(params: RunParams): Promise<string> {
    const id = `publish-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    await this.env.REGISTRY_RUN.create({ id, params });
    await this.ctx.storage.put("active", { id, params, startedAt: Date.now() } satisfies ActiveRun);
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    return id;
  }
}
