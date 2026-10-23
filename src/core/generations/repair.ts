/**
 * GBRA-161 PR 1a: `gbrain repair generations`, the preview-first undo and release path of the generation ledger. `--kind`
 * names the ledger kind and `--mode` the operation (default restore); one selector (`--run`, `--since`, `--key`,
 * `--generation`, or `--held` for release-held) bounds the set.
 *
 * - restore: republishes the item set the selected live generation replaced, as a new generation (`restore_of`): items it
 *   retired come back from their ledger preimages, items it overwrote return to their earlier content, and items it added
 *   are versioned and retired (`retired_by: generation-restore`). A key with an item edited since the generation, or one
 *   with no stored preimage, is refused whole and the apply exits incomplete; nothing of that key changes.
 * - release-held: publishes a held result once (shrunk, valve, attempts_exhausted; oversize after the operator raised
 *   `generations.max_items`). no_proof, fence_absent, tie and segmented_unsupported are refused: releasing them would
 *   manufacture the proof they lack.
 * - cleanup: the synthesis unmatched-predecessor retire (PR 4); no kind in this release has it.
 *
 * Explicit-only, preview-bound, destructive consent: the preview saves the set under its hash and `--apply --expect <hash>
 * --yes` applies exactly that set, rechecking each key under its locks (`changed_since_preview` otherwise).
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { stableJson } from '../persistence/digest.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from '../repair/core.ts';
import { generationAdapter, generationKinds } from './adapters/index.ts';
import { readGenerationsConfig, restoreDaysHint } from './config.ts';
import { RELEASABLE_HELD_REASONS, type GenerationAdapter, type GenerationKey, type HeldReason, type ProposedItem } from './contract.ts';
import { activateGeneration, assertItemsLive, itemSetHash, lockGeneration, publishGeneration, readLiveGeneration, type LedgerItem } from './publish.ts';

export const GENERATION_MODES = ['restore', 'release-held', 'cleanup'] as const;
export type GenerationMode = typeof GENERATION_MODES[number];

/** What one run selects: the kind, the mode and the selectors the operator passed (`since` is a concrete ISO instant). */
export interface GenerationsSelection { kind: string; mode: GenerationMode; run?: string; since?: string; key?: string; generation?: number; held?: boolean }

/** The argv that selects this set again (preview, apply and consent replay share it). */
export function generationsSelectionArgv(selection: GenerationsSelection): string[] {
  return ['--kind', selection.kind, '--mode', selection.mode, ...(selection.run ? ['--run', selection.run] : []), ...(selection.key ? ['--key', selection.key] : []),
    ...(selection.generation !== undefined ? ['--generation', String(selection.generation)] : []), ...(selection.since ? ['--since', selection.since] : []),
    ...(selection.held ? ['--held'] : [])];
}

/** The read-only preview a notice prints for a kind (and optionally one key): the restore window, or the held set. */
export function generationsPreviewArgv(target: { kind: string; ownerKey?: string; sourceId?: string }, mode: 'restore' | 'release-held' = 'restore'): string[] {
  return ['gbrain', 'repair', 'generations', '--kind', target.kind, '--mode', mode, ...(target.sourceId ? ['--source', target.sourceId] : []),
    ...(target.ownerKey ? ['--key', target.ownerKey] : mode === 'release-held' ? ['--held'] : ['--since', `${restoreDaysHint()}d`]), '--json'];
}

const usage = (message: string, suggestion: string, selection: Partial<GenerationsSelection>) => opError('invalid_params', message, suggestion,
  { fix: readFix('Previews the generations repair; without --apply it writes nothing.', { argv: generationsPreviewArgv({ kind: selection.kind && generationAdapter(selection.kind) ? selection.kind : generationKinds()[0] ?? 'atom' },
    selection.mode === 'release-held' ? 'release-held' : 'restore') }) });

/** The usage refusal for an incomplete or contradictory selection, or null when it can run. */
export function generationsSelectionRefusal(selection: Partial<GenerationsSelection>): OperationError | null {
  const kinds = generationKinds().join(', ');
  const example = (mode: 'restore' | 'release-held' = 'restore') => generationsPreviewArgv({ kind: selection.kind && generationAdapter(selection.kind) ? selection.kind : generationKinds()[0] ?? 'atom' }, mode).slice(0, -1).join(' ');
  if (!selection.kind) return usage('gbrain repair generations needs --kind.', `Name the ledger kind (${kinds}), e.g. ${example()}.`, selection);
  if (!generationAdapter(selection.kind)) return usage(`--kind ${selection.kind} is not a generation kind this brain publishes (${kinds}).`, `Pass --kind ${generationKinds()[0] ?? 'atom'}.`, selection);
  if (!selection.mode || !GENERATION_MODES.includes(selection.mode)) {
    return usage(`--mode must be restore, release-held or cleanup (got "${selection.mode ?? ''}").`,
      'restore republishes the generation a key replaced; release-held publishes a held result once.', selection);
  }
  if (selection.mode === 'cleanup') return usage(`--mode cleanup retires unmatched synthesis predecessors; --kind ${selection.kind} has none.`, 'Use --mode restore or --mode release-held for this kind.', selection);
  if (!selection.run && !selection.since && !selection.key && selection.generation === undefined && !selection.held) {
    return usage('gbrain repair generations needs a selector: --run, --since, --key, --generation or --held.', `Bound the set, e.g. ${example(selection.mode === 'release-held' ? 'release-held' : 'restore')}.`, selection);
  }
  if (selection.held && selection.mode !== 'release-held') return usage('--held selects held results, which only --mode release-held publishes.', `Run ${example('release-held')}.`, selection);
  return null;
}

interface RestoreEntry {
  mode: 'restore'; id: number; source_id: string; owner_key: string; generation: number; restore_to: number; restore_to_id: number;
  revive: string[]; retire: string[]; refused: string[];
}
interface ReleaseEntry {
  mode: 'release-held'; id: number; source_id: string; owner_key: string; reason: HeldReason; hold_id: string; input_pin: string | null;
  attempts: number; proposal_bytes: number | null; items: number; refused: string[];
}
type Entry = RestoreEntry | ReleaseEntry;
interface EntryItem extends RepairItem { entry: Entry; hash: string; last: boolean; selection: GenerationsSelection }

function selectorSql(selection: GenerationsSelection, params: unknown[], alias: string): string {
  const parts: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
  if (selection.run) add(`${alias}.run_id = ?`, selection.run);
  if (selection.since) add(`${alias}.created_at >= ?::timestamptz`, selection.since);
  if (selection.key) add(`${alias}.owner_key = ?`, selection.key);
  if (selection.generation !== undefined) add(`${alias}.id = ?`, selection.generation);
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

const keyOf = (kind: string, sourceId: string, ownerKey: string): GenerationKey => ({ kind, sourceId, ownerKey });

/** What restoring the live generation `liveId` of `key` to its predecessor would do, read now. */
async function planRestore(db: BrainEngine, adapter: GenerationAdapter<unknown>, key: GenerationKey, liveId: number, prevId: number) {
  const items = await db.executeRaw<{ generation_id: number; item_key: string; identity_hash: string; action: string; preimage: Record<string, unknown> | null }>(
    'SELECT generation_id, item_key, identity_hash, action, preimage FROM derived_generation_items WHERE generation_id = ANY($1::bigint[])', [[liveId, prevId]]);
  const owned = (id: number) => new Map(items.filter(item => Number(item.generation_id) === id && item.action !== 'retired').map(item => [item.item_key, item.identity_hash]));
  const target = owned(prevId);
  const current = owned(liveId);
  const liveRecords = new Map(items.filter(item => Number(item.generation_id) === liveId).map(item => [item.item_key, item]));
  const rows = await adapter.readItems(db, key, [...new Set([...target.keys(), ...current.keys()])]);
  const revive: string[] = []; const retire: string[] = []; const refused: string[] = [];
  const preimages = new Map<string, Record<string, unknown>>();
  for (const [itemKey, identity] of target) {
    const row = rows.get(itemKey);
    if (row?.live && row.identityHash === identity) continue;
    const record = liveRecords.get(itemKey);
    const expectedNow = record?.action === 'retired' ? (row ? !row.live : false) : (row?.live === true && row.identityHash === record?.identity_hash);
    if (!record?.preimage || adapter.preimageIdentity(record.preimage) !== identity) { refused.push(`${itemKey}: no_preimage`); continue; }
    if (!expectedNow) { refused.push(`${itemKey}: edited_since`); continue; }
    revive.push(itemKey); preimages.set(itemKey, record.preimage);
  }
  for (const [itemKey, identity] of current) {
    if (target.has(itemKey)) continue;
    const row = rows.get(itemKey);
    if (!row?.live) continue;
    if (row.identityHash !== identity) refused.push(`${itemKey}: edited_since`);
    else retire.push(itemKey);
  }
  return { target, revive: revive.sort(), retire: retire.sort(), refused: refused.sort(), preimages, rows };
}

async function selectEntries(db: BrainEngine, adapter: GenerationAdapter<unknown>, sources: string[], selection: GenerationsSelection, id?: number): Promise<Entry[]> {
  const params: unknown[] = [sources, adapter.kind];
  if (selection.mode === 'restore') {
    const where = id === undefined ? selectorSql(selection, params, 'g') : (params.push(id), ` AND g.id = $${params.length}`);
    const rows = await db.executeRaw<{ id: number; source_id: string; owner_key: string; generation: number; prev_id: number; prev_generation: number }>(
      `SELECT g.id, g.source_id, g.owner_key, g.generation, p.id AS prev_id, p.generation AS prev_generation
         FROM derived_generations g JOIN derived_generations p ON p.superseded_by = g.id AND p.state = 'superseded'
        WHERE g.source_id = ANY($1::text[]) AND g.kind = $2 AND g.state = 'live'${where} ORDER BY g.id`, params);
    const entries: Entry[] = [];
    for (const row of rows) {
      const plan = await planRestore(db, adapter, keyOf(adapter.kind, row.source_id, row.owner_key), Number(row.id), Number(row.prev_id));
      if (!plan.revive.length && !plan.retire.length && !plan.refused.length) continue;
      entries.push({ mode: 'restore', id: Number(row.id), source_id: row.source_id, owner_key: row.owner_key, generation: Number(row.generation),
        restore_to: Number(row.prev_generation), restore_to_id: Number(row.prev_id), revive: plan.revive, retire: plan.retire, refused: plan.refused });
    }
    return entries;
  }
  const where = id === undefined ? selectorSql(selection, params, 'g') : (params.push(id), ` AND g.id = $${params.length}`);
  const config = await readGenerationsConfig(db);
  const rows = await db.executeRaw<{ id: number; source_id: string; owner_key: string; held_reason: HeldReason; hold_id: string; input_pin: string | null;
    attempts: number; proposal_bytes: number | null; items: number | null }>(
    `SELECT g.id, g.source_id, g.owner_key, g.held_reason, g.hold_id, g.input_pin, g.attempts, g.proposal_bytes, jsonb_array_length(g.proposal) AS items
       FROM derived_generations g WHERE g.source_id = ANY($1::text[]) AND g.kind = $2 AND g.state = 'held'${where} ORDER BY g.id`, params);
  return rows.map(row => {
    const refused = !RELEASABLE_HELD_REASONS.has(row.held_reason) ? [`${row.owner_key}: ${row.held_reason} is not releasable`]
      : row.items === null ? [`${row.owner_key}: no retained proposal`]
      : row.held_reason === 'oversize' && Number(row.items) > config.maxItems ? [`${row.owner_key}: oversize until generations.max_items is raised`] : [];
    return { mode: 'release-held' as const, id: Number(row.id), source_id: row.source_id, owner_key: row.owner_key, reason: row.held_reason, hold_id: row.hold_id,
      input_pin: row.input_pin, attempts: Number(row.attempts), proposal_bytes: row.proposal_bytes === null ? null : Number(row.proposal_bytes), items: Number(row.items ?? 0), refused };
  });
}

function describeEntry(entry: Entry): string {
  const refused = entry.refused.length ? `; refused: ${entry.refused.join(', ')}` : '';
  if (entry.mode === 'release-held') return `held ${entry.reason}, ${entry.items} item(s), ${entry.attempts} attempt(s)${refused}`;
  return `generation ${entry.generation} back to ${entry.restore_to}: revive ${entry.revive.length}, retire ${entry.retire.length}${refused}`;
}

async function hashParts(engine: BrainEngine, scope: RepairScope, selection: GenerationsSelection, entries: Entry[]) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'generations-v1', brain_id: scope.brain_id, sources, selection, entries };
}

function previewCommand(scope: RepairScope, selection: GenerationsSelection): string {
  return ['gbrain', 'repair', 'generations', ...(scope.source_ids.length === 1 ? ['--source', scope.source_ids[0]!] : []), ...generationsSelectionArgv(selection)].join(' ');
}

function requireAdapter(selection: GenerationsSelection | undefined): { adapter: GenerationAdapter<unknown>; selection: GenerationsSelection } {
  const refusal = generationsSelectionRefusal(selection ?? {});
  if (refusal) throw refusal;
  return { adapter: generationAdapter(selection!.kind)!, selection: selection! };
}

type Approved = Entry & { selection: GenerationsSelection; sources: string[] };

export const generationsRepair: RepairHandler = {
  kind: 'generations',
  publication: 'projection',
  embeds: true,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const { adapter, selection } = requireAdapter(opts?.generations);
    const command = previewCommand(scope, selection);
    const item = (entry: Entry, hash: string, last: boolean): EntryItem => ({ cursor: { phase: entry.mode === 'restore' ? 1 : 2, id: entry.id }, source_id: entry.source_id,
      slug: entry.owner_key, chars: 0, action: entry.mode === 'restore' ? 'restore' : 'release', entry, hash, last, selection });
    if (!opts?.apply) {
      const entries = await selectEntries(engine, adapter, scope.source_ids, selection);
      const hash = previewHash(await hashParts(engine, scope, selection, entries));
      if (entries.length) await saveApprovedSet<Approved>(engine, { command: 'generations', hash }, entries.map(entry => ({ ...entry, selection, sources: scope.source_ids })));
      return { items: entries.map((entry, index) => item(entry, hash, index === entries.length - 1)), preview_hash: hash,
        residuals: { keys: entries.length, refused: entries.filter(entry => entry.refused.length).length },
        listing: entries.map(entry => ({ item: `${entry.source_id}:${entry.owner_key}`, class: entry.refused.length ? 'refused' : entry.mode, detail: describeEntry(entry) })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair generations --apply applies only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, 'docs/guides/repair.md#generations');
    }
    const approved = await loadApprovedSet<Approved>(engine, { command: 'generations', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, selection, [])) });
    if (approved.items.some(entry => stableJson(entry.selection) !== stableJson(selection) || stableJson(entry.sources) !== stableJson(scope.source_ids))) {
      throw previewChangedError(opts.expect, command);
    }
    const items = approved.items.map(({ selection: _s, sources: _src, ...entry }, index) => item(entry, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, raw): Promise<RepairItemOutcome> {
    const { entry, hash, last, selection } = raw as EntryItem;
    const adapter = generationAdapter(selection.kind)!;
    const outcome = await applyEntry(ctx, adapter, entry, selection);
    if (last) await clearApprovedSet(ctx.engine, { command: 'generations', hash });
    return outcome;
  },
  async report(_ctx, _scope, result, opts) {
    const refused = (result.outcome_items ?? []).filter(item => item.outcome === 'refused');
    if (result.mode !== 'apply' || !refused.length || !opts.generations) return {};
    return { stopped: { reason: 'incomplete', message: `${refused.length} key(s) were refused and left unchanged: ${refused.map(item => item.reason).join('; ')}`,
      fix: readFix('Previews the generations repair again, read-only.', { argv: ['gbrain', 'repair', 'generations', ...generationsSelectionArgv(opts.generations), '--json'] }) } };
  },
};

async function applyEntry(ctx: OperationContext, adapter: GenerationAdapter<unknown>, approved: Entry, selection: GenerationsSelection): Promise<RepairItemOutcome> {
  const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });
  if (approved.refused.length) return { applied: false, outcome: 'refused', reason: approved.refused.join(', ') };
  const key = keyOf(adapter.kind, approved.source_id, approved.owner_key);
  if (approved.mode === 'release-held') {
    const [row] = await ctx.engine.executeRaw<{ proposal: ProposedItem[] | null; hold_id: string }>(
      `SELECT proposal, hold_id FROM derived_generations WHERE id=$1 AND state='held'`, [approved.id]);
    if (!row || row.hold_id !== approved.hold_id || !row.proposal) return changed('the held result changed or was released since the preview');
    const outcome = await publishGeneration(ctx.engine, adapter, { key, items: row.proposal, runId: `release:${approved.hold_id}`, release: { holdId: approved.hold_id, reason: approved.reason } });
    if (outcome.state === 'held') return { applied: false, outcome: 'refused', reason: `${approved.owner_key}: still held (${outcome.reason})` };
    return { applied: true, outcome: 'released', detail: { generation: outcome.generation, ...(outcome.state === 'published' ? { retired: outcome.retired.length } : {}) } };
  }
  const restored = await maintenanceTransaction(ctx.engine, async tx => {
    const live = await readLiveGeneration(tx, key);
    const plan0 = live?.id === approved.id ? await planRestore(tx, adapter, key, approved.id, approved.restore_to_id) : null;
    await lockGeneration(tx, adapter, key, plan0 ? [...plan0.target.keys(), ...plan0.retire] : []);
    if (!plan0 || (await readLiveGeneration(tx, key))?.id !== approved.id) return 'changed' as const;
    const plan = await planRestore(tx, adapter, key, approved.id, approved.restore_to_id);
    if (stableJson([plan.revive, plan.retire, plan.refused]) !== stableJson([approved.revive, approved.retire, approved.refused])) return 'changed' as const;
    if (plan.refused.length) return plan.refused;
    for (const itemKey of plan.revive) await adapter.restoreItem(tx, key, itemKey, plan.preimages.get(itemKey)!);
    await adapter.retireItems(tx, key, plan.retire, 'generation-restore');
    await assertItemsLive(tx, adapter, key, plan.target);
    const items: LedgerItem[] = [
      ...[...plan.target].map(([itemKey, identity]) => ({ key: itemKey, identityHash: identity, action: plan.revive.includes(itemKey) ? 'revived' as const : 'kept' as const,
        ...(plan.revive.includes(itemKey) && plan.rows.get(itemKey)?.live ? { preimage: plan.rows.get(itemKey)!.preimage() } : {}) })),
      ...plan.retire.map(itemKey => ({ key: itemKey, identityHash: plan.rows.get(itemKey)!.identityHash, action: 'retired' as const, preimage: plan.rows.get(itemKey)!.preimage() })),
    ];
    const setHash = itemSetHash([...plan.target].map(([itemKey, identityHash]) => ({ key: itemKey, identityHash })));
    const activated = await activateGeneration(tx, key, live, { operationId: `restore:${approved.id}:${approved.restore_to_id}`, input: await adapter.readInput(tx, key, undefined),
      setHash, completeness: { complete: true, restore: approved.restore_to }, restoreOf: approved.restore_to_id }, items);
    return activated;
  });
  if (restored === 'changed') return changed('the live generation or its items changed since the preview');
  if (Array.isArray(restored)) return { applied: false, outcome: 'refused', reason: restored.join(', ') };
  return { applied: true, outcome: 'restored', detail: { generation: restored.generation, restore_of: approved.restore_to, revived: approved.revive.length, retired: approved.retire.length } };
}
