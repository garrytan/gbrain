/**
 * Postgres twin of test/shadow-seed-managed-gate.test.ts: `gbrain engine shadow seed` on a managed-storage Postgres brain.
 *
 * Protects: a Postgres brain with persistence_brain.enabled = true is refused (exit 3, engine_swap_refused /
 * managed_storage) by `seed` and `seed --json` before the shadow directory exists, before the Rust store opens and
 * before the REPEATABLE READ snapshot transaction starts; the same brain with enabled = false goes on to open the store.
 * Regression it catches: a seed that opens a store or starts its snapshot on a managed Postgres brain.
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1); skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../../src/commands/engine-shadow.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let home: string;

async function seedCommand(args: string[]) {
  const config = { engine: 'postgres' as const, database_url: 'postgresql://example.invalid/brain' };
  const r = { code: -1, out: [] as string[], err: [] as string[], dir: '', storeOpens: 0, addonLoads: 0, transactions: 0 };
  const watched = Object.create(engine, {
    transaction: { value: (...a: unknown[]) => { r.transactions++; return (engine.transaction as (...x: unknown[]) => unknown)(...a); } },
    disconnect: { value: async () => undefined },
  }) as BrainEngine;
  await withEnv({ GBRAIN_HOME: home }, async () => {
    r.dir = shadowDirFor(shadowBrainKey(config)!);
    r.code = await runEngineShadow(args, {
      config: () => config, out: l => r.out.push(l), err: l => r.err.push(l),
      loadAddon: async () => { r.addonLoads++; return { ok: true as const, addon: {} as never }; },
      openStore: async () => { r.storeOpens++; throw Object.assign(new Error('locked by the test'), { code: 'rust_store_locked' }); },
      openPrimary: async () => watched,
    });
  });
  return r;
}

d('engine shadow seed on a Postgres brain', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => {
    ({ engine, close } = await template.clone());
    home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-gate-pg-'));
  }, 60_000);
  afterEach(async () => { await close(); rmSync(home, { recursive: true, force: true }); });

  test('a managed brain is refused by seed and seed --json, and nothing is created', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    for (const args of [['seed'], ['seed', '--json']]) {
      const r = await seedCommand(args);
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.err[0], args.join(' ')).toBe('engine shadow: engine_swap_refused (managed_storage): Shadow mode is refused: this brain uses managed storage.');
      expect(existsSync(r.dir), args.join(' ')).toBe(false);
      expect([r.storeOpens, r.addonLoads, r.transactions]).toEqual([0, 0, 0]);
      if (args.includes('--json')) expect(JSON.parse(r.out.join('\n'))).toMatchObject({ error: 'engine_swap_refused', reason: 'managed_storage', class: 'consent' });
    }
  }, 60_000);

  test('an unmanaged brain passes the gate and goes on to open the store', async () => {
    const r = await seedCommand(['seed']);
    expect(r.storeOpens).toBe(1);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).not.toContain('engine_swap_refused');
  }, 60_000);
});
