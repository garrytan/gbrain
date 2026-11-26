/**
 * Owner failover on a Rust brain (docs/designs/RUST_ENGINE.md, "PR sequence" step 18). A process that owns the brain
 * is killed with SIGKILL while it and two clients write. The clients must take the brain over within a bound: one of
 * them becomes the owner and opens the store, the other becomes its client, and every write that any process saw
 * acknowledged is still there. A write in flight when the owner died ends with `owner_unavailable`
 * (`outcome_unknown`) and is never sent again, so it is not applied twice.
 *
 * Needs the file `bun run rust:build` writes (rust/target/addon) and skips without it; GBRAIN_TEST_RUST_ADDON_REQUIRED=1
 * makes a missing addon an error.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { OperationError } from '../src/core/ops/contract.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const CHILD = join(import.meta.dir, 'helpers', 'rust-owner-child.ts');
const SCRATCH = mkdtempSync(join(tmpdir(), 'gbrain-rust-owner-failover-'));
/** The longest a client may take, from the owner's death, to finish its first write on the new owner. */
const TAKEOVER_BOUND_MS = 6_000;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Starts a child, collects its JSON lines, and resolves once it prints `ready`. */
function startChild(mode: string, db: string, worker: number): Promise<{ child: ChildProcess; lines: Array<Record<string, unknown>> }> {
  const child = spawn(process.execPath, [CHILD, mode, db, String(worker)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GBRAIN_RUST_ENGINE_ADDON: BUILT },
  });
  const lines: Array<Record<string, unknown>> = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', chunk => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const part of parts) {
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        if (line.ready) resolve({ child, lines });
        if (line.fatal !== undefined) reject(new Error(`child failed: ${part}`));
      }
    });
    child.on('close', code => reject(new Error(`child exited ${code} before ready: ${stderr}`)));
  });
}

async function client(db: string): Promise<RustEngine> {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const engine = openRustEngine({ addon, databasePath: db });
  await engine.connect({ engine: 'pglite', database_path: db } as never);
  return engine;
}

/** Puts pages one after another until `stop`, recording every acknowledged slug and every error. */
function writeLoop(engine: RustEngine, name: string, stop: { now: boolean }) {
  const acked: string[] = [];
  const errors: OperationError[] = [];
  const done = (async () => {
    for (let n = 0; !stop.now; n++) {
      const slug = `fo/${name}-${n}`;
      try {
        await engine.putPage(slug, { type: 'note', title: `${name} ${n}`, compiled_truth: `Page ${n}.` });
        acked.push(slug);
      } catch (error) {
        errors.push(error as OperationError);
        // A refusal can come back at once; yield so the test's own timers still run.
        await Bun.sleep(5);
      }
    }
  })();
  return { acked, errors, done };
}

describe('a Rust brain whose owner is killed mid-write', () => {
  withAddon('embedded, one owner: a client takes over within the bound, one process owns the brain, and no acknowledged write is lost', async () => {
    const db = join(SCRATCH, 'brain-kill');
    const { child, lines } = await startChild('writer', db, 0);
    const engines: RustEngine[] = [];
    const stop = { now: false };
    try {
      expect(lines[0]!.role).toBe('owner');
      const a = await client(db);
      const b = await client(db);
      engines.push(a, b);
      expect(a.ownerRole).toBe('client');
      expect(b.ownerRole).toBe('client');

      const loops = [writeLoop(a, 'a', stop), writeLoop(b, 'b', stop)];
      // Let every process commit writes through the owner, then kill it while its own loop and both clients write.
      while (loops.some(loop => loop.acked.length < 20) || lines.filter(l => l.acked).length < 20) await Bun.sleep(10);
      const killedAt = Date.now();
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('close', resolve));
      const before = loops.map(loop => loop.acked.length);
      // Each client must write again on the new owner within the bound.
      while (loops.some((loop, i) => loop.acked.length <= before[i]! + 5)) {
        expect(Date.now() - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
        await Bun.sleep(10);
      }
      const tookOverMs = Date.now() - killedAt;
      stop.now = true;
      await Promise.all(loops.map(loop => loop.done));

      // Exactly one survivor owns the brain; the other reaches it through the new owner.
      expect([a.ownerRole, b.ownerRole].sort()).toEqual(['client', 'owner']);
      // A write in flight when the owner died has an unknown outcome and was not sent again; nothing else failed.
      for (const loop of loops) {
        for (const error of loop.errors) {
          expect(error.code).toBe('owner_unavailable');
          expect(error.reason).toBe('outcome_unknown');
        }
        expect(loop.errors.length).toBeLessThanOrEqual(1);
      }
      // Every write any process saw acknowledged, including the dead owner's own, is in the store.
      const acked = [...loops.flatMap(loop => loop.acked), ...lines.filter(l => l.acked).map(l => String(l.acked))];
      const reader = a.ownerRole === 'client' ? a : b;
      for (const slug of acked) expect((await reader.getPage(slug))?.slug ?? `missing ${slug}`).toBe(slug);
      console.log(`[failover] took over in ${tookOverMs} ms; ${acked.length} acknowledged writes all present`);
    } finally {
      stop.now = true;
      child.kill('SIGKILL');
      for (const engine of engines) await engine.disconnect().catch(() => undefined);
    }
  }, 60_000);
  test.todo('multi-writer (C06): after a takeover within the bound exactly one primary writes, the old primary is fenced by its token, and no acknowledged write is lost', () => {});

  withAddon('embedded, one owner: a client whose owner disconnects cleanly takes the brain over on its next call', async () => {
    const db = join(SCRATCH, 'brain-close');
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const owner = openRustEngine({ addon, databasePath: db });
    await owner.connect({ engine: 'pglite', database_path: db } as never);
    const c = await client(db);
    try {
      await c.putPage('fo/before', { type: 'note', title: 'Before', compiled_truth: 'x' });
      await owner.disconnect();
      expect(owner.ownerRole).toBeNull();
      expect((await c.getPage('fo/before'))?.title).toBe('Before');
      expect(c.ownerRole).toBe('owner');
      await c.putPage('fo/after', { type: 'note', title: 'After', compiled_truth: 'y' });
      expect((await c.getPage('fo/after'))?.title).toBe('After');
    } finally {
      await c.disconnect().catch(() => undefined);
      await owner.disconnect().catch(() => undefined);
    }
  }, 30_000);
  test.todo('multi-writer (C06): a primary that hands over cleanly leaves a higher epoch to the next primary, which writes on its next call', () => {});
});
