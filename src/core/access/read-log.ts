/**
 * GST-2476 gap 1: the access read log. One row per read a non-owner member or audience made: an enforced member CLI
 * read (cli/enforced-member.ts) or a remote read whose credential is bound to a member or which asserts an audience
 * (mcp/dispatch.ts). A row holds when, who (member, audience), the operation, the transport, the result code and the
 * ids of the pages the read returned (the pages search, query, recall, get_page and fetch surface; see
 * last-retrieved.ts). Never page text, never query terms or other arguments.
 *
 * Cost: an owner read, an unbound read and every read on a brain with no members only test `readLogged` (no query, no
 * buffer). A logged read pushes one row into a per-engine buffer; the insert runs after the response, batched (every
 * FLUSH_ROWS rows or FLUSH_MS), and a failed insert drops its batch with one warning, so the log never fails or slows a
 * read. The CLI's teardown drain flushes what a short-lived command buffered; a hard kill loses it.
 *
 * Retention: at most once an hour per process, rows older than RETENTION_DAYS and rows beyond MAX_ROWS (oldest
 * first) are deleted. Readers: `gbrain access log` and `gbrain access who-read` (commands/access-read-log.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { CallerAccess } from '../search/private-visibility.ts';
import { registerBackgroundWorkDrainer, type BackgroundWorkDrainMode } from '../background-work.ts';
import { engineKey } from '../engine-key.ts';
import { isMissingSchemaObject } from '../utils.ts';

export const RETENTION_DAYS = 365;
export const MAX_ROWS = 1_000_000;
const FLUSH_ROWS = 50;
const FLUSH_MS = 2_000;
const MAX_BUFFERED = 5_000;
const MAX_PAGES_PER_ROW = 500;
const PRUNE_EVERY_MS = 3_600_000;

export interface ReadLogRow {
  created_at: string;
  member: string | null;
  audience: string[] | null;
  operation: string;
  transport: string;
  result_code: string;
  page_ids: number[];
}

/** Whether this read is logged: a non-mutating read by a caller that is not the owner and speaks as a member or an audience. */
export function readLogged(access: Partial<CallerAccess>, enforcedMember?: boolean): boolean {
  if (access.owner) return false;
  return !!enforcedMember || !!access.audience?.length || !!access.identity?.some(p => p.startsWith('member:'));
}

/** The member a logged read speaks as (its bound or attested member), or null for an audience of several. */
export function readLogMember(access: Partial<CallerAccess>): string | null {
  return access.identity?.find(p => p.startsWith('member:'))?.slice('member:'.length) ?? access.actor?.member ?? null;
}

const collector = new AsyncLocalStorage<Set<number>>();

/** Runs `fn` collecting the ids of the pages it returns (noteReturnedPages); `on` false runs it untouched. */
export async function collectReturnedPages<T>(on: boolean, fn: () => Promise<T>): Promise<{ value: T; pageIds: number[] }> {
  if (!on) return { value: await fn(), pageIds: [] };
  const ids = new Set<number>();
  const value = await collector.run(ids, fn);
  return { value, pageIds: [...ids] };
}

/** Called where a read op returns pages (bumpLastRetrievedAt); a no-op outside collectReturnedPages. */
export function noteReturnedPages(pageIds: readonly number[]): void {
  const ids = collector.getStore();
  if (!ids) return;
  for (const id of pageIds) if (Number.isInteger(id)) ids.add(id);
}

/** The code a tool result carries: ok, or its error envelope's code. */
export function resultCode(out: { isError?: boolean; content?: Array<{ text?: string }> }): string {
  if (!out.isError) return 'ok';
  try {
    const env = JSON.parse(out.content?.[0]?.text ?? '') as Record<string, unknown>;
    const code = env.code ?? env.error;
    return typeof code === 'string' && code ? code.slice(0, 120) : 'error';
  } catch { return 'error'; }
}

const INSERT_SQL = `INSERT INTO access_read_log (created_at, member, audience, operation, transport, result_code, page_ids)
  SELECT (r->>'created_at')::timestamptz, r->>'member',
    CASE WHEN jsonb_typeof(r->'audience') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r->'audience')) END,
    r->>'operation', r->>'transport', r->>'result_code', ARRAY(SELECT jsonb_array_elements_text(r->'page_ids')::int)
  FROM jsonb_array_elements($1::text::jsonb) r`;

/** Retention: rows past the window by time, then rows beyond the cap by id (oldest first). */
export async function pruneAccessReadLog(engine: BrainEngine, days = RETENTION_DAYS, maxRows = MAX_ROWS): Promise<void> {
  await engine.executeRaw('DELETE FROM access_read_log WHERE created_at < now() - make_interval(days => $1::int)', [days]);
  await engine.executeRaw('DELETE FROM access_read_log WHERE id <= (SELECT max(id) FROM access_read_log) - $1::bigint', [maxRows]);
}

let dropped = 0;
let warned = false;

class ReadLogWriter {
  rows: ReadLogRow[] = [];
  inFlight: Promise<void> | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  lastPrune = 0;
  constructor(readonly engine: BrainEngine) {}

  push(row: ReadLogRow): void {
    if (this.rows.length >= MAX_BUFFERED) { dropped++; return; }
    this.rows.push(row);
    if (this.rows.length >= FLUSH_ROWS) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (this.rows.length === 0) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.rows.splice(0);
    this.inFlight = (async () => {
      try {
        await this.engine.executeRaw(INSERT_SQL, [JSON.stringify(batch)]);
        if (Date.now() - this.lastPrune >= PRUNE_EVERY_MS) {
          this.lastPrune = Date.now();
          await pruneAccessReadLog(this.engine);
        }
      } catch (e) {
        dropped += batch.length;
        if (!warned && !isMissingSchemaObject(e, 'table', 'access_read_log')) {
          warned = true;
          console.warn(`[access-read-log] write failed; reads are unaffected (best-effort): ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }
}

let writers = new WeakMap<object, ReadLogWriter>();
const live = new Set<ReadLogWriter>();

/** Buffers one row; never awaits, never throws. */
export function recordAccessRead(engine: BrainEngine, row: Omit<ReadLogRow, 'created_at' | 'page_ids'> & { page_ids: readonly number[] }): void {
  try {
    const key = engineKey(engine) as BrainEngine;
    let writer = writers.get(key);
    if (!writer) { writer = new ReadLogWriter(key); writers.set(key, writer); }
    live.add(writer);
    writer.push({ ...row, audience: row.audience ? [...row.audience] : null, page_ids: [...row.page_ids].slice(0, MAX_PAGES_PER_ROW), created_at: new Date().toISOString() });
  } catch { dropped++; }
}

/** Flushes every buffer now (tests; a reader in the same process). */
export async function flushAccessReadLog(): Promise<void> {
  await Promise.all([...live].map(w => w.flush()));
}

async function drainAccessReadLog(timeoutMs: number, mode: BackgroundWorkDrainMode): Promise<{ unfinished: number }> {
  const work = mode === 'exit' ? flushAccessReadLog() : Promise.all([...live].map(w => w.inFlight)).then(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
  try {
    const outcome = await Promise.race([work.then(() => 'done' as const, () => 'done' as const), timedOut]);
    return { unfinished: outcome === 'done' ? 0 : [...live].reduce((n, w) => n + w.rows.length, 0) + 1 };
  } finally { if (timer) clearTimeout(timer); }
}

registerBackgroundWorkDrainer({ name: 'access-read-log', order: 6.5, drain: drainAccessReadLog });

export function droppedAccessReads(): number { return dropped; }

export function __resetAccessReadLogForTests(): void {
  for (const w of live) { if (w.timer) clearTimeout(w.timer); w.rows = []; }
  live.clear();
  writers = new WeakMap();
  dropped = 0;
  warned = false;
}
