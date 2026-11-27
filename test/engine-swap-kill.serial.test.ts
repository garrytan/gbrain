/**
 * An engine swap whose process is killed (SIGKILL) mid-run, then restarted with `--resume`
 * (src/core/engine-swap/run.ts, test/fixtures/engine-swap-kill/child.ts).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the user's brain across a crash during the swap: after the kill the
 * config names exactly one engine, the old primary is fenced exactly when the run recorded the fence, and no page is
 * lost or duplicated on either engine; after the restart the run finishes on the Rust engine with the same pages.
 * (2) Fails when a kill leaves authority on an engine that was not verified, leaves the primary fenced before the run
 * recorded it or unfenced after, loses a page written before the fence, duplicates a page in the Rust store, or when
 * `--resume` cannot finish from a real process death (no finally block, no flush). (3) test/engine-swap-run.serial.test.ts
 * throws inside one process; only this file kills the process. (4) Seams: the shadow child's RPC runs inside the killed
 * process (test/helpers/follow-rig.ts) and the route probe is injected; the primary, the store, the record and the
 * kill are real. Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1
 * makes it an error).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import type { SwapState } from '../src/core/engine-swap/record.ts';
import { fillSeedFixture } from './helpers/shadow-seed-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const CHILD = join(import.meta.dir, 'fixtures', 'engine-swap-kill', 'child.ts');
const ORDER: SwapState[] = ['planned', 'checkpointed', 'fenced', 'verified', 'switched', 'succeeded'];

interface Seen { engine: string; state: SwapState | null; fenced: boolean; primaryPages: Record<string, number>; rustPages: Record<string, number> | null }

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function child(args: string[]): { status: number | null; signal: NodeJS.Signals | null; out: string; err: string } {
  const env = { ...process.env, GBRAIN_RUST_ENGINE_ADDON: BUILT };
  const r = spawnSync(process.execPath, [CHILD, ...args], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
}
const inspect = (home: string): Seen => {
  const r = child(['inspect', home]);
  if (r.status !== 0) throw new Error(`inspect failed: ${r.err}`);
  return JSON.parse(r.out.trim().split('\n').pop()!) as Seen;
};

/** A fresh world: a file-backed PGLite brain with the seed fixture, its config naming PGLite. */
async function world(): Promise<{ home: string; pages: Record<string, number> }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-swap-kill-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }));
  const primary = new PGLiteEngine();
  await primary.connect({ engine: 'pglite', database_path: dbPath });
  await primary.initSchema();
  await fillSeedFixture(primary);
  const rows = await primary.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE deleted_at IS NULL ORDER BY slug');
  await primary.disconnect();
  return { home, pages: Object.fromEntries(rows.map(r => [r.slug, 1])) };
}

(HAVE_ADDON ? describe : describe.skip)('an engine swap killed mid-run', () => {
  for (const at of ['planned', 'checkpointed', 'fenced', 'verified', 'switched'] as SwapState[]) {
    test(`a SIGKILL at ${at} leaves one engine, a fence exactly when recorded and every page once; --resume finishes on Rust`, async () => {
      const { home, pages } = await world();
      const killed = child(['run', home, at]);
      expect({ signal: killed.signal, err: killed.signal ? '' : killed.err }).toEqual({ signal: 'SIGKILL', err: '' });

      const after = inspect(home);
      expect(after.state).toBe(at);
      // Exactly one engine has authority: the config names the old engine until the run switched it.
      const switched = ORDER.indexOf(at) >= ORDER.indexOf('switched');
      expect(after.engine).toBe(switched ? 'rust' : 'pglite');
      // The fence is in place exactly when the run recorded it (a kill before `fenced` leaves the primary writable).
      const fencedRecorded = ORDER.indexOf(at) >= ORDER.indexOf('fenced');
      expect(after.fenced).toBe(fencedRecorded);
      // No page lost or duplicated on the primary.
      expect(after.primaryPages).toEqual(pages);

      // Before the fence the old engine still takes writes, and the resumed run must carry them.
      const expected = { ...pages };
      if (!fencedRecorded) {
        const primary = new PGLiteEngine();
        await primary.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
        await primary.putPage('notes/after-kill-example', { type: 'note', title: 'After kill', compiled_truth: 'Written between the kill and the restart.', timeline: '' });
        await primary.disconnect();
        expected['notes/after-kill-example'] = 1;
      }

      const resumed = child(['resume', home]);
      expect({ status: resumed.status, err: resumed.status === 0 ? '' : resumed.err }).toEqual({ status: 0, err: '' });
      const done = inspect(home);
      expect({ engine: done.engine, state: done.state, fenced: done.fenced }).toEqual({ engine: 'rust', state: 'succeeded', fenced: true });
      expect(done.primaryPages).toEqual(expected);
      expect(done.rustPages).toEqual(expected);
    }, 300_000);
  }
});
