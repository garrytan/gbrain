/** `gbrain jobs cancel` (dispatched by runJobs in src/commands/jobs.ts). */
import { paidJobNames, parseFlag, reportJobsError, selectionSummaryLines, type JobsCommandContext } from './shared.ts';
import { applyLegacyCancel, previewLegacyCancel } from '../../core/minions/legacy-cancel.ts';
import { parseLegacyJobSelection } from '../../core/minions/legacy-selection.ts';
import { OperationError, opError } from '../../core/ops/contract.ts';

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
  const groupId = parseFlag(args, '--group');
  if (groupId !== undefined) return cancelSpendGroup(ctx, groupId);
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

/** `jobs cancel --group <id>`: cancels every unfinished job of a spend group (finished rows are left as they are). */
async function cancelSpendGroup({ args, engine, queue }: JobsCommandContext, groupId: string): Promise<void> {
  const { groupJobs } = await import('../../core/minions/spend-authorization.ts');
  const jobs = await groupJobs(engine, groupId);
  const cancelled: number[] = [];
  for (const job of jobs) {
    if (['completed', 'failed', 'dead', 'cancelled'].includes(job.status)) continue;
    if (await queue.cancelJob(job.id)) cancelled.push(job.id);
  }
  const json = args.includes('--json');
  if (!jobs.length) {
    if (json) return reportJobsError(opError('not_found', `No jobs in spend group ${groupId}.`, `Check the id with: gbrain jobs list --group ${groupId} --json`), true);
    console.error(`No jobs in spend group ${groupId}; check the id with: gbrain jobs list --group ${groupId} --json`);
    process.exit(1);
  }
  if (json) { console.log(JSON.stringify({ group_id: groupId, cancelled_ids: cancelled, jobs: jobs.length }, null, 2)); return; }
  console.log(`Cancelled ${cancelled.length} unfinished job(s) of spend group ${groupId}${cancelled.length ? `: ${cancelled.join(', ')}` : ''}.`);
}
