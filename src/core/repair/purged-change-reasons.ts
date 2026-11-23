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
 *   - path_mismatch (kept): another or no `source_path`, or the commit holds more than one reason for that path (the
 *     purge may have matched the other one); cleared only with `--include-ambiguous` and that preview's hash.
 * A tombstone whose commit or trailer can no longer be read counts `unreadable_commit`; a source with no checkout (a
 * repo-less source) never stored a Git reason and counts `sources_without_checkout`. Neither refuses.
 *
 * The preview prints a per-brain count, a count per source and a few `<source>:<slug>@v<id>` items, never the reason
 * text, and saves the approved set (row ids and classes, never the text or a digest of it). The apply, bound to that hash
 * and the user's consent, reads the source's candidates from Git again, then takes the source `FOR UPDATE` as a purge
 * does and sets each approved row that is still a candidate of its class and still holds exactly that text to '[purged]',
 * the value the purge's own redaction writes; any other row is reported changed_since_preview and kept. Git history is
 * never rewritten. Never automatic.
 */
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
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

export interface LeakedReason { id: number; source_id: string; slug: string; class: LeakedReasonClass }

/** `text` is the stored reason; it stays in memory and never reaches the approved set or the output. */
export interface LeakedReasonScan { rows: Array<LeakedReason & { text: string }>; unreadable_commit: number; without_checkout: boolean }

interface Approved { source_id: string; include_ambiguous: boolean; scope: string[]; rows: LeakedReason[] }
interface BatchItem extends RepairItem { batch: Approved; hash: string; last: boolean }
interface Details { brain_total: number; by_source: Record<string, number>; samples: Record<string, string[]>; sources_without_checkout: number }

/** The source's checkout, found the way the purge's trailer scan finds it; null for a repo-less source. */
async function checkoutRoot(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const source = await engine.getSource(sourceId);
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
  const tombstones = await engine.readReasonPurgeTombstones(sourceId);
  const root = await checkoutRoot(engine, sourceId);
  if (!root) return { rows: [], unreadable_commit: tombstones.length, without_checkout: true };
  const repo = tombstones.length ? gitTopLevel(root) : null;
  if (!repo) return { rows: [], unreadable_commit: tombstones.length, without_checkout: false };
  const forms = pathForms(repo.scopePrefix);
  const commits = new Map<string, TrailerCommit | null>();
  const pathsByText = new Map<string, Set<string>>();
  const sharedTexts = new Set<string>();
  let unreadable = 0;
  for (const tombstone of tombstones) {
    if (!commits.has(tombstone.commit_sha)) commits.set(tombstone.commit_sha, await readCommit(repo.gitRoot, tombstone.commit_sha));
    const commit = commits.get(tombstone.commit_sha);
    const raw = commit ? trailerTexts(commit, forms).byPath.get(tombstone.path) : undefined;
    const text = raw === undefined ? null : canonicalChangeReason(raw);
    if (text === null) { unreadable++; continue; }
    if (commit!.values.filter(value => trailerTexts({ ...commit!, values: [value] }, forms).byPath.has(tombstone.path)).length > 1) sharedTexts.add(text);
    const paths = pathsByText.get(text) ?? new Set<string>();
    for (const form of forms(tombstone.path)) paths.add(form);
    pathsByText.set(text, paths);
  }
  if (!pathsByText.size) return { rows: [], unreadable_commit: unreadable, without_checkout: false };
  const rows = await engine.listVersionsByChangeReason(sourceId, [...pathsByText.keys()]);
  return {
    rows: rows.map(row => ({ id: row.id, source_id: sourceId, slug: row.slug, text: row.reason,
      class: row.source_path !== null && !sharedTexts.has(row.reason) && pathsByText.get(row.reason)!.has(row.source_path) ? 'evidenced' : 'path_mismatch' })),
    unreadable_commit: unreadable, without_checkout: false,
  };
}

async function previewCommand(engine: BrainEngine, sourceIds: string[], includeAmbiguous: boolean): Promise<string> {
  const n = (await engine.listAllSources()).length;
  return `gbrain repair ${COMMAND}${sourceIds.length === 1 && Number(n) > 1 ? ` --source ${sourceIds[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

function batchItems(batches: Approved[], hash: string): BatchItem[] {
  return batches.map((batch, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: batch.source_id, slug: batch.rows[0]!.slug, chars: 0,
    action: `set ${batch.rows.length} leaked change reason(s) to '${PURGED_REASON}'`, batch, hash, last: index === batches.length - 1 }));
}

const sourcesOf = (engine: BrainEngine, ids: string[]) => engine.listSourceIncarnations(ids);

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
      rows.push(...scan.rows.map(({ text: _text, ...row }) => row));
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
    const bySource = new Map<string, number>();
    const samples = new Map<string, string[]>();
    for (const row of batches.flatMap(batch => batch.rows)) {
      bySource.set(row.source_id, (bySource.get(row.source_id) ?? 0) + 1);
      const items = samples.get(row.source_id) ?? [];
      if (items.length < SAMPLES) samples.set(row.source_id, [...items, itemName(row)]);
    }
    const details: Details = { brain_total: [...bySource.values()].reduce((sum, n) => sum + n, 0), by_source: Object.fromEntries(bySource),
      samples: Object.fromEntries(samples), sources_without_checkout: withoutCheckout };
    const kept = includeAmbiguous ? 0 : rows.filter(r => r.class === 'path_mismatch').length;
    return { items: batchItems(batches, hash), preview_hash: hash, details: details as unknown as Record<string, unknown>,
      residuals: { path_mismatch: kept, unreadable_commit: unreadable, sources_without_checkout: withoutCheckout } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const item = entry as BatchItem;
    const current = new Map((await findLeakedChangeReasons(ctx.engine, item.source_id)).rows.map(row => [row.id, row]));
    const still = item.batch.rows.flatMap(row => { const now = current.get(row.id); return now && now.class === row.class ? [{ id: row.id, text: now.text }] : []; });
    const result = await maintenanceTransaction(ctx.engine, tx => clearBatch(tx, item.batch, still));
    if (item.last) await clearApprovedSet(ctx.engine, { command: COMMAND, hash: item.hash });
    if (!result.cleared.length) return { applied: false, outcome: 'changed_since_preview', reason: 'every approved row changed since the preview' };
    return { applied: true, outcome: 'cleared', detail: { cleared: result.cleared.length, ...(result.changed.length ? { changed_since_preview: result.changed } : {}) } };
  },
  render(raw): string[] {
    const details = raw as unknown as Details;
    const lines = [`  ${details.brain_total} leaked change reason(s) in ${Object.keys(details.by_source).length} source(s) of this brain`];
    for (const [sourceId, count] of Object.entries(details.by_source)) {
      const samples = Object.hasOwn(details.samples, sourceId) ? details.samples[sourceId]! : [];
      lines.push(`    ${sourceId}: ${count}`, ...samples.map(item => `      ${item}`));
      if (count > samples.length) lines.push(`      and ${count - samples.length} more`);
    }
    if (details.sources_without_checkout) lines.push(`  ${details.sources_without_checkout} source(s) without a Git checkout: nothing to check there`);
    return lines;
  },
};

/**
 * Under the source lock a purge takes: set each approved row that the apply's own Git read still finds (`still`, with the
 * text it found) to '[purged]' only while it holds exactly that text. Nothing outside the approved ids is written.
 */
async function clearBatch(tx: BrainEngine, batch: Approved, still: Array<{ id: number; text: string }>): Promise<{ cleared: number[]; changed: number[] }> {
  await tx.lockSourceRow(batch.source_id);
  const ids = batch.rows.map(row => row.id);
  const cleared = await tx.replaceVersionChangeReasons(batch.source_id, still.map(row => ({ id: row.id, reason: row.text })), PURGED_REASON);
  const done = new Set(cleared);
  return { cleared, changed: ids.filter(id => !done.has(id)) };
}
