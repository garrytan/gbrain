import type { BrainEngine } from '../core/engine.ts';
import {
  dateWindowFromArgs,
  listPendingMeetings,
  normalizeProviderList,
  syncMeetings,
  type MeetingProvider,
} from '../core/meeting-sync.ts';
import { propagatePendingMeetings, verifyCompleteMeetings } from '../core/meeting-propagation.ts';
import { getDefaultSourcePath, resolveSourceId } from '../core/source-resolver.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

interface Args {
  providers: MeetingProvider[];
  repoPath?: string;
  all?: boolean;
  days?: number;
  start?: string;
  end?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  listPending?: boolean;
  propagatePending?: boolean;
  verifyComplete?: boolean;
  agentReviewed?: boolean;
  meetings?: string[];
  limit?: number;
  source?: string;
}

type MeetingSyncJobMode = 'collect' | 'list-pending' | 'propagate-pending' | 'verify-complete';

export interface MeetingSyncJobParams extends Record<string, unknown> {
  mode: MeetingSyncJobMode;
  providers?: MeetingProvider[];
  repoPath?: string;
  window?: { start?: string; end?: string };
  dryRun?: boolean;
  force?: boolean;
  meetings?: string[];
  limit?: number;
  sourceId?: string;
  agentReviewed?: boolean;
}

export const HELP = `Usage: gbrain meeting-sync [options]

Sync meeting transcripts from Fireflies and Granola into a brain repo's
meetings/ directory as idempotent Phase 1 meeting pages.
Phase 2 propagation enriches attendee/entity/action pages, writes timelines,
creates bidirectional graph links, verifies deterministic writes, and leaves
meetings pending for final agent review.

Authentication:
  Uses local Composio CLI connections only:
  - fireflies toolkit
  - granola_mcp toolkit

Options:
  --providers LIST    fireflies,granola,all (default: all)
  --provider NAME     Alias for --providers NAME
  --repo PATH         Brain repo path. Defaults to resolved source local_path,
                      then legacy sync.repo_path.
  --days N            Sync the last N calendar days (default: 2)
  --start YYYY-MM-DD  Start date for backfill
  --end YYYY-MM-DD    End date for backfill (default: today)
  --all               Full backfill; omits provider date filters
  --dry-run           Fetch and report without writing files
  --force             Overwrite existing filename matches
  --list-pending      List meetings where ingestion_status is not complete
  --propagate-pending Propagate pending meetings to people/entity/action pages
  --verify-complete   Verify strict Phase 2 completion and finalize if allowed
  --agent-reviewed    Required with --verify-complete before writing complete
  --meeting VALUE     Restrict propagation to a meeting path or source_id
  --limit N           Limit --propagate-pending, --verify-complete, or
                      --list-pending output
  --source ID         DB source id for Phase 2 writes (default: resolver)
  --background        Submit as a Minion job; print job_id; exit
  --follow            With --background, follow the submitted job
  --json              Machine-readable output
  --help, -h          Show this help

Examples:
  gbrain meeting-sync --providers fireflies,granola --days 7
  gbrain meeting-sync --provider granola --all --repo ~/brain
  gbrain meeting-sync --start 2026-01-01 --end 2026-06-29 --dry-run
  gbrain meeting-sync --providers fireflies,granola --days 2 --background
  gbrain meeting-sync --propagate-pending --meeting granola:MEETING_UUID
  gbrain meeting-sync --verify-complete --agent-reviewed --meeting granola:MEETING_UUID
`;

function parseArgs(args: string[]): Args | { help: true } {
  const out: Partial<Args> = {};
  let providerRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { out.json = true; continue; }
    if (a === '--follow') { continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '--list-pending') { out.listPending = true; continue; }
    if (a === '--propagate-pending') { out.propagatePending = true; continue; }
    if (a === '--verify-complete') { out.verifyComplete = true; continue; }
    if (a === '--agent-reviewed') { out.agentReviewed = true; continue; }
    if (a === '--providers' || a === '--provider') {
      providerRaw = requireValue(args, ++i, a);
      continue;
    }
    if (a === '--meeting') {
      out.meetings = [...(out.meetings ?? []), requireValue(args, ++i, a)];
      continue;
    }
    if (a === '--source') {
      out.source = requireValue(args, ++i, a);
      continue;
    }
    if (a === '--repo') {
      out.repoPath = requireValue(args, ++i, a);
      continue;
    }
    if (a === '--days') {
      out.days = parsePositiveInt(requireValue(args, ++i, a), a);
      continue;
    }
    if (a === '--limit') {
      out.limit = parsePositiveInt(requireValue(args, ++i, a), a);
      continue;
    }
    if (a === '--start') {
      out.start = parseDateFlag(requireValue(args, ++i, a), a);
      continue;
    }
    if (a === '--end') {
      out.end = parseDateFlag(requireValue(args, ++i, a), a);
      continue;
    }
    if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
  }
  return {
    providers: normalizeProviderList(providerRaw),
    repoPath: out.repoPath,
    all: out.all,
    days: out.days,
    start: out.start,
    end: out.end,
    dryRun: out.dryRun,
    force: out.force,
    json: out.json,
    listPending: out.listPending,
    propagatePending: out.propagatePending,
    verifyComplete: out.verifyComplete,
    agentReviewed: out.agentReviewed,
    meetings: out.meetings,
    limit: out.limit,
    source: out.source,
  };
}

export function buildMeetingSyncJobParams(args: string[], now = new Date()): MeetingSyncJobParams {
  const parsed = parseArgs(args);
  if ('help' in parsed) throw new Error('--background cannot be combined with --help');
  const mode: MeetingSyncJobMode = parsed.listPending
    ? 'list-pending'
    : parsed.verifyComplete
      ? 'verify-complete'
      : parsed.propagatePending
        ? 'propagate-pending'
        : 'collect';
  const params: MeetingSyncJobParams = {
    mode,
    repoPath: parsed.repoPath,
    dryRun: parsed.dryRun,
    force: parsed.force,
    meetings: parsed.meetings,
    limit: parsed.limit,
    sourceId: parsed.source,
    agentReviewed: parsed.agentReviewed,
  };
  if (mode === 'collect') {
    params.providers = parsed.providers;
    params.window = dateWindowFromArgs({
      all: parsed.all,
      days: parsed.days,
      start: parsed.start,
      end: parsed.end,
      now,
    });
  }
  return stripUndefined(params) as MeetingSyncJobParams;
}

export async function runMeetingSync(engine: BrainEngine | null, args: string[]): Promise<void> {
  let effectiveArgs = args;
  if (args.includes('--background')) {
    if (!engine) throw new Error('--background requires a connected local engine.');
    const { maybeBackground } = await import('../core/cli-options.ts');
    const backgrounded = await maybeBackground({
      engine,
      args,
      jobName: 'meeting-sync',
      paramBuilder: buildMeetingSyncJobParams,
      source: 'cli',
    });
    if (backgrounded) return;
    // PGLite degrades to inline; strip background-only flags before normal parse.
    effectiveArgs = args.filter((a) => a !== '--background' && a !== '--follow');
  }

  const parsed = parseArgs(effectiveArgs);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }

  const repoPath = parsed.repoPath ?? (engine ? await getDefaultSourcePath(engine) : null);
  if (!repoPath) {
    throw new Error('No brain repo path configured. Pass --repo PATH or set a source local_path with `gbrain sources add <id> --path <path>`.');
  }

  if (parsed.listPending) {
    const pending = listPendingMeetings(repoPath).slice(0, parsed.limit);
    if (parsed.json) {
      console.log(JSON.stringify({ repoPath, pending }, null, 2));
      return;
    }
    if (pending.length === 0) {
      console.log('No pending meeting propagations.');
      return;
    }
    console.log(`Pending meeting propagations (${pending.length}):`);
    for (const p of pending) {
      console.log(`- ${p.path}${p.sourceId ? ` [${p.sourceId}]` : ''}${p.ingestionStatus ? ` (${p.ingestionStatus})` : ''}`);
    }
    return;
  }

  if (parsed.verifyComplete) {
    if (!engine) throw new Error('Completion verification requires a connected local engine.');
    const sourceId = await resolveSourceId(engine, parsed.source, repoPath);
    const result = await verifyCompleteMeetings(engine, {
      repoPath,
      sourceId,
      dryRun: parsed.dryRun,
      meetings: parsed.meetings,
      limit: parsed.limit,
      agentReviewed: parsed.agentReviewed,
    });
    if (result.failed > 0) setCliExitVerdict(1);
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`meeting-sync completion verification repo: ${repoPath}${parsed.dryRun ? ' (dry run)' : ''}`);
    console.log(`source: ${sourceId}`);
    console.log(`scanned ${result.scanned}, completed ${result.completed}, blocked ${result.failed}`);
    for (const m of result.meetings) {
      console.log(`- ${m.status}: ${m.path}`);
      for (const err of m.verificationErrors) console.error(`[meeting-sync] ${m.slug}: ${err}`);
    }
    return;
  }

  if (parsed.propagatePending) {
    if (!engine) throw new Error('Phase 2 propagation requires a connected local engine.');
    const sourceId = await resolveSourceId(engine, parsed.source, repoPath);
    const result = await propagatePendingMeetings(engine, {
      repoPath,
      sourceId,
      dryRun: parsed.dryRun,
      meetings: parsed.meetings,
      limit: parsed.limit,
    });
    if (result.failed > 0) setCliExitVerdict(1);
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`meeting-sync Phase 2 repo: ${repoPath}${parsed.dryRun ? ' (dry run)' : ''}`);
    console.log(`source: ${sourceId}`);
    console.log(`scanned ${result.scanned}, completed ${result.completed}, pending ${result.pending}, failed ${result.failed}`);
    for (const m of result.meetings) {
      console.log(`- ${m.status}: ${m.path}`);
      console.log(`  attendees ${m.attendees.length}, entities ${m.entities.length}, action items ${m.actionItems.length}, links ${m.linksCreated}, timeline entries ${m.timelineEntriesCreated}`);
      for (const err of m.verificationErrors) console.error(`[meeting-sync] ${m.slug}: ${err}`);
      for (const reason of m.skipReasons) console.error(`[meeting-sync] ${m.slug}: ${reason}`);
    }
    return;
  }

  const results = await syncMeetings({
    providers: parsed.providers,
    repoPath,
    window: dateWindowFromArgs({
      all: parsed.all,
      days: parsed.days,
      start: parsed.start,
      end: parsed.end,
    }),
    dryRun: parsed.dryRun,
    force: parsed.force,
  });

  const missingAll = results.every(r => r.fetched === 0 && r.created === 0 && r.skipped === 0 && r.failed > 0);
  if (missingAll) setCliExitVerdict(1);

  if (parsed.json) {
    console.log(JSON.stringify({ repoPath, dryRun: Boolean(parsed.dryRun), results }, null, 2));
    return;
  }

  console.log(`meeting-sync repo: ${repoPath}${parsed.dryRun ? ' (dry run)' : ''}`);
  for (const r of results) {
    console.log(`${r.provider}: fetched ${r.fetched}, created ${r.created}, skipped ${r.skipped}`);
    for (const warning of r.warnings) console.error(`[meeting-sync] ${warning}`);
    for (const err of r.errors) console.error(`[meeting-sync] ${r.provider}: ${err.title ? `${err.title}: ` : ''}${err.error}`);
    for (const file of r.files.slice(0, 5)) console.log(`  ${file.path}`);
    if (r.files.length > 5) console.log(`  ... ${r.files.length - 5} more`);
  }
  const created = results.reduce((sum, r) => sum + r.created, 0);
  if (created > 0 && !parsed.dryRun) {
    console.log('Next: run `gbrain sync --no-pull --no-embed`, `gbrain embed --stale`, then propagate every pending meeting before marking ingestion_status complete.');
  }
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function parseDateFlag(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${flag} must use YYYY-MM-DD`);
  return raw;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, stripUndefined(v)] as const)
        .filter(([, v]) => v !== undefined),
    );
  }
  return value === undefined ? undefined : value;
}
