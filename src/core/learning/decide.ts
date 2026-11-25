/**
 * Nightly learning PR 2: keep and undo, the answers the morning note asks for. Both act only on items the caller can
 * read now (learned's own filters, read.ts), named by their stable item ids.
 *
 *   keep  marks a change item (fact_added, promise_found, page_filled) kept. It writes the ledger row and nothing else.
 *   undo  reverses the change through the op that owns it, with the caller's own context, so its scope checks, the write
 *         door, git-first writes and the writer lock apply as for a direct call:
 *           fact_added     forget (a withdrawal; the audit trail stays)
 *           promise_found  loops_close as dropped (which also retires the loop's fact)
 *           page_filled    revert_version to the version enrich replaced, only while no write followed the enrich write
 *           conflict_found reject the proposal (the older fact stays); trusted local only, else the owner's command
 *           duplicate_to_confirm  never run here: the answer is gbrain dedupe reject on the brain host, returned as a command
 *         you_wrote rows are the owner's own Facts fence rows and are edited on the page, never undone here.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type Operation, type OperationContext } from '../ops/contract.ts';
import { operationScopesAllowed } from '../scope.ts';
import { enforceBoundClientOpAllowList } from '../ops/context.ts';
import { enforceReadTrustFloor } from '../eligibility/registry.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { CHANGE_KINDS } from './kinds.ts';
import { callerFilters, liveItems, LEARNED_MAX_LIMIT, LEARNED_WINDOW_DAYS, type LearnedItem } from './read.ts';

export type DecisionStatus = 'kept' | 'undone' | 'answered' | 'already' | 'refused' | 'not_found' | 'owner_command' | 'dry_run' | 'pending';
export interface Decision {
  id: string;
  kind?: string;
  status: DecisionStatus;
  reason?: string;
  /** owner_command: the command the owner runs on the brain host; refused page_filled: the commands that choose a version. */
  command?: string[];
  commands?: string[][];
  result?: unknown;
}

/** "12 15", "12,15", [12, 15] or "all" (keep only). Null when nothing usable was given. */
export function parseItemIds(raw: unknown): 'all' | number[] | null {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'all') return 'all';
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' || typeof raw === 'number' ? String(raw).split(/[\s,]+/) : [];
  const ids = parts.map(p => p.trim()).filter(Boolean);
  if (!ids.length || ids.some(p => !/^[1-9][0-9]{0,17}$/.test(p))) return null;
  return [...new Set(ids.map(Number))];
}

const inRequestOrder = (out: Decision[], ids: number[]) => ids.map(String).flatMap(id => out.filter(d => d.id === id));
const decidedBy = (ctx: OperationContext) => ctx.auth?.member?.id ?? (ctx.remote === false ? 'local' : ctx.auth?.clientId ?? 'remote');

async function readable(engine: BrainEngine, ctx: OperationContext, sourceIds: string[] | null, ids: number[]): Promise<Map<string, LearnedItem>> {
  const f = await callerFilters(engine, ctx);
  const items = await liveItems(engine, ctx, f, { sourceIds, since: new Date(0), unseenOnly: false, limit: ids.length, ids });
  return new Map(items.map(i => [i.id, i]));
}

/** Items whose target is gone from the caller's view: an undone fact or a dropped loop reads as already decided to a caller that reads the whole ledger. */
async function missing(engine: BrainEngine, ctx: OperationContext, sourceIds: string[] | null, ids: string[]): Promise<Decision[]> {
  if (!ids.length) return [];
  const full = ctx.remote === false || (await callerFilters(engine, ctx)).full;
  const rows = full ? await engine.executeRaw<{ id: number | string; kind: string; state: string }>(
    `SELECT id, kind, state FROM learning_items WHERE id = ANY($1::bigint[]) AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))`, [ids, sourceIds]) : [];
  const known = new Map(rows.map(r => [String(r.id), r]));
  return ids.map(id => {
    const row = known.get(id);
    return row && row.state !== 'pending' ? { id, kind: row.kind, status: 'already', reason: row.state } : { id, status: 'not_found' };
  });
}

async function mark(engine: BrainEngine, ctx: OperationContext, ids: string[], state: 'kept' | 'undone' | 'answered', from: string[]): Promise<Set<string>> {
  if (!ids.length || ctx.dryRun) return new Set();
  const rows = await engine.executeRaw<{ id: number | string }>(
    `UPDATE learning_items SET state = $2, decided_at = now(), decided_by = $3 WHERE id = ANY($1::bigint[]) AND state = ANY($4::text[]) RETURNING id`,
    [ids, state, decidedBy(ctx), from]);
  return new Set(rows.map(r => String(r.id)));
}

export async function keepItems(engine: BrainEngine, ctx: OperationContext, sourceIds: string[] | null, which: 'all' | number[]): Promise<Decision[]> {
  const items = which === 'all'
    ? (await liveItems(engine, ctx, await callerFilters(engine, ctx), {
      sourceIds, since: new Date(Date.now() - LEARNED_WINDOW_DAYS * 86_400_000), unseenOnly: false, limit: LEARNED_MAX_LIMIT,
    })).filter(i => i.family === 'change' && i.state === 'pending')
    : [...(await readable(engine, ctx, sourceIds, which)).values()];
  const out: Decision[] = which === 'all' ? [] : await missing(engine, ctx, sourceIds, which.map(String).filter(id => !items.some(i => i.id === id)));
  const keep: LearnedItem[] = [];
  for (const item of items) {
    if (!CHANGE_KINDS.includes(item.kind)) {
      out.push({ id: item.id, kind: item.kind, status: 'refused', reason: item.family === 'question' ? 'a question: answer it (learned-undo, or the commands the note shows)' : 'your own Facts fence row: edit it on the page' });
    } else if (item.state === 'pending') keep.push(item);
    else out.push({ id: item.id, kind: item.kind, status: item.state === 'kept' ? 'already' : 'refused', reason: item.state });
  }
  const kept = await mark(engine, ctx, keep.map(i => i.id), 'kept', ['pending']);
  for (const item of keep) out.push({ id: item.id, kind: item.kind, status: ctx.dryRun ? 'dry_run' : kept.has(item.id) ? 'kept' : 'already' });
  return which === 'all' ? out : inRequestOrder(out, which);
}

/** Runs another op's handler as this caller, behind the same per-op gates dispatch applies to a direct call. */
async function asCaller(ctx: OperationContext, load: () => Promise<Operation[]>, name: string, params: Record<string, unknown>): Promise<unknown> {
  const op = (await load()).find(o => o.name === name);
  if (!op) throw new Error(`learned: the ${name} operation is missing`);
  if (ctx.remote !== false && !operationScopesAllowed(ctx.auth?.scopes ?? [], op)) {
    throw opError('permission_denied', `${name} needs the ${op.scope ?? 'read'} scope this connection lacks`, 'Nothing was changed; the brain host operator can grant the scope.');
  }
  enforceBoundClientOpAllowList(ctx.auth, op);
  enforceReadTrustFloor(ctx.auth, op);
  return op.handler(ctx, params);
}

const evidence = (item: LearnedItem, key: 'fact_id' | 'loop_id' | 'proposal_id' | 'version_id') => item.evidence.find(e => e[key])?.[key];

/** page_filled: the versions written after the enrich write's snapshot; none means the page still holds what enrich wrote. */
async function versionsAfter(engine: BrainEngine, versionId: string): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number | string }>(`SELECT n.id FROM page_versions v JOIN page_versions n ON n.page_id = v.page_id AND n.id > v.id
     WHERE v.id = $1::bigint ORDER BY n.id`, [versionId]);
  return rows.map(r => Number(r.id));
}

async function undoOne(engine: BrainEngine, ctx: OperationContext, item: LearnedItem, reason: string | null): Promise<Decision> {
  const base = { id: item.id, kind: item.kind };
  const note = reason ? `learned undo: ${reason}` : 'learned undo';
  if (item.kind === 'you_wrote') return { ...base, status: 'refused', reason: 'your own Facts fence row: edit it on the page' };
  if (item.kind === 'duplicate_to_confirm') {
    return item.commands ? { ...base, status: 'owner_command', reason: 'dedupe answers run on the brain host', command: item.commands.reject } : { ...base, status: 'not_found' };
  }
  if (item.kind === 'conflict_found') {
    const proposal = Number(evidence(item, 'proposal_id'));
    const command = ['gbrain', 'decide', 'proposals', 'reject', String(proposal)];
    if (ctx.remote !== false) return { ...base, status: 'owner_command', reason: 'proposal review runs on the brain host', command };
    if (ctx.dryRun) return { ...base, status: 'dry_run', command };
    const { rejectProposal } = await import('../facts/proposal-supersede.ts');
    const result = await rejectProposal(engine, proposal);
    if (result.status !== 'rejected') return { ...base, status: 'refused', reason: result.reason ?? result.status };
    await mark(engine, ctx, [item.id], 'answered', ['pending', 'expired']);
    return { ...base, status: 'answered', result };
  }
  let result: unknown;
  if (item.kind === 'fact_added') {
    result = await asCaller(ctx.remote === false ? { ...ctx, sourceId: item.source_id } : ctx, async () => (await import('../verbs.ts')).verbOperations, 'forget',
      { id: evidence(item, 'fact_id'), reason: note });
  } else if (item.kind === 'promise_found') {
    result = await asCaller(ctx, async () => (await import('../ops/loops.ts')).loopsOperations, 'loops_close',
      { id: Number(evidence(item, 'loop_id')), status: 'dropped', note, ...(ctx.remote === false ? { source_id: item.source_id } : {}) });
    const closed = result as { closed?: boolean; reason?: string; dry_run?: boolean };
    if (!closed.dry_run && closed.closed !== true) return { ...base, status: 'refused', reason: closed.reason ?? 'not closed', result };
  } else {
    const versionId = String(evidence(item, 'version_id'));
    const slug = String(item.subject);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: item.source_id });
    if (!snapshot) return { ...base, status: 'not_found' };
    const newer = await versionsAfter(engine, versionId);
    if (newer.length) {
      return { ...base, status: 'refused', reason: `the page changed after it was filled in (version${newer.length === 1 ? '' : 's'} ${newer.join(', ')}); undo would overwrite that edit`,
        commands: [['gbrain', 'history', slug], ['gbrain', 'revert', slug, versionId]] };
    }
    result = await asCaller(ctx, async () => (await import('../ops/admin.ts')).adminOperations, 'revert_version',
      { slug, version_id: Number(versionId), source_id: item.source_id, expected_revision: snapshot.revision, reason: note });
  }
  if (ctx.dryRun) return { ...base, status: 'dry_run', result };
  const done = await mark(engine, ctx, [item.id], 'undone', ['pending', 'kept', 'expired']);
  return { ...base, status: done.has(item.id) ? 'undone' : 'already', result };
}

export async function undoItems(engine: BrainEngine, ctx: OperationContext, sourceIds: string[] | null, ids: number[], reason: string | null): Promise<Decision[]> {
  const items = await readable(engine, ctx, sourceIds, ids);
  const out = await missing(engine, ctx, sourceIds, ids.map(String).filter(id => !items.has(id)));
  for (const item of items.values()) {
    if (item.state === 'undone' || item.state === 'answered') { out.push({ id: item.id, kind: item.kind, status: 'already', reason: item.state }); continue; }
    try {
      out.push(await undoOne(engine, ctx, item, reason));
    } catch (e) {
      const pending = acceptedPendingReceipt(e);
      if (pending) {
        out.push({ id: item.id, kind: item.kind, status: 'pending', reason: 'the write was accepted and has not committed yet; the item stays pending until it does', command: ['gbrain', 'write-request', pending.request_id] });
        continue;
      }
      const code = (e as { code?: unknown }).code;
      out.push({ id: item.id, kind: item.kind, status: 'refused', reason: `${typeof code === 'string' ? code + ': ' : ''}${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return inRequestOrder(out, ids);
}

const STATUS_TEXT: Record<DecisionStatus, string> = {
  kept: 'kept', undone: 'undone', answered: 'answered', already: 'already decided', refused: 'not changed',
  not_found: 'not found (or not readable here)', owner_command: 'run on the brain host', dry_run: 'dry run, nothing changed',
  pending: 'accepted, still being written',
};

/** The CLI's text form of a keep or undo result: one line per item, then any command the owner runs. */
export function formatDecisions(result: { action: string; results: Decision[] }): string {
  if (!result.results.length) return `Nothing to ${result.action}.\n`;
  const lines: string[] = [];
  for (const d of result.results) {
    lines.push(`item ${d.id}${d.kind ? ` (${d.kind})` : ''}: ${STATUS_TEXT[d.status]}${d.reason ? ` - ${d.reason}` : ''}`);
    if (d.command) lines.push(`  ${d.command.join(' ')}`);
    for (const c of d.commands ?? []) lines.push(`  ${c.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}
