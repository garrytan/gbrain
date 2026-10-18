#!/usr/bin/env bun
/**
 * #6543 (I1): read-only integrity audit for a brain that served writes through
 * a transaction-mode pooler (Supavisor :6543) while pipelined answers could be
 * misrouted. It lists persistence rows touched in a window whose identity
 * values belong to another row, separately from rows it verified and rows it
 * cannot judge. It never writes and never repairs: any corrective write is a
 * separate, preview-bound decision for the brain's owner.
 *
 * Usage:
 *   bun audit-pooler-misroute.ts --url <direct or session-pooler URL> \
 *     --since <iso> --until <iso> [--json] [--batch-size 500] [--batch-timeout-ms 15000]
 *
 * Self-contained, so it runs beside any install (a v0.60.180.0 global install
 * included) with no checkout: copy this one file anywhere and run it with bun.
 * It imports nothing from gbrain's src/, only the postgres driver, from the
 * first of: $GBRAIN_AUDIT_POSTGRES_DRIVER (a path to postgres's src/index.js),
 * ../vendor/postgres/src/index.js next to this file (a checkout),
 * ~/.bun/install/global/node_modules/gbrain/vendor/postgres/src/index.js (a
 * `bun install -g` gbrain), or a `postgres` package node_modules resolves.
 *
 * Connection: one connection to the URL given with --url (never read from the
 * environment). A direct URL or the session pooler (Supabase :5432) is
 * accepted; a transaction-mode URL (port 6543 or ?prepare=false) is refused,
 * because the audit must not read through the transport it is auditing.
 *
 * Reads: bounded batches, each one REPEATABLE READ READ ONLY transaction with
 * a transaction-local statement timeout, so every comparison inside a batch is
 * made against one snapshot. There is NO global snapshot across batches. A row
 * whose updated_at is at or after the audit's start was written while the
 * audit ran and is reported `unknown` (changed_during_audit), never judged.
 * Only columns present at schema v239 are read.
 *
 * Checks (all identity values a misrouted row could have carried):
 *   persistence_effects: source_id, source_incarnation and worktree_id are
 *     copied from their request in the same statement, so a difference is a
 *     `mismatch`; all three unset (rows from before those columns) is unknown.
 *   persistence_requests: a source_incarnation owned by another source (it is
 *     unique per source) and a page_id whose page lives in another source are
 *     `mismatch`. A removed source, a re-created source, a removed page, a page
 *     whose slug differs (a later move), compacted history and a claim stamp
 *     from another execution token (a reclaimed claim) are coverage gaps:
 *     `unknown`, never clean.
 *
 * Output (--json): { verified_ok: { requests, effects }, mismatch: [...],
 * unknown: [...], unknown_by_reason, ... }. Exit 0 when nothing mismatched, 1
 * when a mismatch was found, 2 on a usage error or a refused URL.
 * Runbook: docs/guides/pooler-misroute-audit.md.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Sql = {
  begin<T>(options: string, fn: (tx: Sql) => Promise<T>): Promise<T>;
  unsafe<T = Record<string, unknown>[]>(query: string, params?: unknown[]): Promise<T>;
  end(opts?: { timeout?: number }): Promise<void>;
};
type PostgresFactory = (url: string, options: Record<string, unknown>) => Sql;

export interface AuditOptions {
  since: Date;
  until: Date;
  batchSize?: number;
  batchTimeoutMs?: number;
  /** Test seam: runs after each committed batch, before the next one opens. */
  onBatch?: (index: number) => Promise<void> | void;
}

export interface AuditMismatch { table: 'persistence_requests' | 'persistence_effects'; id: string; request_id: string | null; field: string; value: string | null; expected: string | null; belongs_to?: { table: string; id: string } }
export interface AuditUnknown { table: 'persistence_requests' | 'persistence_effects'; id: string; request_id: string | null; reasons: string[] }
export interface AuditReport {
  window: { since: string; until: string };
  audit_started_at: string;
  snapshot: 'per_batch';
  disclaimer: string;
  batches: number;
  scanned: { requests: number; effects: number };
  verified_ok: { requests: number; effects: number };
  mismatch: AuditMismatch[];
  unknown: AuditUnknown[];
  unknown_by_reason: Record<string, number>;
}

const DISCLAIMER = 'Each batch reads one REPEATABLE READ READ ONLY snapshot; there is no global snapshot across batches. '
  + 'Rows written after the audit started are reported unknown (changed_during_audit). Unknown rows are not verified.';

/** Refuses a transaction-mode URL; returns null when the URL is acceptable. */
export function refuseTransactionPoolerUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://')); } catch { return 'the --url is not a valid postgres URL'; }
  if (parsed.port === '6543') return 'the --url is a transaction-mode pooler (port 6543); give the direct URL or the session pooler (Supabase: port 5432)';
  if (parsed.searchParams.get('prepare') === 'false') return 'the --url has ?prepare=false (a transaction-mode pooler); give the direct URL or the session pooler (Supabase: port 5432)';
  return null;
}

async function loadPostgres(): Promise<PostgresFactory> {
  const candidates = [
    process.env.GBRAIN_AUDIT_POSTGRES_DRIVER,
    fileURLToPath(new URL('../vendor/postgres/src/index.js', import.meta.url)),
    join(homedir(), '.bun/install/global/node_modules/gbrain/vendor/postgres/src/index.js'),
  ].filter((path): path is string => !!path && existsSync(path));
  for (const specifier of [...candidates, 'postgres']) {
    try { return ((await import(specifier)) as { default: PostgresFactory }).default; } catch { /* next candidate */ }
  }
  throw new Error('no postgres driver found: set GBRAIN_AUDIT_POSTGRES_DRIVER to the path of a postgres src/index.js (a gbrain install has one under vendor/postgres)');
}

const REQUESTS_SQL = `SELECT r.sequence::text AS seq, r.id::text AS id, r.request_id::text AS request_id, r.source_id, r.source_incarnation::text AS source_incarnation,
    r.page_id::text AS page_id, r.slug, r.compacted, r.execution_token::text AS execution_token, r.claim_phase->>'token' AS stamp_token,
    (r.updated_at >= $3::timestamptz) AS changed,
    s.id AS source_now, s.incarnation::text AS source_incarnation_now, o.id AS incarnation_owner,
    p.id::text AS page_now, p.source_id AS page_source_id, p.slug AS page_slug
  FROM persistence_requests r
  LEFT JOIN sources s ON s.id = r.source_id
  LEFT JOIN sources o ON o.incarnation = r.source_incarnation
  LEFT JOIN pages p ON p.id = r.page_id
  WHERE r.sequence > $4::bigint
    AND ((r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz) OR (r.updated_at >= $1::timestamptz AND r.updated_at < $2::timestamptz) OR r.updated_at >= $3::timestamptz)
  ORDER BY r.sequence LIMIT $5`;

const EFFECTS_SQL = `SELECT e.id::text AS id, r.request_id::text AS request_id, e.source_id, e.source_incarnation::text AS source_incarnation, e.worktree_id::text AS worktree_id,
    r.source_id AS r_source_id, r.source_incarnation::text AS r_source_incarnation, r.worktree_id::text AS r_worktree_id,
    (e.updated_at >= $3::timestamptz) AS changed
  FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
  WHERE e.id > $4::bigint AND ((e.updated_at >= $1::timestamptz AND e.updated_at < $2::timestamptz) OR e.updated_at >= $3::timestamptz)
  ORDER BY e.id LIMIT $5`;

type RequestRow = { seq: string; id: string; request_id: string; source_id: string; source_incarnation: string; page_id: string | null; slug: string; compacted: boolean;
  execution_token: string | null; stamp_token: string | null; changed: boolean; source_now: string | null; source_incarnation_now: string | null; incarnation_owner: string | null;
  page_now: string | null; page_source_id: string | null; page_slug: string | null };
type EffectRow = { id: string; request_id: string; source_id: string | null; source_incarnation: string | null; worktree_id: string | null;
  r_source_id: string; r_source_incarnation: string; r_worktree_id: string | null; changed: boolean };

function judgeRequest(row: RequestRow): { mismatch: AuditMismatch[]; unknown: string[] } {
  const base = { table: 'persistence_requests' as const, id: row.id, request_id: row.request_id };
  if (row.changed) return { mismatch: [], unknown: ['changed_during_audit'] };
  const mismatch: AuditMismatch[] = [];
  if (row.incarnation_owner !== null && row.incarnation_owner !== row.source_id) {
    mismatch.push({ ...base, field: 'source_incarnation', value: row.source_incarnation, expected: row.source_incarnation_now, belongs_to: { table: 'sources', id: row.incarnation_owner } });
  }
  if (row.page_now !== null && row.page_source_id !== row.source_id) {
    mismatch.push({ ...base, field: 'page_id', value: row.page_id, expected: null, belongs_to: { table: 'sources', id: row.page_source_id ?? '' } });
  }
  const unknown: string[] = [];
  if (row.source_now === null) unknown.push('source_removed');
  else if (row.incarnation_owner === null && row.source_incarnation_now !== row.source_incarnation) unknown.push('source_reincarnated');
  if (row.page_id !== null && row.page_now === null) unknown.push('page_removed');
  if (row.page_now !== null && row.page_source_id === row.source_id && row.page_slug !== row.slug) unknown.push('page_slug_differs');
  if (row.compacted) unknown.push('compacted_history');
  if (row.stamp_token !== null && row.execution_token !== null && row.stamp_token !== row.execution_token) unknown.push('token_reclaimed');
  return { mismatch, unknown };
}

function judgeEffect(row: EffectRow): { mismatch: AuditMismatch[]; unknown: string[] } {
  if (row.changed) return { mismatch: [], unknown: ['changed_during_audit'] };
  if (row.source_id === null && row.source_incarnation === null && row.worktree_id === null) return { mismatch: [], unknown: ['effect_identity_unset'] };
  const pairs: Array<[string, string | null, string | null]> = [
    ['source_id', row.source_id, row.r_source_id], ['source_incarnation', row.source_incarnation, row.r_source_incarnation], ['worktree_id', row.worktree_id, row.r_worktree_id]];
  return { mismatch: pairs.filter(([, value, expected]) => value !== expected)
    .map(([field, value, expected]) => ({ table: 'persistence_effects' as const, id: row.id, request_id: row.request_id, field, value, expected, belongs_to: undefined })), unknown: [] };
}

/** Runs the audit on `sql` (one connection). Read-only: every statement is a SELECT inside a READ ONLY transaction. */
export async function auditPoolerMisroute(sql: Sql, opts: AuditOptions): Promise<AuditReport> {
  const batchSize = opts.batchSize ?? 500;
  const timeoutMs = opts.batchTimeoutMs ?? 15_000;
  const report: AuditReport = { window: { since: opts.since.toISOString(), until: opts.until.toISOString() }, audit_started_at: '', snapshot: 'per_batch', disclaimer: DISCLAIMER,
    batches: 0, scanned: { requests: 0, effects: 0 }, verified_ok: { requests: 0, effects: 0 }, mismatch: [], unknown: [], unknown_by_reason: {} };
  const batch = async <T>(query: string, after: string, started: string | null): Promise<{ rows: T[]; started: string }> => {
    const result = await sql.begin('isolation level repeatable read read only', async tx => {
      await tx.unsafe("SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)", [`${timeoutMs}ms`]);
      const now = started ?? (await tx.unsafe<Array<{ now: string }>>('SELECT now()::text AS now'))[0]!.now;
      return { rows: await tx.unsafe<T[]>(query, [report.window.since, report.window.until, now, after, batchSize]), started: now };
    });
    report.batches += 1;
    await opts.onBatch?.(report.batches);
    return result;
  };
  const record = (table: AuditUnknown['table'], id: string, requestId: string | null, verdict: { mismatch: AuditMismatch[]; unknown: string[] }) => {
    if (verdict.mismatch.length) { report.mismatch.push(...verdict.mismatch); return; }
    if (verdict.unknown.length) {
      report.unknown.push({ table, id, request_id: requestId, reasons: verdict.unknown });
      for (const reason of verdict.unknown) report.unknown_by_reason[reason] = (report.unknown_by_reason[reason] ?? 0) + 1;
      return;
    }
    if (table === 'persistence_requests') report.verified_ok.requests += 1; else report.verified_ok.effects += 1;
  };
  let started: string | null = null;
  for (let after = '0'; ;) {
    const page: { rows: RequestRow[]; started: string } = await batch<RequestRow>(REQUESTS_SQL, after, started);
    started = page.started;
    for (const row of page.rows) record('persistence_requests', row.id, row.request_id, judgeRequest(row));
    report.scanned.requests += page.rows.length;
    if (page.rows.length < batchSize) break;
    after = page.rows[page.rows.length - 1]!.seq;
  }
  for (let after = '0'; ;) {
    const page: { rows: EffectRow[] } = await batch<EffectRow>(EFFECTS_SQL, after, started);
    for (const row of page.rows) record('persistence_effects', row.id, row.request_id, judgeEffect(row));
    report.scanned.effects += page.rows.length;
    if (page.rows.length < batchSize) break;
    after = page.rows[page.rows.length - 1]!.id;
  }
  report.audit_started_at = new Date(started!).toISOString();
  return report;
}

/**
 * One connection, read-only by default on the session too. Statements are awaited one at a time, so nothing pipelines;
 * `max_pipeline: 0` is not set because upstream postgres 3.4.9 then never runs a transaction's begin hook.
 */
export function auditConnectionOptions(): Record<string, unknown> {
  return { max: 1, idle_timeout: 5, connect_timeout: 15, onnotice: () => {},
    connection: { application_name: 'gbrain-audit-pooler-misroute', default_transaction_read_only: 'on' } };
}

function parseArgs(argv: string[]): { url: string; since: Date; until: Date; json: boolean; batchSize: number; batchTimeoutMs: number } | string {
  const value = (flag: string) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const url = value('--url');
  const since = new Date(value('--since') ?? '');
  const until = new Date(value('--until') ?? '');
  if (!url) return 'missing --url (the direct URL or the session pooler; never read from the environment)';
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return 'missing or invalid --since / --until (ISO timestamps)';
  if (since >= until) return '--since must be before --until';
  const batchSize = Number(value('--batch-size') ?? 500);
  const batchTimeoutMs = Number(value('--batch-timeout-ms') ?? 15_000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(batchTimeoutMs) || batchTimeoutMs < 100) return '--batch-size must be a positive integer and --batch-timeout-ms an integer of at least 100';
  return { url, since, until, json: argv.includes('--json'), batchSize, batchTimeoutMs };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') { console.error(`audit-pooler-misroute: ${args}`); return 2; }
  const refused = refuseTransactionPoolerUrl(args.url);
  if (refused) { console.error(`audit-pooler-misroute: refused: ${refused}`); return 2; }
  const postgres = await loadPostgres();
  const sql = postgres(args.url, auditConnectionOptions());
  try {
    const report = await auditPoolerMisroute(sql, args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`window ${report.window.since} .. ${report.window.until} (audit started ${report.audit_started_at}; ${report.batches} batches, per-batch snapshots)`);
      console.log(`scanned: ${report.scanned.requests} requests, ${report.scanned.effects} effects`);
      console.log(`verified_ok: ${report.verified_ok.requests} requests, ${report.verified_ok.effects} effects`);
      console.log(`mismatch: ${report.mismatch.length}`);
      for (const m of report.mismatch) console.log(`  ${m.table} ${m.id} (request ${m.request_id}): ${m.field}=${m.value} expected ${m.expected}${m.belongs_to ? ` (belongs to ${m.belongs_to.table} ${m.belongs_to.id})` : ''}`);
      console.log(`unknown: ${report.unknown.length} ${JSON.stringify(report.unknown_by_reason)}`);
      console.log(DISCLAIMER);
    }
    return report.mismatch.length ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) process.exit(await main());
