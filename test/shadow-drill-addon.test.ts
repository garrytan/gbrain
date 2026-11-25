/**
 * The shadow restore drill against a real Rust owner (src/shadow/drill.ts; rust/docs/store/snapshot.md).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the claim criterion 10 rests on: a drill copies the shadow's store while
 * the shadow's owner keeps writing, verifies the copy without a normal open, opens it once and leaves nothing behind.
 * (2) Fails when the drill pauses or blocks the owner's writes, when the copy holds a later commit, when a killed CLI's
 * scratch space is deleted (or reads as a pass) while the owner may still be copying, or when the next drill cannot clear
 * it once the owner says the copy ended. (3) The fake-owner tests (test/shadow-drill.test.ts) cannot show any of this: the
 * lifecycle is the addon's. (4) The real addon (`bun run rust:build`), a real owner child process, the real verifier;
 * skips without the addon (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 or GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error). The Rust
 * engine workflow runs it through its rust-store receipt lane with GBRAIN_TEST_REQUIRE_RUST_ADDON=1, so the stress gate does
 * not stress it where no addon exists (scripts/stress/README.md).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, loadRustEngineAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { DEFAULT_HARD_EXCLUDES } from '../src/core/search/source-boost.ts';
import { verifyStoreDir } from '../src/core/rust-engine/store.ts';
import { runBackupDrill } from '../src/shadow/drill.ts';
import { ENGLISH_STOPWORDS } from '../src/shadow/english-stopwords.ts';
import { buildDrillStatus } from '../src/shadow/drill-status.ts';
import { writeEpoch } from './helpers/shadow-drill-fixtures.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1' || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1')) {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 or GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
// The drill checks the digest of the addon it loads against the epoch's: the epoch of these tests names this file's.
const BUILT_SHA = HAVE_ADDON ? createHash('sha256').update(readFileSync(BUILT)).digest('hex') : '';
/** The drill's digest reads the override file, as the shadow child's epoch does. */
const drill = (dir: string, deps?: Parameters<typeof runBackupDrill>[1]) => withEnv({ GBRAIN_RUST_ENGINE_ADDON: BUILT }, () => runBackupDrill(dir, deps));

const root = join(import.meta.dir, '..');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

/** A shadow directory whose store has a live owner child that keeps writing. */
async function shadowWithOwner(): Promise<{ dir: string; initialPages: number; stop(): Promise<number> }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-drill-addon-'));
  const child = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'shadow-drill-owner.ts'), BUILT, dir], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let out = '';
  void (async () => { for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk); })();
  cleanups.push(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  await until('the owner to be ready', () => /ready \d+/.test(out), 40_000);
  writeEpoch(dir, { addon: BUILT_SHA });
  return {
    dir, initialPages: Number(/ready (\d+)/.exec(out)![1]),
    stop: async () => {
      child.stdin.write('stop\n');
      await child.stdin.flush();
      await until('the owner to stop', () => /stopped \d+/.test(out));
      return Number(/stopped (\d+)/.exec(out)![1]);
    },
  };
}
const scratches = (dir: string): string[] => (existsSync(join(dir, 'drills')) ? readdirSync(join(dir, 'drills')).filter(n => n.startsWith('scratch-')) : []);

(HAVE_ADDON ? describe : describe.skip)('the restore drill on a real shadow store', () => {
  test('copies the store while its owner keeps writing, verifies and opens the copy, and leaves nothing behind', async () => {
    const shadow = await shadowWithOwner();
    const record = await drill(shadow.dir, {
      loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }),
      snapshotOptions: { batchBytes: 4096, batchDelayMs: 20 },
    });
    expect(record).toMatchObject({ pass: true, reason: null, via: 'owner_ipc', method: 'online_logical', scratch_deleted: true, over_archive_cap: false });
    expect(record.generation).toBeGreaterThan(0);
    expect(record.compared!.tags).toBeGreaterThan(0);
    expect(record.mismatches).toEqual([]);
    expect(record.post_open!.pages).toBeGreaterThanOrEqual(shadow.initialPages);
    expect(record.post_open!.keyword_state).toBe('complete');
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
    expect(record.free_bytes_low_water!).toBeLessThanOrEqual(record.free_bytes_initial!);
    expect(JSON.parse(readFileSync(join(shadow.dir, 'drills', 'backup.json'), 'utf8')).drill_id).toBe(record.drill_id);
    expect(scratches(shadow.dir)).toEqual([]);
    expect(buildDrillStatus(shadow.dir).drills.backup_restore_passed).toBe(true);
    // The owner was never paused: it kept writing through the copy and took pages after it.
    const total = await shadow.stop();
    expect(total).toBeGreaterThan(shadow.initialPages);
  }, 90_000);

  test('a killed CLI leaves cleanup_pending until the owner ends the copy; the next drill then clears it', async () => {
    const shadow = await shadowWithOwner();
    const cli = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'shadow-drill-cli.ts'), BUILT, shadow.dir, '150', '4096'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    cleanups.push(() => { cli.kill('SIGKILL'); });
    await until('the copy to start', () => scratches(shadow.dir).some(n => existsSync(join(shadow.dir, 'drills', n, 'restored', 'records.redb'))), 40_000);
    cli.kill('SIGKILL');
    await cli.exited;
    // Right after the kill the drill left its pending record, and status is not a pass whatever the owner is doing.
    expect(existsSync(join(shadow.dir, 'drills', 'pending.json'))).toBe(true);
    expect(buildDrillStatus(shadow.dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending' });
    // The owner stops the copy for the gone caller and says so; only then does a drill clear it and run.
    let next = await drill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    const deadline = Date.now() + 30_000;
    while (next.reason === 'cleanup_pending' && Date.now() < deadline) {
      await sleep(100);
      next = await drill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    }
    expect(next).toMatchObject({ pass: true, scratch_deleted: true });
    expect(scratches(shadow.dir)).toEqual([]);
    expect(existsSync(join(shadow.dir, 'drills', 'pending.json'))).toBe(false);
    expect(buildDrillStatus(shadow.dir).drills.backup_restore_passed).toBe(true);
    await shadow.stop();
  }, 120_000);

  test('a store with no owner running is copied in process', async () => {
    const shadow = await shadowWithOwner();
    await shadow.stop();
    await sleep(500);
    const record = await drill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    expect(record).toMatchObject({ pass: true, via: 'in_process', scratch_deleted: true });
  }, 90_000);

  /** A shadow directory whose store holds the given pages (source, slug, text) and has no owner running. */
  async function shadowWithPages(pages: Array<{ source?: string; slug: string; text: string }>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-drill-pages-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = `${dir}/store`;
    const engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }), databasePath: store });
    await engine.connect({ database_path: store } as never);
    try {
      for (const source of new Set(pages.map(p => p.source).filter(Boolean))) {
        await (engine as unknown as { openStore(member: string): { brain: { upsertSource(input: object): Promise<unknown> } } }).openStore('test').brain.upsertSource({ id: source, name: source, config: {} });
      }
      for (const p of pages) {
        const opts = p.source ? { sourceId: p.source } : undefined;
        await engine.putPage(p.slug, { type: 'note', title: p.slug, compiled_truth: p.text, timeline: '' }, opts);
        await engine.sealChunks(p.slug, [{ chunk_index: 0, chunk_text: p.text, chunk_source: 'compiled_truth' }], opts);
      }
    } finally {
      await engine.disconnect();
    }
    writeEpoch(dir, { addon: BUILT_SHA });
    return dir;
  }

  test('a healthy copy whose longest word is a stop word passes, with a keyword hit from a word the engine indexes', async () => {
    const dir = await shadowWithPages([{ slug: 'notes/s', text: 'quasar themselves' }]);
    const record = await drill(dir);
    expect(record).toMatchObject({ pass: true, reason: null, addon_sha256: BUILT_SHA, scratch_deleted: true });
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
  }, 90_000);

  test('a brain that holds pages only in a named source still runs its search and passes', async () => {
    const dir = await shadowWithPages([{ source: 'wiki', slug: 'notes/w', text: 'harbor lanterns' }]);
    const record = await drill(dir);
    expect(record).toMatchObject({ pass: true, reason: null });
    expect(record.post_open!.pages).toBeGreaterThan(0);
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
  }, 90_000);

  test('an epoch that started on another addon refuses before any copy is made', async () => {
    const dir = await shadowWithPages([{ slug: 'notes/s', text: 'harbor lanterns' }]);
    writeEpoch(dir, { addon: 'd'.repeat(64) });
    const record = await drill(dir);
    expect(record).toMatchObject({ pass: false, reason: 'addon_mismatch', addon_sha256: BUILT_SHA, op_id: null });
    expect(existsSync(join(dir, 'drills'))).toBe(false);
  }, 90_000);

  test('a healthy copy whose chunk starts with 30 stop words longer than its one real word still passes', async () => {
    const stops = ENGLISH_STOPWORDS.filter(w => w.length >= 5).slice(0, 30);
    const dir = await shadowWithPages([{ slug: 'notes/s', text: `${stops.join(' ')} cats` }]);
    const record = await drill(dir);
    expect(record).toMatchObject({ pass: true, reason: null });
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
  }, 90_000);

  test('20 newer pages under a search-excluded prefix do not hide the one older searchable page', async () => {
    const prefix = DEFAULT_HARD_EXCLUDES[0]!;
    const older = { slug: 'notes/older', text: 'harbor lanterns' };
    const excluded = Array.from({ length: 21 }, (_, n) => ({ slug: `${prefix}p${n}`, text: `attached filler ${n}` }));
    const dir = await shadowWithPages([older, ...excluded]);
    const record = await drill(dir);
    expect(record).toMatchObject({ pass: true, reason: null });
    expect(record.post_open!.pages).toBe(22);
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
  }, 90_000);

  test('a shadow deleted while the real verifier runs is not recreated by the drill\'s open of the copy', async () => {
    const dir = await shadowWithPages([{ slug: 'notes/s', text: 'harbor lanterns' }]);
    const record = await drill(dir, {
      verify: async (addon, copy, expected) => {
        const report = await verifyStoreDir(addon, copy, expected);
        rmSync(dir, { recursive: true, force: true }); // gbrain engine shadow stop --delete, racing the drill
        return report;
      },
    });
    expect(record).toMatchObject({ pass: false, reason: 'shadow_gone' });
    expect(existsSync(dir)).toBe(false);
  }, 90_000);
});
