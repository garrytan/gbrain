/**
 * `gbrain backup create` and `backup restore` of a Rust brain (src/core/backup/rust-snapshot.ts). A seeded brain is
 * backed up through its owner, restored into a new root, and the restored brain is read in a fresh process.
 *
 * Needs the addon `bun run rust:build` writes (rust/target/addon); skips without it, and GBRAIN_TEST_RUST_ADDON_REQUIRED=1
 * (the Rust CI job) makes a missing addon an error. Fails on: an archive that records the container version as the store
 * version, a restore that reads the original tree, a restored store that differs from the snapshot before the restore
 * changes it, a restore step that changes more than it reports, an unfinished request or a missing purge that is
 * published, a refusal that leaves the retry in the dark.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { verifyStoreDir } from '../src/core/rust-engine/store.ts';
import { hashFile, readBackupManifest } from '../src/core/backup/archive.ts';
import { createBackup as create, restoreBackup as restore, type RustBackupResult, type RustRestoreResult } from '../src/core/backup/rust-snapshot.ts';
import { PURGE_MIRROR_FILE } from '../src/core/belief/purge-mirror.ts';
import { brainDir, forgeArchive, makeHome, queueWrite, seedBrain, QUEUED_REQUEST, WRITER } from './helpers/rust-backup-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

/** These tests all run on Rust brains, so the dispatchers answer the Rust shapes. */
const createBackup = (options: Parameters<typeof create>[0]): Promise<RustBackupResult> => create(options) as Promise<RustBackupResult>;
const restoreBackup = (options: Parameters<typeof restore>[0]): Promise<RustRestoreResult> => restore(options) as Promise<RustRestoreResult>;

let addon: RustAddon;
let temporary: string;
let count = 0;
const fresh = (name: string): string => join(temporary, `${name}-${++count}`);
const failure = async (promise: Promise<unknown>): Promise<Record<string, any>> => promise.then(() => { throw new Error('unexpectedly succeeded'); }, (error: Error) => error as never);

/** A seeded home, its archive from `createBackup`, and the original's record file hash. */
async function backedUp(extra?: (brain: any) => Promise<void>) {
  const root = fresh('home');
  makeHome(root);
  await seedBrain(addon, root, extra);
  const archive = `${root}.gbrain-backup`;
  const created = await createBackup({ output: archive, root, addon });
  return { root, archive, created };
}

(HAVE_ADDON ? describe : describe.skip)('Rust backup round trip', () => {
  beforeAll(async () => {
    temporary = mkdtempSync(join(tmpdir(), 'gbrain-rust-backup-'));
    addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  });
  afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

  test('a format-5 store: archive metadata keeps the container version apart from the store version', async () => {
    const { archive, created } = await backedUp();
    const manifest = readBackupManifest(archive) as Record<string, any>;
    expect(manifest.format_version).toBe(1);
    expect(manifest.kind).toBe('gbrain-rust');
    expect(manifest.store.engine_format_version).toBeGreaterThan(1);
    expect(manifest.entries.map((e: { path: string }) => e.path).sort()).toEqual(['config.json', 'files/memory/note.md', 'store/FORMAT', 'store/SNAPSHOT.json', 'store/records.redb']);
    expect(created.restore_blockers).toEqual([]);
  });

  test('restore: phase 1 equals the snapshot, phase 2 changes only what it reports, the brain id is fresh, a fresh process reads it', async () => {
    const { root, archive } = await backedUp();
    const before = hashFile(join(brainDir(root), 'records.redb'));
    const into = fresh('restored');
    const result = await restoreBackup({ archive, into, mode: 'new_brain', addon });
    expect(result.revoked).toEqual({ local_writers: [WRITER], oauth_clients: ['c1'] });
    expect(result.quarantined_jobs).toBe(1);
    expect(result.brain_id.restored).not.toBe(result.brain_id.archived);
    expect(result.brain_id.archived).toBe((readBackupManifest(archive) as Record<string, any>).store.brain_id);
    expect(result.reconnect_required.join('\n')).toContain('Re-issue access');
    expect(result.reconnect_required.join('\n')).toContain('Access tokens are not revoked');
    expect(hashFile(join(brainDir(root), 'records.redb'))).toEqual(before);
    const detached = JSON.parse(readFileSync(join(into, '.gbrain', 'restore-detached.json'), 'utf8'));
    const archived = JSON.parse(readFileSync(join(into, '.gbrain', 'restore-snapshot.json'), 'utf8'));
    expect(detached.detached_sources).toEqual(['ext']);
    expect(detached.rebased_sources).toEqual(['managed']);
    expect(detached.generation.snapshot).toBe(archived.generation);
    expect(detached.generation.restored).toBe(archived.generation + 1);
    const after = await verifyStoreDir(addon, brainDir(into));
    expect(after.verdict).toBe('ok');
    const moved = Object.keys({ ...archived.tags, ...after.tags }).filter(tag => archived.tags[tag]?.sha256 !== after.tags[tag]?.sha256).sort();
    // Only the records a restore step owns changed: config, the meta record (new brain id, rotated_from), pages (origins), sources, jobs, writers, the commit sequence, OAuth clients.
    expect(moved).toEqual(['43', '4d', '50', '53', '57', '6d', '6f']);
    expect(JSON.parse(readFileSync(join(into, '.gbrain', 'config.json'), 'utf8'))).toMatchObject({ engine: 'rust', database_path: brainDir(into) });
    expect(readFileSync(join(into, 'memory', 'note.md'), 'utf8')).toContain('Preserve this file');
    // A fresh process reads the restored brain while the original tree cannot be read.
    chmodSync(join(root, '.gbrain'), 0);
    try {
      const child = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-reopen.ts'), BUILT, brainDir(into), 'notes/a', 'zebra'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(out)).toEqual({ title: 'Alpha note', hits: ['notes/a'], role: 'owner' });
    } finally { chmodSync(join(root, '.gbrain'), 0o700); }
  }, 120_000);

  describe('create through the brain owner', () => {
    const talk = async (child: ReturnType<typeof Bun.spawn>, line: string, lines: AsyncGenerator<string>): Promise<void> => {
      (child.stdin as { write(text: string): number }).write(`${line}\n`);
      (child.stdin as { flush(): void }).flush();
      expect((await lines.next()).value).toBe('ok');
    };
    async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
      const decoder = new TextDecoder(); let buffered = '';
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk);
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) { yield buffered.slice(0, at); buffered = buffered.slice(at + 1); }
      }
    }
    async function owner(root: string) {
      const child = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-owner-child.ts'), BUILT, brainDir(root)], { cwd: join(import.meta.dir, '..'), stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
      const lines = linesOf(child.stdout as ReadableStream<Uint8Array>);
      expect((await lines.next()).value).toBe('ready');
      return { child, lines, say: (line: string) => talk(child, line, lines) };
    }

    test('a client of the owner archives one generation while the owner keeps writing, and the owner is untouched', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
      const o = await owner(root);
      try {
        await o.say('put early/1');
        const archive = `${root}.gbrain-backup`;
        let writing = true; let writes = 0;
        const writer = (async () => { while (writing) { await o.say(`put during/${writes++}`); } })();
        const created = await createBackup({ output: archive, root, addon });
        writing = false; await writer;
        expect(writes).toBeGreaterThan(1); // the owner took writes while the backup ran, so the archive below is not of an idle brain
        await o.say('put after/1');
        const into = fresh('restored');
        await restoreBackup({ archive, into, addon });
        const verdict = await verifyStoreDir(addon, brainDir(into));
        expect(verdict.verdict).toBe('ok');
        expect((readBackupManifest(archive) as Record<string, any>).store.generation).toBeGreaterThan(0);
        expect(created.restore_blockers).toEqual([]);
        const read = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-reopen.ts'), BUILT, brainDir(into), 'early/1', 'early'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe' });
        expect(JSON.parse(await new Response(read.stdout).text()).title).toBe('early/1');
        const late = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-reopen.ts'), BUILT, brainDir(into), 'after/1', 'after'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe' });
        expect(JSON.parse(await new Response(late.stdout).text()).title).toBeNull();
      } finally { (o.child.stdin as { write(t: string): number }).write('quit\n'); await o.child.exited; }
    }, 120_000);

    test('unfinished write work is retaken until it finishes; when it never does, create refuses writers_active and writes nothing', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
      const o = await owner(root);
      try {
        await o.say(`admit ${QUEUED_REQUEST}`);
        const waited: string[][] = [];
        const created = await createBackup({ output: `${root}-drained.gbrain-backup`, root, addon, retake: { attempts: 3, waitMs: 10,
          onWait: async (_attempt, pending) => { waited.push(pending); await o.say(`finish ${QUEUED_REQUEST}`); } } });
        expect(waited).toEqual([['pending_requests 1']]);
        expect(created.restore_blockers).toEqual([]);
        await o.say(`admit ${QUEUED_REQUEST.replace(/1$/, '2')}`);
        const stuck = `${root}-stuck.gbrain-backup`;
        const error = await failure(createBackup({ output: stuck, root, addon, retake: { attempts: 2, waitMs: 5 } }));
        expect(error.code).toBe('writers_active');
        expect(error.message).toContain('pending_requests 1');
        expect(existsSync(stuck)).toBe(false);
        expect(readdirSync(temporary).filter(name => name.startsWith('.gbrain-backup-'))).toEqual([]);
      } finally { (o.child.stdin as { write(t: string): number }).write('quit\n'); await o.child.exited; }
    }, 120_000);
  });

  describe('restore refusals', () => {
    const refusal = async (archive: string, extra: Record<string, unknown> = {}) => {
      const into = fresh('refused');
      const error = await failure(restoreBackup({ archive, into, addon, ...extra }));
      return { into, error };
    };
    const reserved = (into: string) => JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8'));

    test('an unfinished request refuses by name, publishes nothing, leaves a failed receipt, and an unchanged retry says restore_target_exists', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root, queueWrite);
      const archive = `${root}.gbrain-backup`;
      await forgeArchive(addon, root, archive);
      const { into, error } = await refusal(archive);
      expect(error).toMatchObject({ code: 'restore_step_unsupported', reason: 'pending_requests' });
      expect(error.message).toContain('Nothing was published');
      expect(error.detail).toMatch(/gbrain=\S+ addon_build=\S+ diagnostic=\S+/);
      expect(reserved(into)).toMatchObject({ state: 'failed', reason: 'restore_step_unsupported', refusal_reason: 'pending_requests' });
      expect(existsSync(join(into, '.gbrain'))).toBe(false);
      expect(readdirSync(into).filter(name => name.startsWith('.restore-'))).toHaveLength(1);
      expect((await failure(restoreBackup({ archive, into, addon }))).code).toBe('restore_target_exists');
    });

    test('recovery mode and an addon without the restore step refuse before any folder is reserved', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
      const archive = `${root}.gbrain-backup`;
      await forgeArchive(addon, root, archive);
      const recovery = await refusal(archive, { mode: 'recovery', confirmQuiesced: true, confirmBackupCompatible: true, confirmAuthorityReviewed: true });
      expect(recovery.error.reason).toBe('recovery_mode');
      const old = await refusal(archive, { addon: { Brain: class {}, Pool: class {} } });
      expect(old.error.reason).toBe('restore_addon_too_old');
      expect(existsSync(recovery.into) || existsSync(old.into)).toBe(false);
    });

    test('archive metadata that does not match the store is refused, whichever field disagrees', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
      for (const field of ['generation', 'brain_id', 'engine_format_version']) {
        const archive = `${root}-${field}.gbrain-backup`;
        await forgeArchive(addon, root, archive, m => { m.store[field] = field === 'brain_id' ? 'someone-else' : m.store[field] + 1; });
        const { into, error } = await refusal(archive);
        expect(error.code).toBe('invalid_backup');
        expect(reserved(into).state).toBe('failed');
      }
    });

    test('restored bytes that are not the snapshot are refused before the restore changes anything', async () => {
      const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
      const archive = `${root}.gbrain-backup`;
      await forgeArchive(addon, root, archive, undefined, dir => {
        const file = join(dir, 'records.redb');
        const bytes = readFileSync(file);
        for (let at = 8192; at < bytes.length - 100; at += 97) bytes[at] = bytes[at]! ^ 0xff;
        writeFileSync(file, bytes);
      });
      const { into, error } = await refusal(archive);
      expect(error.code).toBe('restore_verify_failed');
      expect(reserved(into).state).toBe('failed');
      expect(existsSync(join(into, '.gbrain'))).toBe(false);
    });

    describe('purges, by request id', () => {
      const intent = (request: string, sources: Array<{ id: string; incarnation: string }>) => ({ kind: 'intent', request, request_id: 'r1', source_id: sources[0]!.id, source_incarnation: sources[0]!.incarnation,
        scope: 'page', recorded_at: new Date().toISOString(), purge_epoch: 1, slug: 'notes/a', facts: [], takes: [], lifetimes: [] });
      async function withMirror(lines: (sources: Array<{ id: string; incarnation: string }>) => unknown[] | string | null) {
        const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
        const archive = `${root}.gbrain-backup`;
        await forgeArchive(addon, root, archive);
        const sources = (readBackupManifest(archive) as Record<string, any>).sources as Array<{ id: string; incarnation: string }>;
        const content = lines(sources);
        const mirror = join(root, '.gbrain', PURGE_MIRROR_FILE);
        if (content !== null) writeFileSync(mirror, typeof content === 'string' ? content : content.map(l => JSON.stringify(l)).join('\n') + '\n');
        return { root, archive };
      }
      const PURGE = '0c0c0c0c-0000-4000-8000-0000000000c1';

      test('a committed purge the snapshot lacks refuses purge_replay, whatever its time', async () => {
        const { archive } = await withMirror(s => [{ ...intent(PURGE, s), recorded_at: '2000-01-01T00:00:00.000Z' }, { kind: 'committed', request: PURGE, recorded_at: new Date().toISOString() }]);
        expect((await refusal(archive)).error).toMatchObject({ code: 'restore_step_unsupported', reason: 'purge_replay' });
      });
      test('an intent that never committed publishes, named unverified, as PGLite does', async () => {
        const { archive } = await withMirror(s => [intent(PURGE, s)]);
        const into = fresh('restored');
        const result = await restoreBackup({ archive, into, addon }) as { purge_replay: { state: string; replays: Array<{ request: string }> }; reconnect_required: string[] };
        expect(result.purge_replay).toMatchObject({ state: 'unverified', replays: [{ request: PURGE }] });
        expect(result.reconnect_required.join('\n')).toContain('never confirmed committed');
      });
      test('a damaged mirror refuses purge_mirror_unreadable; no mirror at all publishes as unavailable; a mirror for another incarnation is ignored', async () => {
        const damaged = await withMirror(() => '{not json\n');
        expect((await refusal(damaged.archive)).error.reason).toBe('purge_mirror_unreadable');
        const gone = await withMirror(() => null);
        rmSync(join(gone.root, '.gbrain', 'config.json'));
        const result = await restoreBackup({ archive: gone.archive, into: fresh('restored'), addon }) as { purge_replay: { state: string } };
        expect(result.purge_replay.state).toBe('unavailable');
        const other = await withMirror(s => [{ ...intent(PURGE, s), source_incarnation: '00000000-0000-4000-8000-000000000000' }, { kind: 'committed', request: PURGE }]);
        expect((await restoreBackup({ archive: other.archive, into: fresh('restored'), addon }) as { purge_replay: { state: string } }).purge_replay.state).toBe('none');
      });
    });
  });
});
