/**
 * `gbrain repair accepted-takes` (v0.60.253.0 accept bug): restore takes that
 * an owner accept of a held strike-through or kind change removed.
 *
 * On v0.60.253.0, accepting a held `forget` proposal whose take the page's
 * fence still carried with the same claim (a strike-through, the guard's
 * `deactivated` change, or a kind or holder change, a same-claim `replaced`)
 * ran an owner `takes_remove`: the row left the fence (a reservation row kept
 * its number) and the takes index. The accept should have applied the fence
 * row as the page said. A later sync or publish cannot bring it back: the
 * page no longer carries the row.
 *
 * Only what the records prove is restored. An item needs all of:
 *   1. an accepted `forget` proposal on a take, `change` deactivated or
 *      replaced, filed by a page publish or reconcile (not `takes_remove`);
 *   2. the committed `takes_remove` receipt bound to that proposal
 *      (`intent.trust_accept`), naming the page and the row number;
 *   3. the page version that receipt archived (`archived_write_request_id`),
 *      whose takes fence holds the row at that number: the row the accept
 *      should have applied;
 *   4. the live page's fence still holding the reservation row at that number,
 *      with no take there in the fence or the index.
 * The apply republishes the live page with that fence row in place of its
 * reservation (a revision-bound `put_page`), then lowers the restored take to
 * the tier of the write the owner accepted when the republish stamped it
 * higher. What the records never held cannot come back: a grade or resolution
 * stored only in the database, the take's id and its embedding (re-embedded).
 *
 * Explicit-only and preview-bound: the preview lists each take with its
 * evidence and saves the set under its hash; `--apply --expect <hash>`
 * restores exactly that set, rechecking every condition per item.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { stableJson } from '../persistence/digest.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { materializedSnapshot, segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { locateOutsideCode } from '../fence-scan.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, renderTakesFence, type ParsedTake } from '../takes-fence.ts';
import { setRowTier } from '../trust/page-handlers.ts';
import { compareTrust, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#accepted-takes';
const COMMAND = 'gbrain repair accepted-takes';

/** One take the records prove an accept removed, with the fence row to restore. */
export interface RemovedTake {
  proposal_id: number; source_id: string; slug: string; page_id: number; row_num: number;
  receipt_id: string; version_id: number; change: string; writer_tier: TrustTier; row: ParsedTake;
}
interface AcceptedTakeItem extends RepairItem { take: RemovedTake; hash: string; last: boolean }
type Residual = 'version_missing' | 'row_not_in_version' | 'row_number_in_use' | 'page_missing' | 'fence_unreadable';

interface Candidate { proposal_id: number; source_id: string; slug: string; page_id: number; row_num: number; receipt_id: string; change: string; writer_tier: string }

async function candidates(engine: BrainEngine, sourceIds: readonly string[], proposalId?: number): Promise<Candidate[]> {
  return engine.executeRaw<Candidate>(`SELECT p.id::int AS proposal_id, r.source_id, r.slug, r.page_id::int AS page_id,
      (r.intent->>'row_num')::int AS row_num, r.id::text AS receipt_id, p.before_state->>'change' AS change,
      p.before_state->>'writer_tier' AS writer_tier
    FROM trust_proposals p
    JOIN persistence_requests r ON r.operation = 'takes_remove' AND r.state = 'committed' AND r.source_id = p.source_id
      AND r.intent->>'trust_accept' = p.id::text AND r.page_id IS NOT NULL AND (r.intent->>'row_num') ~ '^[0-9]+$'
    WHERE p.action = 'forget' AND p.target_table = 'takes' AND p.status = 'accepted' AND p.proposer <> 'takes_remove'
      AND p.before_state->>'change' IN ('deactivated', 'replaced') AND p.source_id = ANY($1::text[])
      AND ($2::bigint IS NULL OR p.id = $2::bigint)
    ORDER BY p.id`, [[...sourceIds], proposalId ?? null]);
}

/** The archived fence row the accept should have applied, or why it cannot be read. */
async function archivedRow(engine: BrainEngine, c: Candidate): Promise<{ version_id: number; row: ParsedTake } | Residual> {
  const [version] = await engine.executeRaw<{ id: number; body_storage: string | null; compiled_truth: string | null; timeline: string | null }>(
    `SELECT id::int AS id, body_storage, compiled_truth, timeline FROM page_versions
      WHERE page_id = $1 AND archived_write_request_id::text = $2 ORDER BY id DESC LIMIT 1`, [c.page_id, c.receipt_id]);
  if (!version || version.body_storage === 'segmented' || version.compiled_truth === null) return 'version_missing';
  const row = parseTakesFence(`${version.compiled_truth}\n${version.timeline ?? ''}`).takes.find(t => t.rowNum === c.row_num);
  return row ? { version_id: Number(version.id), row } : 'row_not_in_version';
}

/** The live page's markdown and revision when its fence still reserves `rowNum` and nothing else uses it. */
async function livePage(engine: BrainEngine, take: Pick<RemovedTake, 'source_id' | 'slug' | 'page_id' | 'row_num'>): Promise<{ content: string; revision: string; takes: ParsedTake[]; reserved: number[] } | Residual> {
  const raw = await engine.readPageSnapshot(take.slug, { sourceId: take.source_id });
  if (!raw || Number(raw.page.id) !== take.page_id) return 'page_missing';
  if (segmentedOverCeiling(raw.page as never)) return 'fence_unreadable';
  const snapshot = (await materializedSnapshot(engine, raw))!;
  const content = serializePageToMarkdown(snapshot.page, snapshot.tags);
  if (content.split(TAKES_FENCE_BEGIN).length !== 2) return 'fence_unreadable';
  const fence = parseTakesFence(content);
  if (fence.warnings.length) return 'fence_unreadable';
  const [stored] = await engine.executeRaw('SELECT 1 FROM takes WHERE page_id = $1 AND row_num = $2', [take.page_id, take.row_num]);
  if (stored || fence.takes.some(t => t.rowNum === take.row_num) || !fence.reservedRowNums.includes(take.row_num)) return 'row_number_in_use';
  return { content, revision: snapshot.revision, takes: fence.takes, reserved: fence.reservedRowNums };
}

/** Every take of the selected sources the records prove restorable, and the count of each reason one is not. */
export async function scanRemovedTakes(engine: BrainEngine, sourceIds: readonly string[], proposalId?: number): Promise<{ takes: RemovedTake[]; residuals: Record<Residual, number> }> {
  const residuals: Record<Residual, number> = { version_missing: 0, row_not_in_version: 0, row_number_in_use: 0, page_missing: 0, fence_unreadable: 0 };
  const takes: RemovedTake[] = [];
  for (const c of await candidates(engine, sourceIds, proposalId)) {
    const archived = await archivedRow(engine, c);
    if (typeof archived === 'string') { residuals[archived]++; continue; }
    const live = await livePage(engine, c);
    if (typeof live === 'string') { residuals[live]++; continue; }
    takes.push({ proposal_id: c.proposal_id, source_id: c.source_id, slug: c.slug, page_id: c.page_id, row_num: c.row_num, receipt_id: c.receipt_id,
      version_id: archived.version_id, change: c.change, writer_tier: storedTrustTier(c.writer_tier), row: archived.row });
  }
  return { takes, residuals };
}

const label = (t: RemovedTake) => `${t.row.active ? '' : '~~'}${t.row.claim}${t.row.active ? '' : '~~'} (${t.row.kind}, ${t.row.holder})`;
const hashParts = (scope: RepairScope, takes: RemovedTake[]) => ({ kind: 'accepted-takes-v1', brain_id: scope.brain_id, source_ids: scope.source_ids, takes });
const item = (take: RemovedTake, hash: string, last: boolean): AcceptedTakeItem => ({ cursor: { phase: 1, id: take.proposal_id }, source_id: take.source_id,
  slug: take.slug, chars: 0, action: `restore_take:#${take.row_num}`, take, hash, last });

export const acceptedTakesRepair: RepairHandler = {
  kind: 'accepted-takes',
  async plan(engine, scope, after, opts) {
    const scan = await scanRemovedTakes(engine, scope.source_ids);
    if (!opts?.apply) {
      const hash = previewHash(hashParts(scope, scan.takes));
      if (scan.takes.length) await saveApprovedSet(engine, { command: 'accepted-takes', hash }, scan.takes);
      return {
        items: scan.takes.map((take, index) => item(take, hash, index === scan.takes.length - 1)), preview_hash: hash, residuals: scan.residuals,
        listing: scan.takes.map(t => ({ item: `${t.source_id}:${t.slug}#${t.row_num}`, class: `accepted_${t.change}`,
          detail: `tp${t.proposal_id} removed ${label(t)}; restored from page version ${t.version_id} at "${t.writer_tier}"` })),
        ...(scan.takes.length ? { warnings: ['A grade or resolution the database alone held, and the take\'s id, are not in any record and are not restored.'] } : {}),
        details: { docs: DOCS },
      };
    }
    if (!opts.expect) {
      throw opError('invalid_params', `${COMMAND} --apply restores only the set a preview printed.`,
        `Preview first: ${COMMAND} — then, after the user agrees, run the apply command it prints: ${COMMAND} --apply --expect <preview-hash>`,
        { fix: readFix('Previews the takes the records prove an accept removed; writes nothing.', { argv: ['gbrain', 'repair', 'accepted-takes', '--json'] }), docs: DOCS });
    }
    const approved = await loadApprovedSet<RemovedTake>(engine, { command: 'accepted-takes', hash: opts.expect, previewCommand: COMMAND,
      emptyHash: async () => previewHash(hashParts(scope, [])) });
    const items = approved.items.map((take, index) => item(take, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { take, hash, last } = entry as AcceptedTakeItem;
    try {
      return await restoreTake(ctx.engine, ctx, entry, take);
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'accepted-takes', hash });
    }
  },
  render(details) {
    return [`  each restored take: republished from the page version its removal archived; guide: ${details.docs}`];
  },
};

const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason: `${reason}; run ${COMMAND} again for a new preview.` });

async function restoreTake(engine: BrainEngine, ctx: Parameters<RepairHandler['apply']>[0], entry: RepairItem, take: RemovedTake): Promise<RepairItemOutcome> {
  const [now] = (await scanRemovedTakes(engine, [take.source_id], take.proposal_id)).takes;
  if (!now || now.version_id !== take.version_id || now.row_num !== take.row_num || stableJson(now.row) !== stableJson(take.row)) {
    return changed(`take #${take.row_num} on ${take.slug} is no longer restorable as previewed`);
  }
  const live = await livePage(engine, take);
  if (typeof live === 'string') return changed(`page ${take.slug} changed (${live})`);
  const rows = [...live.takes, take.row].sort((a, b) => a.rowNum - b.rowNum);
  const { beginIdx, endIdx } = locateOutsideCode(live.content, TAKES_FENCE_BEGIN, TAKES_FENCE_END);
  const content = live.content.slice(0, beginIdx) + renderTakesFence(rows, live.reserved.filter(n => n !== take.row_num)) + live.content.slice(endIdx + TAKES_FENCE_END.length);
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: take.slug, source_id: take.source_id, content, expected_revision: live.revision,
    request_id: await repairRequestId(ctx, 'accepted-takes', entry, live.revision) } });
  const [restored] = await engine.executeRaw<{ id: number; trust_tier: string }>('SELECT id::int AS id, trust_tier FROM takes WHERE page_id = $1 AND row_num = $2',
    [take.page_id, take.row_num]);
  if (restored && compareTrust(storedTrustTier(restored.trust_tier), take.writer_tier) > 0) {
    await setRowTier(engine, { table: 'takes', id: Number(restored.id), sourceId: take.source_id, tier: take.writer_tier, note: { repair: 'accepted-takes', proposal: take.proposal_id } });
  }
  return { applied: true, outcome: 'restored', detail: { proposal: `tp${take.proposal_id}`, row_num: take.row_num, version_id: take.version_id, tier: take.writer_tier } };
}
