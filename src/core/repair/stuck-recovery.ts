/**
 * `gbrain repair stuck-recovery [--source <id>] [--request-id <uuid>]` (#6650 §1.10; GBRA-130 C-1, C-4): the repair-kind
 * adapter for `persistence/recovery-resolve.ts`. Explicit-only, preview-bound and destructive-consent: the preview lists
 * each recovery record blocked on unexpected bytes (a page write's, a shared-skill bundle's or a withdrawal-mirror
 * effect's: recorded and disk fingerprints, a private diff, the choices available) and saves the set under its hash;
 * `--apply --expect <hash> --keep prior|disk|withdrawn --yes` resolves exactly that set. There is no default `--keep`,
 * a choice some approved record does not offer is refused before anything runs, and a terminal request is listed as
 * refused (see recovery-resolve.ts for the per-state semantics).
 * Projection-only: no journal admission; each record finishes through the owner's own recovery.
 */
import { OperationError } from '../ops/contract.ts';
import { catalogueError } from '../error-catalogue.ts';
import { loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { KEEP_CHOICES, priorStageUnavailable, readResolutions, resolveStuckRecovery, scanStuckRecoveries, stuckRecoveryPreviewCommand, type KeepChoice, type RecoveryFileView, type RefusedRecovery,
  type StuckRecovery } from '../persistence/recovery-resolve.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type Selection = { sources: string[]; request_id: string | null };
type ApprovedRecovery = StuckRecovery & { selection: Selection };
type RecoveryItem = RepairItem & { recovery: StuckRecovery; hash: string; keep: KeepChoice };

const CHOICE_TEXT: Record<KeepChoice, string> = {
  prior: 'discard the edit: write the recorded prior bytes back (unlink the file when the prior was a create; every file of a skill bundle); the owner then finishes the recovery '
    + 'by its own rule, so a request with no recorded failure is requeued and its write publishes again, and one with a failure ends with it',
  disk: 'keep the edit and abandon the write: every file stays as it is on disk (every file of a skill bundle), the request ends conflict (source_changed), or with the failure it '
    + 'already recorded, and its recovery record is cleared; the database page keeps the content before the write, so reconcile the page afterwards (a managed sync import is '
    + 'retried by the next sync instead)',
  withdrawn: 'finish the withdrawal: write the recorded post-withdrawal bytes over the edited file (the only choice for a withdrawal-mirror effect: keeping the edit would keep the '
    + 'forgotten fact on disk for the next sync to import again); the effect then finishes forward and the writes behind it resume',
};

function item(recovery: StuckRecovery, index: number, hash: string, keep: KeepChoice): RecoveryItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: recovery.source_id, slug: recovery.slug, chars: 0, action: `resolve_keep_${keep}`,
    change: { from: recovery.digest, to: keep }, recovery, hash, keep };
}

const selectionOf = (scope: RepairScope, requestId?: string): Selection => ({ sources: scope.source_ids, request_id: requestId ?? null });
const hashOf = (scope: RepairScope, selection: Selection, items: StuckRecovery[]) =>
  previewHash({ kind: 'stuck-recovery-v1', brain_id: scope.brain_id, selection, items: items.map(found => found.digest) });

/** A prior file over the single-string ceiling is the staged copy beside it (recovery-resolve.ts PriorStageView). */
const STAGE_TEXT = {
  verified: 'verified',
  missing: 'missing (--keep prior is unavailable)',
  mismatched: 'does not match its recorded SHA-256 (--keep prior is unavailable)',
} as const;

function fileLines(file: RecoveryFileView): string[] {
  const priorLabel = file.withdrawn ? 'before withdrawal' : 'prior';
  const prior = file.prior.absent ? 'absent: prior was a create'
    : `sha256 ${file.prior.sha256.slice(0, 16)}… size ${file.prior.size ?? '?'} mode ${file.prior.mode === null ? '?' : file.prior.mode.toString(8)}`
      + (file.prior.stage ? `, staged copy ${STAGE_TEXT[file.prior.stage.state]}` : file.prior.stored || file.withdrawn ? '' : ' (bytes not stored in the record)');
  const disk = file.disk.deleted ? 'deleted on disk' : file.disk.kind !== 'file' ? `${file.disk.kind} (not a regular file; resolve it by hand)`
    : `sha256 ${file.disk.sha256!.slice(0, 16)}… size ${file.disk.size} mode ${file.disk.mode.toString(8)}`;
  const seen = file.matches === 'neither' ? `neither the ${file.withdrawn ? 'pre-withdrawal nor the withdrawn' : 'prior nor the published'} bytes (blocked)` : `the ${file.matches} bytes`;
  return [`    file ${file.relative}`, `      ${priorLabel}: ${prior}`,
    ...(file.withdrawn ? [`      withdrawn: sha256 ${file.withdrawn.sha256.slice(0, 16)}… size ${file.withdrawn.size}`] : []),
    `      disk:  ${disk}`, `      recovery sees: ${seen}`,
    ...(file.diff_path ? [`      diff: ${file.diff_path}${file.diff_summary ? ' (summary: a version is over the 24 MiB single-string ceiling, so no full diff)' : ''}`,
      `      reproduce: ${file.diff_command}`] : [])];
}

function headerLines(found: StuckRecovery): string[] {
  if (found.target === 'withdrawal_mirror') return [`  effect ${found.effect_id} (withdrawal mirror of request ${found.request_id}, ${found.source_id}:${found.slug}, ${found.state}${found.blocked_reason ? `, ${found.blocked_reason}` : ''}; page revision ${found.page_revision ?? 'none'})`,
    '    the withdrawal is committed: --keep withdrawn is the only choice (keeping the edit would keep the forgotten fact on disk)'];
  const what = found.target === 'skill_bundle' ? `skill bundle ${found.files.length} file(s)` : `page revision ${found.page_revision ?? 'none'}`;
  return [`  request ${found.request_id} (${found.operation} ${found.source_id}:${found.slug}, ${found.state}${found.blocked_reason ? `, ${found.blocked_reason}` : ''}; ${what})`,
    `    ${found.recorded_error ? `recorded failure ${found.recorded_error}: either choice ends the request with it` : 'no recorded failure: --keep prior requeues the write, --keep disk abandons it'}`
      + (found.target === 'skill_bundle' ? '; either choice applies to every file of the bundle' : '')];
}

export const stuckRecoveryRepair: RepairHandler = {
  kind: 'stuck-recovery',
  publication: 'projection',
  embeds: false,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = stuckRecoveryPreviewCommand(scope.source_ids, opts?.requestId);
    const selection = selectionOf(scope, opts?.requestId);
    if (!opts?.apply) {
      const scan = await scanStuckRecoveries(engine, scope.source_ids, { requestId: opts?.requestId, artifacts: opts?.remote === false });
      const hash = hashOf(scope, selection, scan.items);
      if (scan.items.length) await saveApprovedSet<ApprovedRecovery>(engine, { command: 'stuck-recovery', hash }, scan.items.map(found => ({ ...found, selection })));
      const apply = (keep: KeepChoice) => `${command} --keep ${keep} --apply --expect ${hash} --yes`;
      return { items: scan.items.map((found, index) => item(found, index, hash, 'prior')), preview_hash: hash, residuals: scan.residuals,
        listing: scan.items.map(found => ({ item: `${found.source_id}:${found.slug}`, class: 'unexpected_file_bytes',
          detail: `${found.target === 'withdrawal_mirror' ? `withdrawal-mirror effect ${found.effect_id} of request` : 'request'} ${found.request_id}, ${found.files.filter(file => file.matches === 'neither').length} of ${found.files.length} file(s) match neither recorded version` })),
        details: { recoveries: scan.items, heads: scan.heads, refused: scan.refused,
          choices: KEEP_CHOICES.filter(keep => scan.items.length && scan.items.every(found => found.choices[keep]))
            .map(keep => ({ keep, what: CHOICE_TEXT[keep], apply_command: apply(keep) })) } };
    }
    if (!opts.expect || !opts.keep) {
      throw new OperationError('invalid_params', 'gbrain repair stuck-recovery --apply needs the preview hash and the version to keep.',
        `Preview first: ${command} — show the user the diff it prints, then run the choice they pick from the ones it lists: ${command} --keep prior --apply --expect <preview-hash> --yes, `
        + `${command} --keep disk --apply --expect <preview-hash> --yes, or (a withdrawal-mirror effect) ${command} --keep withdrawn --apply --expect <preview-hash> --yes`, 'docs/guides/repair.md#stuck-recovery');
    }
    const { expect, keep } = opts;
    let approved: ApprovedRecovery[];
    try {
      approved = (await loadApprovedSet<ApprovedRecovery>(engine, { command: 'stuck-recovery', hash: expect, previewCommand: command,
        emptyHash: async () => hashOf(scope, selection, (await scanStuckRecoveries(engine, scope.source_ids, { requestId: opts.requestId })).items) })).items;
    } catch (error) {
      // An identical apply after the approved set aged out still replays its recorded resolutions.
      const done = await readResolutions(engine, expect);
      if (!done.length || done.some(entry => entry.phase !== 'done')) throw error;
      approved = done.map(entry => ({ id: entry.id, request_id: entry.request_id, source_id: entry.source_id, slug: entry.slug, selection } as ApprovedRecovery));
    }
    if (approved.some(entry => JSON.stringify(entry.selection) !== JSON.stringify(selection))) throw previewChangedError(expect, command);
    const unavailable = approved.filter(entry => entry.choices && !entry.choices[keep]);
    if (unavailable.length) throw unavailable.map(entry => priorStageUnavailable(entry, keep, expect)).find(Boolean) ?? catalogueError('recovery_choice_refused', `--keep ${keep} is not available for ${unavailable.map(entry => `${entry.source_id}:${entry.slug} (${entry.target === 'withdrawal_mirror' ? `withdrawal-mirror effect ${entry.effect_id}` : `request ${entry.request_id}`})`).join(', ')}.`,
      `Nothing was changed. The preview lists the choices every record offers; run it again (${command}) and apply one of those, or narrow it to one record with --request-id.`);
    const started = new Set((await readResolutions(engine, expect)).map(entry => entry.id));
    const fresh = approved.filter(entry => !started.has(entry.id));
    if (fresh.length) {
      // Re-verify the preview before anything is written: every record not yet started still has the bytes and revision the user saw.
      const current = await scanStuckRecoveries(engine, scope.source_ids);
      const digests = new Map(current.items.map(found => [found.id, found.digest]));
      if (fresh.some(entry => digests.get(entry.id) !== entry.digest)) throw previewChangedError(expect, command);
    }
    const items = approved.map(({ selection: _selection, ...recovery }, index) => item(recovery, index, expect, keep));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { recovery, hash, keep } = entry as RecoveryItem;
    const result = await resolveStuckRecovery(ctx.engine, recovery, { keep, previewHash: hash });
    return { applied: result.outcome === 'resolved' && !result.replayed, outcome: result.replayed ? 'replayed' : result.outcome,
      ...(result.blocked_reason ? { reason: result.blocked_reason } : {}),
      detail: { request_id: recovery.request_id, ...(recovery.effect_id ? { effect_id: recovery.effect_id } : {}), keep, request_state: result.request_state,
        finished_by: result.finished_by, backup_dir: result.backup_dir, next: result.next } };
  },
  render(details) {
    const recoveries = (details.recoveries ?? []) as StuckRecovery[];
    const heads = (details.heads ?? []) as Array<{ source_id: string; queued_request_id: string | null; blocked_by: string | null }>;
    const choices = (details.choices ?? []) as Array<{ keep: KeepChoice; what: string; apply_command: string }>;
    const lines: string[] = [];
    for (const head of heads) if (head.queued_request_id) lines.push(`  source ${head.source_id}: queued write ${head.queued_request_id} is blocked by ${head.blocked_by ?? 'nothing known'}`);
    for (const found of recoveries) {
      lines.push(...headerLines(found));
      for (const file of found.files) lines.push(...fileLines(file));
    }
    for (const refused of (details.refused ?? []) as RefusedRecovery[]) {
      lines.push(`  refused ${refused.effect_id ? `effect ${refused.effect_id} of ` : ''}${refused.request_id} (${refused.source_id}:${refused.slug}, ${refused.state}${refused.blocked_reason ? `, ${refused.blocked_reason}` : ''}) ${refused.code}: ${refused.reason}`);
      if (refused.fix?.user_message) lines.push(`    ask the user: ${refused.fix.user_message}`);
    }
    if (recoveries.length && !choices.length) lines.push('  no choice is available for every listed record: narrow the preview with --request-id, or resolve the files listed above by hand, then rerun the preview');
    for (const choice of choices) lines.push(`  --keep ${choice.keep}: ${choice.what}.`, `    apply (after the user picks it): ${choice.apply_command}`);
    if (choices.length) lines.push('  every choice first backs up the disk and recorded bytes beside the diff above');
    return lines;
  },
};
