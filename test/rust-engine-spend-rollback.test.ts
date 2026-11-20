/**
 * The budget meter on the Rust engine (rust/docs/store/jobs-spend.md, rust/docs/store/spend-log.md): the holds, the
 * ledger and the client caps all run on the store, and a refusal inside a transaction rolls the store's writes back
 * with it (here, the trusted admission recheck refusing after the hold was taken). Needs the file `bun run rust:build` writes (rust/target/addon) and skips without it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { getClientDailyCapCents, reserve, reserveGroup, settle } from '../src/core/minions/budget-meter.ts';
import { getTodaySpendCents } from '../src/core/spend-log.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(): Promise<RustEngine> {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-spend-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return engine;
}

async function refusal(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return undefined;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the budget meter on the Rust engine', () => {
  withAddon('an uncapped group hold is served in full by the store', async () => {
    const engine = await open();
    const hold = await reserveGroup(engine, { budgetKey: 'group:a', capCents: null, estimatedCents: 3, model: 'anthropic:m', provider: 'anthropic' });
    expect(hold.estimatedCents).toBe(3);
    expect(await engine.markSpendUsageUnknown(hold.reservationId, 'pricing_unknown')).toBe(true);
    expect(await engine.expireSpendReservations({ budgetKey: 'group:a' })).toBe(0);
  });

  withAddon('settle writes the ledger row with the settled hold, once', async () => {
    const engine = await open();
    const hold = await reserveGroup(engine, { budgetKey: 'group:a', capCents: null, estimatedCents: 3, model: 'anthropic:m', provider: 'anthropic' });
    await settle(engine, hold.reservationId, 1.5);
    expect(await engine.readGroupSpendTotals('group:a')).toEqual({ committed_cents: 1.5, overdue_cents: 0, live_cents: 0 });
    await settle(engine, hold.reservationId, 9);
    expect((await engine.readGroupSpendTotals('group:a')).committed_cents).toBe(1.5);
    expect(await refusal(() => settle(engine, '00000000-0000-4000-8000-000000000001', 1))).toBe('Error');
  });

  withAddon('a per-client hold is held against the client cap and counted in the ledger of the day', async () => {
    const engine = await open();
    await engine.insertOauthClient({ client_id: 'c1', client_name: 'one', scope: null, budget_usd_per_day: 0.1, bound_tools: null, deleted_at: null });
    expect(await getClientDailyCapCents(engine, 'c1')).toBe(10);
    const hold = await reserve(engine, { clientId: 'c1', capCents: null, estimatedCents: 6, model: 'anthropic:m', provider: 'anthropic' });
    expect(await refusal(() => reserve(engine, { clientId: 'c1', capCents: null, estimatedCents: 6, model: 'anthropic:m', provider: 'anthropic' }))).toBe('BUDGET_EXCEEDED');
    await settle(engine, hold.reservationId, 6);
    expect(await getTodaySpendCents(engine, 'c1')).toBe(6);
  });

  withAddon('a refused admission recheck rolls the hold back with it', async () => {
    const engine = await open();
    const code = await refusal(() => reserve(engine, {
      clientId: 'c1', capCents: null, estimatedCents: 1, model: 'anthropic:m', provider: 'anthropic',
      validateAdmission: async () => { throw new Error('delegation revoked'); },
    }));
    expect(code).toBe('Error');
    // The hold did not stay: under a cap of zero cents a pending hold of 1 would refuse even free work.
    const free = await reserve(engine, { clientId: 'c1', capCents: 0, estimatedCents: 0, model: 'anthropic:m', provider: 'anthropic' });
    expect(free.estimatedCents).toBe(0);
  });
});
