/**
 * The typed commit-log members (engine-members/commit-log.ts): `readCommitLog(after, limit)` and `lastCommitPosition()`.
 *
 * - Rust, multi-user mode with the commit log on (set in-run with withEnv, and asserted on the opened store): every
 *   transaction's own engine answers the position it committed at, also after it ended; positions strictly increase;
 *   `readCommitLog` returns those commits at those positions with their write ids; out-of-range cursors are refused.
 * - Rust with the mode off, and PGLite: both members refuse `engine_capability_missing` with reason `commit_log`.
 *
 * Needs the addon `bun run rust:build` writes; the Rust cases skip without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes
 * that an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CommitPosition } from '../src/core/engine-members/commit-log.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ON = { GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_COMMIT_LOG: '1', GBRAIN_RUST_WRITE_ORIGIN: undefined };
const OFF = { GBRAIN_RUST_MULTIUSER: undefined, GBRAIN_RUST_COMMIT_LOG: undefined, GBRAIN_RUST_WRITE_ORIGIN: undefined };

async function openRust(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-commit-log-engine-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: join(dir, 'brain') });
  await engine.connect({ engine: 'rust', database_path: join(dir, 'brain') } as never);
  return engine;
}

async function refusal(p: Promise<unknown>): Promise<{ code?: unknown; reason?: unknown }> {
  try {
    await p;
  } catch (error) {
    return error as { code?: unknown; reason?: unknown };
  }
  return { code: 'resolved' };
}

const after = (a: CommitPosition, b: CommitPosition) => a.sequence > b.sequence || (a.sequence === b.sequence && a.index > b.index);

describe('commit log engine members', () => {
  withAddon('multi-user mode with the log on: each transaction answers its own position, and the log lists them', async () => {
    await withEnv(ON, async () => {
      const engine = await openRust();
      try {
        // How the mode is on: set in-run, and asserted on the store this engine opened.
        expect(engine.openStore('test').multiuser).toBe(true);
        expect(engine.openStore('test').commitLog).toBe(true);
        expect(engine.capabilities.has('commit_log')).toBe(true);
        const start = (await engine.readCommitLog(null, 10_000)).newest;
        const positions: CommitPosition[] = [];
        for (let i = 0; i < 3; i++) {
          let seen: { lastCommitPosition(): Promise<CommitPosition | null> } | undefined;
          await engine.transaction(async tx => {
            seen = tx;
            await tx.setConfig(`test.k${i}`, `v${i}`);
            expect(await tx.lastCommitPosition()).toBeNull(); // still open
          });
          const at = await seen!.lastCommitPosition(); // after it ended
          expect(at).toEqual({ sequence: expect.any(Number), index: expect.any(Number) });
          positions.push(at!);
        }
        for (let i = 1; i < positions.length; i++) expect(after(positions[i]!, positions[i - 1]!)).toBe(true);
        expect(await engine.lastCommitPosition()).toEqual(positions[2]!);
        // A rolled-back transaction's engine answers null.
        let rolled: { lastCommitPosition(): Promise<CommitPosition | null> } | undefined;
        await engine.transaction(async tx => { rolled = tx; await tx.setConfig('test.rb', 'x'); throw new Error('roll back'); }).catch(() => undefined);
        expect(await rolled!.lastCommitPosition()).toBeNull();
        const page = await engine.readCommitLog(start, 10_000);
        expect(page.snapshot_required).toBe(false);
        const logged = page.records.map(r => r.position);
        for (const p of positions) expect(logged).toContainEqual(p);
        for (const r of page.records) {
          expect(typeof r.commit_time_us).toBe('number');
          expect(r.op_count).toBeGreaterThan(0);
        }
        // Out-of-range cursors are refused, never truncated.
        expect((await refusal(engine.readCommitLog({ sequence: 2 ** 53, index: 0 }, 1))).code).toBe('invalid_argument');
        expect((await refusal(engine.readCommitLog({ sequence: 1, index: 2 ** 32 }, 1))).code).toBe('invalid_argument');
      } finally {
        await engine.disconnect();
      }
    });
  });

  withAddon('the mode off: both members refuse naming commit_log', async () => {
    await withEnv(OFF, async () => {
      const engine = await openRust();
      try {
        expect(engine.openStore('test').commitLog).toBe(false);
        for (const p of [engine.readCommitLog(null, 10), engine.lastCommitPosition()]) {
          const e = await refusal(p);
          expect(e.code).toBe('engine_capability_missing');
          expect(e.reason).toBe('commit_log');
        }
      } finally {
        await engine.disconnect();
      }
    });
  });

});

describe('commit log engine members on PGLite', () => {
  let pglite: PGLiteEngine;
  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
  }, 120_000);
  afterAll(async () => { await pglite.disconnect(); });

  test('PGLite refuses both members naming commit_log, and does not report the capability', async () => {
    expect(pglite.capabilities.has('commit_log')).toBe(false);
    for (const p of [pglite.readCommitLog(null, 10), pglite.lastCommitPosition()]) {
      const e = await refusal(p);
      expect(e.code).toBe('engine_capability_missing');
      expect(e.reason).toBe('commit_log');
    }
  });
});
