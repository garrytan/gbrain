/**
 * gbrain transcripts archive — the day-sliced conversation archive (GST-2768). Off unless the owner turns it on.
 *
 *   run                          archive the last few local days from every readable harness
 *   backfill --from D [--to D]   archive a date range, newest first, capped per run; embedding held for approval
 *   status                       readers, pinned timezone, archived and held days
 *   adopt-legacy --dir <folder>  list the days an old archive folder covers (--apply records them so backfill skips them)
 *   on | off                     turn the archive on or off for this brain
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

Writes one redacted page per conversation per local day (conversations/<harness>/<day>/...) plus a day index
(conversations/days/<day>) into the archive source (default "conversations"). Off unless turned on with
"gbrain transcripts archive on". Backfilled pages are keyword-only until "gbrain embed --held" approves their cost.
Guide: docs/guides/conversation-archive.md`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find(a => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export async function runTranscriptsArchive(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'> = {}): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const sourceId = flag(rest, '--source');
  const out = (doc: unknown, human: () => void) => { if (json) console.log(JSON.stringify(doc, null, 2)); else human(); };
  const archive = await import('../core/transcripts/archive.ts');

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
    out(status, () => {
      console.log('conversation archive: ' + (status.enabled ? 'on' : 'off') + ' (source: ' + status.source_id + ', timezone: ' + (status.timezone ?? status.configured_timezone + ', pinned at the first run') + ')');
      for (const h of status.harnesses) console.log('  ' + h.reader.padEnd(18) + ' ' + (h.info ?? (h.conversations + ' conversation(s), newest session day ' + (h.newest_session_day ?? '-') + ', newest archived day ' + (h.newest_archived_day ?? '-'))));
      console.log('  archived days: ' + status.archived_days + (status.legacy_days ? ', covered by a legacy archive: ' + status.legacy_days : ''));
      for (const h of status.held) console.log('  held: ' + h.harness + ' ' + h.day + ' (' + h.code + ')');
      for (const e of status.errors) console.log('  error: ' + e.reader + ' ' + e.code + ': ' + e.message);
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
  const context = dryRun ? undefined : await dispatch.makeContext?.(engine, { source: sourceId ?? 'conversations' });
  const result = await archive.runTranscriptArchive(engine, {
    mode: sub, dryRun, sourceId, context,
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
    for (const d of result.days.filter(d => d.status === 'held' || d.status === 'error')) console.log('  ' + d.status + ': ' + d.harness + ' ' + d.day + ' (' + d.code + ')');
    for (const line of result.info) console.log('  ' + line);
    for (const e of result.errors) console.log('  error: ' + e.reader + ' ' + e.code + ': ' + e.message);
    if (sub === 'backfill' && result.written) console.log('  backfilled pages are keyword-only; preview their embedding cost with: gbrain embed --held --dry-run');
  });
  if (result.errors.length || result.days.some(d => d.status === 'error') || (result.held && result.fix)) setCliExitVerdict(1);
}
