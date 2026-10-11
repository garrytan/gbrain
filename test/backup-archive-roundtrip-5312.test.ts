/**
 * #5312 (wave 14 P4.10): the archive layer's backup → restore round trip on
 * the host it runs on, including the `windows-latest` row of test.yml.
 *
 * `writeBackupArchive` publishes with link(2) and then flushes the output's
 * PARENT DIRECTORY, the site that raised EPERM on Windows before it went
 * through `flushDirectory`'s win32 guard; `readBackupArchive` and
 * `extractPgliteDump` must give back every byte and every EMPTY directory
 * (a PGLite cluster carries ~18 of them; a file-only copy loses them and the
 * restored store fails to initialise with a message that reads like
 * corruption). The PGLite `dumpDataDir` step itself is not exercised here:
 * its Windows ENOENT (#5312, defect 2) is still open and this file makes no
 * claim about it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPgliteDump, readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';

let temporary: string;
beforeAll(() => { temporary = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5312-'))); // macOS: /var is a symlink and the archive root refuses symlinks });
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

/** One ustar entry the way PGLite's dumpDataDir writes them: /-prefixed, typeflag 0 or 5. */
function ustar(path: string, body: Buffer | null): Buffer {
  const header = Buffer.alloc(512);
  header.write(`/${path}${body === null ? '/' : ''}`, 0, 100, 'utf8');
  header.write(body === null ? '0000755\0' : '0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${(body?.length ?? 0).toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header[156] = body === null ? 53 : 48;
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  if (body === null) return header;
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

test('writeBackupArchive publishes next to its parent flush and readBackupArchive returns every byte', async () => {
  const source = join(temporary, 'source'); mkdirSync(join(source, 'memory', 'nested'), { recursive: true });
  const bytes = Buffer.from([0, 1, 2, 255, 128, 10, 13, 26]);
  writeFileSync(join(source, 'memory', 'nested', 'note.md'), '# nested\n\nbody\n');
  writeFileSync(join(source, 'memory', 'bytes.bin'), bytes);
  writeFileSync(join(source, 'empty.txt'), '');
  const output = join(temporary, 'out', 'brain.gbrain-backup'); mkdirSync(join(temporary, 'out'));
  const manifest = await writeBackupArchive(output, { kind: 'test' }, [
    { path: 'files/memory/nested/note.md', file: join(source, 'memory', 'nested', 'note.md') },
    { path: 'files/memory/bytes.bin', file: join(source, 'memory', 'bytes.bin') },
    { path: 'files/empty.txt', file: join(source, 'empty.txt') },
  ]);
  expect(manifest.entries.map(e => e.path)).toEqual(['files/memory/nested/note.md', 'files/memory/bytes.bin', 'files/empty.txt']);
  expect(readdirSync(join(temporary, 'out'))).toEqual(['brain.gbrain-backup']);
  expect(statSync(output).size).toBeGreaterThan(0);

  const restored = join(temporary, 'restored'); mkdirSync(restored);
  expect(readBackupArchive(output, restored)).toEqual(manifest);
  expect(readFileSync(join(restored, 'files', 'memory', 'nested', 'note.md'), 'utf8')).toBe('# nested\n\nbody\n');
  expect(readFileSync(join(restored, 'files', 'memory', 'bytes.bin'))).toEqual(bytes);
  expect(readFileSync(join(restored, 'files', 'empty.txt'))).toEqual(Buffer.alloc(0));
});

test('extractPgliteDump restores the cluster tree, empty directories included', () => {
  const emptyDirectories = ['pg_tblspc', 'pg_wal/archive_status', 'pg_notify', 'pg_stat_tmp', 'pg_snapshots'];
  const tar = Buffer.concat([
    ustar('PG_VERSION', Buffer.from('16\n')),
    ustar('global', null),
    ustar('global/pg_control', Buffer.alloc(8192, 7)),
    ustar('base', null),
    ustar('base/1', null),
    ustar('base/1/1234', Buffer.from('relation bytes')),
    ustar('pg_wal', null),
    ...emptyDirectories.map(d => ustar(d, null)),
    ustar('postmaster.pid', Buffer.from('-42\n/pglite/data\n')),
    Buffer.alloc(1024),
  ]);
  const file = join(temporary, 'database.tar'); writeFileSync(file, tar);
  const cluster = join(temporary, 'cluster'); mkdirSync(cluster);
  extractPgliteDump(file, cluster);
  for (const directory of emptyDirectories) expect(readdirSync(join(cluster, directory))).toEqual([]);
  expect(readFileSync(join(cluster, 'PG_VERSION'), 'utf8')).toBe('16\n');
  expect(readFileSync(join(cluster, 'global', 'pg_control'))).toEqual(Buffer.alloc(8192, 7));
  expect(readFileSync(join(cluster, 'base', '1', '1234'), 'utf8')).toBe('relation bytes');
  expect(readdirSync(cluster)).not.toContain('postmaster.pid');
});
