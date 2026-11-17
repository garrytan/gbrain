/**
 * Time-to-value for engine graduation (PGLite -> Postgres): every command an
 * agent runs from the first `foresights migrate --to postgres` (which prints the
 * plan and exits 3) to a green `foresights doctor --no-migrate --json`, with wall
 * time, the run's per-phase timings and query latency on both engines.
 *
 *   DATABASE_URL=postgresql://...:5432/gbrain_test \
 *     bun scripts/persistence/graduation-ttv.ts --pages 1000 [--seed 1] [--live-serve] [--out report.json] [--enforce]
 *   ... --kind legacy                      the hand-built legacy fixture instead of history pages
 *   ... --target-url-env NAME              graduate into an existing empty database instead of a fresh one
 *
 * The fixture comes from graduation-fixture.ts (cached; provisioning is
 * excluded from the clock, as is creating the target database). With
 * `--live-serve` a resident `foresights serve` (stdio) owns the source when the
 * flow starts; the report records whether the run's marker hand-off sufficed
 * or a manual stop was needed (target: none).
 *
 * Gate: 1,000 pages or fewer must reach a green doctor in under five minutes.
 * Larger runs are reported, not gated. Exit codes: 0 report written (and,
 * with --enforce, the gate passed); 1 the gate or an expected exit code
 * failed under --enforce; 2 usage error; 3 the harness itself crashed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { prepareGraduationFixture, type GraduationFixtureKind } from './graduation-fixture.ts';
import { codeOf, gbrain, mcpStdioSession, planHashOf, type GbrainResult } from './graduation-process.ts';

const TARGET_ENV = 'GBRAIN_TARGET_URL';
const GATE_MS = 5 * 60_000;
const TERMS = ['alpha', 'harbor', 'ledger', 'quartz', 'meadow', 'signal', 'copper', 'lantern', 'orbit', 'thistle', 'cobalt', 'drift', 'acme'];

interface Options { kind: GraduationFixtureKind; pages: number; seed: number; liveServe: boolean; out?: string; enforce: boolean; samples: number; targetUrlEnv?: string; keep: boolean }

function parse(argv: string[]): Options {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const kind = (value('--kind') ?? 'history') as GraduationFixtureKind;
  if (kind !== 'history' && kind !== 'legacy') throw new Error('--kind must be history or legacy');
  const pages = Number(value('--pages') ?? 1000);
  if (kind === 'history' && !(Number.isSafeInteger(pages) && pages >= 1 && pages <= 10_000)) throw new Error('--pages must be 1..10000');
  return { kind, pages, seed: Number(value('--seed') ?? 1), liveServe: argv.includes('--live-serve'), out: value('--out'), enforce: argv.includes('--enforce'),
    samples: Number(value('--query-samples') ?? 50), targetUrlEnv: value('--target-url-env'), keep: argv.includes('--keep') };
}

const redact = (url: string) => { const u = new URL(url); u.password = ''; u.username = u.username ? `${u.username}` : ''; return `${u.protocol}//${u.username}@${u.host}${u.pathname}`; };
function percentile(values: number[], p: number): number { const s = values.toSorted((a, b) => a - b); return s.length ? Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)) : 0; }

async function queryLatency(engine: import('../../src/core/engine.ts').BrainEngine, samples: number) {
  const times: number[] = [];
  for (const term of TERMS.slice(0, 3)) await engine.searchKeyword(term, { limit: 10 });
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await engine.searchKeyword(TERMS[i % TERMS.length], { limit: 10 });
    times.push(performance.now() - started);
  }
  return { samples, p50_ms: percentile(times, 0.5), p95_ms: percentile(times, 0.95) };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

async function main(): Promise<number> {
  let opts: Options;
  try { opts = parse(process.argv.slice(2)); } catch (error) { console.error((error as Error).message); return 2; }
  const admin = process.env.DATABASE_URL;
  if (!opts.targetUrlEnv && !admin) { console.error('DATABASE_URL (a test-shaped admin URL) or --target-url-env is required'); return 2; }
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-graduation-ttv-'));
  let database: string | null = null;
  let targetUrl: string;
  if (opts.targetUrlEnv) {
    targetUrl = process.env[opts.targetUrlEnv] ?? '';
    if (!targetUrl) { console.error(`${opts.targetUrlEnv} is empty`); return 2; }
  } else {
    const { assertSafeE2eDatabaseUrl } = await import('../../test/helpers/db-guard.ts');
    assertSafeE2eDatabaseUrl(admin!);
    database = `gbrain_test_graduation_ttv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const sql = postgres(admin!, { max: 1, prepare: false, onnotice: () => {} });
    try { await sql.unsafe(`CREATE DATABASE ${database}`); } finally { await sql.end(); }
    const u = new URL(admin!); u.pathname = `/${database}`; targetUrl = u.toString();
  }
  try {
    const fixture = await prepareGraduationFixture({ kind: opts.kind, pages: opts.pages, seed: opts.seed, dir: join(scratch, 'fixture'), timeoutMs: 45 * 60_000 });
    const home = fixture.home;
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const pglite = await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: fixture.dataDir });
      try { return await queryLatency(engine, opts.samples); } finally { await engine.disconnect(); }
    });

    const serve = opts.liveServe ? await mcpStdioSession({ home, timeoutMs: 3_600_000 }) : null;
    if (serve) await serve.call('search', { query: 'alpha' });
    const env = { [TARGET_ENV]: targetUrl };
    const commands: { argv: string[]; exit: number; ms: number; code?: string }[] = [];
    const record = (argv: string[], r: GbrainResult) => { commands.push({ argv: ['gbrain', ...argv], exit: r.code, ms: r.ms, ...(codeOf(r.json) ? { code: codeOf(r.json) } : {}) }); return r; };
    const t0 = Date.now();
    const planArgv = ['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json'];
    const plan = record(planArgv, await gbrain(planArgv, { home, env, timeoutMs: 600_000 }));
    const hash = planHashOf(plan.json);
    const runArgv = ['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(hash), '--json'];
    let run = hash ? record(runArgv, await gbrain(runArgv, { home, env, timeoutMs: 3_600_000 })) : plan;
    let manualStop = false;
    if (serve && codeOf(run.json) === 'graduation_source_writer_held') {
      manualStop = true;
      await serve.close();
      run = record(runArgv, await gbrain(runArgv, { home, env, timeoutMs: 3_600_000 }));
    }
    const doctorArgv = ['doctor', '--no-migrate', '--json'];
    const doctor = record(doctorArgv, await gbrain(doctorArgv, { home, timeoutMs: 600_000 }));
    const wallMs = Date.now() - t0;
    const failing = ((doctor.json?.checks ?? []) as { name: string; status: string }[]).filter(c => c.status === 'fail').map(c => c.name);
    let handoff: Record<string, unknown> | null = null;
    if (serve) {
      const exited = await Promise.race([serve.exited, Bun.sleep(5_000).then(() => null)]);
      handoff = { manual_stop_needed: manualStop, serve_exited: !!exited, serve_refusal: exited ? /graduation_in_progress/.test(`${exited.stdout}${exited.stderr}`) : false };
      if (!exited) await serve.close();
    }

    let postgresLatency = null;
    if (run.code === 0) {
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const pg = new PostgresEngine();
      await pg.connect({ database_url: targetUrl, poolSize: 2 });
      try { postgresLatency = await queryLatency(pg, opts.samples); } finally { await pg.disconnect(); }
    }

    const gated = opts.kind === 'legacy' || opts.pages <= 1000;
    const expected = plan.code === 3 && !!hash && run.code === 0 && failing.length === 0;
    const pass = expected && (!gated || wallMs < GATE_MS);
    const report = {
      kind: opts.kind, pages: fixture.report.pages, seed: opts.seed, target: redact(targetUrl),
      label: 'existing brain, provisioned target, plan to green doctor',
      fixture: fixture.report, fixture_cached: fixture.cached,
      commands, wall_ms: wallMs, gate: gated ? { limit_ms: GATE_MS, pass } : { limit_ms: null, pass: expected, note: 'reported, not gated' },
      phases: run.json?.receipt?.timings ?? run.json?.timings ?? null,
      doctor_failing: failing,
      query_latency: { pglite: pglite, postgres: postgresLatency },
      live_serve: handoff,
    };
    const text = JSON.stringify(report, null, 2);
    if (opts.out) writeFileSync(opts.out, `${text}\n`);
    console.log(text);
    if (!expected) console.error(`[graduation-ttv] unexpected outcome: plan exit ${plan.code}, run exit ${run.code}${codeOf(run.json) ? ` (${codeOf(run.json)})` : ''}, failing doctor checks: ${failing.join(', ') || 'none'}\n${run.stderr.slice(-2000)}`);
    return opts.enforce && !pass ? 1 : 0;
  } finally {
    if (database && !opts.keep) {
      const sql = postgres(admin!, { max: 1, prepare: false, onnotice: () => {} });
      try { await sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await sql.end(); }
    }
    if (!opts.keep) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then(code => process.exit(code), error => { console.error(`[graduation-ttv] harness crashed: ${(error as Error).stack ?? error}`); process.exit(3); });
}
