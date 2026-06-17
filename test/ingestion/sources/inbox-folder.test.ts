/**
 * InboxFolderSource tests. Mix of helper-pure tests (no fs / chokidar)
 * and stubbed-chokidar lifecycle tests using tmp dirs for the archive
 * move semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createInboxFolderSource,
  __testing,
} from '../../../src/core/ingestion/sources/inbox-folder.ts';
import { IngestionTestHarness } from '../../../src/core/ingestion/test-harness.ts';
import type { FSWatcher } from 'chokidar';

let tmpRoot: string;
let inboxDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-inbox-test-'));
  inboxDir = path.join(tmpRoot, 'inbox');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Stub with deferred-ready replay (see file-watcher.test.ts for design notes). */
function makeStubWatcher() {
  const emitter = new EventEmitter();
  const closed = { current: false };
  const state = { readyFired: false, errorFired: null as Error | null };
  const stub = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'ready' && state.readyFired) {
        queueMicrotask(() => handler());
        return stub;
      }
      if (event === 'error' && state.errorFired) {
        const err = state.errorFired;
        queueMicrotask(() => handler(err));
        return stub;
      }
      emitter.on(event, handler);
      return stub;
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'ready' && state.readyFired) {
        queueMicrotask(() => handler());
        return stub;
      }
      if (event === 'error' && state.errorFired) {
        const err = state.errorFired;
        queueMicrotask(() => handler(err));
        return stub;
      }
      emitter.once(event, handler);
      return stub;
    },
    off(event: string, handler: (...args: unknown[]) => void) { emitter.off(event, handler); return stub; },
    close: async () => { closed.current = true; emitter.removeAllListeners(); },
    getWatched: () => ({ '/': ['watched'] }),
    add: () => {},
    unwatch: () => {},
  } as unknown as FSWatcher;
  return {
    watcher: stub,
    fireAdd: (p: string) => emitter.emit('add', p),
    fireReady: () => { state.readyFired = true; emitter.emit('ready'); },
    closed,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

describe('detectContentType (helper)', () => {
  test('routes markdown to text/markdown', () => {
    expect(__testing.detectContentType('foo.md')).toBe('text/markdown');
    expect(__testing.detectContentType('foo.markdown')).toBe('text/markdown');
    expect(__testing.detectContentType('FOO.MD')).toBe('text/markdown');
  });

  test('routes text to text/plain', () => {
    expect(__testing.detectContentType('note.txt')).toBe('text/plain');
  });

  test('routes html', () => {
    expect(__testing.detectContentType('page.html')).toBe('text/html');
    expect(__testing.detectContentType('page.htm')).toBe('text/html');
  });

  test('routes images to image/*', () => {
    expect(__testing.detectContentType('shot.png')).toBe('image/*');
    expect(__testing.detectContentType('photo.jpeg')).toBe('image/*');
    expect(__testing.detectContentType('anim.gif')).toBe('image/*');
  });

  test('routes audio to audio/*', () => {
    expect(__testing.detectContentType('voice.m4a')).toBe('audio/*');
    expect(__testing.detectContentType('song.mp3')).toBe('audio/*');
  });

  test('routes video to video/*', () => {
    expect(__testing.detectContentType('clip.mp4')).toBe('video/*');
    expect(__testing.detectContentType('movie.mkv')).toBe('video/*');
  });

  test('routes pdf to application/pdf', () => {
    expect(__testing.detectContentType('doc.pdf')).toBe('application/pdf');
  });

  test('routes json to application/json', () => {
    expect(__testing.detectContentType('data.json')).toBe('application/json');
  });

  test('unknown extension routes to unknown', () => {
    expect(__testing.detectContentType('foo.xyz')).toBe('unknown');
    expect(__testing.detectContentType('no-extension')).toBe('unknown');
  });
});

describe('archiveDateFolder (helper)', () => {
  test('formats UTC date as YYYY-MM-DD', () => {
    expect(__testing.archiveDateFolder(new Date('2026-05-20T12:00:00Z'))).toBe('2026-05-20');
    expect(__testing.archiveDateFolder(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});

describe('uniqueArchivePath (helper)', () => {
  test('returns the candidate when no collision', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'arch-'));
    const result = __testing.uniqueArchivePath(dir, 'note.md');
    expect(result).toBe(path.join(dir, 'note.md'));
  });

  test('suffixes with -1, -2 on collision', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'arch-'));
    fs.writeFileSync(path.join(dir, 'note.md'), '');
    fs.writeFileSync(path.join(dir, 'note-1.md'), '');
    const result = __testing.uniqueArchivePath(dir, 'note.md');
    expect(result).toBe(path.join(dir, 'note-2.md'));
  });
});

describe('InboxFolderSource — startup', () => {
  test('requires inboxDir', () => {
    expect(() => createInboxFolderSource({ inboxDir: '' as never })).toThrow(/inboxDir is required/);
  });

  test('creates inbox + archive dirs if missing', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      _watchFactory: () => stub.watcher,
    });
    expect(fs.existsSync(inboxDir)).toBe(false);
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;
    expect(fs.existsSync(inboxDir)).toBe(true);
    expect(fs.existsSync(path.join(inboxDir, '.archived'))).toBe(true);
    await harness.stop();
  });

  test('warns when inbox dir is world-writable', async () => {
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o777 });
    fs.chmodSync(inboxDir, 0o777);
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;
    expect(harness.logs.some((l) => l.level === 'warn' && l.msg.includes('world-writable'))).toBe(true);
    await harness.stop();
  });
});

describe('InboxFolderSource — file ingestion', () => {
  test('text file: read content, emit, archive', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    const f = path.join(inboxDir, 'capture.md');
    fs.writeFileSync(f, '# captured thought');
    stub.fireAdd(f);

    await waitFor(() => harness.events.length === 1, 1500);
    expect(harness.events[0]?.content_type).toBe('text/markdown');
    expect(harness.events[0]?.content).toBe('# captured thought');
    expect(harness.events[0]?.source_uri).toBe(f);
    // metadata should report it was text
    expect(harness.events[0]?.metadata?.is_text).toBe(true);

    // File should have been archived.
    await waitFor(() => !fs.existsSync(f), 1500);
    const today = __testing.archiveDateFolder(new Date());
    const archived = path.join(inboxDir, '.archived', today, 'capture.md');
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.readFileSync(archived, 'utf8')).toBe('# captured thought');
    await harness.stop();
  });

  test('binary file: path-only content, hash from path+stat', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    const f = path.join(inboxDir, 'photo.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    stub.fireAdd(f);

    await waitFor(() => harness.events.length === 1, 1500);
    expect(harness.events[0]?.content_type).toBe('image/*');
    // For binary, content is the absolute path (NOT the bytes).
    expect(harness.events[0]?.content).toBe(f);
    expect(harness.events[0]?.metadata?.is_text).toBe(false);
    await harness.stop();
  });

  test('symlink is rejected and logged', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    // Create the target outside the inbox.
    const target = path.join(tmpRoot, 'sensitive.md');
    fs.writeFileSync(target, '# secret');
    const link = path.join(inboxDir, 'evil.md');
    fs.symlinkSync(target, link);

    stub.fireAdd(link);
    await new Promise((r) => setTimeout(r, 150));
    expect(harness.events).toHaveLength(0);
    expect(harness.logs.some((l) => l.level === 'warn' && l.msg.includes('rejected symlink'))).toBe(true);
    await harness.stop();
  });

  test('events under .archived are ignored (no re-ingestion loop)', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    // Simulate chokidar accidentally firing 'add' for an archived path.
    const archivedFile = path.join(inboxDir, '.archived', '2026-05-20', 'old.md');
    fs.mkdirSync(path.dirname(archivedFile), { recursive: true });
    fs.writeFileSync(archivedFile, '# old');
    stub.fireAdd(archivedFile);

    await new Promise((r) => setTimeout(r, 150));
    expect(harness.events).toHaveLength(0);
    await harness.stop();
  });

  test('archiveAfterEmit=false leaves the file in place', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 30,
      archiveAfterEmit: false,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    const f = path.join(inboxDir, 'no-archive.md');
    fs.writeFileSync(f, '# stays');
    stub.fireAdd(f);

    await waitFor(() => harness.events.length === 1, 1500);
    expect(fs.existsSync(f)).toBe(true);
    await harness.stop();
  });

  test('rapid duplicate add events coalesce via debounce', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      debounceMs: 50,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    const f = path.join(inboxDir, 'dup.md');
    fs.writeFileSync(f, '# once');
    // Fire 5 rapid 'add' events on the same path before debounce settles.
    for (let i = 0; i < 5; i++) {
      stub.fireAdd(f);
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => harness.events.length === 1, 800);
    expect(harness.events).toHaveLength(1);
    await harness.stop();
  });

  test('healthCheck reports ok when watcher is alive', async () => {
    const stub = makeStubWatcher();
    const source = createInboxFolderSource({
      inboxDir,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;
    const h = await harness.healthCheck();
    expect(h.status).toBe('ok');
    await harness.stop();
  });
});
