/**
 * Wave C 1E (spec §5 "PGLite backup"): the dump is written to disk piece by piece.
 *
 * 1. Protects: createPgliteBackup writes `dumpDataDir`'s Blob through `Blob.stream()` into the private stage file and
 *    never calls `arrayBuffer()`, which copies the whole tar a second time (master); the archive restores a brain that
 *    holds the same page.
 * 2. Fails when: the dump is read whole with arrayBuffer() (or text()/bytes()) before it is written.
 * PGLite 0.4.3 builds the tar itself in memory (fs.dumpTar), so one tar's worth of heap remains and no peak-RSS bound
 *    independent of the data dir is claimed; the witness is the Blob's read path. PGLite only (the path is PGLite's).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteBackup, restorePgliteBackup } from '../../src/core/backup/snapshot.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backup-stream-')));
const reads = { stream: 0, whole: 0 };
let restoredTruth: string | undefined;

beforeAll(async () => {
  const withBrain = async <T>(path: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: path });
    try { return await fn(engine); } finally { await engine.disconnect(); }
  };
  const root = join(dir, 'root');
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  const database = join(root, '.gbrain', 'brain.pglite');
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
  await withBrain(database, async engine => {
    await engine.initSchema();
    await engine.putPage('notes/backup-stream', { type: 'note', title: 'Backup stream', compiled_truth: 'Kept across the backup.', timeline: '' });
  });

  const dump = PGlite.prototype.dumpDataDir;
  PGlite.prototype.dumpDataDir = async function (this: PGlite, ...args: Parameters<PGlite['dumpDataDir']>) {
    const blob = await dump.apply(this, args);
    const whole = () => { reads.whole++; throw new Error('the dump was read whole'); };
    return Object.assign(blob, {
      arrayBuffer: whole, text: whole, bytes: whole,
      stream: () => { reads.stream++; return Blob.prototype.stream.call(blob); },
    });
  } as PGlite['dumpDataDir'];
  const archive = join(dir, 'brain.gbrain-backup');
  try { await createPgliteBackup({ root, output: archive }); } finally { PGlite.prototype.dumpDataDir = dump; }

  const restored = join(dir, 'restored');
  await restorePgliteBackup({ archive, into: restored });
  restoredTruth = (await withBrain(join(restored, '.gbrain', 'brain.pglite'), engine => engine.getPage('notes/backup-stream')))?.compiled_truth;
}, 300_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the dump streams to disk without arrayBuffer(), and the archive restores the brain', () => {
  expect(reads).toEqual({ stream: 1, whole: 0 });
  expect(restoredTruth).toBe('Kept across the backup.');
});
