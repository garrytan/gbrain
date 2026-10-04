/**
 * Agent-first operator wave E2: `run_doctor` (MCP, `doctorReportRemote`) and
 * the CLI `doctor` (`buildChecks`) agree on the same brain. Both surfaces call
 * the same check functions; this pins that every check name both emit has the
 * same status, severity and readiness_state on a keyless day-zero brain, and
 * that the remote report renders fixes for its transport (CLI-only commands
 * become tell_user_to_run for host_admin over HTTP, with no local paths).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, doctorReportRemote } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
let engine: PGLiteEngine;
const ENV = { OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined } as const;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-remote-parity-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('embedding_disabled', 'true');
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('run_doctor and CLI doctor agree', () => {
  test('shared checks have the same status, severity and readiness_state', async () => {
    await withEnv({ ...ENV, GBRAIN_HOME: home, HOME: home }, async () => {
      const local = new Map((await buildChecks(engine, ['--json'])).map(c => [c.name, c]));
      const remote = await doctorReportRemote(engine, { remote: true });
      const shared = remote.checks.filter(c => local.has(c.name));
      expect(shared.length).toBeGreaterThan(20);
      const disagreements = shared
        .map(r => ({ r, l: local.get(r.name)! }))
        .filter(({ r, l }) => r.status !== l.status || (r.severity ?? null) !== (l.severity ?? null) || (r.readiness_state ?? null) !== (l.readiness_state ?? null))
        .map(({ r, l }) => `${r.name}: local ${l.status}/${l.severity ?? '-'} remote ${r.status}/${r.severity ?? '-'}`);
      expect(disagreements).toEqual([]);
    });
  });

  test('fixes render for the caller transport: CLI-only → host_admin + tell_user_to_run over HTTP, local paths redacted', async () => {
    const { computeDoctorReport } = await import('../src/commands/doctor.ts');
    const report = computeDoctorReport([{ name: 'embeddings', status: 'warn', message: 'x',
      fix: { argv: ['gbrain', 'init', '--force', '--path', `${home}/.gbrain/brain.pglite`], consent: [], actor: 'agent', why: `brain at ${home}/.gbrain`, requires_exclusive: true } }],
      { render: { transport: 'http', isCallable: () => false, preapproved: () => false } });
    const fix = report.checks[0].fix as unknown as Record<string, unknown>;
    expect(fix).toMatchObject({ actor: 'host_admin', next: 'tell_user_to_run' });
    expect(JSON.stringify(fix)).not.toContain(home);
  });
});
