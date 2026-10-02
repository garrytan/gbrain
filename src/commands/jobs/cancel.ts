/** `gbrain jobs cancel` (dispatched by runJobs in src/commands/jobs.ts). */
import { paidJobNames, parseFlag, reportJobsError, selectionSummaryLines, type JobsCommandContext } from './shared.ts';
import { applyLegacyCancel, previewLegacyCancel } from '../../core/minions/legacy-cancel.ts';
import { parseLegacyJobSelection } from '../../core/minions/legacy-selection.ts';
import { OperationError } from '../../core/ops/contract.ts';

/** `--select <filter> [--expect <hash> --yes]`: preview-bound bulk cancel of legacy rows (DX-T2). */
async function runLegacyCancel({ args, engine }: JobsCommandContext): Promise<void> {
  const json = args.includes('--json');
  try {
    const selection = parseLegacyJobSelection(parseFlag(args, '--select'), 'cancel');
    const expected = parseFlag(args, '--expect');
    const yes = args.includes('--yes');
    // --dry-run always previews, even next to --expect/--yes, matching the --ids path.
    if (!args.includes('--dry-run') && (expected !== undefined || yes)) {
      const result = await applyLegacyCancel(engine, selection, expected, yes);
      if (json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Cancelled ${result.cancelled_ids.length} legacy job(s) matching ${result.selection}.`);
      return;
    }
    const preview = await previewLegacyCancel(engine, selection);
    const paid = await paidJobNames(Object.keys(preview.summary.by_name));
    if (json) { console.log(JSON.stringify({ ...preview, paid_job_names: paid }, null, 2)); return; }
    console.log(`Legacy jobs matching ${preview.selection} to cancel (missing or unsupported authority): ${preview.summary.total}`);
    for (const line of selectionSummaryLines(preview.summary, paid)) console.log(line);
    if (preview.unsupported_ids.length) console.log(`  Unsupported non-NULL authority among them: ${preview.unsupported_ids.slice(0, 20).join(', ')}`);
    if (!preview.preview_hash) { console.log('Nothing to cancel.'); return; }
    if (preview.parent_transitions.length) {
      console.log(`Parents that return to waiting: ${preview.parent_transitions.map(p => p.id).join(', ')}`);
    }
    console.log(`Preview hash: ${preview.preview_hash}`);
    console.log(`Cancel exactly this set: ${preview.apply_command}`);
    console.log('Full rows: re-run with --json. Nothing was changed.');
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    reportJobsError(error, json);
  }
}

export async function runJobsCancel(ctx: JobsCommandContext): Promise<void> {
  const { args, queue } = ctx;
  if (args.includes('--select')) return runLegacyCancel(ctx);
  const id = parseInt(args[1], 10);
  if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  const cancelled = await queue.cancelJob(id);
  if (cancelled) {
    console.log(`Job #${id} cancelled.`);
  } else {
    console.error(`Could not cancel job #${id} (may already be completed/dead).`);
    process.exit(1);
  }
}
