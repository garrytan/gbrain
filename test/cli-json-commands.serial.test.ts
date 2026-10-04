/**
 * Agent contract v1 (D2), the remaining command migrations: under `--json`
 * stdout carries exactly one document (or, for NDJSON commands, lines that
 * end a failure with a `{status:"error", …envelope}` line), a failure is an
 * envelope with `code` + `suggestion`, and legacy keys stay. Subprocesses
 * against a keyless PGLite brain (and an unreachable-Postgres config for
 * the paths that need one); the Postgres-only successes (db-repair healthy,
 * jobs supervisor start --detach) live in
 * test/e2e/cli-json-commands-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const EVAL_FIXTURES = join(import.meta.dir, 'fixtures', 'eval-baselines');
const QRELS = join(EVAL_FIXTURES, 'qrels-search.json');
const CAPTURED = join(EVAL_FIXTURES, 'captured-sample.ndjson');
const UNREACHABLE_PG = 'postgresql://fixture@127.0.0.1:1/gbrain_test';

function onlyDocument(r: CliResult): Record<string, unknown> {
  const doc = JSON.parse(r.stdout);
  expect(typeof doc).toBe('object');
  return doc as Record<string, unknown>;
}

function lines(r: CliResult): Array<Record<string, unknown>> {
  return r.stdout.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, unknown>);
}

function expectEnvelope(doc: Record<string, unknown>, code: string): void {
  expect(doc.code).toBe(code);
  expect(typeof doc.suggestion).toBe('string');
  expect(doc.contract_version).toBe(1);
}

let brain = '';
let pgHome = '';
const cli = (args: string[], home = brain, env?: Record<string, string | undefined>) =>
  runCli(args, { home, cwd: home, timeoutMs: 120_000, ...(env ? { env } : {}) });

function freshHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

beforeAll(async () => {
  brain = freshHome('gbrain-json-cmds-brain-');
  const init = await cli(['init', '--pglite', '--no-embedding', '--json']);
  if (init.exitCode !== 0) throw new Error(`fixture init failed: ${init.stderr}`);
  pgHome = freshHome('gbrain-json-cmds-pg-');
  mkdirSync(join(pgHome, '.gbrain'), { recursive: true });
  writeFileSync(join(pgHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: UNREACHABLE_PG }));
}, 150_000);

afterAll(() => {
  for (const home of [brain, pgHome]) if (home) rmSync(home, { recursive: true, force: true });
});

describe('apply-migrations --json', () => {
  test('dry run: one document with the plan; unknown --migration: invalid_params envelope (exit 2) leading with the plan keys', async () => {
    const ok = await cli(['apply-migrations', '--dry-run', '--json']);
    expect(ok.exitCode).toBe(0);
    const doc = onlyDocument(ok);
    expect(doc).toMatchObject({ status: 'dry_run' });
    expect(Array.isArray((doc.plan as { pending: unknown[] }).pending)).toBe(true);

    const bad = await cli(['apply-migrations', '--json', '--migration', '9.9.9']);
    expect(bad.exitCode).toBe(2);
    const env = onlyDocument(bad);
    expectEnvelope(env, 'invalid_params');
    expect(env).toMatchObject({ status: 'invalid', fix: { argv: ['gbrain', 'apply-migrations', '--list'] } });
  }, 120_000);

  test('a real run: one document with per-migration results; --list is a document too', async () => {
    const run = await cli(['apply-migrations', '--yes', '--no-autopilot-install', '--json']);
    expect(run.exitCode).toBe(0);
    const doc = onlyDocument(run);
    expect(doc.status === 'ok' || doc.status === 'partial').toBe(true);
    expect((doc.results as unknown[]).length).toBeGreaterThan(0);
    const list = await cli(['apply-migrations', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    expect(onlyDocument(list)).toMatchObject({ status: 'listed' });
  }, 240_000);

  test('A4: the v0.11.0 autopilot install needs consent (exit 3 payload); --no-autopilot-install skips the ask and the failure is migration_failed', async () => {
    const ask = await cli(['apply-migrations', '--migration', '0.11.0', '--json'], pgHome);
    expect(ask.exitCode).toBe(3);
    expect(onlyDocument(ask)).toMatchObject({
      code: 'confirmation_required', effects: ['persistent_install'],
      fix: { argv: ['gbrain', 'apply-migrations', '--migration', '0.11.0', '--yes'], next: 'ask_user' },
    });
    const skip = await cli(['apply-migrations', '--migration', '0.11.0', '--no-autopilot-install', '--json'], pgHome);
    expect(skip.exitCode).toBe(1);
    const env = onlyDocument(skip);
    expectEnvelope(env, 'migration_failed');
    expect(env).toMatchObject({ status: 'failed', reason: 'orchestrator_failed', results: [{ version: '0.11.0', status: 'failed' }] });
  }, 120_000);

  test('no brain: the unconfigured document (exit 0)', async () => {
    const empty = freshHome('gbrain-json-cmds-empty-');
    try {
      const r = await cli(['apply-migrations', '--json'], empty);
      expect(r.exitCode).toBe(0);
      expect(onlyDocument(r)).toMatchObject({ status: 'unconfigured', previews: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('post-upgrade --json', () => {
  test('success: one report; a failing apply-migrations: one envelope leading with the report', async () => {
    const empty = freshHome('gbrain-json-cmds-pu-');
    try {
      const ok = await cli(['post-upgrade', '--json', '--no-autopilot-install'], empty, { GBRAIN_SKIP_REFERENCE_SWEEP: '1' });
      expect(ok.exitCode).toBe(0);
      expect(onlyDocument(ok)).toMatchObject({ status: 'ok', warnings: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const bad = await cli(['post-upgrade', '--json'], pgHome, { GBRAIN_SKIP_REFERENCE_SWEEP: '1' });
    expect(bad.exitCode).toBe(1);
    const env = onlyDocument(bad);
    expectEnvelope(env, 'migration_failed');
    expect(env).toMatchObject({ status: 'failed', apply_migrations: { exit_code: 1 } });
  }, 180_000);
});

describe('db-repair --json', () => {
  test('an unreachable Postgres: one database_error envelope leading with the diagnosis report', async () => {
    const r = await cli(['db-repair', '--json'], pgHome);
    expect(r.exitCode).toBe(1);
    const env = onlyDocument(r);
    expectEnvelope(env, 'database_error');
    expect(env).toMatchObject({ schema_version: 1, reason: 'conn_refused', tier: 'auto', fixed: false, fix: { argv: ['gbrain', 'db-repair', '--yes', '--brain', 'host'] } });
  }, 60_000);

  test('a PGLite brain: config_error naming pglite-repair; a bad flag combination: invalid_params (exit 2)', async () => {
    const pglite = await cli(['db-repair', '--json']);
    expect(pglite.exitCode).toBe(1);
    expect(onlyDocument(pglite)).toMatchObject({ code: 'config_error', fix: { argv: ['gbrain', 'pglite-repair', '--help'] } });
    const flags = await cli(['db-repair', '--apply-rewrites', '--json']);
    expect(flags.exitCode).toBe(2);
    expectEnvelope(onlyDocument(flags), 'invalid_params');
  }, 60_000);
});

describe('dream --json', () => {
  test('cycle: one CycleReport document; an unknown phase: invalid_params (exit 2)', async () => {
    const ok = await cli(['dream', '--json', '--phase', 'lint']);
    expect(ok.exitCode).toBe(0);
    expect(onlyDocument(ok)).toMatchObject({ schema_version: '1' });
    const bad = await cli(['dream', '--json', '--phase', 'garbage']);
    expect(bad.exitCode).toBe(2);
    expectEnvelope(onlyDocument(bad), 'invalid_params');
  }, 120_000);

  test('retriage and reset-key: refusals are envelopes, --list is a document', async () => {
    const retriage = await cli(['dream', 'retriage', '--json']);
    expect(retriage.exitCode).toBe(1);
    expectEnvelope(onlyDocument(retriage), 'config_error');
    const list = await cli(['dream', 'reset-key', '--list', '--json']);
    expect(list.exitCode).toBe(0);
    expect(onlyDocument(list)).toMatchObject({ enabled: true, tripped: [] });
    const key = await cli(['dream', 'reset-key', 'not-a-key', '--json']);
    expect(key.exitCode).toBe(2);
    expectEnvelope(onlyDocument(key), 'invalid_params');
  }, 120_000);
});

describe('jobs supervisor start --detach --json', () => {
  test('a PGLite brain refuses with one config_error envelope; an unknown subcommand is invalid_params', async () => {
    const r = await cli(['jobs', 'supervisor', 'start', '--detach', '--json']);
    expect(r.exitCode).toBe(1);
    expectEnvelope(onlyDocument(r), 'config_error');
    const sub = await cli(['jobs', 'supervisor', 'bogus', '--json']);
    expect(sub.exitCode).toBe(2);
    expectEnvelope(onlyDocument(sub), 'invalid_params');
  }, 60_000);
});

describe('NDJSON: eval export / replay / gate, bench publish', () => {
  test('eval export: one line per captured row; a bad --since ends with one status:error line (exit 2)', async () => {
    const capture = await cli(['search', 'hello'], brain, { GBRAIN_CONTRIBUTOR_MODE: '1' });
    expect(capture.exitCode).toBe(0);
    const ok = await cli(['eval', 'export', '--json']);
    expect(ok.exitCode).toBe(0);
    const rows = lines(ok);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ schema_version: 1, tool_name: 'search' });
    const bad = await cli(['eval', 'export', '--json', '--since', 'bogus']);
    expect(bad.exitCode).toBe(2);
    const out = lines(bad);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ status: 'error' });
    expectEnvelope(out[0]!, 'invalid_params');
  }, 120_000);

  test('eval replay: one summary line; no --against: one status:error line (exit 2)', async () => {
    const ok = await cli(['eval', 'replay', '--against', CAPTURED, '--json']);
    expect(ok.exitCode).toBe(0);
    const out = lines(ok);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ schema_version: 1, summary: { rows_total: 2 } });
    const bad = await cli(['eval', 'replay', '--json']);
    expect(bad.exitCode).toBe(2);
    const err = lines(bad);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ status: 'error', code: 'invalid_params' });
  }, 120_000);

  test('eval gate: a pass is one result line; a breached gate is the result line then a gate_failed status:error line', async () => {
    const det = ['eval', 'gate', '--qrels', QRELS, '--embedder', 'deterministic'];
    const ok = await cli([...det, '--threshold-recall-at-k', '0', '--threshold-first-relevant-hit', '0', '--threshold-expected-top1', '0', '--json']);
    expect(ok.exitCode).toBe(0);
    const pass = lines(ok);
    expect(pass.length).toBe(1);
    expect(pass[0]).toMatchObject({ verdict: 'pass' });
    const bad = await cli([...det, '--json']);
    expect(bad.exitCode).toBe(1);
    const fail = lines(bad);
    expect(fail.length).toBe(2);
    expect(fail[0]).toMatchObject({ verdict: 'fail' });
    expect(fail[1]).toMatchObject({ status: 'error' });
    expectEnvelope(fail[1]!, 'gate_failed');
  }, 120_000);

  test('bench publish: one result line; an existing --to: one status:error line (exit 2)', async () => {
    const home = freshHome('gbrain-json-cmds-bench-');
    try {
      const args = ['bench', 'publish', '--from', CAPTURED, '--to', 'sample.baseline.ndjson', '--json'];
      const ok = await cli(args, home);
      expect(ok.exitCode).toBe(0);
      const out = lines(ok);
      expect(out.length).toBe(1);
      expect(out[0]).toMatchObject({ schema_version: 1, label: 'sample', row_count: 2 });
      expect(existsSync(join(home, 'sample.baseline.ndjson'))).toBe(true);
      const again = await cli(args, home);
      expect(again.exitCode).toBe(2);
      const err = lines(again);
      expect(err.length).toBe(1);
      expect(err[0]).toMatchObject({ status: 'error', code: 'invalid_params' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
