/** Synthetic mounted FS only. No PGlite engine, operator home or provider. */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPgliteDump } from '../src/core/backup/archive.ts';
import { streamPgliteTar, writePgliteDump, type PgliteDumpFS } from '../src/core/backup/pglite-tar.ts';

interface File { size: number; bytes?: Buffer; directory?: boolean }
function fixture(files: Record<string, File>, options: { truncate?: boolean; mutate?: boolean } = {}) {
  const epoch = new Date('2026-01-01T00:00:00Z');
  let reads = 0, closed = 0, opened = 0, largestRead = 0;
  const key = (path: string) => path.replace('/pglite/data/', '');
  const attrs = (path: string) => {
    const file = files[key(path)]; if (!file) throw new Error('synthetic absent entry');
    return { mode: file.directory ? 0o40700 : 0o100600, size: file.size, mtime: epoch, ino: 1 };
  };
  const fs = {
    readdir(path: string) {
      const parent = path === '/pglite/data' ? '' : key(path) + '/';
      return ['.', '..', ...Object.keys(files).filter(p => p.startsWith(parent) && !p.slice(parent.length).includes('/')).map(p => p.slice(parent.length))];
    },
    lstat: attrs,
    stat(path: string) { const stat = attrs(path); return { ...stat, size: stat.size + (options.mutate ? 1 : 0) }; },
    isFile(mode: number) { return (mode & 0o170000) === 0o100000; },
    isDir(mode: number) { return (mode & 0o170000) === 0o40000; },
    open(path: string) { opened++; return { path }; },
    read(stream: { path: string }, out: Uint8Array, offset: number, length: number, position: number) {
      reads++; largestRead = Math.max(largestRead, length);
      if (options.truncate) return 0;
      const file = files[key(stream.path)];
      if (file.bytes) out.set(file.bytes.subarray(position, position + length), offset);
      return length;
    },
    close() { closed++; },
  } as unknown as PgliteDumpFS;
  return { fs, counts: () => ({ reads, closed, opened, largestRead }) };
}

test('streamed cluster restores exact payloads using the unchanged extractor and retains dump lock entries', () => {
  const work = mkdtempSync(join(tmpdir(), 'gbrain-tar-fixture-'));
  try {
    const input = fixture({ PG_VERSION: { size: 3, bytes: Buffer.from('17\n') },
      global: { size: 0, directory: true }, 'global/pg_control': { size: 5, bytes: Buffer.from([0,1,2,3,255]) },
      '.gbrain-lock': { size: 0, directory: true }, '.gbrain-lock/lock': { size: 5, bytes: Buffer.from('lease') },
      'postmaster.pid': { size: 3, bytes: Buffer.from('123') } });
    const tar = join(work, 'database.tar'); writePgliteDump(input.fs, tar);
    expect(statSync(tar).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(tar);
    expect(bytes.includes(Buffer.from('/.gbrain-lock/lock'))).toBe(true);
    expect(bytes.subarray(-1024).every(b => b === 0)).toBe(true);
    expect(parseInt(bytes.subarray(100,108).toString(),8)).toBe(0o600);
    expect(parseInt(bytes.subarray(108,116).toString(),8)).toBe(0);
    expect(parseInt(bytes.subarray(116,124).toString(),8)).toBe(0);
    expect(parseInt(bytes.subarray(136,148).toString(),8)).toBe(1767225600);
    const into = join(work,'restored'); mkdirSync(into, { mode: 0o700 }); extractPgliteDump(tar,into);
    expect(readFileSync(join(into,'PG_VERSION'))).toEqual(Buffer.from('17\n'));
    expect(readFileSync(join(into,'global/pg_control'))).toEqual(Buffer.from([0,1,2,3,255]));
    expect(existsSync(join(into,'.gbrain-lock'))).toBe(false);
    expect(existsSync(join(into,'postmaster.pid'))).toBe(false);
    expect(input.counts().opened).toBe(input.counts().closed);
    expect(() => writePgliteDump(input.fs,tar)).toThrow();
    expect(readFileSync(tar)).toEqual(bytes);
  } finally { rmSync(work,{recursive:true,force:true}); }
});

test('a virtual cluster above 4 GiB streams exact tar length with only bounded read and sink requests', () => {
  const sizes = [3*1024**3, 1536*1024**2];
  const input = fixture({ first:{size:sizes[0]},second:{size:sizes[1]} });
  let emitted=0, largestWrite=0;
  streamPgliteTar(input.fs, bytes => { emitted+=bytes.length; largestWrite=Math.max(largestWrite,bytes.length); });
  expect(emitted).toBe(sizes.reduce((n,size)=>n+512+Math.ceil(size/512)*512,1024));
  expect(emitted).toBeGreaterThan(4*1024**3);
  expect(input.counts().largestRead).toBeLessThanOrEqual(1024**2);
  expect(largestWrite).toBeLessThanOrEqual(1024**2);
  expect(input.counts().closed).toBe(2);
});

test('truncation or a changed cluster file refuses and closes the owned stream', () => {
  for (const options of [{truncate:true},{mutate:true}]) {
    const input=fixture({file:{size:32}},options); let writes=0;
    expect(()=>streamPgliteTar(input.fs,()=>{writes++;})).toThrow();
    expect(input.counts().closed).toBe(1);
    expect(writes).toBeGreaterThan(0);
  }
});

test('a downstream write failure is preserved while the owned FS stream closes', () => {
  const input=fixture({file:{size:32}});let calls=0;
  const failure=new Error('synthetic sink refused');
  expect(()=>streamPgliteTar(input.fs,()=>{if(++calls===2)throw failure;})).toThrow(failure);
  expect(calls).toBe(2);expect(input.counts().closed).toBe(1);
});
