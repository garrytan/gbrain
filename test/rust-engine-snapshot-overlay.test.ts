/**
 * The Rust withdrawal overlay folds the fence text as the SQL engines do (FACT_SPACE_CLASS), on the page read
 * (`overlayStoreSnapshot`) and on a segmented page's seal lead (`overlayStoreLead`).
 *
 * Authoring gate (docs/TESTING.md): protects a forgotten claim staying hidden on a Rust brain. A regression is a fold
 * by JavaScript's `\s`, which leaves U+0085 unfolded (a withdrawn claim holding it stays live in the seal lead) and
 * folds U+1680 and U+00A0 (an unrelated claim is struck). The parity case in test/engine-parity/page-withdrawal-overlay.test.ts
 * reads pages only; the seal lead is built inside sealSegmentedPage and has no read-back, so this runs the function itself.
 * No seam: the real overlay over rows the store answers, with the fingerprint a ledger row holds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { normalizeLoweredClaim } from '../src/core/facts/withdrawal-schema.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { overlayStoreLead } from '../src/core/rust-engine/snapshot-overlay.ts';
import type { PageWithdrawal } from '../src/core/page-state/types.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const dirs: string[] = [];
const engines: RustEngine[] = [];
let addon: RustAddon | undefined;
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The store's own fence normalization, as the seal reads it. */
async function storeNormalize(): Promise<RustEngine['normalizeFenceLines']> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-snapshot-overlay-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return (bodies, timelines) => engine.normalizeFenceLines(bodies, timelines);
}

// The ledger hash of a claim is its own engine's: ASCII here, so the JavaScript twin gives the store's hash. The Unicode
// claims below are withdrawn with the hash of their store-lowercased form, which only the store can give (the parity file
// test/engine-parity/page-withdrawal-overlay.test.ts withdraws them through insertFactWithdrawal).
const hash = (claim: string) => createHash('sha256').update(normalizeLoweredClaim(claim.toLowerCase())).digest('hex');
const ledger = (claim: string, purged = false): PageWithdrawal =>
  ({ visibility: 'private', fact_hash: hash(claim), withdrawn_at: '2026-03-01T10:00:00.000Z', ...(purged ? { purged: true } : {}) });
const lead = (...claims: string[]) => `Lead.\n\n${renderFactsTable(claims.map((claim, i) => ({
  rowNum: i + 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'private' as const, notability: 'medium' as const, active: true, context: '' })))}\n`;
const rows = (text: string) => text.split('\n').filter(line => /^\| \d+ \|/.test(line));

describe('the seal lead of a segmented page on a Rust brain', () => {
  withAddon('strikes a claim holding U+0085 and leaves claims that differ by U+1680 or U+00A0', async () => {
    const text = lead('Walks\u0085to work', 'Drinks\u1680green tea', 'Drinks\u00a0green tea');
    const out = await overlayStoreLead(await storeNormalize(), text, { withdrawals: [ledger('Walks to work'), ledger('Drinks green tea')] });
    expect(rows(out).map(line => line.includes('forgotten:'))).toEqual([true, false, false]);
  });

  withAddon('drops a purged claim holding U+0085 named by a subject-* tombstone', async () => {
    const text = lead('Walks\u0085to work', 'Prefers the aisle seat');
    const out = await overlayStoreLead(await storeNormalize(), text, { withdrawals: [], globalPurgeRows: [ledger('Walks to work', true)] });
    expect(rows(out)).toHaveLength(1);
    expect(out).toContain('Prefers the aisle seat');
  });

  withAddon('asks the store to normalize nothing when the page has no ledger rows or no fence', async () => {
    const calls: number[] = [];
    const normalize = async () => { calls.push(1); return []; };
    expect(await overlayStoreLead(normalize, lead('Plain claim'), { withdrawals: [] })).toBe(lead('Plain claim'));
    expect(await overlayStoreLead(normalize, 'No fence here.', { withdrawals: [ledger('Plain claim')] })).toBe('No fence here.');
    expect(calls).toEqual([]);
  });
});
