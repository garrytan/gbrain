/**
 * The follower's addon methods (rust/crates/gbrain-napi/src/families/follower.rs) on a real Rust brain, as lane L3's
 * follower frames call them: the primary's `Brain#readCommitLogRaw` hands records over as the bytes it stores, and a
 * `Follower` applies them (`applyRaw`) or installs a snapshot (`installSnapshot`). Store refusals keep their codes.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

type Position = { sequence: number; index: number };
type RawRecord = { sequence: number; index: number; bytes: Buffer };
type RawPage = { brainId: string; lineage: unknown[]; newest: Position | null; snapshotRequired: boolean; records: RawRecord[] };
interface AnyAddon {
  Pool: new (threads: number) => { shutdown(ms: number): Promise<unknown> };
  Brain: new (pool: unknown) => Record<string, (...args: never[]) => Promise<unknown>> & {
    open(path: string, options: object): Promise<unknown>;
    close(): Promise<void>;
    setConfig(key: string, value: string): Promise<unknown>;
    readCommitLogRaw(after: Position | null, max?: number): Promise<RawPage>;
    snapshotTo(target: string, options: object): Promise<unknown>;
  };
  Follower: new (pool: unknown) => {
    open(dir: string): Promise<{ cursor: Position | null }>;
    close(): Promise<void>;
    cursor(): Promise<Position | null>;
    applyRaw(brainId: string, lineage: unknown[], records: RawRecord[]): Promise<{ applied: number; skipped: number; cursor: Position }>;
    installSnapshot(dir: string, manifest: object | null): Promise<Position>;
  };
}

const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const addon = (await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } })) as unknown as AnyAddon;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-follower-napi-'));
  dirs.push(root);
  const pool = new addon.Pool(2);
  closers.push(() => pool.shutdown(1000));
  const open = async (name: string) => {
    const brain = new addon.Brain(pool);
    await brain.open(join(root, name), {
      schemaVersion: 1, createdBy: 'test', multiuser: true, commitLog: true,
      hostId: 'd0000000-0000-4000-8000-0000000000d1',
    });
    closers.push(() => brain.close());
    return brain;
  };
  const primary = await open('primary');
  await primary.setConfig('test.seed', '1');
  const snapshot = async (name: string) => {
    const target = join(root, name);
    await primary.snapshotTo(target, { v: 1, opId: name });
    return { dir: target, manifest: JSON.parse(readFileSync(join(target, 'SNAPSHOT.json'), 'utf8')) };
  };
  const follower = new addon.Follower(pool);
  await follower.open(join(root, 'follower'));
  closers.push(() => follower.close());
  return { addon, pool, root, open, primary, snapshot, follower };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'resolved';
}

describe('follower addon methods', () => {
  withAddon('installSnapshot then applyRaw follows the primary, and a re-apply is a no-op', async () => {
    const { primary, snapshot, follower } = await setup();
    expect(await follower.cursor()).toBeNull();
    const snap = await snapshot('snap');
    const installed = await follower.installSnapshot(snap.dir, snap.manifest);
    expect(installed).toEqual({ sequence: expect.any(Number), index: 0 });
    for (let i = 0; i < 5; i++) await primary.setConfig(`test.k${i}`, `v${i}`);
    const page = await primary.readCommitLogRaw(installed, 100);
    expect(page.snapshotRequired).toBe(false);
    expect(page.records.length).toBe(5);
    expect(Buffer.isBuffer(page.records[0]!.bytes)).toBe(true);
    expect(page.records[0]!.bytes[0]).toBe(2); // record version 2, unparsed by TypeScript
    const first = await follower.applyRaw(page.brainId, page.lineage, page.records);
    expect(first).toEqual({ applied: 5, skipped: 0, cursor: page.newest! });
    const again = await follower.applyRaw(page.brainId, page.lineage, page.records);
    expect(again).toEqual({ applied: 0, skipped: 5, cursor: page.newest! });
    expect(await follower.cursor()).toEqual(page.newest);
  });

  withAddon('a gap is snapshot_required and another brain is invalid_state', async () => {
    const { primary, open, snapshot, follower } = await setup();
    const snap = await snapshot('snap');
    const at = await follower.installSnapshot(snap.dir, snap.manifest);
    for (let i = 0; i < 3; i++) await primary.setConfig(`test.k${i}`, `v${i}`);
    const page = await primary.readCommitLogRaw(at, 100);
    expect(await code(follower.applyRaw(page.brainId, page.lineage, page.records.slice(1)))).toBe('snapshot_required');
    const other = await open('other');
    for (let i = 0; i < 6; i++) await other.setConfig(`test.o${i}`, `v${i}`);
    const foreign = await other.readCommitLogRaw(null, 100);
    expect(await code(follower.applyRaw(foreign.brainId, foreign.lineage, foreign.records))).toBe('invalid_state');
    expect(await follower.cursor()).toEqual(at);
  });

  withAddon('out-of-range positions are refused, never truncated', async () => {
    const { primary, snapshot, follower } = await setup();
    const snap = await snapshot('snap');
    const at = await follower.installSnapshot(snap.dir, snap.manifest);
    await primary.setConfig('test.k', 'v');
    const page = await primary.readCommitLogRaw(at, 100);
    const good = page.records[0]!;
    for (const bad of [
      { ...good, sequence: 2 ** 53 },
      { ...good, sequence: -1 },
      { ...good, sequence: 1.5 },
      { ...good, index: 2 ** 32 },
      { ...good, index: -1 },
    ]) {
      expect(await code(follower.applyRaw(page.brainId, page.lineage, [bad]))).toBe('invalid_argument');
    }
    expect(await code(primary.readCommitLogRaw({ sequence: 2 ** 53, index: 0 }))).toBe('invalid_argument');
    expect(await code(follower.applyRaw(page.brainId, [{ id: 't', from: { sequence: 1, index: 2 ** 32 } }], [good]))).toBe('invalid_argument');
    expect(await follower.cursor()).toEqual(at);
  });
});
