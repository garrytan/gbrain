/**
 * `gbrain repair rename-identity --source <id> --slug <new-slug> [--from <old-slug>] [--close]` (#6729): the remedy for an
 * inexact Git rename that sync split into a delete plus an add because the files did not confirm it
 * (sync-rename-identity.ts, recorded by sync-identity-downgrades.ts). The operator picks the mapping: the preview names
 * exactly one open pair (its new page is <new-slug>; `--from` disambiguates), binds the brain, the pair, both page ids,
 * both revisions and the disposition into its plan hash, and saves it; with no `--slug` it lists the open pairs with
 * their per-pair preview commands and nothing can be applied. `--apply --expect <hash> --yes` (destructive consent)
 * re-reads both pages under their page locks and refuses `changed_since_preview` when anything moved. Both dispositions settle
 * the record (`completed_keys[0].disposition = { kind: remedied | closed, at }`) in the same transaction as the move.
 *
 * Dispositions:
 *  - `carry` (default), a deferred true rename: the old page id moves to the new slug, so its version history,
 *    timeline, links and every page-id-keyed row stay on it, and the new file's current content is imported onto it as
 *    an edit (a new version). The provisional page is retired: re-keyed purge-style (`<slug>~purged-<id>`) and
 *    soft-deleted, its history, timeline and edges moved onto the carried page, nothing hard-deleted. An old -> new
 *    slug redirect is recorded, the old page's slug-keyed facts, aliases and withdrawals move, and the record settles `remedied`.
 *    Facts: every fence row of the old page must be in the new file's fence (read from the checkout, the bytes the carry
 *    imports) with the same claim, and the provisional page's stored row there must carry that claim too. A matching
 *    pair is one fact: the old row (id, created_at and its validity window, valid_from and valid_until) survives with
 *    the new row's other fence fields; the carry never writes valid_until. Anything else (a different claim at a row number, or an old
 *    row the new file does not hold) refuses `fact_rows_collide` before anything is written, naming the rows.
 *    Classic sources only: on a managed brain page tables take writes only through coordinated publications, so carrying
 *    is unavailable there (`managed_remedy_unavailable`): the preview says so and names `--close`, and an apply refuses.
 *  - `close`: settles the record `closed`, which releases the purge hold, and moves nothing. Classic and managed.
 *
 * Explicit-only, preview-bound and destructive: `--all`, the maintenance cycle and the doctor remediation plan never
 * run it (`explicit_kind_required`).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { importFile } from '../import-file.ts';
import { movePageIdReferences } from '../page-state/rename-alias.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { lockedBeliefBatch } from '../belief/writers.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { purgedSlug } from '../../commands/sync/rename-collision.ts';
import { IDENTITY_DOWNGRADE_OP, IDENTITY_HOLD_RELEASE, MANAGED_REMEDY_UNAVAILABLE, identityDowngradeReasonText, identityRemedyParts, identityRestoreArgv, listIdentityDowngrades,
  renameIdentityPreviewArgv, settleIdentityDowngrade, withIdentityRemedies, type IdentityDowngrade, type IdentityRemedyDisposition, type IdentityRemedyParts } from '../sync-identity-downgrades.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions } from './core.ts';
import { assertOriginUnclaimed } from '../persistence/origin-guard.ts';

const DOCS = 'docs/guides/repair.md#rename-identity';
/** The restore alternative, named only where the source admits a restore (an unbound Postgres source with a checkout does not). */
const restoreRoute = (record: IdentityDowngrade): string | null => record.restore_available === false ? null : identityRestoreArgv(record).join(' ');

interface Approved { record: IdentityDowngrade; parts: IdentityRemedyParts; source_id: string }
interface PairItem extends RepairItem { record: IdentityDowngrade; parts: IdentityRemedyParts; hash: string }
/** One old fence row and what the new file and the provisional page hold at its row number. */
export interface FenceRowCheck { row: number; old_id: number; old_claim: string; file_claim: string | null; new_id: number | null; new_claim: string | null }

/** The consent payload of `--apply --expect <hash> --yes` (registry `consentText`). */
export const RENAME_IDENTITY_CONSENT_TEXT = {
  what: 'Carry the previewed old page\'s identity onto its new page (or, with --close, release its purge hold)',
  why: 'Sync split an inexact rename into a delete plus an add because the files did not confirm it; the user picked this pair and the preview bound both pages and their revisions.',
  risk: 'Carry: the old page id takes the new slug and the new file is imported onto it as an edit; the provisional page is retired (soft-deleted under a purged slug, its history and edges moved). '
    + 'Facts of both pages stay; colliding fence rows refuse before anything changes. Close: the old page is purged once its soft-delete window ends. Undo neither from gbrain; where the source admits a restore, keep the old page instead with gbrain restore <old-slug> --source-id <id> --force.',
  user_message: 'Carry the old page\'s history, facts and links onto its new page as previewed (or release the hold with --close)? The provisional page is retired',
};

const previewCommand = (sourceId: string, opts: Pick<RepairPlanOptions, 'slugs' | 'from' | 'close'> = {}) =>
  ['gbrain', 'repair', 'rename-identity', '--source', sourceId, ...(opts.slugs ?? []).flatMap(slug => ['--slug', slug]), ...(opts.from ? ['--from', opts.from] : []),
    ...(opts.close ? ['--close'] : [])].join(' ');
const listFix = (sourceId: string): Action => readFix('Lists the open pairs of the source with their per-pair preview commands; writes nothing.',
  { argv: ['gbrain', 'repair', 'rename-identity', '--source', sourceId, '--json'] });
const refuse = (code: string, message: string, suggestion: string, fix: Action, detail?: string) => {
  const error = new OperationError(code, message, suggestion, DOCS);
  error.fix = fix;
  if (detail) error.detail = detail;
  return error;
};

/** The new file as the carry imports it, from the source checkout; a missing file refuses: there is nothing to carry onto. */
async function readNewFile(engine: Pick<BrainEngine, 'executeRaw'>, record: IdentityDowngrade): Promise<{ path: string; text: string }> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [record.source_id]);
  const path = source?.local_path ? join(source.local_path, record.to) : null;
  if (!path || !existsSync(path)) throw changedSincePreview(record, `the new file ${record.to} is not in the source checkout`);
  return { path, text: readFileSync(path, 'utf8') };
}

/** Each fence row of the old page against the new file's facts fence and the provisional page's stored row at that row number. */
export async function fenceRowChecks(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, oldSlug: string, newSlug: string, newFile: string): Promise<FenceRowCheck[]> {
  const file = new Map<number, string>();
  for (const fact of parseFactsFence(newFile).facts) if (!file.has(fact.rowNum)) file.set(fact.rowNum, fact.claim);
  const rows = await engine.executeRaw<{ row_num: number; old_id: number | string; old_fact: string; new_id: number | string | null; new_fact: string | null }>(
    `SELECT o.row_num, o.id AS old_id, o.fact AS old_fact, n.id AS new_id, n.fact AS new_fact FROM facts o
      LEFT JOIN facts n ON n.source_id = o.source_id AND n.source_markdown_slug = $3 AND n.row_num = o.row_num
      WHERE o.source_id = $1 AND o.source_markdown_slug = $2 AND o.row_num IS NOT NULL ORDER BY o.row_num`, [sourceId, oldSlug, newSlug]);
  return rows.map(row => ({ row: Number(row.row_num), old_id: Number(row.old_id), old_claim: row.old_fact, file_claim: file.get(Number(row.row_num)) ?? null,
    new_id: row.new_id == null ? null : Number(row.new_id), new_claim: row.new_fact }));
}

const collides = (check: FenceRowCheck) => check.file_claim !== check.old_claim || (check.new_claim !== null && check.new_claim !== check.old_claim);

function factRowsCollide(record: IdentityDowngrade, checks: FenceRowCheck[]): OperationError {
  const rows = checks.filter(collides).map(check => check.file_claim === null
    ? `row ${check.row} "${check.old_claim}" is not in ${record.to}'s fence`
    : `row ${check.row}: "${check.old_claim}" on ${record.old_slug}, "${check.new_claim ?? check.file_claim}" on ${record.new_slug}`);
  return refuse('fact_rows_collide', `Carrying ${record.old_slug} onto ${record.new_slug} would drop facts: ${rows.join('; ')}.`,
    `Nothing was written. Give each old claim its own row in the ## Facts fence of ${record.to} (or keep it at its row number with the same claim), commit and sync, then preview again: `
      + `${renameIdentityPreviewArgv(record).join(' ')}. ${restoreRoute(record) ? `Or keep the old page as its own page: ${restoreRoute(record)}; or r` : 'Or r'}elease the hold without carrying: ${renameIdentityPreviewArgv(record, { close: true }).join(' ')}.`,
    readFix(`Shows ${record.new_slug}'s page with its facts fence, read-only.`, { argv: ['gbrain', 'get', '--source', record.source_id, '--', record.new_slug!] }));
}

function managedRemedyUnavailable(record: IdentityDowngrade) {
  const close = renameIdentityPreviewArgv(record, { close: true });
  return { close, message: `Carrying ${record.old_slug}'s identity onto ${record.new_slug} is unavailable on a managed source; nothing was written.`,
    suggestion: `Release the purge hold without carrying identity: preview ${close.join(' ')}, then, after the user agrees, run the apply command it prints. `
      + (restoreRoute(record) ? `Or keep ${record.old_slug} as its own page: ${restoreRoute(record)}.` : '') };
}

const managedRemedyRefusal = (record: IdentityDowngrade) => {
  const unavailable = managedRemedyUnavailable(record);
  return refuse(MANAGED_REMEDY_UNAVAILABLE, unavailable.message, unavailable.suggestion,
    readFix('Previews closing this pair, which releases the purge hold without carrying identity; writes nothing.', { argv: unavailable.close }));
};

const changedSincePreview = (record: IdentityDowngrade, why: string) => refuse('changed_since_preview',
  `The pair ${record.old_slug} -> ${record.new_slug ?? record.to} changed since its preview: ${why}.`,
  `Nothing was written. Preview again (${renameIdentityPreviewArgv(record).join(' ')}), review the new plan and approve its new hash.`, listFix(record.source_id));

function describe(record: IdentityDowngrade, disposition: IdentityRemedyDisposition): string {
  return `${record.from} -> ${record.to} (git similarity ${record.similarity}%; ${identityDowngradeReasonText(record.reason)}): ${disposition === 'carry'
    ? `page ${record.old_page_id} moves from ${record.old_slug} to ${record.new_slug} with ${record.facts} fact(s), ${record.links} link(s) and ${record.aliases} alias(es); the new file is imported onto it and the provisional page is retired`
    : `the record closes and ${record.old_slug} purges once its soft-delete window ends; nothing moves`}`;
}

function pairItem(record: IdentityDowngrade, parts: IdentityRemedyParts, hash: string): PairItem {
  return { cursor: { phase: 1, id: record.old_page_id }, source_id: record.source_id, slug: record.old_slug, chars: 0,
    action: `${parts.disposition}:rename_identity`, change: { from: record.old_slug, to: record.new_slug ?? record.old_slug }, record, parts, hash };
}

/** The open pair the options name, or the refusal that says why none or more than one matches. */
function selectPair(open: IdentityDowngrade[], sourceId: string, opts: RepairPlanOptions): IdentityDowngrade {
  const slug = opts.slugs?.[0];
  const matches = open.filter(record => (!slug || record.new_slug === slug) && (!opts.from || record.old_slug === opts.from));
  const named = [slug ? `new page ${slug}` : '', opts.from ? `old page ${opts.from}` : ''].filter(Boolean).join(' and ');
  if (!matches.length) throw refuse('invalid_params', `Source ${sourceId} has no open rename-identity pair with ${named}.`,
    `A pair already carried or closed, or whose old page was restored or purged, is no longer open, and nothing was written; list the open pairs with gbrain repair rename-identity --source ${sourceId}.`, listFix(sourceId));
  if (matches.length > 1) throw refuse('invalid_params', `${matches.length} open pairs of source ${sourceId} match ${named}.`,
    `Name the old page too: ${matches.map(record => renameIdentityPreviewArgv(record, { from: true }).join(' ')).join('; ')}.`, listFix(sourceId));
  const record = matches[0]!;
  if (!opts.close && !record.new_slug) throw refuse('invalid_params', `The new file ${record.to} of ${record.old_slug} has no page to carry onto.`,
    `Fix the file and sync so it imports, then preview again; or release the hold now: ${renameIdentityPreviewArgv(record, { close: true }).join(' ')}.`, listFix(sourceId));
  return record;
}

async function listingPlan(engine: BrainEngine, sourceId: string, open: IdentityDowngrade[], apply: boolean): Promise<RepairPlan> {
  if (apply) throw refuse('invalid_params', 'gbrain repair rename-identity --apply needs one pair: --slug <new-slug> (and --from <old-slug> when two pairs share it).',
    `Preview the pair first: gbrain repair rename-identity --source ${sourceId} --slug <new-slug>, then run the apply command it prints after the user agrees.`, listFix(sourceId));
  const entries = await withIdentityRemedies(engine, open);
  return { items: [], residuals: { open_pairs: entries.length },
    listing: entries.map(record => ({ item: `${record.source_id}:${record.old_slug} -> ${record.new_slug ?? record.to}`, class: record.reason,
      detail: `preview: ${record.remedy.preview_argv.join(' ')}; hold releases ${record.remedy.hold_releases}` })),
    details: { pairs: entries.map(record => ({ old_slug: record.old_slug, new_slug: record.new_slug, from: record.from, to: record.to, remedy: record.remedy })), docs: DOCS } };
}

export const renameIdentityRepair = {
  kind: 'rename-identity' as const,
  publication: 'projection' as const,
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) throw refuse('invalid_params', 'gbrain repair rename-identity needs --source <id>.',
      'Each pair belongs to one source; name it, e.g. gbrain repair rename-identity --source default.', readFix('Lists the registered sources.', { argv: ['gbrain', 'sources', 'list', '--json'] }));
    const sourceId = scope.source_ids[0]!;
    const options = opts ?? { apply: false };
    const open = await listIdentityDowngrades(engine, [sourceId]);
    if (!options.slugs?.length && !options.from) return listingPlan(engine, sourceId, open, options.apply);
    const record = selectPair(open, sourceId, options);
    const disposition: IdentityRemedyDisposition = options.close ? 'close' : 'carry';
    if (disposition === 'carry' && await managedPersistenceEnabled(engine)) {
      if (options.apply) throw managedRemedyRefusal(record);
      const unavailable = managedRemedyUnavailable(record);
      return { items: [], residuals: { carry_unavailable: 1 },
        listing: [{ item: `${sourceId}:${record.old_slug} -> ${record.new_slug}`, class: MANAGED_REMEDY_UNAVAILABLE, detail: `${unavailable.message} ${unavailable.suggestion}` }],
        details: { disposition, code: MANAGED_REMEDY_UNAVAILABLE, message: unavailable.message, suggestion: unavailable.suggestion, close_preview: unavailable.close.join(' '),
          restore: restoreRoute(record), docs: DOCS } };
    }
    const parts = await identityRemedyParts(engine, record, disposition);
    const hash = previewHash(parts);
    const command = previewCommand(sourceId, options);
    if (disposition === 'carry') await assertCarryable(engine, record, parts);
    if (!options.apply) {
      await saveApprovedSet<Approved>(engine, { command: 'rename-identity', hash }, [{ record, parts, source_id: sourceId }]);
      return { items: [pairItem(record, parts, hash)], preview_hash: hash, residuals: {},
        listing: [{ item: `${sourceId}:${record.old_slug} -> ${record.new_slug ?? record.to}`, class: disposition, detail: describe(record, disposition) }],
        details: { disposition, old: parts.old, new: parts.new, hold_releases: IDENTITY_HOLD_RELEASE,
          restore: restoreRoute(record), docs: DOCS } };
    }
    if (!options.expect) throw refuse('invalid_params', 'gbrain repair rename-identity --apply applies only the pair a preview printed.',
      `Preview first: ${command} — then, after the user agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, listFix(sourceId));
    const approved = await loadApprovedSet<Approved>(engine, { command: 'rename-identity', hash: options.expect, previewCommand: command });
    if (hash !== options.expect || approved.items.length !== 1 || approved.items[0]!.record.old_page_id !== record.old_page_id) throw previewChangedError(options.expect, command);
    return { items: [pairItem(record, parts, hash)].filter(entry => afterCursor(entry.cursor, after)), preview_hash: hash, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { record, parts, hash } = entry as PairItem;
    try {
      if (parts.disposition === 'close') {
        if (previewHash(await identityRemedyParts(ctx.engine, record, 'close')) !== hash) throw changedSincePreview(record, 'a page of the pair changed');
        if (!await settleIdentityDowngrade(ctx.engine, record.old_page_id, 'closed')) throw changedSincePreview(record, 'its record was settled since the preview');
        return { applied: true, outcome: 'closed', detail: { old_slug: record.old_slug, purge_hold: 'released' } };
      }
      return await carryIdentity(ctx.engine, record, hash);
    } finally {
      await clearApprovedSet(ctx.engine, { command: 'rename-identity', hash });
    }
  },
  render(details) {
    if (Array.isArray(details.pairs)) return [`  each pair: preview it by name to carry or close it; guide: ${details.docs}`];
    if (details.code) return [`  ${details.code}: ${details.message}`, `  ${details.suggestion}`];
    return [`  ${details.disposition}: old page ${JSON.stringify(details.old)}, new page ${JSON.stringify(details.new)}; the purge hold releases ${details.hold_releases}`,
      `  alternative: keep the old page as its own page: ${details.restore}`];
  },
} satisfies Omit<RepairHandler, 'kind'> & { kind: 'rename-identity' };

/** A carry must be possible before a preview hash is printed: both pages as recorded, and no fence row that would drop a fact. */
async function assertCarryable(engine: BrainEngine, record: IdentityDowngrade, parts: IdentityRemedyParts): Promise<void> {
  if (!parts.old?.deleted || !parts.new) throw changedSincePreview(record, 'the old page is no longer soft-deleted or the new page is gone');
  const checks = await fenceRowChecks(engine, record.source_id, parts.old.slug, parts.new.slug, (await readNewFile(engine, record)).text);
  if (checks.some(collides)) throw factRowsCollide(record, checks);
}

/**
 * The carry, in one maintenance transaction under both page locks: re-check the bound state, merge each duplicate fence
 * row onto the old row, retire the provisional page purge-style, move the old page onto the new slug (redirect and
 * slug-keyed rows with it), move the provisional's history and edges, import the new file onto it, close the record.
 */
async function carryIdentity(engine: BrainEngine, record: IdentityDowngrade, hash: string): Promise<RepairItemOutcome> {
  if (await managedPersistenceEnabled(engine)) throw managedRemedyRefusal(record);
  const file = await readNewFile(engine, record);
  const sourceId = record.source_id, oldSlug = record.old_slug, newSlug = record.new_slug!;
  const publicationId = randomUUID();
  const report = { appended: 0 };
  const outcome = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId, slug: oldSlug }, { sourceId, slug: newSlug }]);
    const live = await identityRemedyParts(tx, record, 'carry');
    const [open] = await tx.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op = $1 AND fingerprint = $2 AND completed_keys->0->>'disposition' IS NULL`, [IDENTITY_DOWNGRADE_OP, String(record.old_page_id)]);
    if (previewHash(live) !== hash || !open || !live.old || !live.new) throw changedSincePreview(record, 'a page of the pair changed or its record closed');
    const checks = await fenceRowChecks(tx, sourceId, oldSlug, live.new.slug, file.text);
    if (checks.some(collides)) throw factRowsCollide(record, checks);
    const oldId = live.old.page_id, provisionalId = live.new.page_id, retired = purgedSlug(newSlug, provisionalId);
    const merged = checks.filter(check => check.new_id !== null);
    await lockedBeliefBatch(tx, { sourceId, slugs: [oldSlug, newSlug], publicationId, op: 'rename_identity', remote: false, report }, async () => {
      for (const check of merged) {
        await tx.executeRaw('UPDATE facts SET superseded_by = $1 WHERE superseded_by = $2', [check.old_id, check.new_id]);
        await tx.executeRaw(`UPDATE facts o SET kind = n.kind, visibility = n.visibility, notability = n.notability, context = n.context,
            expired_at = n.expired_at, source = n.source, confidence = n.confidence, claim_metric = n.claim_metric, claim_value = n.claim_value, claim_unit = n.claim_unit,
            claim_period = n.claim_period, event_type = n.event_type, attributed_to = n.attributed_to FROM facts n WHERE o.id = $1 AND n.id = $2`, [check.old_id, check.new_id]);
      }
      // origin-guard-ok: retires the provisional page to a tombstone, which claims no origin
      await tx.executeRaw('UPDATE pages SET slug = $1, deleted_at = now(), updated_at = now() WHERE id = $2 AND source_id = $3', [retired, provisionalId, sourceId]);
      if (await tx.updateSlug(oldSlug, newSlug, { sourceId }) !== 1) throw changedSincePreview(record, `page ${oldSlug} could not move to ${newSlug}`);
      await assertOriginUnclaimed(tx, { sourceId, pageId: oldId, sourcePath: record.to, revive: true });
      // origin-guard-ok: assertOriginUnclaimed above revives and assigns in the same transaction
      await tx.executeRaw('UPDATE pages SET deleted_at = NULL, source_path = $1, updated_at = now() WHERE id = $2', [record.to, oldId]);
      await movePageIdReferences(tx, provisionalId, oldId);
    });
    const imported = await importFile(tx, file.path, record.to, { noEmbed: true, sourceId });
    if (imported.slug !== newSlug || imported.error) throw changedSincePreview(record, `the new file did not import onto ${newSlug} (${imported.error ?? imported.slug})`);
    if (!await settleIdentityDowngrade(tx, oldId, 'remedied')) throw changedSincePreview(record, 'its record was settled since the preview');
    return { applied: true, outcome: 'carried', detail: { old_page_id: oldId, from: oldSlug, to: newSlug, retired_page_id: provisionalId, retired_slug: retired,
      facts_merged: merged.length, import: imported.status } } satisfies RepairItemOutcome;
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
  return outcome;
}
