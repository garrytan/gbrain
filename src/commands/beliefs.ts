/**
 * `gbrain beliefs`: the belief ledger's coverage (docs/designs/BELIEF_LEDGER.md
 * section 7). `enable` runs the resumable baseline and starts a coverage
 * interval; `disable` stops it; `status` prints each source's intervals,
 * watermark, certified status, baseline progress, restore gaps, drift marks
 * and unmarked publications; `reconcile` appends `reconcile` events for drifted
 * slugs and fills missing commit marks; `backfill` seeds best-effort history
 * before the coverage start from retained page versions.
 */
import type { BrainEngine } from '../core/engine.ts';
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { disableBeliefLedger, enableBeliefLedger } from '../core/belief/coverage.ts';
import { coverageIntervals, coveredSources, fillCommitMarks, orphanLifetimes, reconcileBeliefDrift, unmarkedPublications, type CoverageInterval } from '../core/belief/coverage-report.ts';
import { backfillBeliefHistory } from '../core/belief/backfill.ts';
import { readLedgerSource } from '../core/belief/ledger.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';
import { resolveSourceId, SourceTargetError } from '../core/source-resolver.ts';
import { replayPurgesCli } from './beliefs-replay-purges.ts';
import { beliefChanges, renderBeliefChanges } from '../core/belief/changes.ts';
import { parseSince } from '../core/since.ts';

export const BELIEFS_USAGE = [
  'Usage: gbrain beliefs <enable|disable|status|changes|reconcile|backfill|replay-purges> [--source <id>] [--json]',
  '  enable     Start recording the belief ledger on a source: baselines every page (resumable) and sets the watermark.',
  '             Only a managed source\'s coverage is certified; an unmanaged source is recorded but uncertified.',
  '  disable    Stop recording (appends coverage.stopped); enabling again starts a new interval with a new baseline.',
  '  status     Coverage intervals per source: watermark, certified or uncertified, baseline progress, restore gaps, drift.',
  '  changes [<entity>...] [--since 7d]',
  '             Each belief that changed in the window (default the last 7 days), before and after, with the event that caused it.',
  '             An inferred relationship end is marked as an upper bound. On a thin client this runs through the host\'s delta',
  '             and lists what a remote caller may see: world beliefs on pages visible now.',
  '  reconcile  Appends reconcile events for slugs whose state drifted from their newest event, and fills missing commit marks.',
  '             A drifted slug\'s interval stays uncertified on a managed source.',
  '  backfill   Seeds best-effort history before the coverage start from retained page versions (never certified).',
  '  replay-purges --archived-at <iso> (--purge-mirror <abs path> | --from-url-env <VAR>) [--apply]',
  '             After a Postgres restore, replays the purges the restored backup does not hold (dry run unless --apply).',
  '  --source <id>  The source (default: every covered source for status and reconcile; the resolved source, as for other commands, for the rest).',
].join('\n');

const SUBCOMMANDS = ['enable', 'disable', 'status', 'changes', 'reconcile', 'backfill', 'replay-purges'] as const;

/** `beliefs changes` arguments: the entity slugs and the window start, shared with the thin-client route. */
export function beliefsChangesArgs(args: string[], now = Date.now()): { entities: string[]; since: string } {
  const entities: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--since' || args[i] === '--source') i++;
    else if (!args[i]!.startsWith('-')) entities.push(args[i]!);
  }
  const at = args.indexOf('--since');
  const raw = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--since='))?.slice('--since='.length);
  if ((at >= 0 || raw !== undefined) && (!raw || raw.startsWith('-'))) throw opError('invalid_params', '--since needs a value.', 'Pass a relative age (7d, 24h) or an ISO date (2026-10-01).');
  try {
    return { entities, since: parseSince(raw ?? '7d', '--since', now)! };
  } catch (error) {
    throw opError('invalid_params', (error as Error).message, 'Pass a relative age (7d, 24h) or an ISO date (2026-10-01).');
  }
}

function sourceArg(args: string[]): string | undefined {
  const at = args.indexOf('--source');
  const value = at >= 0 ? args[at + 1] : args.find(a => a.startsWith('--source='))?.slice('--source='.length);
  if ((at >= 0 || value !== undefined) && (!value || value.startsWith('-'))) throw opError('invalid_params', '--source needs a source id.', 'Name the source after --source; gbrain sources list shows the source ids.');
  return value;
}

const unknownSource = (sourceId: string) => opError('invalid_params', `Source ${sourceId} does not exist.`, 'Run gbrain sources list to see the source ids.');

async function sourceStatus(engine: BrainEngine, sourceId: string) {
  const source = await readLedgerSource(engine, sourceId);
  if (!source) throw unknownSource(sourceId);
  const intervals = await coverageIntervals(engine, sourceId);
  return { source_id: sourceId, managed: await readManagedMode(engine), active: source.coverage != null && source.coverage !== 'coverage.stopped', intervals,
    unmarked_publications: (await unmarkedPublications(engine, sourceId)).length, orphans: await orphanLifetimes(engine, sourceId, 5) };
}

function renderInterval(i: CoverageInterval): string[] {
  const lines = [`  interval from ${i.started_at}${i.stopped_at ? ` to ${i.stopped_at}` : ' (open)'}: ${i.certified ? 'certified (links: journaled publications only)' : 'uncertified'}`,
    `    watermark: ${i.watermark ?? 'none yet'}; baseline: ${i.baseline.pages_done} page(s) done${i.baseline.complete ? ', complete' : `, ${i.baseline.pending ?? '?'} pending (rerun gbrain beliefs enable to resume)`}`];
  for (const r of i.restores) lines.push(`    restore at ${r.at} from an archive of ${r.archived_at ?? 'unknown time'} (gap); purge replay: ${r.purge_replay ?? 'unknown'}`);
  if (i.drift.length) lines.push(`    drift: ${i.drift.length} reconcile mark(s), uncertified permanently for ${[...new Set(i.drift.map(d => d.slug))].slice(0, 5).join(', ')}`);
  return lines;
}

async function report(args: string[], value: unknown, text: string): Promise<void> {
  if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(value, null, 2)}\n`);
  else console.log(text);
}

export async function runBeliefs(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub] = args;
  if (args.includes('--help') || args.includes('-h') || !sub) { console.log(BELIEFS_USAGE); return; }
  try {
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw opError('invalid_params', `Unknown beliefs subcommand '${sub}'.`, 'gbrain beliefs --help lists enable, disable, status, changes, reconcile, backfill and replay-purges.');
    }
    const named = sourceArg(args);
    if (named !== undefined && !await readLedgerSource(engine, named)) throw unknownSource(named);
    const target = () => resolveSourceId(engine, named).catch(error => {
      throw error instanceof SourceTargetError ? opError('invalid_params', error.message, 'Name the source after --source; gbrain sources list shows the source ids.') : error;
    });
    if (sub === 'enable') {
      const sourceId = await target();
      const run = await enableBeliefLedger(engine, sourceId);
      const outcome = !run.complete ? 'stopped before the baseline finished (a disable ran meanwhile); nothing is certified'
        : run.certified ? 'certified (managed source)' : 'uncertified (unmanaged source: recorded, never certified)';
      await report(args, { source_id: sourceId, ...run }, `Belief ledger ${run.resumed ? 'resumed' : 'enabled'} on ${sourceId}: ${run.pages} page(s) baselined; ${outcome}.`
        + `${run.unkeyable.length ? ` ${run.unkeyable.length} slug(s) no page key can name were not baselined: ${run.unkeyable.slice(0, 5).join(', ')}.` : ''}`);
      return;
    }
    if (sub === 'disable') {
      const sourceId = await target();
      const stopped = await disableBeliefLedger(engine, sourceId);
      await report(args, { source_id: sourceId, stopped }, stopped ? `Belief ledger stopped on ${sourceId}.` : `The belief ledger was not recording ${sourceId}.`);
      return;
    }
    if (sub === 'backfill') {
      const sourceId = await target();
      const result = await backfillBeliefHistory(engine, sourceId);
      const incomplete = result.pages.filter(p => !p.complete);
      await report(args, result, `Backfilled ${result.events} event(s) before ${result.since} across ${result.pages.length} page(s) of ${sourceId} (best effort, never certified)`
        + `${incomplete.length ? `; ${incomplete.length} page(s) incomplete (${[...new Set(incomplete.flatMap(p => p.reasons))].join(', ')})` : ''}.`);
      return;
    }
    if (sub === 'changes') {
      const { entities, since } = beliefsChangesArgs(args);
      const changes = await beliefChanges(engine, { sourceId: await target(), since, until: new Date().toISOString(), remote: false, entities });
      await report(args, changes, renderBeliefChanges(changes));
      return;
    }
    if (sub === 'replay-purges') {
      const { value, text } = await replayPurgesCli(engine, args);
      await report(args, value, text);
      return;
    }
    const sources = named ? [named] : await coveredSources(engine);
    if (sub === 'status') {
      const statuses = [];
      for (const sourceId of sources) statuses.push(await sourceStatus(engine, sourceId));
      const text = statuses.length ? statuses.flatMap(s => [`${s.source_id} (${s.managed ? 'managed' : 'unmanaged'}, ${s.active ? 'recording' : 'not recording'})`,
        ...(s.intervals.length ? s.intervals.flatMap(renderInterval) : ['  never enabled (gbrain beliefs enable --source ' + s.source_id + ')']),
        ...(s.unmarked_publications ? [`  ${s.unmarked_publications} committed publication(s) without a commit mark (gbrain beliefs reconcile fills them)`] : []),
        ...(s.orphans.count ? [`  ${s.orphans.count} orphan lifetime(s) (gbrain beliefs reconcile ends them)`] : [])]).join('\n')
        : 'The belief ledger is not enabled on any source. Enable it with gbrain beliefs enable --source <id>.';
      await report(args, { sources: statuses }, text);
      return;
    }
    const results = [];
    for (const sourceId of sources) {
      const drift = await reconcileBeliefDrift(engine, sourceId);
      results.push({ source_id: sourceId, checked: drift.scan.checked, reconciled: drift.reconciled, events: drift.events, commit_marks_filled: await fillCommitMarks(engine, sourceId, { deep: true }) });
    }
    await report(args, { sources: results }, results.length ? results.map(r => `${r.source_id}: ${r.checked} slug(s) checked, ${r.reconciled.length} reconciled (${r.events} event(s)), `
      + `${r.commit_marks_filled} commit mark(s) filled.`).join('\n') : 'No source has belief ledger coverage; nothing to reconcile.');
  } catch (error) {
    if (error instanceof OperationError) { setCliExitVerdict(writeCliError(error, 'beliefs', { json: jsonRequested(args) })); return; }
    throw error;
  }
}
