/**
 * #6649: `gbrain backup create` on PGLite refuses a brain its archive format
 * cannot hold before it takes the writer lock or opens the database:
 *
 * - a flat config home or a data dir reached through a symlink is
 *   `unmanaged_database_path` (before: a flat home got a one-line refusal and
 *   a symlinked `.gbrain` alias got the generic `symlink_path`, neither naming
 *   a recovery);
 * - an estimated archive over the 8 GiB cap is `backup_too_large` (before: the
 *   dump ran, was materialized in memory, and failed late or opaquely).
 *
 * Both name the quiesced physical-copy runbook, and the restore drill below
 * runs that runbook end to end: stop writers, copy the data dir and config
 * into a new isolated managed home, verify the copy opens with the data, and
 * show the copy is a normal layout that `backup create` then archives and
 * `backup restore` restores. Oversize inputs are sparse files (apparent size,
 * no disk use), so no test writes gigabytes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { BACKUP_ARCHIVE_MAX_BYTES } from '../src/core/backup/archive.ts';
import { estimatedTarBytes, pgliteBackupLayout, pgliteBackupPreflight } from '../src/core/backup/preflight.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { backupSizeCheck } from '../src/commands/doctor/checks/db-connection.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { codeEntry } from '../src/core/error-catalogue.ts';

let temporary: string;

async function makeBrain(dataDir: string, configFile: string): Promise<void> {
  mkdirSync(join(dataDir, '..'), { recursive: true, mode: 0o700 });
  privateWrite(configFile, JSON.stringify({ engine: 'pglite', database_path: dataDir, embedding_disabled: true }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  try {
    await engine.initSchema();
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Survives the physical copy.' });
  } finally { await engine.disconnect(); }
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string; fix?: { user_message?: string; docs?: string; ask_user?: boolean; verify?: { argv?: string[] } } }> {
  try { await promise; } catch (error) { return error as never; }
  throw new Error('backup unexpectedly succeeded');
}

beforeAll(() => { temporary = realpathSync(mkdtempSync(join(tmpdir(), 'g6649-'))); });
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

describe('layout preflight', () => {
  test('a symlinked .gbrain alias (the reported layout) is unmanaged_database_path with the runbook, not symlink_path, and writes nothing', async () => {
    const physical = join(temporary, 'volume', 'brain-home');
    const root = join(temporary, 'alias-user');
    await makeBrain(join(physical, 'brain.pglite'), join(physical, 'config.json'));
    mkdirSync(root);
    symlinkSync(physical, join(root, '.gbrain'), process.platform === 'win32' ? 'junction' : 'dir');
    privateWrite(join(physical, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'), embedding_disabled: true }));
    expect(pgliteBackupLayout(root, join(root, '.gbrain', 'brain.pglite'))).toBe('symlinked');
    const output = join(temporary, 'alias.gbrain-backup');
    const error = await failure(createPgliteBackup({ root, output }));
    expect(error.code).toBe('unmanaged_database_path');
    expect(error.message).toContain('symlink');
    expect(error.fix?.ask_user).toBe(true);
    expect(error.fix?.user_message).toContain('stop every gbrain writer');
    expect(error.fix?.docs).toContain('quiesced-physical-copy');
    expect(error.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(physical, 'brain.pglite'))).not.toContain('.gbrain-lock');
  });

  test('a flat config home whose database_path is outside <root>/.gbrain is unmanaged_database_path', async () => {
    const root = join(temporary, 'flat');
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    const elsewhere = join(temporary, 'flat-data', 'brain.pglite');
    mkdirSync(elsewhere, { recursive: true });
    privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: elsewhere }));
    const error = await failure(createPgliteBackup({ root, output: join(temporary, 'flat.gbrain-backup') }));
    expect(error.code).toBe('unmanaged_database_path');
    expect(error.message).toContain(elsewhere);
  });

  test('both refusals are registered codes with a runbook fix, so `gbrain errors` and the contract cover them', () => {
    for (const code of ['unmanaged_database_path', 'backup_too_large']) {
      const entry = codeEntry(code);
      expect(entry?.class).toBe('host_only');
      expect(entry?.docs).toContain('quiesced-physical-copy');
      expect(entry?.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--json']);
    }
  });
});

describe('size preflight', () => {
  let root: string;
  let dataDir: string;
  const sparse = () => join(dataDir, 'base', 'sparse-6649');

  beforeAll(async () => {
    root = join(temporary, 'large');
    dataDir = join(root, '.gbrain', 'brain.pglite');
    await makeBrain(dataDir, join(root, '.gbrain', 'config.json'));
  });
  afterEach(() => { rmSync(sparse(), { force: true }); });

  test('the estimate counts tar headers and 512-byte padding for every file', () => {
    const dir = join(temporary, 'estimate');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a'), 'x');
    writeFileSync(join(dir, 'sub', 'b'), Buffer.alloc(513));
    // closing blocks + 2 directories + (header + 1 block) + (header + 2 blocks)
    expect(estimatedTarBytes(dir)).toBe(512 * (2 + 2 + 2 + 3));
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an entry the runtime cannot lstat adds nothing to the estimate instead of failing it', () => {
    const dir = mkdtempSync(join(temporary, 'unreadable-'));
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'entry'), 'x');
    chmodSync(locked, 0o600);
    try {
      expect(estimatedTarBytes(dir)).toBe(512 * (2 + 2));
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('a data dir over the 8 GiB cap is refused as backup_too_large before the lock, the dump or any output', async () => {
    writeFileSync(sparse(), '');
    truncateSync(sparse(), BACKUP_ARCHIVE_MAX_BYTES + 1);
    const output = join(temporary, 'large.gbrain-backup');
    const started = Date.now();
    const error = await failure(createPgliteBackup({ root, output }));
    expect(error.code).toBe('backup_too_large');
    expect(error.message).toContain('8.00 GiB cap');
    expect(error.fix?.user_message).toContain('copy the whole data directory and config.json into a new, isolated GBRAIN_HOME');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(temporary).some(name => name.startsWith('.gbrain-backup-'))).toBe(false);
    expect(readdirSync(dataDir)).not.toContain('.gbrain-lock');
  });

  test('managed files count toward the cap', () => {
    expect(pgliteBackupPreflight(root, dataDir, () => 0)).toBeNull();
    expect(pgliteBackupPreflight(root, dataDir, () => BACKUP_ARCHIVE_MAX_BYTES)?.code).toBe('backup_too_large');
  });
});

describe('doctor pglite_data_dir near-cap warning', () => {
  test('silent below 75% of the cap, warns near it and over it with the runbook fix', () => {
    const dir = join(temporary, 'doctor');
    expect(backupSizeCheck(dir, Math.floor(BACKUP_ARCHIVE_MAX_BYTES * 0.74))).toBeNull();
    const near = backupSizeCheck(dir, Math.ceil(BACKUP_ARCHIVE_MAX_BYTES * 0.8))!;
    expect(near).toMatchObject({ name: 'pglite_data_dir', status: 'warn', details: { code: 'backup_too_large', over_limit: false } });
    expect(near.message).toContain('will refuse it soon');
    const over = backupSizeCheck(dir, BACKUP_ARCHIVE_MAX_BYTES + 1)!;
    expect(over.details).toMatchObject({ over_limit: true, limit_bytes: BACKUP_ARCHIVE_MAX_BYTES });
    expect((over.fix as { verify?: { argv?: string[] } }).verify?.argv).toEqual(['gbrain', 'doctor', '--json']);
  });
});

describe('restore drill: the quiesced physical-copy runbook', () => {
  test('stop writers, copy into an isolated managed home, verify, then archive and restore the copy', async () => {
    // The reported layout: a physical home on another volume reached through a .gbrain alias.
    const physical = join(temporary, 'drill-volume', 'brain-home');
    const aliasRoot = join(temporary, 'drill-user');
    await makeBrain(join(physical, 'brain.pglite'), join(physical, 'config.json'));
    mkdirSync(aliasRoot);
    symlinkSync(physical, join(aliasRoot, '.gbrain'), process.platform === 'win32' ? 'junction' : 'dir');

    // 1. Writers stopped: nothing holds the PGLite lock (makeBrain disconnected), so a fresh open would succeed.
    expect(readdirSync(join(physical, 'brain.pglite'))).not.toContain('.gbrain-lock');

    // 2. Copy the physical data dir (resolved through the alias) and config into a new isolated managed home.
    const copyRoot = join(temporary, 'drill-copy');
    const copyData = join(copyRoot, '.gbrain', 'brain.pglite');
    mkdirSync(join(copyRoot, '.gbrain'), { recursive: true, mode: 0o700 });
    cpSync(realpathSync(join(aliasRoot, '.gbrain', 'brain.pglite')), copyData, { recursive: true });
    const config = JSON.parse(readFileSync(join(physical, 'config.json'), 'utf8'));
    privateWrite(join(copyRoot, '.gbrain', 'config.json'), JSON.stringify({ ...config, database_path: copyData }));

    // 3. Verify the copy opens in its isolated home with the data intact.
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: copyData });
    try {
      expect((await engine.getPage('people/alice-example'))?.compiled_truth).toContain('Survives the physical copy.');
    } finally { await engine.disconnect(); }

    // 4. The copy is the managed layout: backup create archives it and restore brings it back in a third root.
    expect(pgliteBackupLayout(copyRoot, copyData)).toBe('managed');
    const archive = join(temporary, 'drill.gbrain-backup');
    await createPgliteBackup({ root: copyRoot, output: archive });
    const restored = await restorePgliteBackup({ archive, into: join(temporary, 'drill-restored') });
    const check = new PGLiteEngine();
    await check.connect({ engine: 'pglite', database_path: join(restored.root, '.gbrain', 'brain.pglite') });
    try {
      expect((await check.getPage('people/alice-example'))?.compiled_truth).toContain('Survives the physical copy.');
    } finally { await check.disconnect(); }
  }, 120_000);
});
