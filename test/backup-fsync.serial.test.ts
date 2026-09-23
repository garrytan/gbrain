import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';

for (const platform of ['linux', 'win32'] as const) {
  test(`backup file durability preserves fsync while directory opens follow the ${platform} guard`, () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-fsync-'));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const open = fs.openSync;
    const fsync = fs.fsyncSync;
    let directoryOpens = 0;
    let fileSyncs = 0;
    let directorySyncs = 0;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) directorySyncs++;
      else fileSyncs++;
      fsync(fd);
    });
    const opened = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (fs.existsSync(path) && fs.statSync(path).isDirectory()) {
        directoryOpens++;
        if (platform === 'win32') throw Object.assign(new Error('Windows directory open refused'), { code: 'EPERM' });
      }
      return open(path, flags, mode);
    });
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const input = join(tmp, 'memory.md');
      privateWrite(input, '# Durable fixture\n');
      const archive = join(tmp, 'fixture.gbrain-backup');
      writeBackupArchive(archive, {}, [{ path: 'memory.md', file: input }]);
      const into = join(tmp, 'restored');
      fs.mkdirSync(into);
      readBackupArchive(archive, into);
      expect(fs.readFileSync(join(into, 'memory.md'), 'utf8')).toBe('# Durable fixture\n');
      expect(fileSyncs).toBe(3);
      expect(directoryOpens).toBe(2);
      expect(directorySyncs).toBe(platform === 'win32' ? 0 : 2);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      opened.mockRestore(); sync.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('regular file fsync failures remain fatal on the Windows guard path', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-fsync-failure-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('file fsync failed'); });
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    expect(() => privateWrite(join(tmp, 'receipt.json'), '{}')).toThrow('file fsync failed');
    expect(fs.existsSync(join(tmp, 'receipt.json'))).toBe(false);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    sync.mockRestore(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unexpected directory I/O errors remain fatal even on Windows', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-directory-failure-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = fs.openSync;
  const opened = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (fs.existsSync(path) && fs.statSync(path).isDirectory()) throw Object.assign(new Error('directory I/O failed'), { code: 'EIO' });
    return open(path, flags, mode);
  });
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    expect(() => privateWrite(join(tmp, 'fixture'), 'fixture')).toThrow('directory I/O failed');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    opened.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
