/**
 * `gbrain repair purged-change-reasons` (GST-2886, #8635 follow-up): clear change reasons that a sync stored after a fact
 * purge had tombstoned them.
 *
 * Before #8635, a sync could read a page's `gbrain-reason` trailer, a fact purge could then commit and tombstone that
 * (source, commit, path), and the import would still store the purged text as the snapshot's `page_versions.change_reason`.
 * The fix stops new leaks; this repair finds the rows already stored. The purged claim is gone, so the match never uses it:
 * for each `reason_purge_tombstones` row the commit's trailers are read again from the source's checkout, with the same
 * functions sync uses, to get the exact text T the import stored. A version of a page in that source whose
 * `change_reason` equals T is a candidate:
 *   - evidenced: its `source_path` is a spelling of the tombstoned path;
 *   - path_mismatch (kept): another or no `source_path`; cleared only with `--include-ambiguous` and that preview's hash.
 * A tombstone whose commit or trailer can no longer be read counts `unreadable_commit`; a source with no checkout (a
 * repo-less source) never stored a Git reason and counts `sources_without_checkout`. Neither refuses.
 *
 * The preview prints a per-brain count, a count per source and a few `<source>:<slug>@v<id>` items, never the reason
 * text, and saves the approved set (row ids and text digests, never the text). The apply, bound to that hash and the
 * user's consent, takes the source `FOR UPDATE` as a purge does and sets exactly the approved rows whose reason still
 * has the previewed digest to '[purged]', the value the purge's own redaction writes; any other row is reported
 * changed_since_preview and kept. Git history is never rewritten. Never automatic.
 */
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { canonicalChangeReason } from '../persistence/change-reason.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { gitTopLevel, pathForms, readReasonTrailers, trailerTexts, type TrailerCommit } from '../reason-trailers.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan } from './core.ts';

const COMMAND = 'purged-change-reasons' as const;
const DOCS = 'docs/guides/repair.md#purged-change-reasons';
const BATCH_ROWS = 500;
const SAMPLES = 5;
const PURGED_REASON = '[purged]';

export type LeakedReasonClass = 'evidenced' | 'path_mismatch';

export interface LeakedReason { id: number; source_id: string; slug: string; class: LeakedReasonClass; text_hash: string }

export interface LeakedReasonScan { rows: LeakedReason[]; unreadable_commit: number; without_checkout: boolean }

interface Approved { source_id: string; include_ambiguous: boolean; scope: string[]; rows: LeakedReason[] }
interface BatchItem extends RepairItem { batch: Approved; hash: string; last: boolean }
interface Details { brain_total: number; by_source: Record<string, number>; samples: Record<string, string[]>; sources_without_checkout: number }

const textHash = (text: string) => digest(['purged-change-reason', text]);

/** The source's checkout, found the way the purge's trailer scan finds it; null for a repo-less source. */
async function checkoutRoot(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  const root = source?.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  return root && isAbsolute(root) ? root : null;
}

async function readCommit(gitRoot: string, sha: string): Promise<TrailerCommit | null> {
  let found: TrailerCommit | null = null;
  const read = await readReasonTrailers(gitRoot, `${sha}^!`, 1, commit => { if (commit.sha === sha) found = commit; });
  return read.status === 'complete' ? found : null;
}

/** Every stored change reason of the source that is the trailer text of one of its tombstoned (commit, path) pairs. Read-only. */
export async function findLeakedChangeReasons(engine: BrainEngine, sourceId: string): Promise<LeakedReasonScan> {
  const tombstones = await engine.executeRaw<{ commit_sha: string; path: string }>(
    'SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1 ORDER BY commit_sha, path', [sourceId]);
  const root = await checkoutRoot(engine, sourceId);
  if (!root) return { rows: [], unreadable_commit: tombstones.length, without_checkout: true };
  const repo = tombstones.length ? gitTopLevel(root) : null;
  if (!repo) return { rows: [], unreadable_commit: tombstones.length, without_checkout: false };
  const forms = pathForms(repo.scopePrefix);
  const commits = new Map<string, TrailerCommit | null>();
  const pathsByText = new Map<string, Set<string>>();
  let unreadable = 0;
  for (const tombstone of tombstones) {
    if (!commits.has(tombstone.commit_sha)) commits.set(tombstone.commit_sha, await readCommit(repo.gitRoot, tombstone.commit_sha));
    const commit = commits.get(tombstone.commit_sha);
    const raw = commit ? trailerTexts(commit, forms).byPath.get(tombstone.path) : undefined;
    const text = raw === undefined ? null : canonicalChangeReason(raw);
    if (text === null) { unreadable++; continue; }
    const paths = pathsByText.get(text) ?? new Set<string>();
    for (const form of forms(tombstone.path)) paths.add(form);
    pathsByText.set(text, paths);
  }
  if (!pathsByText.size) return { rows: [], unreadable_commit: unreadable, without_checkout: false };
  const rows = await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; reason: string }>(
    `SELECT v.id, p.slug, v.source_path, v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND v.change_reason = ANY($2::text[]) ORDER BY v.id`, [sourceId, [...pathsByText.keys()]]);
  return {
    rows: rows.map(row => ({ id: Number(row.id), source_id: sourceId, slug: row.slug, text_hash: textHash(row.reason),
      class: row.source_path !== null && pathsByText.get(row.reason)!.has(row.source_path) ? 'evidenced' : 'path_mismatch' })),
    unreadable_commit: unreadable, without_checkout: false,
  };
}

async function previewCommand(engine: BrainEngine, sourceIds: string[], includeAmbiguous: boolean): Promise<string> {
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM sources WHERE archived IS NOT TRUE');
  return `gbrain repair ${COMMAND}${sourceIds.length === 1 && Number(n) > 1 ? ` --source ${sourceIds[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

function batchItems(batches: Approved[], hash: string): BatchItem[] {
  return batches.map((batch, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: batch.source_id, slug: batch.rows[0]!.slug, chars: 0,
    action: `set ${batch.rows.length} leaked change reason(s) to '${PURGED_REASON}'`, batch, hash, last: index === batches.length - 1 }));
}

const sourcesOf = (engine: BrainEngine, ids: string[]) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [ids]);

const itemName = (row: LeakedReason) => `${row.source_id}:${row.slug}@v${row.id}`;

export const purgedChangeReasonsRepair: RepairHandler = {
  kind: COMMAND,
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    const command = await previewCommand(engine, scope.source_ids, includeAmbiguous);
    const hashOf = async (rows: LeakedReason[]) => previewHash({ kind: 'purged-change-reasons-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, scope.source_ids),
      selection: { source_ids: scope.source_ids, include_ambiguous: includeAmbiguous }, rows });
    if (opts?.apply) {
      if (!opts.expect) {
        throw new OperationError('invalid_params', `gbrain repair ${COMMAND} --apply clears only the set a preview printed.`,
          `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
      }
      const approved = await loadApprovedSet<Approved>(engine, { command: COMMAND, hash: opts.expect, previewCommand: command, emptyHash: () => hashOf([]) });
      const scopeKey = JSON.stringify(scope.source_ids);
      if (approved.items.some(batch => batch.include_ambiguous !== includeAmbiguous || JSON.stringify(batch.scope) !== scopeKey)) throw previewChangedError(opts.expect, command);
      const items = batchItems(approved.items, opts.expect).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { command: COMMAND, hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    const rows: LeakedReason[] = [];
    let unreadable = 0;
    let withoutCheckout = 0;
    for (const sourceId of scope.source_ids) {
      const scan = await findLeakedChangeReasons(engine, sourceId);
      rows.push(...scan.rows);
      unreadable += scan.unreadable_commit;
      if (scan.without_checkout) withoutCheckout++;
    }
    const batches: Approved[] = [];
    for (const row of rows.filter(r => r.class === 'evidenced' || includeAmbiguous)) {
      const open = batches.at(-1);
      if (open && open.source_id === row.source_id && open.rows.length < BATCH_ROWS) open.rows.push(row);
      else batches.push({ source_id: row.source_id, include_ambiguous: includeAmbiguous, scope: scope.source_ids, rows: [row] });
    }
    const hash = await hashOf(batches.length ? rows : []);
    if (batches.length) await saveApprovedSet(engine, { command: COMMAND, hash }, batches);
    const details: Details = { brain_total: 0, by_source: {}, samples: {}, sources_without_checkout: withoutCheckout };
    for (const row of batches.flatMap(batch => batch.rows)) {
      details.brain_total++;
      details.by_source[row.source_id] = (details.by_source[row.source_id] ?? 0) + 1;
      const samples = details.samples[row.source_id] ??= [];
      if (samples.length < SAMPLES) samples.push(itemName(row));
    }
    const kept = includeAmbiguous ? 0 : rows.filter(r => r.class === 'path_mismatch').length;
    return { items: batchItems(batches, hash), preview_hash: hash, details: details as unknown as Record<string, unknown>,
      residuals: { path_mismatch: kept, unreadable_commit: unreadable, sources_without_checkout: withoutCheckout } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const item = entry as BatchItem;
    const result = await maintenanceTransaction(ctx.engine, tx => clearBatch(tx, item.batch));
    if (item.last) await clearApprovedSet(ctx.engine, { command: COMMAND, hash: item.hash });
    if (!result.cleared.length) return { applied: false, outcome: 'changed_since_preview', reason: 'every approved row changed since the preview' };
    return { applied: true, outcome: 'cleared', detail: { cleared: result.cleared.length, ...(result.changed.length ? { changed_since_preview: result.changed } : {}) } };
  },
  render(raw): string[] {
    const details = raw as unknown as Details;
    const lines = [`  ${details.brain_total} leaked change reason(s) in ${Object.keys(details.by_source).length} source(s) of this brain`];
    for (const [sourceId, count] of Object.entries(details.by_source)) {
      const samples = details.samples[sourceId] ?? [];
      lines.push(`    ${sourceId}: ${count}`, ...samples.map(item => `      ${item}`));
      if (count > samples.length) lines.push(`      and ${count - samples.length} more`);
    }
    if (details.sources_without_checkout) lines.push(`  ${details.sources_without_checkout} source(s) without a Git checkout: nothing to check (no Git reason was ever stored there)`);
    return lines;
  },
};

/**
 * Under the source lock a purge takes: set each approved row whose reason still has the previewed digest to '[purged]'.
 * Nothing outside the approved ids is read for writing.
 */
async function clearBatch(tx: BrainEngine, batch: Approved): Promise<{ cleared: number[]; changed: number[] }> {
  await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR UPDATE', [batch.source_id]);
  const ids = batch.rows.map(row => row.id);
  const current = new Map((await tx.executeRaw<{ id: number | string; reason: string | null }>(
    `SELECT v.id, v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND v.id = ANY($2::bigint[]) FOR UPDATE OF v`, [batch.source_id, ids])).map(row => [Number(row.id), row.reason]));
  const same = batch.rows.filter(row => { const now = current.get(row.id); return typeof now === 'string' && textHash(now) === row.text_hash; }).map(row => row.id);
  const cleared = same.length ? (await tx.executeRaw<{ id: number | string }>(
    'UPDATE page_versions SET change_reason = $1 WHERE id = ANY($2::bigint[]) RETURNING id', [PURGED_REASON, same])).map(row => Number(row.id)) : [];
  const done = new Set(cleared);
  return { cleared: cleared.sort((a, b) => a - b), changed: ids.filter(id => !done.has(id)) };
}
