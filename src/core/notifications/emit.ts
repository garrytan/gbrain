/**
 * Event producers: queue take_proposal.* events for every enabled sink that wants them and whose filter matches.
 * Never throws and never blocks on delivery: a failure to queue is logged and the emitting write or dream cycle
 * carries on. Delivery happens in the dispatcher (notifications/dispatcher.ts); a dispatcher running in this process
 * is kicked so it delivers at once instead of at its next poll.
 */
import type { BrainEngine } from '../engine.ts';
import { filterMatches, loadSinks, sinkWantsEvent, type NotificationEvent, type SinkConfig } from './config.ts';
import { enqueue } from './outbox.ts';
import type { ProposalEventPayload } from './types.ts';

let kickHook: (() => void) | null = null;
/** The in-process dispatcher registers itself here; null clears it. */
export function setDispatcherKick(kick: (() => void) | null): void { kickHook = kick; }
export function kickDispatcher(): void { try { kickHook?.(); } catch { /* a kick is best-effort */ } }

export const proposalSubject = (id: number) => `take_proposal:${id}`;

interface ProposalRow {
  id: number; source_id: string; page_slug: string; claim_text: string; kind: string; holder: string; weight: number;
  domain: string | null; status: string; proposed_at: unknown; promoted_row_num: number | null;
  acted_by: string | null; acted_at: unknown; acted_via: string | null; decision_reason: string | null;
}

const iso = (value: unknown): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

export function proposalPayload(event: string, row: ProposalRow): ProposalEventPayload {
  return {
    event,
    occurred_at: new Date().toISOString(),
    proposal: {
      id: Number(row.id), source_id: row.source_id, page_slug: row.page_slug, claim: row.claim_text, kind: row.kind,
      holder: row.holder, weight: Number(row.weight), domain: row.domain, status: row.status, proposed_at: iso(row.proposed_at),
      promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
      acted_by: row.acted_by, acted_at: iso(row.acted_at), acted_via: row.acted_via, reason: row.decision_reason,
    },
  };
}

export async function readProposalRows(engine: BrainEngine, ids: number[]): Promise<ProposalRow[]> {
  if (ids.length === 0) return [];
  return engine.executeRaw<ProposalRow>(
    `SELECT id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, promoted_row_num,
            acted_by, acted_at, acted_via, decision_reason
       FROM take_proposals WHERE id = ANY($1::bigint[])`, [ids]);
}

/** Queue `event` for each proposal id to every matching sink. Returns how many deliveries were queued. */
export async function emitTakeProposalEvent(
  engine: BrainEngine,
  event: NotificationEvent,
  ids: number[],
  opts: { sinks?: SinkConfig[]; log?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line));
  try {
    if (ids.length === 0) return 0;
    const sinks = (opts.sinks ?? (await loadSinks(engine)).sinks).filter(sink => sinkWantsEvent(sink, event));
    if (sinks.length === 0) return 0;
    let queued = 0;
    for (const row of await readProposalRows(engine, ids)) {
      const subject = { weight: Number(row.weight), kind: row.kind, page_slug: row.page_slug, holder: row.holder, source_id: row.source_id };
      for (const sink of sinks) {
        if (!filterMatches(sink.filter, subject)) continue;
        if (await enqueue(engine, { sink: sink.name, event, subject: proposalSubject(Number(row.id)), payload: proposalPayload(event, row) as unknown as Record<string, unknown> })) queued++;
      }
    }
    if (queued > 0) kickDispatcher();
    return queued;
  } catch (error) {
    log(`[notify] could not queue ${event} for proposal(s) ${ids.join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
