/** `gbrain jobs authorize-legacy` (dispatched by runJobs in src/commands/jobs.ts). */
import { paidJobNames, parseFlag, reportJobsError, selectionSummaryLines, type JobsCommandContext } from './shared.ts';
import { applyLegacySelection, authorizeLegacyJobs, parseLegacyJobIds, previewLegacySelection } from '../../core/minions/authorize-legacy.ts';
import { parseLegacyJobSelection } from '../../core/minions/legacy-selection.ts';
import { catalogueError } from '../../core/error-catalogue.ts';
import { OperationError } from '../../core/ops/contract.ts';

export async function runJobsAuthorizeLegacy({ args, engine }: JobsCommandContext): Promise<void> {
  const json = args.includes('--json');
  try {
    const select = parseFlag(args, '--select');
    if (select === undefined && !args.includes('--select')) {
      const ids = parseLegacyJobIds(parseFlag(args, '--ids'));
      const preview = args.includes('--dry-run');
      const result = await authorizeLegacyJobs(engine, ids, preview ? undefined : parseFlag(args, '--expect'), !preview && args.includes('--yes'));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (args.includes('--ids')) {
      throw catalogueError('legacy_job_selection_invalid', 'Pass either --ids or --select, not both.', 'gbrain jobs authorize-legacy --select "status=waiting"');
    }
    const selection = parseLegacyJobSelection(select, 'authorize-legacy');
    const expected = parseFlag(args, '--expect');
    const yes = args.includes('--yes');
    // --dry-run always previews, even next to --expect/--yes, matching the --ids path.
    if (!args.includes('--dry-run') && (expected !== undefined || yes)) {
      const result = await applyLegacySelection(engine, selection, expected, yes);
      if (json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Authorized ${result.authorized} legacy job(s) matching ${result.selection}. Restart producers and workers now.`);
      return;
    }
    const preview = await previewLegacySelection(engine, selection);
    const paid = await paidJobNames(Object.keys(preview.summary.by_name));
    if (json) { console.log(JSON.stringify({ ...preview, paid_job_names: paid }, null, 2)); return; }
    console.log(`Legacy jobs matching ${preview.selection} (SQL NULL authority, authorizable): ${preview.summary.total}`);
    for (const line of selectionSummaryLines(preview.summary, paid)) console.log(line);
    if (preview.unsupported_ids.length) {
      console.log(`Unsupported non-NULL authority (not authorizable; cancel locally): ${preview.unsupported_ids.slice(0, 20).join(', ')}${preview.unsupported_ids.length > 20 ? ' …' : ''}`);
    }
    if (!preview.preview_hash) { console.log('Nothing to authorize.'); return; }
    console.log(`Startup-blocking dependencies outside the selection: ${preview.startup_blocking_dependency_count}`);
    console.log(`Preview hash: ${preview.preview_hash}`);
    console.log(`Apply exactly this set: ${preview.apply_command}`);
    console.log('Full rows: re-run with --json. Nothing was changed.');
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    reportJobsError(error, json);
  }
}
