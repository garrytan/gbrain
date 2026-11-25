/**
 * Sixteen processes on one Rust brain (docs/designs/RUST_ENGINE.md, "PR sequence" step 18). This process owns the
 * brain; sixteen child processes reach it as clients and write and read at the same time through the owner socket.
 * None of them may get `rust_store_locked` or any other busy error, and every page they wrote must be in the store.
 * The test prints the throughput and the p50/p99 latency (scripts/bench-rust-owner.ts runs the same harness larger).
 *
 * Needs the file `bun run rust:build` writes (rust/target/addon) and skips without it; GBRAIN_TEST_RUST_ADDON_REQUIRED=1
 * makes a missing addon an error.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { runOwnerBench } from './helpers/rust-owner-bench.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const SCRATCH = mkdtempSync(join(tmpdir(), 'gbrain-rust-owner-clients-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('sixteen processes on one Rust brain', () => {
  withAddon('embedded, one owner: all reach the owner, none gets a busy error, and every page they wrote is there', async () => {
    const result = await runOwnerBench({ addonPath: BUILT, db: join(SCRATCH, 'brain'), clients: 16, ops: 100 });
    console.log(`[owner-clients] ${JSON.stringify({ ...result, roles: undefined })}`);
    expect(result.ownerRole).toBe('owner');
    expect(result.roles).toEqual(Array(16).fill('client'));
    expect(result.errors).toEqual([]);
    expect(result.pagesFound).toBe(result.pagesWritten);
    expect(result.pagesWritten).toBe(16 * 50);
  }, 120_000);
  test.todo('multi-writer (C18): sixty-four writers in eight processes all reach the server, none gets a busy error, and every page they wrote is there', () => {});
});
