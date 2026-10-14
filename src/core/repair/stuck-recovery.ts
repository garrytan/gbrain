/**
 * `gbrain repair stuck-recovery [--source <id>] [--request-id <uuid>]` (#6650 §1.10): the repair-kind adapter for
 * `persistence/recovery-resolve.ts`. Explicit-only, preview-bound and destructive-consent: the preview lists each
 * recovery record blocked on unexpected bytes (prior and disk fingerprints, a private diff, the choices available)
 * and saves the set under its hash; `--apply --expect <hash> --keep prior|disk --yes` resolves exactly that set. There is no
 * default `--keep`, and a terminal request is listed as refused (see recovery-resolve.ts for the per-state semantics).
 * Projection-only: no journal admission; each record finishes through the owner's own `recoverPublication`.
 */
import { OperationError } from '../ops/contract.ts';
import { loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { readResolutions, resolveStuckRecovery, scanStuckRecoveries, stuckRecoveryPreviewCommand, type KeepChoice, type RecoveryFileView, type RefusedRecovery, type StuckRecovery }
  from '../persistence/recovery-resolve.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type Selection = { sources: string[]; request_id: string | null };
type ApprovedRecovery = StuckRecovery & { selection: Selection };
type RecoveryItem = RepairItem & { recovery: StuckRecovery; hash: string; keep: KeepChoice };

const CHOICE_TEXT: Record<KeepChoice, string> = {
  prior: 'discard the edit: write the recorded prior bytes back (unlink the file when the prior was a create); the owner then finishes the recovery by its own rule, '
    + 'so a request with no recorded failure is requeued and its write publishes again, and one with a failure ends with it',
  disk: 'keep the edit and abandon the write: the request ends conflict (source_changed), or with the failure it already recorded, and its recovery record is '
    + 'cleared; the database page keeps the content before the write, so reconcile the page afterwards',
};

function item(recovery: StuckRecovery, index: number, hash: string, keep: KeepChoice): RecoveryItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: recovery.source_id, slug: recovery.slug, chars: 0, action: `resolve_keep_${keep}`,
    change: { from: recovery.digest, to: keep }, recovery, hash, keep };
}

const selectionOf = (scope: RepairScope, requestId?: string): Selection => ({ sources: scope.source_ids, request_id: requestId ?? null });
const hashOf = (scope: RepairScope, selection: Selection, items: StuckRecovery[]) =>
  previewHash({ kind: 'stuck-recovery-v1', brain_id: scope.brain_id, selection, items: items.map(found => found.digest) });

function fileLines(file: RecoveryFileView): string[] {
  const prior = file.prior.absent ? 'absent: prior was a create'
    : `sha256 ${file.prior.sha256.slice(0, 16)}… size ${file.prior.size ?? '?'} mode ${file.prior.mode === null ? '?' : file.prior.mode.toString(8)}${file.prior.stored ? '' : ' (bytes not stored in the record)'}`;
  const disk = file.disk.deleted ? 'deleted on disk' : file.disk.kind !== 'file' ? `${file.disk.kind} (not a regular file; resolve it by hand)`
    : `sha256 ${file.disk.sha256!.slice(0, 16)}… size ${file.disk.size} mode ${file.disk.mode.toString(8)}`;
  return [`    file ${file.relative}`, `      prior: ${prior}`, `      disk:  ${disk}`,
    `      recovery sees: ${file.matches === 'neither' ? 'neither the prior nor the published bytes (blocked)' : `the ${file.matches} bytes`}`,
    ...(file.diff_path ? [`      diff: ${file.diff_path}`, `      reproduce: ${file.diff_command}`] : [])];
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
          detail: `request ${found.request_id}, ${found.files.filter(file => file.matches === 'neither').length} of ${found.files.length} file(s) match neither recorded version` })),
        details: { recoveries: scan.items, heads: scan.heads, refused: scan.refused,
          choices: (['prior', 'disk'] as const).filter(keep => scan.items.length && scan.items.every(found => found.choices[keep]))
            .map(keep => ({ keep, what: CHOICE_TEXT[keep], apply_command: apply(keep) })) } };
    }
    if (!opts.expect || !opts.keep) {
      throw new OperationError('invalid_params', 'gbrain repair stuck-recovery --apply needs the preview hash and the version to keep.',
        `Preview first: ${command} — show the user the diff it prints, then run the choice they pick: ${command} --keep prior --apply --expect <preview-hash> --yes, `
        + `or ${command} --keep disk --apply --expect <preview-hash> --yes`, 'docs/guides/repair.md#stuck-recovery');
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
      detail: { request_id: recovery.request_id, keep, request_state: result.request_state, finished_by: result.finished_by, backup_dir: result.backup_dir, next: result.next } };
  },
  render(details) {
    const recoveries = (details.recoveries ?? []) as StuckRecovery[];
    const heads = (details.heads ?? []) as Array<{ source_id: string; queued_request_id: string | null; blocked_by: string | null }>;
    const choices = (details.choices ?? []) as Array<{ keep: KeepChoice; what: string; apply_command: string }>;
    const lines: string[] = [];
    for (const head of heads) if (head.queued_request_id) lines.push(`  source ${head.source_id}: queued write ${head.queued_request_id} is blocked by ${head.blocked_by ?? 'nothing known'}`);
    for (const found of recoveries) {
      lines.push(`  request ${found.request_id} (${found.operation} ${found.source_id}:${found.slug}, ${found.state}${found.blocked_reason ? `, ${found.blocked_reason}` : ''}; page revision ${found.page_revision ?? 'none'})`);
      lines.push(`    ${found.recorded_error ? `recorded failure ${found.recorded_error}: either choice ends the request with it` : 'no recorded failure: --keep prior requeues the write, --keep disk abandons it'}`);
      for (const file of found.files) lines.push(...fileLines(file));
    }
    for (const refused of (details.refused ?? []) as RefusedRecovery[]) lines.push(`  refused ${refused.effect_id ? `effect ${refused.effect_id} of ` : ''}${refused.request_id} (${refused.source_id}:${refused.slug}, ${refused.state}${refused.blocked_reason ? `, ${refused.blocked_reason}` : ''}) ${refused.code}: ${refused.reason}`);
    if (recoveries.length && !choices.length) lines.push('  no choice is available for every listed record: resolve the files listed above by hand, then rerun the preview');
    for (const choice of choices) lines.push(`  --keep ${choice.keep}: ${choice.what}.`, `    apply (after the user picks it): ${choice.apply_command}`);
    if (choices.length) lines.push('  either choice first backs up the disk and prior bytes beside the diff above');
    return lines;
  },
};
