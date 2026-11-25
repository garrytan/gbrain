/**
 * GST-2476 gap 1: the readers of the access read log (core/access/read-log.ts).
 *
 *   gbrain access log [--member <id>] [--since 7d] [--limit 100] [--json]
 *   gbrain access who-read <slug> [--source <id>] [--since 30d] [--limit 100] [--json]
 *
 * Read-only, trusted local CLI. A page id whose page was purged since shows as #<id>.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { AccessReadLogEntryRow } from '../core/engine-sql/access-read-log.ts';
import { opError } from '../core/ops/contract.ts';
import { parseSince } from '../core/since.ts';
import { usageError } from '../cli/cli-error.ts';

export interface ReadLogEntry {
  at: string;
  member: string | null;
  audience: string[] | null;
  operation: string;
  transport: string;
  result_code: string;
  pages: string[];
}

interface Window { since?: string; limit?: string }

function window(opts: Window, defaultSince: string): { since: string; limit: number } {
  let since: string;
  try { since = parseSince(opts.since ?? defaultSince)!; } catch (e) { throw usageError((e as Error).message, 'Pass --since 7d, 24h or 2026-10-01.'); }
  const limit = opts.limit === undefined ? 100 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw usageError('--limit takes a whole number from 1 to 10000.', 'Pass --limit 100.');
  return { since, limit };
}


type Row = AccessReadLogEntryRow;
const entry = (r: Row): ReadLogEntry => ({ at: new Date(r.created_at).toISOString(), member: r.member, audience: r.audience, operation: r.operation, transport: r.transport, result_code: r.result_code, pages: r.pages ?? [] });

/** The logged reads in the window, newest first; --member matches the reads it made and the audiences that named it. */
export async function readAccessLog(engine: BrainEngine, opts: Window & { member?: string }): Promise<ReadLogEntry[]> {
  const { since, limit } = window(opts, '7d');
  const rows = await engine.readAccessReadLog({ since, member: opts.member ?? null, limit });
  return rows.map(entry);
}

export interface WhoReadResult {
  pages: string[];
  since: string;
  readers: Array<{ who: string; reads: number; last_at: string }>;
  reads: ReadLogEntry[];
}

/** Who read a page (every page with that slug, or the one in --source) in the window, by member or audience, with the reads. */
export async function whoRead(engine: BrainEngine, slug: string, opts: Window & { source?: string }): Promise<WhoReadResult> {
  const { since, limit } = window(opts, '30d');
  const pages = await engine.listAccessReadPageRefs(slug, opts.source ?? null);
  if (pages.length === 0) throw opError('page_not_found', `No page ${slug}${opts.source ? ` in source ${opts.source}` : ''}.`, 'Find the slug with gbrain find, then run the command again.');
  const ids = pages.map(p => p.id);
  const reads = (await engine.readAccessReadsOfPages({ pageIds: ids, since, limit })).map(entry);
  const tally = await engine.tallyAccessReadsOfPages({ pageIds: ids, since });
  return {
    pages: pages.map(p => `${p.source_id}:${p.slug}`),
    since,
    readers: tally.map(t => ({ who: t.who, reads: Number(t.reads), last_at: new Date(t.last_at).toISOString() })),
    reads,
  };
}

const who = (e: ReadLogEntry) => e.member ?? e.audience?.join('+') ?? '(unbound)';

export function readLogLines(entries: readonly ReadLogEntry[]): string[] {
  if (entries.length === 0) return ['No logged member reads in this window. Owner reads, and every read on a brain with no members, are not logged.'];
  return entries.map(e => `${e.at}  ${who(e)}  ${e.operation} (${e.transport})  ${e.result_code}${e.pages.length ? `  ${e.pages.join(', ')}` : ''}`);
}

export function whoReadLines(r: WhoReadResult): string[] {
  return [
    `${r.pages.join(', ')}: read since ${r.since}`,
    ...(r.readers.length ? r.readers.map(t => `  ${t.who}  ${t.reads} read(s), last ${t.last_at}`) : ['  No logged member reads. Owner reads are not logged.']),
    ...(r.reads.length ? ['Reads, newest first:', ...readLogLines(r.reads).map(l => '  ' + l)] : []),
  ];
}
