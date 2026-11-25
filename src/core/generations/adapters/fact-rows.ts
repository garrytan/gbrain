/**
 * GBRA-161 PR 2: the fact-rows adapter. Fence-projected facts (`fact_fence`, one owner key per page) and consolidation
 * chains (`consolidation`, one owner key per cluster) are rows of the facts table, so they share the before-state they
 * record and the one writer that puts it back.
 *
 * - `fact_fence`: the page's `## Facts` fence is the generation (fence.ts). Every writer that retires fence rows (the page
 *   publication's projection, extract_facts, the deleted-page expiry) asks `publishFenceGeneration` first and records each
 *   retired row's before-state; a restore transplants the earlier fence block (generations/repair.ts) and re-attaches the
 *   retired rows of that block by id instead of inserting copies.
 * - `consolidation`: the dream consolidate phase closes the older members of a cluster at the next member's
 *   `valid_from` (`valid_until`) and marks them consolidated. A cluster whose members are not in strict chronological
 *   order is held (`tie`, #6023); a strict chain records each member's `valid_until`, `consolidated_at` and
 *   `consolidated_into` before it changes them, and `gbrain repair generations --kind consolidation --mode restore` puts
 *   them back.
 */
import type { BrainEngine } from '../../engine.ts';
import { digest } from '../../persistence/digest.ts';
import { readGenerationsConfig } from '../config.ts';
import type { GenerationAdapter, GenerationKey, ItemRow } from '../contract.ts';
import { factRowIdentity, fenceRowKey, FACT_FENCE_KIND, publishFenceGeneration, type FenceGenerationOutcome, type FenceItem, type FenceRead } from '../fence.ts';
import { activateGeneration, generationKeyLock, itemSetHash, readLiveGeneration, recordHeld } from '../publish.ts';
import { factsFenceHeld } from '../fence-evidence.ts';
import type { FactPreimage } from '../../engine-sql/facts.ts';

export type { FactPreimage };

export const CONSOLIDATION_KIND = 'consolidation';

/** The fence rows of the new generation (one per row number; a duplicate number keeps its first row, as the reconcile does). */
export function factFenceItems(rows: ReadonlyArray<{ row_num: number; fact: string; visibility?: string | null }>): FenceItem[] {
  const seen = new Set<number>();
  return rows.flatMap(row => {
    const rowNum = Number(row.row_num);
    if (seen.has(rowNum)) return [];
    seen.add(rowNum);
    const identityHash = factRowIdentity({ row_num: rowNum, fact: row.fact, visibility: row.visibility ?? 'private' });
    return [{ key: fenceRowKey(rowNum, identityHash), identityHash }];
  });
}

/** A stored fact a writer would retire: keyed by id, with its before-state. */
export function factRetireItem(preimage: FactPreimage): FenceItem {
  return { key: `fact:${preimage.id}`, preimage: preimage as unknown as Record<string, unknown>,
    identityHash: factRowIdentity({ row_num: Number(preimage.row_num ?? 0), fact: preimage.fact, visibility: preimage.visibility }) };
}

/** Before-states of the facts `ids` of `sourceId`. */
export async function factPreimages(db: BrainEngine, sourceId: string, ids: readonly number[]): Promise<FactPreimage[]> {
  return db.readFactPreimages(sourceId, ids);
}

/**
 * The page publication's fence projection (persistence/canonical-projections.ts): the rows it would expire and detach
 * are those attached to the page that the incoming fence no longer holds at the same number and claim (conversation
 * extractor rows only when a fence row claims their number, #5731). #8819: of the others, only a row some fence of the
 * page held, or whose claim the incoming fence states, retires (fence-evidence.ts); a row the fence never held is `kept`
 * active, since no fence edit withdrew it. #8194: a row `gbrain repair open-facts` opens in place (persistence/context.ts
 * openedFactRowSql) is neither retired nor kept: fence-guard moves it to world with its id.
 * Held: the caller expires nothing.
 */
export async function projectFactFenceGeneration(tx: BrainEngine, input: { sourceId: string; slug: string; read: FenceRead; incoming: string;
  rows: ReadonlyArray<{ row_num: number; fact: string; visibility?: string | null }>; writer: string; prior?: ReadonlySet<string> | null }):
  Promise<FenceGenerationOutcome & { retiring: number; retireIds: number[]; kept: number[] }> {
  const candidates = await tx.listFenceRetireCandidates({ sourceId: input.sourceId, slug: input.slug, incoming: input.incoming });
  const extractor = (row: FactPreimage) => (row.source ?? '').startsWith('cli:extract-conversation-facts');
  const { held } = await factsFenceHeld(tx, { sourceId: input.sourceId, slug: input.slug, rows: candidates.filter(row => !extractor(row)), prior: input.prior });
  const claims = new Set(input.rows.map(row => row.fact));
  const retire = candidates.filter(row => extractor(row) || held.has(Number(row.id)) || claims.has(row.fact));
  const outcome = await publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId: input.sourceId, slug: input.slug, read: input.read,
    items: factFenceItems(input.rows), retire: retire.map(factRetireItem), writer: input.writer });
  return { ...outcome, retiring: retire.length, retireIds: retire.map(row => Number(row.id)),
    kept: candidates.filter(row => !retire.includes(row)).map(row => Number(row.id)) };
}

/**
 * Puts a fact's recorded before-state back: lifecycle (`expired_at`, `valid_until`, `superseded_by`), consolidation
 * marks, and its fence position when that number is free. Only a row whose claim and visibility still match is changed;
 * returns whether it was.
 */
export async function restoreFactRow(tx: BrainEngine, sourceId: string, preimage: Record<string, unknown>): Promise<boolean> {
  return tx.restoreFactPreimage(sourceId, preimage);
}

/** One consolidation chain's identity: a member's id, its claim and the close it carries. */
const memberIdentity = (row: { id: number; fact: string; valid_until: string | null; consolidated_into: number | null }) =>
  digest(['consolidation-member-v1', Number(row.id), row.fact, row.valid_until ? new Date(row.valid_until).toISOString() : null, row.consolidated_into === null ? null : Number(row.consolidated_into)]).slice(0, 32);

/** The owner key of a consolidation cluster: its entity and sorted member ids. */
export const consolidationOwnerKey = (entitySlug: string, ids: readonly number[]) => `entity:${entitySlug}:cluster:${[...ids].map(Number).sort((a, b) => a - b).join(',')}`;
const clusterIds = (ownerKey: string) => (ownerKey.split(':cluster:')[1] ?? '').split(',').filter(Boolean).map(Number);

const memberKey = (id: number) => `fact:${Number(id)}`;

/**
 * After the consolidate phase closed a strict chain (`valid_until` and the consolidation marks of `before`'s members, in
 * the caller's transaction): records it as the cluster's live generation, each member at its new identity with its
 * `before` state as preimage. A cluster with no generation yet first records its members as they were (the baseline a
 * restore returns to).
 */
export async function recordConsolidationGeneration(tx: BrainEngine, sourceId: string, entitySlug: string, before: readonly FactPreimage[], runId?: string): Promise<void> {
  if (!before.length) return;
  const ids = before.map(row => Number(row.id));
  const key: GenerationKey = { kind: CONSOLIDATION_KIND, sourceId, ownerKey: consolidationOwnerKey(entitySlug, ids) };
  await tx.lockGenerationKey(generationKeyLock(key));
  const after = await factPreimages(tx, sourceId, ids);
  if (after.every((row, i) => memberIdentity(row) === memberIdentity(before[i]!))) return;
  const input = { pin: digest(['consolidation-input-v1', before.map(row => [row.id, row.fact])]), size: before.length };
  let live = await readLiveGeneration(tx, key);
  if (!live) {
    const baseline = before.map(row => ({ key: memberKey(row.id), identityHash: memberIdentity(row) }));
    await activateGeneration(tx, key, null, { operationId: digest(['consolidation-baseline-v1', key, baseline]), runId, input, setHash: itemSetHash(baseline),
      completeness: { complete: true, writer: 'consolidate', baseline: true } }, baseline.map(item => ({ ...item, action: 'kept' as const })));
    live = await readLiveGeneration(tx, key);
  }
  const prior = new Map(before.map(row => [Number(row.id), row]));
  const items = after.map(row => ({ key: memberKey(row.id), identityHash: memberIdentity(row) }));
  await activateGeneration(tx, key, live, { operationId: digest(['consolidation-v1', key, items]), runId, input, setHash: itemSetHash(items),
    completeness: { complete: true, writer: 'consolidate' } }, items.map(item => {
    const json = prior.get(Number(item.key.slice('fact:'.length))) as unknown as Record<string, unknown>;
    return { ...item, action: 'published' as const, preimage: { json, bytes: JSON.stringify(json).length } };
  }));
}

/** A cluster the consolidate phase will not close because its members tie (#6023): held `tie`, nothing written. */
export async function holdConsolidationTie(tx: BrainEngine, sourceId: string, entitySlug: string, ids: readonly number[], context: Record<string, unknown>): Promise<void> {
  const key: GenerationKey = { kind: CONSOLIDATION_KIND, sourceId, ownerKey: consolidationOwnerKey(entitySlug, ids) };
  await tx.lockGenerationKey(generationKeyLock(key));
  const items = [...ids].map(id => ({ key: memberKey(id), content: '', identityHash: memberKey(id) }));
  await recordHeld(tx, key, await readGenerationsConfig(tx), { key, items, input: null }, itemSetHash(items), 'tie', { members: ids.length, ...context });
}

/** Whether the operator restored this cluster's chain (`repair generations --kind consolidation --mode restore`): the consolidate phase leaves it open. */
export async function consolidationRestored(db: BrainEngine, sourceId: string, entitySlug: string, ids: readonly number[]): Promise<boolean> {
  return db.readGenerationRestored({ sourceId, kind: CONSOLIDATION_KIND, ownerKey: consolidationOwnerKey(entitySlug, ids) });
}

/** Clears the entity's `tie` holds before a consolidate pass re-records the ties it still finds. */
export async function clearConsolidationTies(db: BrainEngine, sourceId: string, entitySlug: string): Promise<void> {
  await db.clearTieHeldGenerationRows(sourceId, CONSOLIDATION_KIND, `entity:${entitySlug}:cluster:`);
}

/** The consolidation adapter: items are the cluster's member facts; a restore writes each member's before-state back. */
export const consolidationAdapter: GenerationAdapter<undefined> = {
  kind: CONSOLIDATION_KIND,
  retiredBy: 'generation-restore',
  modelProduced: false,
  strictOrder: true,
  lockKeys: () => [],
  async readInput(engine, key) {
    const ids = clusterIds(key.ownerKey);
    const rows = await factPreimages(engine, key.sourceId, ids);
    return rows.length ? { pin: digest(['consolidation-input-v1', rows.map(row => [row.id, row.fact, row.expired_at])]), size: rows.length } : null;
  },
  async readItems(engine, key, itemKeys) {
    const ids = [...new Set([...clusterIds(key.ownerKey), ...itemKeys.map(itemKey => Number(itemKey.replace(/^fact:/, '')))])];
    const rows = await factPreimages(engine, key.sourceId, ids);
    return new Map(rows.map(row => [`fact:${row.id}`, { key: `fact:${row.id}`, identityHash: memberIdentity(row), live: row.expired_at === null, owned: true, segmented: false,
      preimage: () => ({ json: row as unknown as Record<string, unknown>, bytes: JSON.stringify(row).length }) } satisfies ItemRow]));
  },
  legacyEvidence: async () => new Set(),
  publishItems: async () => { throw new Error('consolidation members publish through the consolidate phase'); },
  retireItems: async () => {},
  async restoreItem(tx: BrainEngine, key: GenerationKey, _itemKey: string, preimage: Record<string, unknown>) {
    if (!await restoreFactRow(tx, key.sourceId, preimage)) throw new Error(`consolidation member ${String(preimage.id)} changed; nothing restored`);
  },
  preimageIdentity: preimage => memberIdentity(preimage as unknown as FactPreimage),
};

/** The fact_fence adapter as the repair command resolves it: fence kinds restore by transplanting the fence (repair.ts). */
export const factFenceAdapter: GenerationAdapter<undefined> = {
  kind: FACT_FENCE_KIND,
  retiredBy: 'generation-restore',
  modelProduced: false,
  fence: 'facts',
  lockKeys: (key) => [{ sourceId: key.sourceId, slug: key.ownerKey.replace(/^page:/, '') }],
  readInput: async () => null,
  readItems: async () => new Map(),
  legacyEvidence: async () => new Set(),
  publishItems: async () => { throw new Error('fact_fence rows publish through the page fence (publishFenceGeneration)'); },
  retireItems: async () => { throw new Error('fact_fence rows retire through the page fence (publishFenceGeneration)'); },
  restoreItem: async (tx, key, _itemKey, preimage) => { await restoreFactRow(tx, key.sourceId, preimage); },
  preimageIdentity: preimage => factRowIdentity(preimage as unknown as { row_num: number; fact: string; visibility: string }),
};
