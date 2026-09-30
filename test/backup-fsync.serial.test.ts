import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';
import * as privacy from '../src/core/backup/private-path.ts';

for (const platform of ['linux', 'win32'] as const) {
  test(`backup file durability preserves fsync while directory opens follow the ${platform} guard`, async () => {
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
    const acl = spyOn(privacy, 'protectNewBackupPath').mockImplementation(async () => {});
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const input = join(tmp, 'memory.md');
      privateWrite(input, '# Durable fixture\n');
      const archive = join(tmp, 'fixture.gbrain-backup');
      await writeBackupArchive(archive, {}, [{ path: 'memory.md', file: input }]);
      const into = join(tmp, 'restored');
      fs.mkdirSync(into);
      readBackupArchive(archive, into);
      expect(fs.readFileSync(join(into, 'memory.md'), 'utf8')).toBe('# Durable fixture\n');
      expect(fileSyncs).toBe(3);
      expect(directoryOpens).toBe(2);
      expect(directorySyncs).toBe(platform === 'win32' ? 0 : 2);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      opened.mockRestore(); sync.mockRestore(); acl.mockRestore();
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

for (const outcome of ['protected', 'refused'] as const) test(`archive waits for asynchronous privacy ${outcome} before writing or publishing`, async () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-backup-await-'));
  const input = join(tmp, 'input');
  const output = join(tmp, 'archive');
  fs.writeFileSync(input, 'original payload');
  let release!: () => void;
  let deny!: (error: Error) => void;
  let partial = '';
  let settled = false;
  const error = new Error('asynchronous privacy refused');
  const fault = spyOn(privacy, 'protectNewBackupPath').mockImplementation((path, kind) => {
    expect(kind).toBe('file');
    partial = path;
    return new Promise<void>((resolve, reject) => { release = resolve; deny = reject; });
  });
  try {
    const pending = writeBackupArchive(output, {}, [{ path: 'memory', file: input }]);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(partial.startsWith(output + '.partial-')).toBe(true);
    expect(fs.readFileSync(partial)).toEqual(Buffer.alloc(0));
    expect(fs.existsSync(output)).toBe(false);
    if (outcome === 'refused') {
      deny(error);
      await expect(pending).rejects.toBe(error);
      expect(fs.existsSync(output)).toBe(false);
    } else {
      release();
      expect((await pending).entries).toHaveLength(1);
      const into = join(tmp, 'restored');
      fs.mkdirSync(into);
      readBackupArchive(output, into);
      expect(fs.readFileSync(join(into, 'memory'), 'utf8')).toBe('original payload');
    }
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.readFileSync(input, 'utf8')).toBe('original payload');
  } finally {
    release?.();
    fault.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const mode of ['success', 'nonzero', 'unexpected-output', 'stdout-limit', 'stderr-limit', 'timeout', 'input-error', 'input-throw', 'changed-content', 'replaced-path'] as const) {
  test(`Windows privacy async subprocess ${mode} preserves its bounded fail-closed contract`, async () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-privacy-process-'));
    const path = join(tmp, 'empty');
    fs.writeFileSync(path, '');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const execute = childProcess.execFile;
    let child: childProcess.ChildProcess | undefined;
    let calls = 0;
    let processError: Error | null = null;
    let callback = false;
    const probe = `import * as fs from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
  const mode = ${JSON.stringify(mode)};
  if (mode === 'timeout' || mode.startsWith('input-')) { setInterval(() => {}, 100); return; }
  if (mode === 'nonzero') { process.exitCode = 7; return; }
  if (mode === 'stdout-limit' || mode === 'stderr-limit') { process[mode === 'stdout-limit' ? 'stdout' : 'stderr'].write('x'.repeat(65537)); return; }
  if (mode === 'changed-content') fs.writeFileSync(process.env.GBRAIN_BACKUP_PRIVATE_PATH, 'unexpected');
  if (mode === 'replaced-path') { fs.renameSync(process.env.GBRAIN_BACKUP_PRIVATE_PATH, process.env.GBRAIN_BACKUP_PRIVATE_PATH + '.old'); fs.writeFileSync(process.env.GBRAIN_BACKUP_PRIVATE_PATH, ''); }
  process.stdout.write(mode === 'unexpected-output' ? 'not-private' : 'private');
});`;
    const launch = spyOn(childProcess, 'execFile').mockImplementation(new Proxy(execute, {
      apply(target, thisArg, args) {
        const options = args[2] as childProcess.ExecFileOptionsWithStringEncoding;
        if (options?.env?.GBRAIN_BACKUP_PRIVATE_PATH !== path) return Reflect.apply(target, thisArg, args);
        calls++;
        expect(args[0]).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
        expect(args[1].slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
        expect(options).toMatchObject({ encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
        expect(options.shell).toBeUndefined();
        const done = args[3];
        child = Reflect.apply(target, thisArg, [process.execPath, ['--no-env-file', '--eval', probe], options,
          (error: Error | null, stdout: string, stderr: string) => { callback = true; processError = error; done(error, stdout, stderr); }]);
        if (mode === 'input-error' || mode === 'input-throw') {
          child!.stdin!.end = (() => {
            if (mode === 'input-throw') throw new Error('injected input close error');
            child!.stdin!.emit('error', new Error('injected input stream error'));
            return child!.stdin;
          }) as NonNullable<childProcess.ChildProcess['stdin']>['end'];
        }
        return child;
      },
    }));
    const started = performance.now();
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      const pending = privacy.protectNewBackupPath(path, 'file');
      expect(callback).toBe(false);
      if (mode === 'success') await pending;
      else await expect(pending).rejects.toMatchObject({ code: 'private_backup_path_unavailable' });
      expect(calls).toBe(1);
      expect(callback).toBe(true);
      expect(child).toBeDefined();
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      if (mode === 'success') expect(child!.exitCode).toBe(0);
      if (mode === 'nonzero') expect(child!.exitCode).toBe(7);
      if (!mode.startsWith('input-')) expect(child?.stdin?.writableEnded).toBe(true);
      if (mode === 'timeout') {
        expect(performance.now() - started).toBeGreaterThanOrEqual(14_000);
        expect(performance.now() - started).toBeLessThan(19_000);
        expect(child?.killed).toBe(true);
        expect(processError).not.toBeNull();
      }
      if (mode.endsWith('-limit')) {
        expect(processError).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      }
      if (mode !== 'changed-content') expect(fs.readFileSync(path)).toEqual(Buffer.alloc(0));
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      launch.mockRestore();
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child!.once('close', () => resolve()));
        child.kill('SIGKILL');
        await closed;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 25_000);
}
