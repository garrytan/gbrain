import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeExportPublisher, type NativeExportPublisher } from '../src/core/persistence/native-lock.ts';

const roots: string[] = [];
const handles: Array<{ publisher: NativeExportPublisher; handle: object }> = [];
const incomplete = 'GBRAIN EXPORT INCOMPLETE\n';
const marker = '.gbrain-export-status';
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-export-native-')));
  roots.push(root);
  return root;
}
async function begin(root: string) {
  const publisher = await nativeExportPublisher();
  const handle = publisher.beginExport(root);
  handles.push({ publisher, handle });
  return { publisher, handle };
}
afterEach(() => {
  for (const { publisher, handle } of handles.splice(0)) publisher.closeExport(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native export publication', () => {
  test('creates nested destinations, publishes exact binary bytes, completes and closes twice', async () => {
    const root = join(temporary(), 'new', 'export ünicode');
    const { publisher, handle } = await begin(root);
    expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
    const bytes = Buffer.from([0, 1, 255, 10, 0, 13]);
    publisher.publishExportFile(handle, 'nested/ü.txt', bytes);
    publisher.publishExportFile(handle, 'empty', Buffer.alloc(0));
    expect(readFileSync(join(root, 'nested/ü.txt'))).toEqual(bytes);
    expect(readdirSync(join(root, 'nested'))).toEqual(['ü.txt']);
    publisher.completeExport(handle);
    expect(readFileSync(join(root, marker), 'utf8')).toBe(`${incomplete}COMPLETE\n`);
    expect(() => publisher.publishExportFile(handle, 'later', bytes)).toThrow();
    publisher.closeExport(handle);
    publisher.closeExport(handle);
    expect(() => publisher.completeExport(handle)).toThrow();
  });

  test('reserves the marker exclusively and retains evidence after close', async () => {
    const root = temporary();
    const { publisher, handle } = await begin(root);
    expect(() => publisher.beginExport(root)).toThrow();
    publisher.closeExport(handle);
    expect(() => publisher.beginExport(root)).toThrow();
    expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
  });

  test('never modifies a preexisting marker or a non-directory destination prefix', async () => {
    const root = temporary();
    const publisher = await nativeExportPublisher();
    writeFileSync(join(root, marker), 'operator-owned bytes');
    expect(() => publisher.beginExport(root)).toThrow();
    expect(readFileSync(join(root, marker), 'utf8')).toBe('operator-owned bytes');
    writeFileSync(join(root, 'file'), 'keep');
    expect(() => publisher.beginExport(join(root, 'file', 'child'))).toThrow();
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
  });

  test.skipIf(process.platform === 'win32').each(['destination', 'ancestor', 'marker'])('refuses once-only %s replacement before publication', async kind => {
    const base = temporary();
    const root = join(base, 'parent', 'export');
    const { publisher, handle } = await begin(root);
    publisher.publishExportFile(handle, 'first', Buffer.from('first bytes'));
    let retainedRoot = root;
    let retainedMarker = join(root, marker);
    if (kind === 'marker') {
      retainedMarker = join(root, 'old-marker');
      renameSync(join(root, marker), retainedMarker);
      writeFileSync(join(root, marker), 'replacement marker');
    } else {
      const replaced = kind === 'ancestor' ? join(base, 'parent') : root;
      renameSync(replaced, `${replaced}-old`);
      mkdirSync(root, { recursive: true });
      retainedRoot = kind === 'ancestor' ? join(base, 'parent-old', 'export') : `${root}-old`;
      retainedMarker = join(retainedRoot, marker);
    }
    expect(() => publisher.publishExportFile(handle, 'second', Buffer.from('second bytes'))).toThrow();
    expect(() => publisher.completeExport(handle)).toThrow();
    expect(readFileSync(retainedMarker, 'utf8')).toBe(incomplete);
    expect(existsSync(join(retainedRoot, 'second'))).toBe(false);
    expect(existsSync(join(root, 'second'))).toBe(false);
    if (kind === 'marker') expect(readFileSync(join(root, marker), 'utf8')).toBe('replacement marker');
    else expect(readdirSync(root)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32').each(['destination', 'ancestor', 'marker'])('refuses once-only %s replacement immediately before completion', async kind => {
    const base = temporary();
    const root = join(base, 'parent', 'export');
    const { publisher, handle } = await begin(root);
    publisher.publishExportFile(handle, 'first', Buffer.from('first bytes'));
    let retainedMarker: string;
    if (kind === 'marker') {
      retainedMarker = join(root, 'old-marker');
      renameSync(join(root, marker), retainedMarker);
      writeFileSync(join(root, marker), 'replacement marker');
    } else {
      const replaced = kind === 'ancestor' ? join(base, 'parent') : root;
      renameSync(replaced, `${replaced}-old`);
      mkdirSync(root, { recursive: true });
      retainedMarker = join(kind === 'ancestor' ? join(base, 'parent-old', 'export') : `${root}-old`, marker);
    }
    expect(() => publisher.completeExport(handle)).toThrow();
    expect(readFileSync(retainedMarker, 'utf8')).toBe(incomplete);
    if (kind === 'marker') expect(readFileSync(join(root, marker), 'utf8')).toBe('replacement marker');
    else expect(readdirSync(root)).toEqual([]);
    expect(() => publisher.publishExportFile(handle, 'second', Buffer.from('no'))).toThrow();
  });

  test.each(['file', 'directory', 'hardlink'])('never replaces an existing %s', async kind => {
    const root = temporary();
    const leaf = join(root, 'occupied');
    if (kind === 'directory') mkdirSync(leaf);
    else {
      writeFileSync(join(root, 'original'), 'original bytes');
      if (kind === 'hardlink') linkSync(join(root, 'original'), leaf);
      else writeFileSync(leaf, 'original bytes');
    }
    const { publisher, handle } = await begin(root);
    expect(() => publisher.publishExportFile(handle, 'occupied', Buffer.from('replacement'))).toThrow();
    expect(() => publisher.completeExport(handle)).toThrow();
    if (kind !== 'directory') expect(readFileSync(leaf, 'utf8')).toBe('original bytes');
    else expect(readdirSync(leaf)).toEqual([]);
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
  });

  test.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\\b', 'a:b', 'trailing.', 'trailing ', 'NUL', 'COM1.txt', 'LPT²', 'bad\0name', '.gbrain-export-status'])('rejects invalid path %j and poisons completion', async path => {
    const root = temporary();
    const { publisher, handle } = await begin(root);
    expect(() => publisher.publishExportFile(handle, path, Buffer.from('no'))).toThrow();
    expect(() => publisher.completeExport(handle)).toThrow();
    expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
  });

  test('rejects a nonbuffer without permitting completion', async () => {
    const { publisher, handle } = await begin(temporary());
    expect(() => publisher.publishExportFile(handle, 'file', 'text' as unknown as Buffer)).toThrow();
    expect(() => publisher.completeExport(handle)).toThrow();
  });

  test('incomplete publication arguments poison an identifiable handle', async () => {
    const { publisher, handle } = await begin(temporary());
    expect(() => Reflect.apply(publisher.publishExportFile, publisher, [handle, 'file'])).toThrow();
    expect(() => publisher.completeExport(handle)).toThrow();
  });

  test('refuses filesystem case aliases when the filesystem aliases them', async () => {
    const root = temporary();
    writeFileSync(join(root, 'Taken'), 'existing');
    if (!existsSync(join(root, 'taken'))) return;
    const { publisher, handle } = await begin(root);
    expect(() => publisher.publishExportFile(handle, 'taken', Buffer.from('replacement'))).toThrow();
    expect(readFileSync(join(root, 'Taken'), 'utf8')).toBe('existing');
    expect(() => publisher.completeExport(handle)).toThrow();
  });

  test('rejects foreign objects and keeps export handles separate from lock handles', async () => {
    const { publisher, handle } = await begin(temporary());
    const addon = publisher as NativeExportPublisher & { openLock(path: string): object; close(handle: object): void };
    const lock = addon.openLock(join(temporary(), 'writer.lock'));
    try {
      expect(() => publisher.closeExport({})).toThrow();
      expect(() => publisher.closeExport(lock)).toThrow();
      expect(() => addon.close(handle)).toThrow();
      publisher.completeExport(handle);
    } finally { addon.close(lock); }
  });

  test.each(['destination', 'parent', 'leaf', 'marker'])('refuses a symlink/reparse %s without touching its target', async kind => {
    const root = temporary();
    const outside = temporary();
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    const publisher = await nativeExportPublisher();
    if (kind === 'destination') {
      symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => publisher.beginExport(join(root, 'alias', 'child'))).toThrow();
    } else if (kind === 'marker') {
      symlinkSync(outside, join(root, marker), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => publisher.beginExport(root)).toThrow();
    } else {
      const { handle } = await begin(root);
      symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => publisher.publishExportFile(handle, kind === 'parent' ? 'alias/sentinel' : 'alias', Buffer.from('no'))).toThrow();
      expect(() => publisher.completeExport(handle)).toThrow();
    }
    expect(readdirSync(outside)).toEqual(['sentinel']);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('retains incomplete evidence on a real permission failure', async () => {
    const root = temporary();
    const { publisher, handle } = await begin(root);
    mkdirSync(join(root, 'readonly'));
    chmodSync(join(root, 'readonly'), 0o500);
    try {
      expect(() => publisher.publishExportFile(handle, 'readonly/file', Buffer.from('no'))).toThrow();
      expect(() => publisher.completeExport(handle)).toThrow();
      expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
    } finally { chmodSync(join(root, 'readonly'), 0o700); }
  });

  test('competing processes have exactly one marker owner and process exit retains evidence', async () => {
    const root = temporary();
    const fixture = resolve(import.meta.dir, 'fixtures/native-export-process.ts');
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '--no-env-file', fixture, root], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
    }));
    const exits = await Promise.all(children.map(child => child.exited));
    expect(exits.filter(code => code === 0)).toHaveLength(1);
    expect(exits.filter(code => code === 2)).toHaveLength(3);
    expect(readFileSync(join(root, marker), 'utf8')).toBe(incomplete);
  });
});
