#!/usr/bin/env bun
/**
 * Postgres statement probe for one warm MCP tool (GBRA-66). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/probe-pg.ts --label synth-full --tool list_pages --args '{"limit":50}' [--n 25] [--jit on|off|default]
 *
 * Starts one `gbrain serve` stdio process against engines/postgres-<label>, resets
 * pg_stat_statements on that brain's database, runs the tool N times, and prints
 * p50/p95 plus the statements that ran at least N times (calls, mean ms, share of
 * DB time). `--jit off` sets `ALTER DATABASE ... SET jit = off` for the run and resets
 * it afterwards, which is how the list_pages JIT finding was measured.
 *
 * Needs the bench container (gbrain-bench-pg) with pg_stat_statements preloaded:
 *   docker exec gbrain-bench-pg psql -U postgres -c "ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements'"
 *   docker restart gbrain-bench-pg
 * Prints statement text truncated to 140 chars; statements carry $n placeholders, never values.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, REPO, WORK, flag, machine, pct } from './lib.ts';

const label = flag('label')!;
const tool = flag('tool')!;
const args = JSON.parse(flag('args', '{}')!);
const N = Number(flag('n', '25'));
const jit = flag('jit', 'default')!;
const container = flag('container', process.env.BENCH_PG_CONTAINER ?? 'gbrain-bench-pg')!;
const home = join(WORK, 'engines', `postgres-${label}`);
if (!existsSync(home)) throw new Error(`no brain at ${home}`);
const db = `bench_${label.replace(/[^a-z0-9]/gi, '_')}`;

async function psql(sql: string, dbName = db): Promise<string> {
  const p = Bun.spawn(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', dbName, '-tAF', '\t', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(err.trim());
  return out;
}

if (jit !== 'default') await psql(`ALTER DATABASE ${db} SET jit = ${jit === 'off' ? 'off' : 'on'}`, 'postgres');
try {
  await psql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  const proc = Bun.spawn([process.execPath, CLI, 'serve'], { cwd: REPO, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GBRAIN_HOME: home } });
  const pending = new Map<number, (m: any) => void>();
  (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch { /* log line */ }
      }
    }
  })();
  let id = 0;
  const call = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    proc.stdin.flush();
  });
  await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe-pg', version: '1' } });
  await call('tools/call', { name: tool, arguments: args });
  await psql('SELECT pg_stat_statements_reset()');
  const ms: number[] = [];
  let errors = 0;
  for (let k = 0; k < N; k++) {
    const t = performance.now();
    const r = await call('tools/call', { name: tool, arguments: args });
    ms.push(performance.now() - t);
    if (r.error || r.result?.isError) errors++;
  }
  proc.kill();
  const rows = (await psql(`SELECT calls, round(mean_exec_time::numeric, 2), round(total_exec_time::numeric, 1), left(regexp_replace(query, '\\s+', ' ', 'g'), 140)
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND calls >= ${N}
    ORDER BY total_exec_time DESC LIMIT 12`)).trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const dbTotal = rows.reduce((s, r) => s + Number(r[2]), 0);
  console.log(`machine: ${machine()}\nengine: postgres  brain: ${label}  tool: ${tool}  mode: warm stdio  jit: ${jit}  N=${N}  errors=${errors}`);
  console.log(`wall p50 ${pct(ms, 0.5).toFixed(1)} ms  p95 ${pct(ms, 0.95).toFixed(1)} ms  db time/call ${(dbTotal / N).toFixed(2)} ms`);
  console.log('calls\tmean_ms\tshare\tstatement');
  for (const r of rows) console.log(`${r[0]}\t${r[1]}\t${((100 * Number(r[2])) / (dbTotal || 1)).toFixed(0)}%\t${r[3]}`);
} finally {
  if (jit !== 'default') await psql(`ALTER DATABASE ${db} RESET jit`, 'postgres');
}
