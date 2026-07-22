/**
 * #2194 fix #5: `gbrain doctor` warns when autopilot's per-tick fan-out exceeds
 * the worker's effective concurrency. Fanning out more cycles than there are
 * worker slots guarantees waiters that race the stalled-sweeper — a silent
 * misconfig the operator never saw before this check.
 *
 * Drives computeAutopilotFanoutConcurrencyCheck directly with a fake engine so
 * the fan-out (config) and concurrency (audit) inputs are controllable without
 * spawning a supervisor. The audit read is stubbed via GBRAIN_AUDIT_DIR + a
 * hand-written started event.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeAutopilotFanoutConcurrencyCheck } from '../src/commands/doctor.ts';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';

// Minimal fake engine: postgres-kind + a config map for fanout override.
function fakeEngine(config: Record<string, string> = {}) {
  return {
    kind: 'postgres' as const,
    getConfig: async (k: string) => config[k] ?? null,
  } as any;
}

let auditDir: string;
const prevAuditDir = process.env.GBRAIN_AUDIT_DIR;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-fanout-doctor-'));
  process.env.GBRAIN_AUDIT_DIR = auditDir;
});

afterEach(() => {
  if (prevAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = prevAuditDir;
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Write a `started` audit event with the given concurrency for queue 'default'. */
function writeStarted(concurrency: number): void {
  const file = join(auditDir, computeSupervisorAuditFilename());
  const line = JSON.stringify({
    event: 'started',
    ts: new Date().toISOString(),
    supervisor_pid: 4242,
    queue: 'default',
    concurrency,
  });
  writeFileSync(file, line + '\n', 'utf8');
}

describe('computeAutopilotFanoutConcurrencyCheck (#2194 fix #5)', () => {
  test('warns when fan-out (4) exceeds effective slots (concurrency 2 → 1)', async () => {
    writeStarted(2);
    const check = await computeAutopilotFanoutConcurrencyCheck(fakeEngine());
    expect(check.status).toBe('warn');
    expect(check.message).toContain('exceeds worker concurrency');
    expect(check.details).toMatchObject({ fanout_max: 4, concurrency: 2, effective_slots: 1 });
  });

  test('ok when fan-out fits (override 1, concurrency 4)', async () => {
    writeStarted(4);
    const check = await computeAutopilotFanoutConcurrencyCheck(
      fakeEngine({ 'autopilot.fanout_max_per_tick': '1' }),
    );
    expect(check.status).toBe('ok');
  });

  test('ok/skip when no supervisor has ever started (no noise on unsupervised brains)', async () => {
    // No started event written.
    const check = await computeAutopilotFanoutConcurrencyCheck(fakeEngine());
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No supervisor observed');
  });

  test('PGLite short-circuits (single-writer, fan-out is 1)', async () => {
    const check = await computeAutopilotFanoutConcurrencyCheck({ kind: 'pglite', getConfig: async () => null } as any);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('PGLite');
  });
});
