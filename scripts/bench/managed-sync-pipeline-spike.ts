#!/usr/bin/env bun
/**
 * #5984 Phase 0 pipelining spike. Opt-in, never run in CI. Result:
 * docs/eval/managed-sync-catchup.md ("Pipelining spike").
 *
 *   bun scripts/bench/managed-sync-pipeline-spike.ts [--rtt 57] [--out <file.json>] [--keep]
 *
 * Inside one foresights `engine.transaction` on Postgres, issues `tx.executeRaw`
 * calls without awaiting between them and checks, from the wire trace
 * (src/core/sql-trace.ts), whether postgres.js sends them on one connection
 * before the first reply (pipelined) and whether they keep their order. Covers
 * a pipelined failure (the first error code, and what later statements get),
 * `prepare: true` vs `prepare: false`, and transaction-mode PgBouncer. Uses
 * the catch-up bench's Docker Postgres and toxiproxy (loopback only) plus an
 * `edoburu/pgbouncer` container in front of that Postgres.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHarness, round1, type TraceRecord } from './managed-sync-catchup-lib.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const RTT = Number(flag('rtt', '57'));
const KEEP = process.argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'gbrain-spike-'));
const TRACE = join(work, 'trace.jsonl');
process.env.GBRAIN_SQL_TRACE = TRACE;
process.env.GBRAIN_SQL_TRACE_LABEL = 'spike';
process.env.GBRAIN_HOME = work;

const PG_PORT = 55432, PROXY_PORT = 55433, API_PORT = 58474, BOUNCER_PORT = 56432, BOUNCER_PROXY_PORT = 56433;
const harness = await startHarness({ pgPort: PG_PORT, proxyPort: PROXY_PORT, apiPort: API_PORT, keep: KEEP });
await harness.setRtt(RTT);

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}
docker(['rm', '-f', 'gbrain-spike-pgbouncer'], true);
docker(['run', '-d', '--name', 'gbrain-spike-pgbouncer', '--network', 'host', '-e', `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
  '-e', `LISTEN_PORT=${BOUNCER_PORT}`, '-e', 'LISTEN_ADDR=127.0.0.1', '-e', 'POOL_MODE=transaction', '-e', 'AUTH_TYPE=scram-sha-256', '-e', 'MAX_PREPARED_STATEMENTS=0', '-e', 'IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,idle_in_transaction_session_timeout,lock_timeout,options',
  'edoburu/pgbouncer:latest']);
/** Puts the bench's loopback toxiproxy (plain HTTP on 127.0.0.1, as in managed-sync-catchup-lib.ts) in front of PgBouncer. */
async function proxyBouncer(): Promise<void> {
  const api = `http://127.0.0.1:${API_PORT}`;
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback toxiproxy admin API (127.0.0.1) the bench starts itself; no TLS endpoint exists
  await fetch(`${api}/proxies/bouncer-spike`, { method: 'DELETE' });
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback toxiproxy admin API (127.0.0.1) the bench starts itself; no TLS endpoint exists
  await fetch(`${api}/proxies`, { method: 'POST', body: JSON.stringify({ name: 'bouncer-spike', listen: `127.0.0.1:${BOUNCER_PROXY_PORT}`, upstream: `127.0.0.1:${BOUNCER_PORT}`, enabled: true }) });
  for (const stream of ['upstream', 'downstream']) {
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback toxiproxy admin API (127.0.0.1) the bench starts itself; no TLS endpoint exists
    if (RTT > 0) await fetch(`${api}/proxies/bouncer-spike/toxics`, { method: 'POST', body: JSON.stringify({ name: `lat_${stream}`, type: 'latency', stream, toxicity: 1, attributes: { latency: Math.round(RTT / 2), jitter: 0 } }) });
  }
}
await proxyBouncer();

const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
type Engine = InstanceType<typeof PostgresEngine>;

interface CaseResult { name: string; wall_ms: number; records: number; waves: number; describes: number; pipelined: boolean; order_kept?: boolean; errors?: Record<string, string | null>; detail?: unknown }

function traceSince(t0: number): TraceRecord[] {
  return readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TraceRecord).filter(r => r.t >= t0 && r.kind !== 'connect');
}
/** Sequential round trips: maximal runs of overlapping records on one connection. */
function waves(records: TraceRecord[]): number {
  let n = 0, end = -Infinity, conn = -1;
  for (const r of [...records].sort((a, b) => a.conn - b.conn || a.t - b.t)) {
    if (r.conn !== conn || r.t >= end) { n++; end = r.t + r.ms; conn = r.conn; } else end = Math.max(end, r.t + r.ms);
  }
  return n;
}

async function flushTrace(): Promise<void> { await Bun.sleep(1100); }

async function runCase(engine: Engine, name: string, body: (tx: Engine) => Promise<Omit<CaseResult, 'name' | 'wall_ms' | 'records' | 'waves' | 'describes' | 'pipelined'>>): Promise<CaseResult> {
  await flushTrace();
  const t0 = performance.timeOrigin + performance.now();
  const started = performance.now();
  let extra: Awaited<ReturnType<typeof body>> = {};
  try { await engine.transaction(async tx => { extra = await body(tx as Engine); }); } catch (error) { extra = { ...extra, detail: { transaction_error: String((error as { code?: string }).code ?? error) } }; }
  const wall = performance.now() - started;
  await flushTrace();
  const records = traceSince(t0).filter(r => !/^(begin|commit|rollback)/i.test(r.sql.trim()));
  const w = waves(records);
  return { name, wall_ms: round1(wall), records: records.length, waves: w, describes: records.filter(r => r.kind === 'describe').length, pipelined: w < records.length, ...extra };
}

async function suite(url: string, label: string): Promise<CaseResult[]> {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url, poolSize: 2 });
  const out: CaseResult[] = [];
  try {
    await engine.executeRaw('CREATE TABLE IF NOT EXISTS spike_pipeline(id serial PRIMARY KEY, label text UNIQUE, v int NOT NULL DEFAULT 0)');
    await engine.executeRaw('TRUNCATE spike_pipeline RESTART IDENTITY');
    await engine.executeRaw("INSERT INTO spike_pipeline(label) VALUES ('counter')");
    for (const warm of [false, true]) {
      out.push(await runCase(engine, `${label}: 2 statements awaited one by one (${warm ? 'warm' : 'cold'})`, async tx => {
        await tx.executeRaw("UPDATE spike_pipeline SET v=v+$1 WHERE label='counter'", [1]);
        await tx.executeRaw("SELECT v FROM spike_pipeline WHERE label=$1", ['counter']);
        return {};
      }));
      out.push(await runCase(engine, `${label}: 2 dependent statements issued without await (${warm ? 'warm' : 'cold'})`, async tx => {
        const a = tx.executeRaw<{ v: number }>("UPDATE spike_pipeline SET v=v+$1 WHERE label='counter' RETURNING v", [1]);
        const b = tx.executeRaw<{ v: number }>("SELECT v FROM spike_pipeline WHERE label=$1", ['counter']);
        const [[ra], [rb]] = await Promise.all([a, b]);
        return { order_kept: Number(rb!.v) === Number(ra!.v), detail: { update_returned: ra!.v, select_saw: rb!.v } };
      }));
    }
    out.push(await runCase(engine, `${label}: 5 inserts issued without await keep issue order`, async tx => {
      const labels = Array.from({ length: 5 }, (_, i) => `row-${Date.now()}-${i}`);
      await Promise.all(labels.map(l => tx.executeRaw('INSERT INTO spike_pipeline(label) VALUES ($1)', [l])));
      const rows = await tx.executeRaw<{ label: string }>('SELECT label FROM spike_pipeline WHERE label=ANY($1::text[]) ORDER BY id', [labels]);
      return { order_kept: rows.map(r => r.label).join() === labels.join() };
    }));
    out.push(await runCase(engine, `${label}: pipelined failure (unique violation first, then 2 statements)`, async tx => {
      const settled = await Promise.allSettled([
        tx.executeRaw("INSERT INTO spike_pipeline(label) VALUES ($1)", ['counter']),
        tx.executeRaw("UPDATE spike_pipeline SET v=v+$1 WHERE label='counter'", [1]),
        tx.executeRaw('SELECT v FROM spike_pipeline WHERE label=$1', ['counter']),
      ]);
      const code = (s: PromiseSettledResult<unknown>) => s.status === 'rejected' ? String((s.reason as { code?: string }).code ?? s.reason) : null;
      return { errors: { first: code(settled[0]!), second: code(settled[1]!), third: code(settled[2]!) } };
    }));
    out.push(await runCase(engine, `${label}: unparameterized statements issued without await`, async tx => {
      await Promise.all([tx.executeRaw("SELECT 1 AS a"), tx.executeRaw("SELECT 2 AS b"), tx.executeRaw("SELECT 3 AS c")]);
      return {};
    }));
    out.push(await runCase(engine, `${label}: new statement text each call (varying SQL) issued without await`, async tx => {
      await Promise.all([1, 2, 3].map(n => tx.executeRaw(`SELECT $1::int + ${n} AS v`, [n])));
      return {};
    }));
  } finally {
    await engine.executeRaw('DROP TABLE IF EXISTS spike_pipeline').catch(() => undefined);
    await engine.disconnect();
  }
  return out;
}

const report: Record<string, unknown> = { schema: 'gbrain.bench.pipeline-spike/v1', rtt_ms: RTT, started_at: new Date().toISOString(), suites: {} };
try {
  const direct = harness.proxyUrl('postgres');
  const bouncer = `postgresql://postgres:postgres@127.0.0.1:${BOUNCER_PROXY_PORT}/postgres`;
  (report.suites as Record<string, unknown>)['postgres prepare=true'] = await suite(direct, 'postgres prepare=true');
  (report.suites as Record<string, unknown>)['postgres prepare=false'] = await suite(`${direct}?prepare=false`, 'postgres prepare=false');
  (report.suites as Record<string, unknown>)['pgbouncer transaction mode prepare=false'] = await suite(`${bouncer}?prepare=false`, 'pgbouncer txn prepare=false');
} finally {
  report.finished_at = new Date().toISOString();
  const out = flag('out', join(work, 'spike.json'));
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const [suiteName, cases] of Object.entries(report.suites as Record<string, CaseResult[]>)) {
    console.log(`\n## ${suiteName}\n| case | wall ms | statements | round trips | describes | pipelined | order kept | errors |\n|---|---|---|---|---|---|---|---|`);
    for (const c of cases) console.log(`| ${c.name.replace(/^[^:]*: /, '')} | ${c.wall_ms} | ${c.records} | ${c.waves} | ${c.describes} | ${c.pipelined} | ${c.order_kept ?? ''} | ${c.errors ? JSON.stringify(c.errors) : ''} |`);
  }
  console.log(`\nreport: ${out}`);
  if (!KEEP) { docker(['rm', '-f', 'gbrain-spike-pgbouncer'], true); rmSync(work, { recursive: true, force: true }); }
  harness.stop();
}
process.exit(0);
