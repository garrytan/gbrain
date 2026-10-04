/**
 * Day-zero doctor on a keyless brain (agent-first operator wave E2 + E11).
 *
 * `gbrain init --pglite --no-embedding`, then `gbrain doctor --json` with no
 * provider keys, non-TTY, from a hermetic HOME. Baseline on 5b20e98 was
 * 6 WARN / health 70 (retrieval_reflex_health, skill_preconditions,
 * embedding_provider, backup_coverage, cycle_freshness, takes_count): every
 * one of them is a capability that is off by choice or not applicable yet.
 * Now: 0 WARN, 0 FAIL, health >= 90, capped_by names the keyless choice, and
 * the non-TTY heartbeat stays within 10 stderr lines.
 *
 * Serial: subprocess CLI runs against one PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { makeDoctorHome, runGbrain, type DoctorHome } from './helpers/doctor-json-golden.ts';

let h: DoctorHome;

beforeAll(async () => {
  h = makeDoctorHome('doctor-day-zero');
  // A real first install has no partial skills workspace in HOME (the golden
  // helper seeds one for the skill checks; day zero must not inherit it).
  rmSync(h.skillsDir, { recursive: true, force: true });
  const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
}, 120_000);

afterAll(() => h?.cleanup());

interface Report {
  status: string;
  health_score: number;
  capped_by?: string[];
  checks: Array<{ name: string; status: string; message: string; severity?: string; fix?: unknown; fix_unavailable_reason?: string }>;
}

describe('day-zero keyless doctor', () => {
  test('doctor --json: no WARN or FAIL, health >= 90, capped_by embeddings_disabled', async () => {
    const run = await runGbrain(h, ['doctor', '--json']);
    expect(run.exitCode).toBe(0);
    const report = run.json as Report;
    const notOk = report.checks.filter(c => c.status !== 'ok').map(c => `${c.status} ${c.name}: ${c.message}`);
    expect(notOk).toEqual([]);
    expect(report.health_score).toBeGreaterThanOrEqual(90);
    expect(report.capped_by).toEqual(['embeddings_disabled']);
    const info = new Set(report.checks.filter(c => c.severity === 'info').map(c => c.name));
    for (const name of ['embeddings', 'embedding_provider', 'takes_count', 'retrieval_reflex_health', 'skill_preconditions', 'cycle_freshness', 'backup_coverage']) {
      if (report.checks.some(c => c.name === name)) expect(info.has(name), name).toBe(true);
    }
  }, 120_000);

  test('human doctor on a pipe keeps the heartbeat within 10 stderr lines', async () => {
    const run = await runGbrain(h, ['doctor']);
    expect(run.exitCode).toBe(0);
    const lines = run.stderr.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length, run.stderr).toBeLessThanOrEqual(10);
  }, 120_000);
});
