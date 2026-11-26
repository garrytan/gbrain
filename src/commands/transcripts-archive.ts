/**
 * gbrain transcripts archive — the day-sliced conversation archive (GST-2768). On by default on a personal brain, offered on a shared one.
 *
 *   run                          archive the last few local days from every readable harness
 *   backfill --from D [--to D]   archive a date range, newest first, capped per run; embedding held for approval
 *   status                       readers as of the last run, pinned timezone, archived and held days (reads no session)
 *   adopt-legacy --dir <folder>  list the days an old archive folder covers (--apply records them so backfill skips them)
 *   on | off                     turn the archive on or off for this brain
 *   setup-import ...             the history import gbrain setup offers on a new personal install (transcripts-archive-setup-import.ts)
 *
 * Core: src/core/transcripts/archive.ts. Trusted local CLI only; no MCP operation.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { CliDispatchContext } from '../cli/command-table.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const HELP = `Usage:
  gbrain transcripts archive run [--dry-run] [--source S] [--json]
  gbrain transcripts archive backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--source S] [--json]
  gbrain transcripts archive status [--source S] [--json]
  gbrain transcripts archive adopt-legacy --dir <folder> [--dry-run | --apply] [--source S] [--json]
  gbrain transcripts archive on | off [--json]
  gbrain transcripts archive setup-import receipt|preview|run|decline|card ...   (the history import gbrain setup offers; --help)

Writes one redacted page per conversation per local day (conversations/<harness>/<day>/...) plus a day index
(conversations/days/<day>) into the archive source (default "conversations"). On by default on a personal brain,
where the maintenance pass runs it; "gbrain transcripts archive off" stops it, and a shared brain turns it on with
"gbrain transcripts archive on". Backfilled pages are keyword-only until "gbrain embed --held" approves their cost.
Guide: docs/guides/conversation-archive.md`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runTranscriptsArchive(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'> = {}): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const sourceId = flag(rest, '--source');
  const out = (doc: unknown, human: () => void) => { if (json) console.log(JSON.stringify(doc, null, 2)); else human(); };
  const archive = await import('../core/transcripts/archive.ts');

  if (sub === 'setup-import') {
    const { runSetupImport } = await import('./transcripts-archive-setup-import.ts');
    return runSetupImport(engine, rest, dispatch);
  }

  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP);
    if (sub && sub !== '--help' && sub !== '-h' && !rest.includes('--help') && !rest.includes('-h')) setCliExitVerdict(2);
    return;
  }

  if (sub === 'on' || sub === 'off') {
    await archive.setArchiveEnabled(engine, sub === 'on');
    out({ enabled: sub === 'on' }, () => console.log(sub === 'on'
      ? 'conversation archive: on. Run "gbrain transcripts archive run" now, or "gbrain transcripts archive backfill --from <day>" for history.'
      : 'conversation archive: off. Pages already written stay; nothing new is archived.'));
    return;
  }

  if (sub === 'status') {
    const status = await archive.archiveStatus(engine, { sourceId });
    const { resolveArchiveEnabled } = await import('../core/transcripts/archive-default.ts');
    const { loadConfig } = await import('../core/config.ts');
    const why = json ? null : await resolveArchiveEnabled(engine, { config: (() => { try { return loadConfig(); } catch { return null; } })() }).then(e => e.reason, () => null);
    const upkeepOff = !json && status.enabled && !await (await import('../core/maintenance/run.ts')).upkeepEnabled(engine);
    out(status, () => {
      console.log('conversation archive: ' + (status.enabled ? 'on' : 'off') + ' (source: ' + status.source_id + ', timezone: ' + (status.timezone ?? status.configured_timezone + ', pinned at the first run') + ')');
      if (why) console.log('  why: ' + why);
      for (const h of status.harnesses) {
        const read = h.read_at ? h.conversations + ' conversation(s) read by the last ' + (h.read_mode ?? 'run') + ' (' + h.read_at + '), newest session day ' + (h.newest_session_day ?? '-') : 'not read by an archive run yet';
        console.log('  ' + h.reader.padEnd(18) + ' ' + (h.info ?? read + ', newest archived day ' + (h.newest_archived_day ?? '-')));
      }
      console.log('  archived days: ' + status.archived_days + (status.legacy_days ? ', covered by a legacy archive: ' + status.legacy_days : ''));
      for (const h of status.held) console.log('  held: ' + h.harness + ' ' + h.day + ' (' + h.code + ')');
      for (const e of status.errors) console.log('  error on the last run' + (e.at ? ' (' + e.at + ')' : '') + ': ' + e.reader + ' ' + e.code + ': ' + e.message);
      if (status.rescope) console.log('  not kept to the owner yet (' + status.rescope.code + '): ' + status.rescope.message);
      if (upkeepOff) console.log('  maintenance.auto is false, so free upkeep does not archive by itself (an installed autopilot still does); archive now with "gbrain transcripts archive run"');
    });
    if (status.errors.length) setCliExitVerdict(1);
    return;
  }

  if (sub === 'adopt-legacy') {
    const dir = flag(rest, '--dir');
    if (!dir) {
      const { exitCliError, usageError } = await import('../cli/cli-error.ts');
      exitCliError(usageError('adopt-legacy needs --dir <folder>.', 'Run gbrain transcripts archive adopt-legacy --dir <old archive folder> --dry-run.'), 'transcripts', { json });
      return;
    }
    const result = await archive.adoptLegacyArchive(engine, { dir, apply: rest.includes('--apply'), sourceId });
    out(result, () => {
      console.log((result.applied ? 'adopted' : 'would adopt (dry run; pass --apply to record)') + ' ' + result.covered.length + ' day(s) from ' + result.dir);
      for (const [h, n] of Object.entries(result.by_harness)) console.log('  ' + (h === '*' ? 'every harness' : h).padEnd(14) + ' ' + n + ' day(s)');
      console.log('The old files are left as they are. Remove the old scheduled script yourself, then run "gbrain transcripts archive backfill --from <day>" for the gap.');
    });
    return;
  }

  if (sub !== 'run' && sub !== 'backfill') {
    console.log(HELP);
    setCliExitVerdict(2);
    return;
  }
  const dryRun = rest.includes('--dry-run');
  const makeContext = dispatch.makeContext;
  const result = await archive.runTranscriptArchive(engine, {
    mode: sub, dryRun, sourceId,
    ...(makeContext ? { makeContext: (source: string) => makeContext(engine, { source }) } : {}),
    ...(sub === 'backfill' ? { from: flag(rest, '--from'), to: flag(rest, '--to') } : {}),
  });
  out(result, () => {
    if (result.message) console.log(result.message);
    if (result.fix?.argv) console.log('  next: ' + result.fix.argv.join(' '));
    if (!result.enabled && !result.dry_run) return;
    console.log('conversation archive ' + sub + (result.dry_run ? ' (dry run)' : '') + ': ' + result.from + ' to ' + result.to + ' in ' + result.timezone + ', source ' + result.source_id + ' (' + result.write_mode + ')');
    console.log('  days written ' + result.written + ', unchanged ' + result.unchanged + ', held ' + result.held + ', planned ' + result.planned + ', covered by legacy ' + result.skipped_legacy);
    const redacted = result.days.filter(d => (d.redactions ?? 0) > 0);
    if (redacted.length) console.log('  redacted values on ' + redacted.length + ' page(s): ' + redacted.map(d => d.slug + ' (' + d.redactions + ')').join(', '));
    for (const d of result.days.filter(d => d.status === 'held')) console.log('  held: ' + d.harness + ' ' + d.day + ' (' + d.code + ')');
    for (const line of result.info) console.log('  ' + line);
    for (const e of result.errors) console.log('  error: ' + (e.reader ?? e.harness + (e.day ? ' ' + e.day : '')) + ' ' + e.code + ': ' + e.message);
    if (sub === 'backfill' && result.written) console.log('  backfilled pages are keyword-only; preview their embedding cost with: gbrain embed --held --dry-run');
  });
  if (result.errors.length) setCliExitVerdict(1);
}
