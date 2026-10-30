/**
 * `gbrain diag [--json] [--budget-ms <ms>] [--query <text>]`: one bounded diagnostic bundle an agent can paste
 * whole instead of answering question by question. Read-only. Sections, each with its own `elapsed_ms`:
 *
 *   gbrain   this CLI's version, engine and runtime
 *   skew     builds of this host's resident gbrain processes (doctor runtime_build_skew) and the writer version
 *   sources  per source: last_sync_at, last synced commit, commits on this host's checkout HEAD after it, managed pass row
 *   holds    held files per source and code (counts only)
 *   pool     database connections: limit, backends by state, lock waits, long idle transactions, sessions the
 *            server ended on an error (Postgres 14+ pg_stat_database), and this process's pool size
 *   search   per-stage timing of one search (`--query`, default a fixed probe), with its result count only
 *
 * Every section runs under the remaining budget (default 30 s). A section that did not run or did not finish in
 * time says so (`status: 'not_read'` with its reason), never an implicit "none"; one that cannot apply here (a PGLite
 * brain's pool, a source with no checkout) says `not_applicable`; one that failed carries `status: 'error'` with its code. It never reads a source's file level (`sync status --detail` does).
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import { VERSION } from '../version.ts';
import { endSlowRead, incompleteFields } from '../core/read-heartbeat.ts';
import { classifyItemFailure } from '../core/item-failure.ts';

export const DIAG_DEFAULT_BUDGET_MS = 30_000;
export const DIAG_SECTION_CAP_MS = { gbrain: 2_000, skew: 5_000, sources: 10_000, holds: 5_000, pool: 3_000, search: 10_000 } as const;
export const DIAG_PROBE_QUERY = 'gbrain diagnostic probe';
type SectionName = keyof typeof DIAG_SECTION_CAP_MS;

export type DiagSection = { status: 'ok' | 'not_read' | 'not_applicable' | 'error'; elapsed_ms: number; reason?: string; code?: string; message?: string } & Record<string, unknown>;

/** Runs `read` under min(its cap, what is left of the bundle's budget); never throws. */
export async function diagSection(read: () => Promise<Record<string, unknown>>, capMs: number, deadline: number, now = () => performance.now()): Promise<DiagSection> {
  const left = Math.min(capMs, deadline - now());
  if (left <= 0) return { status: 'not_read', elapsed_ms: 0, reason: 'budget', message: 'The bundle budget ran out before this section started.' };
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), left); timer.unref?.(); });
  try {
    const value = await Promise.race([read(), timeout]);
    const elapsed = Math.round(now() - started);
    if (value === 'timeout') return { status: 'not_read', elapsed_ms: elapsed, reason: 'budget', message: `Did not finish within ${Math.round(left)} ms; nothing from it is shown.` };
    return { status: 'ok', elapsed_ms: elapsed, ...value };
  } catch (error) {
    if ((error as { notApplicable?: boolean }).notApplicable) return { status: 'not_applicable', elapsed_ms: Math.round(now() - started), message: (error as Error).message };
    const failure = classifyItemFailure(error);
    return { status: 'error', elapsed_ms: Math.round(now() - started), code: failure.code, message: failure.message.slice(0, 300) };
  } finally { clearTimeout(timer); }
}

const notApplicable = (why: string): Record<string, unknown> => { throw Object.assign(new Error(why), { notApplicable: true }); };

async function readSkew(engine: BrainEngine) {
  const { runtimeBuildSkewCheck } = await import('./doctor/checks/runtime-build-skew.ts');
  const { writerVersionCheck } = await import('./doctor/checks/writer-version.ts');
  const { localHostIdentity } = await import('../core/persistence/identity.ts');
  const brief = (c: { status: string; message?: string; details?: unknown }) => ({ status: c.status, message: c.message ?? null, ...(c.details && c.status !== 'ok' ? { details: c.details } : {}) });
  return { runtime_build_skew: brief(await runtimeBuildSkewCheck(engine, localHostIdentity().id)), writer_version: brief(await writerVersionCheck(engine)) };
}

async function readSources(engine: BrainEngine, deadline: number) {
  const { readGitBehind } = await import('../core/persistence/sync-freshness.ts');
  const { readLivePassRows } = await import('../core/persistence/sync-pass-row.ts');
  const rows = await engine.executeRaw<{ id: string; local_path: string | null; last_commit: string | null; last_sync_at: Date | string | null }>(
    'SELECT id, local_path, last_commit, last_sync_at FROM sources WHERE archived IS NOT TRUE ORDER BY id');
  const passes = await readLivePassRows(engine).catch(() => null);
  const items = [];
  for (const row of rows) {
    const behind = !row.local_path || !row.last_commit
      ? { status: 'not_applicable' as const, elapsed_ms: 0, reason: row.local_path ? 'never_synced' : 'no_checkout' }
      : await diagSection(async () => {
        const lag = await readGitBehind(row.local_path!, row.last_commit!);
        if (!lag) throw Object.assign(new Error('git could not count the commits after the last synced one on this checkout.'), { code: 'git_unavailable' });
        return { commits: lag.commits, oldest_seconds: lag.oldest === null ? null : Math.max(0, Math.round(Date.now() / 1000 - lag.oldest)) };
      }, 3_000, deadline);
    const pass = passes?.get(row.id);
    items.push({ id: row.id, last_sync_at: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null, last_commit: row.last_commit, behind_head: behind,
      managed_pass: passes === null ? { status: 'not_read', reason: 'read_failed' } : pass ? { updated_at: pass.updated_at, state: (pass.value as { state?: unknown }).state ?? null } : { status: 'not_applicable', reason: 'no_pass_row' } });
  }
  return { count: items.length, items };
}

async function readHolds(engine: BrainEngine) {
  const { GIT_HOLD_OP } = await import('../core/persistence/sync-holds.ts');
  const rows = await engine.executeRaw<{ source_id: string; code: string; n: number | string }>(
    `SELECT s.id AS source_id, h.completed_keys->0->>'code' AS code, count(*) AS n FROM op_checkpoints h
       JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      WHERE h.op=$1 GROUP BY 1, 2 ORDER BY 1, 2`, [GIT_HOLD_OP]);
  const bySource: Record<string, { total: number; by_code: Record<string, number> }> = {};
  for (const row of rows) {
    const entry = bySource[row.source_id] ??= { total: 0, by_code: {} };
    entry.by_code[row.code ?? 'unknown'] = Number(row.n);
    entry.total += Number(row.n);
  }
  return { total: Object.values(bySource).reduce((sum, s) => sum + s.total, 0), by_source: bySource };
}

async function readPool(engine: BrainEngine) {
  if (engine.kind !== 'postgres') return notApplicable(`The ${engine.kind} engine has no connection pool.`);
  const [activity] = await engine.executeRaw<Record<string, number | string | null>>(
    `SELECT current_setting('max_connections')::int AS max_connections, count(*) AS backends,
       count(*) FILTER (WHERE state='active') AS active, count(*) FILTER (WHERE state='idle') AS idle,
       count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_transaction,
       count(*) FILTER (WHERE state LIKE 'idle in transaction%' AND state_change < now() - interval '60 seconds') AS idle_in_transaction_over_60s,
       count(*) FILTER (WHERE wait_event_type='Lock') AS waiting_on_lock
     FROM pg_stat_activity WHERE datname=current_database()`);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  let ended: Record<string, unknown>;
  try {
    const [s] = await engine.executeRaw<Record<string, unknown>>(
      'SELECT sessions, sessions_abandoned, sessions_fatal, sessions_killed, deadlocks, stats_reset FROM pg_stat_database WHERE datname=current_database()');
    ended = { status: 'ok', sessions: num(s?.sessions), abandoned: num(s?.sessions_abandoned), fatal: num(s?.sessions_fatal), killed: num(s?.sessions_killed),
      deadlocks: num(s?.deadlocks), since: s?.stats_reset ? new Date(s.stats_reset as string).toISOString() : null };
  } catch { ended = { status: 'not_read', reason: 'server_before_postgres_14' }; }
  return { process_pool_size: Number(process.env.GBRAIN_POOL_SIZE) || null, max_connections: num(activity?.max_connections), backends: num(activity?.backends),
    by_state: { active: num(activity?.active), idle: num(activity?.idle), idle_in_transaction: num(activity?.idle_in_transaction) },
    idle_in_transaction_over_60s: num(activity?.idle_in_transaction_over_60s), waiting_on_lock: num(activity?.waiting_on_lock), sessions_ended: ended };
}

async function readSearch(engine: BrainEngine, query: string, makeContext: ((engine: BrainEngine, params: Record<string, unknown>) => Promise<OperationContext>) | undefined) {
  if (!makeContext) return notApplicable('No operation context is available to this caller.');
  const { operationsByName } = await import('../core/operations.ts');
  const params = { query, limit: 5 };
  let meta: Record<string, unknown> | null = null;
  const ctx: OperationContext = { ...await makeContext(engine, params), emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; } };
  const result = await operationsByName.search!.handler(ctx, params);
  const rows = Array.isArray(result) ? result : Array.isArray((result as { results?: unknown })?.results) ? (result as { results: unknown[] }).results : [];
  const m = meta as Record<string, unknown> | null;
  return { query, result_count: rows.length, timings: m?.timings ?? { status: 'not_read', reason: 'no_timings_reported' }, degraded: m?.degraded ?? null, cost: m?.cost ?? null };
}

export interface DiagOptions { budgetMs: number; query: string; makeContext?: (engine: BrainEngine, params: Record<string, unknown>) => Promise<OperationContext>; caps?: Partial<Record<SectionName, number>> }

/** The bundle (without `elapsed_ms`/`complete`, which the caller's read meta adds). */
export async function collectDiag(engine: BrainEngine, opts: DiagOptions): Promise<Record<string, unknown>> {
  const deadline = performance.now() + opts.budgetMs;
  const cap = (name: SectionName) => opts.caps?.[name] ?? DIAG_SECTION_CAP_MS[name];
  const run = (name: SectionName, read: () => Promise<Record<string, unknown>>) => diagSection(read, cap(name), deadline);
  return {
    schema_version: 1, budget_ms: opts.budgetMs,
    gbrain: await run('gbrain', async () => ({ version: VERSION, engine: engine.kind, runtime: `bun ${Bun.version}`, platform: `${process.platform}-${process.arch}` })),
    skew: await run('skew', () => readSkew(engine)),
    sources: await run('sources', () => readSources(engine, deadline)),
    holds: await run('holds', () => readHolds(engine)),
    pool: await run('pool', () => readPool(engine)),
    search: await run('search', () => readSearch(engine, opts.query, opts.makeContext)),
  };
}

const SECTIONS: SectionName[] = ['gbrain', 'skew', 'sources', 'holds', 'pool', 'search'];

export function formatDiag(doc: Record<string, unknown>): string {
  const lines = [`gbrain diag (budget ${doc.budget_ms} ms, took ${doc.elapsed_ms ?? '?'} ms, ${doc.complete === false ? 'incomplete' : 'complete'})`];
  for (const name of SECTIONS) {
    const s = doc[name] as DiagSection;
    const head = `  ${name}: ${s.status} (${s.elapsed_ms} ms)`;
    if (s.status !== 'ok') { lines.push(`${head}${s.reason ? ` ${s.reason}` : ''}${s.code ? ` ${s.code}` : ''}${s.message ? `: ${s.message}` : ''}`); continue; }
    const { status: _s, elapsed_ms: _e, ...rest } = s;
    lines.push(`${head} ${JSON.stringify(rest)}`);
  }
  return lines.join('\n');
}

export async function runDiag(engine: BrainEngine, args: string[], makeContext?: DiagOptions['makeContext']): Promise<void> {
  const json = args.includes('--json');
  const budgetArg = args[args.indexOf('--budget-ms') + 1];
  const budgetMs = args.includes('--budget-ms') ? Number(budgetArg) : DIAG_DEFAULT_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    const { opError } = await import('../core/ops/contract.ts');
    throw opError('invalid_params', `--budget-ms needs a positive number of milliseconds, got ${budgetArg ?? 'nothing'}.`, 'Pass e.g. --budget-ms 30000, or omit it for the 30 s default.');
  }
  const query = args.includes('--query') ? args[args.indexOf('--query') + 1] ?? DIAG_PROBE_QUERY : DIAG_PROBE_QUERY;
  const started = performance.now();
  const bundle = await collectDiag(engine, { budgetMs, query, makeContext });
  endSlowRead();
  const incomplete = [...incompleteFields(bundle), ...SECTIONS.filter(name => (bundle[name] as DiagSection).status === 'error').map(name => ({ field: name, reason: 'error' as const }))];
  const doc = { ...bundle, elapsed_ms: Math.round(performance.now() - started), complete: incomplete.length === 0, ...(incomplete.length ? { incomplete } : {}) };
  if (json) { const { writeJsonDocument } = await import('../core/cli-force-exit.ts'); await writeJsonDocument(JSON.stringify(doc, null, 2)); }
  else console.log(formatDiag(doc));
}
