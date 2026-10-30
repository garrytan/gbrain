/**
 * GBRA-161 PR 2: the canonical fence kinds (`fact_fence`, `take_fence`) on the generation primitive (plan D4, D6). A page's
 * `## Facts` and takes fences are the system of record for the rows projected from them, so a fence that was read whole
 * and is valid is complete whatever its row count: rows that left it retire, and an empty fence retires them all
 * (`fenceParsedEmpty`). No shrink floor, valve or item cap applies to a canonical kind. A fence that is absent, unread or
 * segmented proves nothing: every writer that would retire rows on it (the page publication's projection, extract_facts,
 * extract takes) records a held generation (`generation_held`, reason `fence_absent`) and retires nothing. The rows of a
 * deleted page expire only on `originGone`, rechecked here under the caller's page key.
 *
 * Writers call `publishFenceGeneration` inside the transaction that already holds the page key (D7: page keys, then the
 * generation key). It decides, records the generation with the before-state of every row it retires or replaces, and
 * says whether the caller may retire; the caller's own statements do the writes in that same transaction.
 */
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable } from '../facts-fence.ts';
import { locateOutsideCode } from '../fence-scan.ts';
import type { BodyStorage } from '../page-body/types.ts';
import { digest } from '../persistence/digest.ts';
import { renderTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { readGenerationsConfig } from './config.ts';
import type { GenerationKey, HeldReason, Preimage } from './contract.ts';
import { activateGeneration, generationKeyLock, itemSetHash, readLiveGeneration, recordHeld, type LedgerItem } from './publish.ts';

export const FACT_FENCE_KIND = 'fact_fence';
export const TAKE_FENCE_KIND = 'take_fence';
export type FenceGenerationKind = typeof FACT_FENCE_KIND | typeof TAKE_FENCE_KIND;
export const FENCE_GENERATION_KINDS: readonly FenceGenerationKind[] = [FACT_FENCE_KIND, TAKE_FENCE_KIND];

/** The largest fence block a generation keeps for restore (UTF-8 bytes); a larger one restores nothing (`no_preimage`). */
export const FENCE_BLOCK_MAX_BYTES = 256 * 1024;
/** The largest before-state one row keeps (UTF-8 bytes of its JSON). */
const ROW_PREIMAGE_MAX_BYTES = 64 * 1024;

export const fenceOwnerKey = (slug: string) => `page:${slug}`;
export const fenceSlugOf = (ownerKey: string) => ownerKey.startsWith('page:') ? ownerKey.slice('page:'.length) : null;
export const fenceName = (kind: FenceGenerationKind) => kind === FACT_FENCE_KIND ? 'facts' as const : 'takes' as const;

/** One fence block per body section, exactly as the page holds it (markers included). */
export interface FenceBlocks { body: string | null; timeline: string | null }
export type FenceRead = { state: 'parsed'; blocks: FenceBlocks } | { state: 'absent' | 'unread' | 'segmented' };

/** The page's `fence` blocks outside markdown code, or `absent` when neither section holds one; a segmented page is never read whole. */
export function readFenceBlocks(page: { compiled_truth: string | null; timeline?: string | null; body_storage?: BodyStorage | null }, fence: 'facts' | 'takes'): FenceRead {
  if (page.body_storage === 'segmented') return { state: 'segmented' };
  const [begin, end] = fence === 'facts' ? [FACTS_FENCE_BEGIN, FACTS_FENCE_END] : [TAKES_FENCE_BEGIN, TAKES_FENCE_END];
  const block = (text: string | null | undefined) => {
    const { beginIdx, endIdx } = locateOutsideCode(text ?? '', begin, end);
    return beginIdx !== -1 && endIdx > beginIdx ? text!.slice(beginIdx, endIdx + end.length) : null;
  };
  return fenceReadOf({ body: block(page.compiled_truth), timeline: block(page.timeline) });
}

/** The read of a fence whose blocks were read whole (each from its begin to its end marker): `absent` when neither section holds one. */
export const fenceReadOf = (blocks: FenceBlocks): FenceRead => blocks.body === null && blocks.timeline === null ? { state: 'absent' } : { state: 'parsed', blocks };

/** A row's identity: what makes it the same canonical row (number and claim; visibility for facts, kind and holder for takes). */
export const factRowIdentity = (row: { row_num: number; fact: string; visibility: string }) =>
  digest(['fact-fence-row-v1', Number(row.row_num), row.fact, row.visibility]).slice(0, 32);
export const takeRowIdentity = (row: { row_num: number; claim: string; kind: string; holder: string }) =>
  digest(['take-fence-row-v1', Number(row.row_num), row.claim, row.kind, row.holder]).slice(0, 32);

/** One fence row of the new generation, or a stored row it retires or replaces (with its before-state). */
export interface FenceItem { key: string; identityHash: string; preimage?: Record<string, unknown> }
export const fenceRowKey = (rowNum: number, identity: string) => `row:${rowNum}:${identity.slice(0, 12)}`;

export interface FenceGenerationRequest {
  kind: FenceGenerationKind;
  sourceId: string;
  slug: string;
  read: FenceRead;
  /** The rows the fence holds after this write. */
  items: readonly FenceItem[];
  /** Stored rows the writer would retire (left the fence, or every row of an empty fence or a deleted page). */
  retire: readonly FenceItem[];
  /** Stored rows the writer overwrites in place with a different identity (a take replaced at its row number). */
  overwrite?: readonly FenceItem[];
  /**
   * The page is deleted: its rows retire on `originGone`, rechecked here: the page is gone under the caller's key, and the
   * rows were derived from a fence (a live generation, or `read` of the deleted page's stored body parses one).
   */
  originGone?: boolean;
  /** Which writer published (projection, extract_facts, extract_takes, deleted_page, restore). */
  writer: string;
  runId?: string;
}

export type FenceGenerationOutcome =
  | { state: 'published'; generation: number }
  | { state: 'unchanged' }
  | { state: 'held'; reason: HeldReason; holdId: string };

const preimageOf = (json: Record<string, unknown> | undefined): Preimage | undefined => {
  if (!json) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(json), 'utf8');
  return { json: bytes <= ROW_PREIMAGE_MAX_BYTES ? json : null, bytes };
};

/** The input pin of a read fence: its blocks as the page holds them. */
export function fenceInput(read: FenceRead): { pin: string; size: number } | null {
  if (read.state !== 'parsed') return null;
  return { pin: digest(['fence-blocks-v1', read.blocks.body, read.blocks.timeline]),
    size: Buffer.byteLength(`${read.blocks.body ?? ''}${read.blocks.timeline ?? ''}`, 'utf8') };
}

function storedBlocks(read: FenceRead): FenceBlocks | null {
  if (read.state !== 'parsed') return null;
  return Buffer.byteLength(`${read.blocks.body ?? ''}${read.blocks.timeline ?? ''}`, 'utf8') <= FENCE_BLOCK_MAX_BYTES ? read.blocks : null;
}

/** Whether `slug` is deleted (or gone) in `sourceId`, read under the caller's page key. */
async function originGoneNow(tx: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const rows = await tx.executeRaw<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return !rows.length || rows.every(row => row.deleted);
}

/**
 * Decides one fence write and records it. `published`: the caller retires every row of `retire` (and overwrites
 * `overwrite`); `unchanged`: the fence owns what the live generation recorded and nothing retires; `held`: retire nothing.
 */
export async function publishFenceGeneration(tx: BrainEngine, request: FenceGenerationRequest): Promise<FenceGenerationOutcome> {
  const key: GenerationKey = { kind: request.kind, sourceId: request.sourceId, ownerKey: fenceOwnerKey(request.slug) };
  const overwrite = request.overwrite ?? [];
  if (!request.items.length && !request.retire.length && !overwrite.length) {
    if (request.read.state === 'parsed') await clearFenceHold(tx, key);
    return { state: 'unchanged' };
  }
  await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [generationKeyLock(key)]);
  const live = await readLiveGeneration(tx, key);
  const input = fenceInput(request.read);
  const setHash = itemSetHash(request.items);
  const hold = async (reason: HeldReason): Promise<FenceGenerationOutcome> => {
    const proposal = request.items.map(item => ({ key: item.key, content: '', identityHash: item.identityHash }));
    const outcome = await recordHeld(tx, key, await readGenerationsConfig(tx), { key, items: proposal, input, runId: request.runId }, setHash, reason,
      { slug: request.slug, fence: fenceName(request.kind), writer: request.writer, read: request.read.state, rows: request.retire.length });
    return outcome.state === 'held' ? { state: 'held', reason: outcome.reason, holdId: outcome.holdId } : { state: 'unchanged' };
  };
  let proof: string | null = null;
  if (request.retire.length) {
    if (request.originGone) {
      if (!await originGoneNow(tx, request.sourceId, request.slug) || (!live && request.read.state !== 'parsed')) return hold('no_proof');
      proof = 'originGone';
    } else if (request.read.state !== 'parsed') {
      return hold('fence_absent');
    } else if (!request.items.length) {
      proof = 'fenceParsedEmpty';
    }
  }
  const recorded = live?.items ?? new Map<string, string>();
  if (live && !request.retire.length && !overwrite.length && recorded.size === request.items.length
    && request.items.every(item => recorded.get(item.key) === item.identityHash)) {
    if (request.read.state === 'parsed') await clearFenceHold(tx, key);
    return { state: 'unchanged' };
  }
  const replaced = new Map(overwrite.map(item => [item.key, item]));
  const items: LedgerItem[] = [
    ...request.items.map(item => ({ key: item.key, identityHash: item.identityHash, action: recorded.has(item.key) ? 'kept' as const : 'published' as const,
      ...(replaced.get(item.key)?.preimage ? { preimage: preimageOf(replaced.get(item.key)!.preimage) } : {}) })),
    ...request.retire.map(item => ({ key: item.key, identityHash: item.identityHash, action: 'retired' as const, preimage: preimageOf(item.preimage) })),
  ];
  const operationId = digest(['fence-generation-v1', key, live?.generation ?? 0, input?.pin ?? null, setHash, request.retire.map(item => item.key).sort(), request.writer]);
  const activated = await activateGeneration(tx, key, live, { operationId, runId: request.runId, input, setHash,
    completeness: { complete: true, writer: request.writer, proof, fence: storedBlocks(request.read), fence_bytes: input?.size ?? null } }, items);
  return { state: 'published', generation: activated.generation };
}

/** A readable fence answers a held `fence_absent` (or `no_proof`) row: it is the proof the hold waited for. */
async function clearFenceHold(tx: BrainEngine, key: GenerationKey): Promise<void> {
  await tx.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason IN ('fence_absent','no_proof')`,
    [key.sourceId, key.kind, key.ownerKey]);
}

/** A held fence result, as doctor, `get_page` and `gbrain sync status` list it. */
export interface FenceHold { source_id: string; kind: FenceGenerationKind; slug: string; reason: HeldReason; read: string; rows: number; since: string; writer: string | null }

/** The held fence results of `sources` (one page with `slug`), oldest first. */
export async function listFenceHolds(db: BrainEngine, sources: readonly string[], slug?: string): Promise<FenceHold[]> {
  const params: unknown[] = [[...sources], [...FENCE_GENERATION_KINDS]];
  if (slug !== undefined) params.push(fenceOwnerKey(slug));
  const rows = await db.executeRaw<{ source_id: string; kind: FenceGenerationKind; owner_key: string; held_reason: HeldReason; held_context: Record<string, unknown> | null; created_at: string }>(
    `SELECT source_id, kind, owner_key, held_reason, held_context, created_at::text AS created_at FROM derived_generations
      WHERE source_id = ANY($1::text[]) AND kind = ANY($2::text[]) AND state = 'held'${slug === undefined ? '' : ' AND owner_key = $3'}
      ORDER BY created_at, id`, params);
  return rows.map(row => ({ source_id: row.source_id, kind: row.kind, slug: fenceSlugOf(row.owner_key) ?? row.owner_key, reason: row.held_reason,
    read: String(row.held_context?.read ?? 'absent'), rows: Number(row.held_context?.rows ?? 0), since: row.created_at,
    writer: typeof row.held_context?.writer === 'string' ? row.held_context.writer : null }));
}

/** A held fence result with the owner's decision it waits for (`fenceAbsentFix`), as the three surfaces show it. */
export type FenceHoldEntry = FenceHold & { fix: Action };

/** `listFenceHolds` with each hold's fix; a page without a recorded file gets the put_page/edit_page form. At most `limit`. */
export async function fenceHoldEntries(db: BrainEngine, sources: readonly string[], opts: { slug?: string; limit?: number } = {}): Promise<FenceHoldEntry[]> {
  const holds = (await listFenceHolds(db, sources, opts.slug)).slice(0, opts.limit ?? 20);
  if (!holds.length) return [];
  const files = await db.executeRaw<{ source_id: string; slug: string; database_only: boolean }>(
    `SELECT source_id, slug, NULLIF(btrim(source_path), '') IS NULL AS database_only FROM pages
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [[...new Set(holds.map(hold => hold.source_id))], holds.map(hold => hold.slug)]);
  const databaseOnly = new Map(files.map(row => [`${row.source_id}\u0000${row.slug}`, row.database_only === true]));
  return holds.map(hold => ({ ...hold, fix: fenceAbsentFix(hold, { databaseOnly: databaseOnly.get(`${hold.source_id}\u0000${hold.slug}`) ?? false }) }));
}

/** The exact empty fence that retires every row of `fence` on the next write (`fenceParsedEmpty`). */
export function emptyFenceBlock(fence: 'facts' | 'takes'): string {
  return fence === 'facts' ? `## Facts\n\n${renderFactsTable([])}\n` : `## Takes\n\n${renderTakesFence([])}\n`;
}

/**
 * The owner's decision a held fence waits for (`ask_user`). For an absent fence: whether the section was removed on
 * purpose. Restoring the fence keeps the rows; writing the empty fence retires them. Neither is the default and nothing
 * runs without the user. A database-only page (no file to edit) changes through `put_page` (`edit_page` refuses fence markers).
 */
export function fenceAbsentFix(hold: Pick<FenceHold, 'source_id' | 'kind' | 'slug' | 'rows' | 'read' | 'reason'>, opts: { databaseOnly: boolean }): Action {
  const fence = fenceName(hold.kind);
  const section = fence === 'facts' ? '## Facts' : '## Takes';
  const what = `${hold.rows} ${fence === 'facts' ? 'fact' : 'take'} row(s)`;
  if (hold.reason !== 'fence_absent' || hold.read !== 'absent') {
    return { consent: [], actor: 'user', requires_exclusive: false, ask_user: true,
      why: `The ${fence} rows of ${hold.slug} (source ${hold.source_id}) were held (${hold.reason}, fence ${hold.read}), so gbrain kept its ${what} live instead of retiring them; `
        + 'nothing was retired. Ask the user whether the page should keep these rows; the next write that reads the whole fence (or, for a deleted page, finds it still deleted) reconciles them.',
      user_message: `gbrain could not confirm the ${section} section of ${hold.slug}, so it kept its ${what} as they were. Nothing was removed.`,
      verify: { argv: ['gbrain', 'doctor', '--only', 'generation_held', '--json'] }, docs: 'docs/guides/repair.md#fence-absent' };
  }
  const block = emptyFenceBlock(fence);
  const write = opts.databaseOnly
    ? ' This page has no file, so either change is a put_page: read it with get_page (include_content: true), then put_page with that revision as expected_revision and the full '
      + 'content with the section restored or the empty block appended (edit_page refuses to write fence markers).'
    : ' Edit the page\'s file and sync it, or read it with get_page (include_content: true) and put_page the full content with that revision as expected_revision.';
  return { consent: [], actor: 'user', requires_exclusive: false, ask_user: true,
    why: `Page ${hold.slug} (source ${hold.source_id}) was written without its ${section} section, so gbrain kept its ${what} live instead of retiring them; `
      + `nothing was retired. The user may have deleted the whole ${section} section on purpose, or an edit may have lost it: ask which. `
      + `To keep the rows, restore the ${section} section (from the page's history or the previous version of its file). `
      + `To retire them, write this exact empty fence into the page; the next write retires every row on it:\n${block}${write}`,
    user_message: `The ${section} section of ${hold.slug} is gone, so gbrain kept its ${what} instead of deleting them. Did you mean to remove them? `
      + `To keep them, restore the ${section} section. To remove them, add this empty section to the page:\n${block}`,
    verify: { argv: ['gbrain', 'doctor', '--only', 'generation_held', '--json'] },
    docs: 'docs/guides/repair.md#fence-absent' };
}
