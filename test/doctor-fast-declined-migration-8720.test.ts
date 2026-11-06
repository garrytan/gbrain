/**
 * #8720: `doctor --fast` runs without an engine, so the opt-out config cannot
 * be read. A migration with an opt-out key must not be reported as pending
 * then (the suggested apply-migrations would skip it as declined).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minionsMigrationEntry } from '../src/commands/doctor/checks/local-runtime.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

describe('#8720 minions_migration without an engine', () => {
  test('does not report an opt-out-capable migration as not run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-fast-8720-'));
    try {
      const dir = join(home, '.gbrain', 'migrations');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'completed.jsonl'), JSON.stringify({ version: '0.60.0', status: 'complete', ts: '2026-01-01T00:00:00Z' }) + '\n');
      const checks = await withEnv({ GBRAIN_HOME: home }, async () => {
        const ctx = { engine: null, progress: { heartbeat() {}, finish() {} }, args: ['--fast'] } as unknown as DoctorContext;
        return await minionsMigrationEntry.run(ctx) as Check[];
      });
      const pending = checks.filter((c) => c.name === 'minions_migration' && c.status === 'warn');
      const mentioned = pending.filter((c) => c.message.includes('0.53.0'));
      expect(mentioned).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
