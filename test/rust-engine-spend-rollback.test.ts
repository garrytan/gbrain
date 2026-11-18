/**
 * The budget meter on the Rust engine (rust/docs/store/jobs-spend.md): the hold's own statements run on the store, the
 * statements that need `mcp_spend_log` or `oauth_clients` are refused, and a refusal inside a transaction rolls the
 * store's writes back with it. Needs the file `bun run rust:build` writes (rust/target/addon) and skips without it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { reserve, reserveGroup, settle } from '../src/core/minions/budget-meter.ts';

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

  withAddon('settle writes the spend log through a statement the store refuses, and the hold stays open', async () => {
    const engine = await open();
    const hold = await reserveGroup(engine, { budgetKey: 'group:a', capCents: null, estimatedCents: 3, model: 'anthropic:m', provider: 'anthropic' });
    expect(await refusal(() => settle(engine, hold.reservationId, 1.5))).toBe('engine_capability_missing');
    // The refused transaction rolled the settle back: the hold is still pending, so this settle is the first one.
    expect(await engine.settleSpendReservation(hold.reservationId, 1.5)).toMatchObject({ outcome: 'settled', budget_key: 'group:a' });
    expect(await engine.settleSpendReservation(hold.reservationId, 9)).toEqual({ outcome: 'already_settled' });
  });

  withAddon('a per-client hold is refused at the oauth_clients read and leaves nothing behind', async () => {
    const engine = await open();
    const code = await refusal(() => reserve(engine, { clientId: 'c1', capCents: null, estimatedCents: 1, model: 'anthropic:m', provider: 'anthropic' }));
    expect(code).toBe('engine_capability_missing');
    expect(await engine.expireSpendReservations({ clientId: 'c1' })).toBe(0);
  });
});
