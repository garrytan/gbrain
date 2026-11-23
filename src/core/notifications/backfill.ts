/**
 * Queue take_proposal.created for proposals that are already pending (they were proposed before a sink existed).
 * Nothing posts them on its own: an operator runs `gbrain notify-backfill` with a limit, so turning a sink on never
 * floods a channel with the whole backlog. Each sink's filter still applies; a proposal already queued for a sink is
 * not queued again.
 */
import type { BrainEngine } from '../engine.ts';
import { filterMatches, loadSinks, sinkWantsEvent } from './config.ts';
import { enqueue } from './outbox.ts';
import { kickDispatcher, proposalPayload, proposalSubject, readProposalRows } from './emit.ts';

export interface BackfillOpts { sink?: string; minWeight?: number; limit?: number; ids?: number[]; dryRun?: boolean }
export interface BackfillResult { sinks: string[]; matched: number[]; queued: Array<{ sink: string; id: number }> }

export async function backfillCreated(engine: BrainEngine, opts: BackfillOpts = {}): Promise<BackfillResult> {
  const { sinks: all, error } = await loadSinks(engine, { fresh: true });
  if (error) throw new Error(`notify.sinks is invalid: ${error}`);
  const sinks = all.filter(s => sinkWantsEvent(s, 'take_proposal.created') && (!opts.sink || s.name === opts.sink));
  if (opts.sink && sinks.length === 0) throw new Error(`no enabled sink '${opts.sink}' receives take_proposal.created`);
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 20)));
  const ids = opts.ids?.length ? opts.ids : (await engine.executeRaw<{ id: number }>(
    `SELECT id FROM take_proposals WHERE status = 'pending' AND ($1::real IS NULL OR weight >= $1::real)
      ORDER BY weight DESC, proposed_at DESC, id DESC`, [opts.minWeight ?? null])).map(r => Number(r.id));
  const result: BackfillResult = { sinks: sinks.map(s => s.name), matched: [], queued: [] };
  const byId = new Map((await readProposalRows(engine, ids)).map(row => [Number(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    if (result.matched.length >= limit) break;
    if (row.status !== 'pending' && !opts.ids?.length) continue;
    const subject = { weight: Number(row.weight), kind: row.kind, page_slug: row.page_slug, holder: row.holder, source_id: row.source_id };
    const targets = sinks.filter(sink => filterMatches(sink.filter, subject));
    if (targets.length === 0) continue;
    result.matched.push(Number(row.id));
    if (opts.dryRun) continue;
    for (const sink of targets) {
      if (await enqueue(engine, { sink: sink.name, event: 'take_proposal.created', subject: proposalSubject(Number(row.id)),
        payload: proposalPayload('take_proposal.created', row) as unknown as Record<string, unknown> })) result.queued.push({ sink: sink.name, id: Number(row.id) });
    }
  }
  if (result.queued.length) kickDispatcher();
  return result;
}
