/**
 * #6398 (fix wave 13 P1.17): doctor's `stub_guard_24h` counts each stub-guard
 * reason on its own. `db_only_page` (facts routed DB-only for a page with no
 * file) is a routing record, not a resolver miss: it never feeds the WARN
 * threshold or the unprefixed (sunset) count.
 * Seams: GBRAIN_AUDIT_DIR / GBRAIN_HOME temp dirs; PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { logStubGuardEvent } from '../src/core/facts/stub-guard-audit.ts';
import { stubGuardEntry } from '../src/commands/doctor/checks/local-audits.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function stubGuardCheck(events: Array<'unprefixed' | 'fallback_resolution' | 'db_only_page' | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-stub-guard-'));
  try {
    return await withEnv({ GBRAIN_AUDIT_DIR: dir, GBRAIN_HOME: dir }, async () => {
      events.forEach((reason, i) => logStubGuardEvent({ slug: `people/p${i}`, source_id: 'default', fact_count: 1, ...(reason ? { reason } : {}) }));
      const checks = await stubGuardEntry.run({ engine, orphanRatioSourceId: null } as unknown as DoctorContext);
      return checks.find(c => c.name === 'stub_guard_24h');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('each reason is counted explicitly; legacy reasonless lines count as unprefixed', async () => {
  const check = await stubGuardCheck(['unprefixed', undefined, 'fallback_resolution', 'db_only_page', 'db_only_page']);
  expect(check?.status).toBe('ok');
  expect(check?.message).toContain('unprefixed=2, fallback_resolution=1, db_only_page=2');
});

test('db_only_page alone never trips the resolver WARN threshold', async () => {
  const check = await stubGuardCheck(Array(12).fill('db_only_page'));
  expect(check?.status).toBe('ok');
  expect(check?.message).toContain('unprefixed=0, fallback_resolution=0, db_only_page=12');
});

test('resolver hits above 10 still WARN', async () => {
  const check = await stubGuardCheck([...Array(11).fill('fallback_resolution'), 'db_only_page']);
  expect(check?.status).toBe('warn');
  expect(check?.message).toContain('unprefixed=0, fallback_resolution=11, db_only_page=1');
});
