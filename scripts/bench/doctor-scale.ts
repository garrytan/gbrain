#!/usr/bin/env bun
/**
 * #6803 C7: doctor at scale, with a pass criterion. A bench, not a test (not in CI).
 *
 *   bun scripts/bench/doctor-scale.ts --url <postgres-url> [--admin-url <url>] [--pages 10000] [--receipts 0] [--load 0] [--out receipt.json]
 *   bun scripts/bench/doctor-scale.ts --engine pglite [--pages 10000] [--out receipt.json]
 *
 * Postgres: --url is what the CLI connects to (point it at a transaction-mode PgBouncer with
 * ?prepare=false to measure the pooled path); --admin-url (default --url) creates a scratch database
 * `gbrain_bench_doctor_<n>›, reached through --url's host with the same credentials, and drops it
 * afterwards. PGLite: a scratch data dir.
 *
 * Fixture (an unmanaged brain built with initSchema): --pages note pages (about 2 KB each, one source),
 * --receipts committed managed write receipts (the capacity forecast reads them), and --load concurrent
 * whole-table scans running through the whole measurement (the resident/autopilot pressure the 90 s
 * default must survive). No chunks, embeddings, links or facts.
 *
 * Measured through the real CLI, non-interactive (stderr is a pipe), so plain `doctor --json› runs under
 * the doctor.default_budget_ms default: wall time and the report's complete/unknown_sections, plus
 * `doctor --tier ops --json› and `sync status --json›.
 *
 * Pass: every cheap incident check (CHEAP_INCIDENT_CHECKS in src/commands/doctor/registry.ts) the run
 * emits reports a health other than unknown, and the plain run returns within the 90 s default plus
 * 20 s for process start and connect. Exit 0 on pass, 1 on fail. Prints the receipt and one Markdown row.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { CHEAP_INCIDENT_CHECKS } from '../../src/commands/doctor/registry.ts';
import { DEFAULT_BUDGET_MS } from '../../src/commands/doctor/default-budget.ts';
import { PROVIDER_ENV_KEYS } from '../../test/helpers/provider-env.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const engineKind = flag('--engine', 'postgres') as 'postgres' | 'pglite';
const pages = Number(flag('--pages', '10000'));
const receipts = Number(flag('--receipts', '0'));
const load = Number(flag('--load', '0'));
const out = flag('--out');
const url = flag('--url');
const adminUrl = flag('--admin-url', url);
if (engineKind === 'postgres' && !url) { console.error('--url <postgres-url> is required with --engine postgres'); process.exit(2); }

const home = mkdtempSync(join(tmpdir(), 'gbrain-bench-doctor-'));
const cleanups: Array<() => Promise<void>> = [async () => rmSync(home, { recursive: true, force: true })];

async function cli(args: string[], timeoutMs = 300_000): Promise<{ ms: number; exit: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of [...PROVIDER_ENV_KEYS, 'DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[k];
  Object.assign(env, { HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1' });
  const started = performance.now();
  const proc = Bun.spawn(['bun', '--no-env-file', join(REPO, 'src/cli.ts'), ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const killer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  return { ms: Math.round(performance.now() - started), exit, stdout, stderr };
}

async function fixtureUrl(): Promise<string> {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  if (engineKind === 'pglite') {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), embedding_disabled: true }));
    return '';
  }
  const name = `gbrain_bench_doctor_${Date.now()}`;
  const admin = postgres(adminUrl!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  cleanups.push(async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  const target = new URL(url!);
  target.pathname = `/${name}`;
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: target.toString(), embedding_disabled: true }));
  return target.toString();
}

async function seed(brainUrl: string): Promise<void> {
  const { createEngine } = await import('../../src/core/engine-factory.ts');
  const engine = await createEngine({ engine: engineKind });
  await engine.connect(engineKind === 'pglite' ? { database_path: join(home, '.gbrain', 'brain.pglite') } : { database_url: brainUrl });
  try {
    await engine.initSchema();
    for (let from = 1; from <= pages; from += 10_000) {
      const to = Math.min(pages, from + 9_999);
      await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
        SELECT 'notes/acme-example-' || g, 'default', 'note', 'Note ' || g, repeat('Bench body text for doctor scale. ', 60), '{}', md5('bench-' || g), now(), now()
        FROM generate_series($1::int, $2::int) AS g`, [from, to]);
    }
    if (receipts > 0) {
      const { requestFixture } = await import('../../test/helpers/persistence-request-fixture.ts');
      const fixture = await requestFixture(engine);
      for (let i = 0; i < receipts; i++) await fixture.publish(await fixture.admit(`bench-${i}`) as never);
    }
    await engine.executeRaw('ANALYZE');
  } finally {
    await engine.disconnect();
  }
}

function startLoad(brainUrl: string): () => Promise<void> {
  if (load <= 0 || engineKind === 'pglite') return async () => undefined;
  const sql = postgres(brainUrl, { max: load, prepare: false });
  let running = true;
  const loops = Array.from({ length: load }, async () => {
    while (running) await sql`SELECT count(*), sum(length(compiled_truth)) FROM pages`.catch(() => undefined);
  });
  return async () => { running = false; await Promise.all(loops); await sql.end(); };
}

interface Row { check: string; status: string; health: string; elapsed_ms: number | null }

async function main(): Promise<number> {
  const brainUrl = await fixtureUrl();
  await seed(brainUrl);
  const stopLoad = startLoad(brainUrl);
  let plain, ops, status;
  try {
    plain = await cli(['doctor', '--json']);
    ops = await cli(['doctor', '--tier', 'ops', '--json']);
    status = await cli(['sync', 'status', '--source', 'default', '--json']);
  } finally {
    await stopLoad();
  }
  const report = JSON.parse(plain.stdout) as { complete?: boolean; unknown_sections?: string[]; budget_ms?: number; checks: Array<{ name: string; status: string; elapsed_ms?: number; details?: { health?: string } }> };
  const opsReport = JSON.parse(ops.stdout) as { complete?: boolean; unknown_sections?: string[] };
  const cheap: Row[] = report.checks.filter(c => CHEAP_INCIDENT_CHECKS.has(c.name))
    .map(c => ({ check: c.name, status: c.status, health: c.details?.health ?? 'known', elapsed_ms: c.elapsed_ms ?? null }));
  const unknownCheap = cheap.filter(r => r.health === 'unknown').map(r => r.check);
  const withinBudget = plain.ms <= DEFAULT_BUDGET_MS + 20_000;
  const pass = unknownCheap.length === 0 && withinBudget;
  const receipt = {
    engine: engineKind, pooled: /prepare=false/.test(url ?? ''), pages, receipts, load,
    doctor: { wall_ms: plain.ms, exit: plain.exit, budget_ms: report.budget_ms ?? null, complete: report.complete ?? null, unknown_sections: report.unknown_sections ?? [] },
    doctor_ops: { wall_ms: ops.ms, complete: opsReport.complete ?? null, unknown_sections: opsReport.unknown_sections ?? [] },
    sync_status: { wall_ms: status.ms, exit: status.exit },
    cheap_incident_checks: cheap, pass, fail_reasons: [...(withinBudget ? [] : [`doctor took ${plain.ms} ms`]), ...unknownCheap.map(c => `${c} unknown`)],
  };
  if (out) writeFileSync(out, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  console.log('\n| engine | pages | receipts | load | doctor wall | complete | unknown | ops wall | ops complete | sync status | cheap checks | pass |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${engineKind}${receipt.pooled ? ' (pgbouncer)' : ''} | ${pages} | ${receipts} | ${load} | ${(plain.ms / 1000).toFixed(1)} s | ${receipt.doctor.complete} | ${receipt.doctor.unknown_sections.length} | `
    + `${(ops.ms / 1000).toFixed(1)} s | ${receipt.doctor_ops.complete} | ${(status.ms / 1000).toFixed(1)} s | ${cheap.map(r => `${r.check}=${r.health === 'unknown' ? 'unknown' : r.status}`).join(', ')} | ${pass ? 'PASS' : 'FAIL'} |`);
  return pass ? 0 : 1;
}

let code = 1;
try { code = await main(); } catch (error) { console.error(error); } finally { for (const c of cleanups.reverse()) await c().catch(() => undefined); }
process.exit(code);
