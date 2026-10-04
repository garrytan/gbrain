/**
 * Agent-first operator wave Lane E (E1/E2/E11): doctor checks speak contract v1.
 *
 * - status stays ok | warn | fail (schema_version 2); capabilities off by
 *   choice are `ok` + severity:'info' + readiness_state and do not cost score;
 * - every non-ok check carries a rendered `fix` or a `fix_unavailable_reason`;
 * - top_issues[] gain the structured `action` next to the legacy `fix` string;
 * - checkError() is the one "could not run" shape;
 * - `--only` parsing / engine need; the backup coaching gate; the non-TTY
 *   heartbeat budget; the agent_contract check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, computeDoctorReport, type Check } from '../src/commands/doctor.ts';
import { checkError, finalizeCheckFixes, infoCheck } from '../src/commands/doctor/check-fix.ts';
import { doctorCheckNames, onlyNeedsEngine, parseOnlyChecks } from '../src/commands/doctor/registry.ts';
import { throttleDoctorHeartbeat } from '../src/commands/doctor/heartbeat.ts';
import { agentContractCheck } from '../src/commands/doctor/checks/agent-contract.ts';
import { backupCoachingDue } from '../src/core/backup/status-file.ts';
import type { ProgressReporter } from '../src/core/progress.ts';
import { withEnv } from './helpers/with-env.ts';

const fix = { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent' as const, why: 'diagnose', requires_exclusive: false, docs: 'docs/guides/troubleshooting.md' };

describe('doctor report status set (E2)', () => {
  test('info checks are ok, keep the health score, and keyless brains report capped_by', () => {
    const checks: Check[] = [
      infoCheck('embeddings', 'off by choice', 'disabled_by_choice', fix),
      { name: 'connection', status: 'ok', message: 'Connected' },
    ];
    const report = computeDoctorReport(checks);
    expect(report.schema_version).toBe(2);
    expect(report.status).toBe('healthy');
    expect(report.health_score).toBe(100);
    expect(report.capped_by).toEqual(['embeddings_disabled']);
    for (const c of report.checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
    const emb = report.checks.find(c => c.name === 'embeddings')!;
    expect(emb).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
    expect(report.top_issues).toEqual([]);
  });

  test('a brain without disabled embeddings carries no capped_by', () => {
    expect(computeDoctorReport([{ name: 'embeddings', status: 'ok', message: 'ok' }]).capped_by).toBeUndefined();
  });

  test('fixes render for the transport: next, shell-quoted command, absolute docs; top_issues gain action', () => {
    const report = computeDoctorReport([{ name: 'sync_failures', status: 'warn', message: 'x', fix }]);
    const rendered = report.checks[0].fix as unknown as Record<string, unknown>;
    expect(rendered).toMatchObject({ next: 'run', command: 'gbrain doctor --json', actor: 'agent' });
    expect(String(rendered.docs)).toMatch(/^https:\/\//);
    expect(report.top_issues?.[0]).toMatchObject({ name: 'sync_failures', fix: 'x', action: { next: 'run', command: 'gbrain doctor --json' } });
  });

  test('an MCP render context rewrites a CLI-only agent fix to tell_user_to_run', () => {
    const report = computeDoctorReport([{ name: 'sync_failures', status: 'warn', message: 'x', fix }], {
      render: { transport: 'http', isCallable: () => false, preapproved: () => false },
    });
    expect(report.checks[0].fix).toMatchObject({ actor: 'host_admin', next: 'tell_user_to_run' });
  });

  test('every non-ok check ends with a fix or a fix_unavailable_reason', () => {
    const out = finalizeCheckFixes<Check>([
      { name: 'a', status: 'warn', message: 'legacy prose' },
      { name: 'b', status: 'fail', message: 'x', fix_unavailable_reason: 'operator_judgement' },
      { name: 'c', status: 'ok', message: 'fine' },
    ]);
    expect(out[0].fix_unavailable_reason).toBe('unstructured');
    expect(out[1].fix_unavailable_reason).toBe('operator_judgement');
    expect(out[2].fix_unavailable_reason).toBeUndefined();
  });
});

describe('checkError (E1)', () => {
  test('keeps the Could-not message and says the check itself failed', () => {
    expect(checkError('rls', 'check RLS status', new Error('boom'))).toEqual({
      name: 'rls', status: 'warn', message: 'Could not check RLS status: boom', fix_unavailable_reason: 'check_errored',
    });
    expect(checkError('rls', 'check RLS status')).toMatchObject({ message: 'Could not check RLS status' });
  });

  test('a database access error gets the read-only db-repair diagnosis as fix', () => {
    const err = Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' });
    const c = checkError('rls', 'check RLS status', err);
    expect(c.fix).toMatchObject({ argv: ['gbrain', 'db-repair'], consent: [], verify: { argv: ['gbrain', 'doctor', '--only', 'rls', '--json'] } });
  });
});

describe('doctor --only (E1)', () => {
  test('parses comma lists, repeats and = form', () => {
    expect(parseOnlyChecks(['--json'])).toBeNull();
    expect([...parseOnlyChecks(['--only', 'a,b', '--only=c'])!]).toEqual(['a', 'b', 'c']);
  });

  test('knows its vocabulary and which checks need the engine', () => {
    const names = doctorCheckNames();
    expect(names.has('harness_wiring')).toBe(true);
    expect(names.has('agent_contract')).toBe(true);
    expect(onlyNeedsEngine(new Set(['harness_wiring', 'agent_contract']))).toBe(false);
    expect(onlyNeedsEngine(new Set(['embeddings']))).toBe(true);
  });

  test('engine-free run returns exactly the requested checks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-only-'));
    try {
      await withEnv({ GBRAIN_HOME: home, HOME: home, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, CODEX_HOME: undefined, OPENCODE: undefined, OPENCODE_PID: undefined }, async () => {
        const checks = await buildChecks(null, ['--only', 'agent_contract,harness_wiring', '--json']);
        expect(checks.map(c => c.name).sort()).toEqual(['agent_contract', 'harness_wiring']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('backup coaching gate (E7)', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const day = 86_400_000;
  test('young and small brains are not coached; 25 items or 7 days are; old caches keep warning', () => {
    expect(backupCoachingDue({ maturity: { items: 3, since: new Date(now - day).toISOString() } }, now)).toBe(false);
    expect(backupCoachingDue({ maturity: { items: 25, since: new Date(now - day).toISOString() } }, now)).toBe(true);
    expect(backupCoachingDue({ maturity: { items: 0, since: new Date(now - 7 * day).toISOString() } }, now)).toBe(true);
    expect(backupCoachingDue({ maturity: { items: 0, since: null } }, now)).toBe(false);
    expect(backupCoachingDue({}, now)).toBe(true);
  });
});

describe('non-TTY heartbeat budget (E11)', () => {
  test('at most one heartbeat per gap; a slow check still gets its line', () => {
    const lines: string[] = [];
    const inner = { start: () => {}, tick: () => {}, heartbeat: (n: string) => { lines.push(n); }, finish: () => {}, child: () => inner } as unknown as ProgressReporter;
    let t = 0;
    const p = throttleDoctorHeartbeat(inner, { tty: false, now: () => t, gapMs: 5_000 });
    p.start('doctor.db_checks');
    for (let i = 0; i < 40; i++) { t += 100; p.heartbeat(`check_${i}`); }
    expect(lines).toEqual([]);
    t += 6_000;
    p.heartbeat('slow_check');
    expect(lines).toEqual(['slow_check']);
    expect(throttleDoctorHeartbeat(inner, { tty: true })).toBe(inner);
  });
});

describe('agent_contract check (E11)', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const ts = new Date(now - 3_600_000).toISOString();
  test('clean log is ok', () => {
    expect(agentContractCheck([], now)).toMatchObject({ status: 'ok' });
  });
  test('refused paid runs and derived-cap stops warn with the user-only preapproval command', () => {
    const c = agentContractCheck([
      { ts, command: 'dream', transport: 'cli', code: 'confirmation_required', effects: ['paid'], outcome: 'refused' },
      { ts, command: 'embed', transport: 'cli', code: 'derived_cap_exhausted', effects: ['paid'], outcome: 'stopped' },
      { ts, command: 'dream', transport: 'cli', code: 'confirmation_required', effects: ['paid'], outcome: 'preapproved' },
    ], now);
    expect(c.status).toBe('warn');
    expect(c.details).toMatchObject({ consent_refused: 1, derived_cap_exhausted: 1 });
    expect(c.fix).toMatchObject({ argv: ['gbrain', 'config', 'set', 'consent.preapprove.paid.max_usd_per_run', '<usd>'], actor: 'user', consent: ['paid'] });
  });
  test('internal errors warn without a fabricated fix; old events age out', () => {
    const c = agentContractCheck([
      { ts, op: 'find_orphans', transport: 'stdio', code: 'internal_error', has_suggestion: true },
      { ts: new Date(now - 30 * 86_400_000).toISOString(), op: 'x', transport: 'stdio', code: 'internal_error' },
    ], now);
    expect(c).toMatchObject({ status: 'warn', fix_unavailable_reason: 'operator_judgement', details: { internal_errors: 1 } });
    expect(c.message).toContain('find_orphans');
  });
});

describe('keyless brain: capability checks are information, not warnings (E2)', () => {
  let home: string;
  let engine: PGLiteEngine;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-keyless-info-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  test('embeddings / embedding_provider / embed_staleness / takes_count / fact_take_vectors / cycle_freshness are ok + info', async () => {
    await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      const checks = await buildChecks(engine, ['--only', 'embeddings,embedding_provider,embed_staleness,takes_count,fact_take_vectors,cycle_freshness']);
      const byName = new Map(checks.map(c => [c.name, c]));
      for (const name of ['embeddings', 'embedding_provider', 'embed_staleness', 'fact_take_vectors']) {
        expect(byName.get(name), name).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
      }
      expect(byName.get('embeddings')!.fix).toMatchObject({ argv: expect.arrayContaining(['gbrain', 'init', '--force', '--embedding-model']) });
      expect(byName.get('embedding_provider')!.message).not.toMatch(/migrate embeddings/);
      expect(byName.get('takes_count')).toMatchObject({ status: 'ok', severity: 'info', fix: { consent: ['paid'] } });
      expect(byName.get('cycle_freshness')!.status).toBe('ok');
    });
  });
});

describe('connection errors name their source; brain score unknown when DB checks did not run (E10)', () => {
  test('describeUrlSource names the env var or the config file under GBRAIN_HOME', async () => {
    const { describeUrlSource } = await import('../src/commands/doctor/checks/db-connection.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-url-source-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(describeUrlSource('env:GBRAIN_DATABASE_URL')).toBe('the GBRAIN_DATABASE_URL environment variable');
        expect(describeUrlSource('config-file')).toBe(`database_url in ${join(home, '.gbrain', 'config.json')}`);
        expect(describeUrlSource(null)).toBeNull();
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a non-ok connection marks the brain score unknown; a live one does not', () => {
    expect(computeDoctorReport([{ name: 'connection', status: 'fail', message: 'refused' }]).unknown_scores).toEqual(['brain']);
    expect(computeDoctorReport([{ name: 'connection', status: 'ok', message: 'Connected, 0 pages' }]).unknown_scores).toBeUndefined();
  });

  test('non-Supabase URLs get no Supabase advice', async () => {
    const { classifyPgAccessError } = await import('../src/core/pg-access-classify.ts');
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(classifyPgAccessError(err, { url: 'postgresql://u@db.internal.example:5432/brain' }).remediation).not.toMatch(/Supabase/);
    expect(classifyPgAccessError(err, { url: 'postgresql://u@db.abcdefgh.supabase.co:5432/postgres' }).remediation).toMatch(/Supabase/);
  });
});
