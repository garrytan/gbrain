/**
 * ENG-6: `gbrain doctor --remediation-plan` is observational. On a brain whose
 * schema is behind, it connects probe-only, leaves the schema version
 * unchanged, and reports the pending migrations as a `migrations_pending`
 * safety notice whose fix applies them (the remediate consent path already
 * connects this way, test/agent-journey.serial.test.ts).
 *
 * Serial: real CLI subprocesses against a temp PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_VERSION, hasPendingMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gb, oneDocument } from './helpers/agent-journey.ts';

async function withBrain<T>(home: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

describe('doctor --remediation-plan on a pending-migration brain', () => {
  let home = '';
  const pending = String(LATEST_VERSION - 1);
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-plan-observational-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'], { timeoutMs: 120_000 })).exitCode).toBe(0);
    await withBrain(home, engine => engine.setConfig('version', pending));
  }, 150_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('--json: schema version unchanged; the plan carries a migrations_pending notice with the apply fix', async () => {
    const r = await gb(home, ['doctor', '--remediation-plan', '--json']);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    const doc = oneDocument(r, 'doctor --remediation-plan --json');
    expect(typeof doc.brain_score_current).toBe('number');
    const notice = (doc.notices as Array<Record<string, any>>).find(n => n.code === 'migrations_pending')!;
    expect(notice).toBeTruthy();
    expect(notice.kind).toBe('safety');
    expect(notice.why).toContain(`v${pending}`);
    expect(notice.fix.argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
    expect(notice.fix.next).toBe('run');
    await withBrain(home, async engine => {
      expect(await engine.getConfig('version')).toBe(pending);
      expect(await hasPendingMigrations(engine)).toBe(true);
    });
  }, 150_000);

  test('human output names the pending migrations; still nothing migrated', async () => {
    const r = await gb(home, ['doctor', '--remediation-plan']);
    expect(r.exitCode, r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toContain('Schema migrations pending');
    expect(r.stdout).toContain('apply: gbrain apply-migrations --yes');
    await withBrain(home, async engine => expect(await engine.getConfig('version')).toBe(pending));
  }, 150_000);

  test('following the notice fix migrates; the next plan has no notice', async () => {
    const applied = await gb(home, ['apply-migrations', '--yes', '--no-autopilot-install'], { timeoutMs: 240_000 });
    expect(applied.exitCode, applied.stderr.slice(-2000)).toBe(0);
    await withBrain(home, async engine => expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION)));
    const doc = oneDocument(await gb(home, ['doctor', '--remediation-plan', '--json']), 'plan after migrating');
    expect(doc.notices).toBeUndefined();
  }, 300_000);
});
