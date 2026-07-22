/**
 * FileWatcherSource tests — uses the _watchFactory test seam so we can
 * exercise the source lifecycle without spinning up real chokidar in
 * a tmp dir (timing-dependent, flaky).
 *
 * The stub chokidar is an EventEmitter that satisfies the FSWatcher
 * surface the source actually touches (.on / .once / .close / .getWatched).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFileWatcherSource } from '../../../src/core/ingestion/sources/file-watcher.ts';
import { IngestionTestHarness } from '../../../src/core/ingestion/test-harness.ts';
import type { FSWatcher } from 'chokidar';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-fw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a stub FSWatcher we can drive from tests.
 *
 * Tracks `readyFired` state so that if a test calls `fireReady()` before
 * the source has registered its `.once('ready', ...)` listener (race —
 * source awaits mkdir/stat before listener registration), the listener
 * still fires once registered. Same for error replay. Real chokidar
 * doesn't have this race because its own async init buys userland time
 * to attach listeners; the stub has to simulate it. */
function makeStubWatcher(): {
  watcher: FSWatcher;
  fireAdd: (path: string) => void;
  fireChange: (path: string) => void;
  fireReady: () => void;
  fireError: (err: Error) => void;
  closed: { current: boolean };
} {
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
    off(event: string, handler: (...args: unknown[]) => void) {
      emitter.off(event, handler);
      return stub;
    },
    close: async () => {
      closed.current = true;
      emitter.removeAllListeners();
    },
    getWatched: () => ({ '/': ['watched'] }),
    add: () => {},
    unwatch: () => {},
  } as unknown as FSWatcher;
  return {
    watcher: stub,
    fireAdd: (p: string) => emitter.emit('add', p),
    fireChange: (p: string) => emitter.emit('change', p),
    fireReady: () => { state.readyFired = true; emitter.emit('ready'); },
    fireError: (err: Error) => {
      state.errorFired = err;
      // EventEmitter throws on emit('error', ...) when no listeners. Guard.
      if (emitter.listenerCount('error') > 0) emitter.emit('error', err);
    },
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

describe('FileWatcherSource — startup', () => {
  test('requires brainDir', () => {
    expect(() => createFileWatcherSource({ brainDir: '' as never })).toThrow(/brainDir is required/);
  });

  test('rejects when brainDir does not exist', async () => {
    const source = createFileWatcherSource({ brainDir: '/does/not/exist/xyz' });
    const harness = new IngestionTestHarness();
    await expect(harness.run(source)).rejects.toThrow(/does not exist/);
  });

  test('rejects when brainDir is a file, not a directory', async () => {
    const f = path.join(tmpRoot, 'not-a-dir.md');
    fs.writeFileSync(f, 'x');
    const source = createFileWatcherSource({ brainDir: f });
    const harness = new IngestionTestHarness();
    await expect(harness.run(source)).rejects.toThrow(/does not exist or is not a directory/);
  });

  test('resolves start() on chokidar ready', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;
    await harness.stop();
  });

  test('rejects start() on early chokidar error', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    // Race: error first.
    stub.fireError(new Error('chokidar boom'));
    await expect(startPromise).rejects.toThrow(/chokidar boom/);
  });

  test('chokidar close() is called on stop()', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;
    await harness.stop();
    expect(stub.closed.current).toBe(true);
  });
});

describe('FileWatcherSource — event flow', () => {
  test('add event for .md file emits IngestionEvent after debounce', async () => {
    const stub = makeStubWatcher();
    const f = path.join(tmpRoot, 'note.md');
    fs.writeFileSync(f, '# Hello');
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      debounceMs: 50,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    stub.fireAdd(f);
    await waitFor(() => harness.events.length === 1, 1000);
    expect(harness.events[0]?.source_kind).toBe('file-watcher');
    expect(harness.events[0]?.source_uri).toBe(f);
    expect(harness.events[0]?.content_type).toBe('text/markdown');
    expect(harness.events[0]?.content).toBe('# Hello');
    await harness.stop();
  });

  test('non-markdown file does NOT emit', async () => {
    const stub = makeStubWatcher();
    const f = path.join(tmpRoot, 'note.txt');
    fs.writeFileSync(f, 'plain');
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    stub.fireAdd(f);
    await new Promise((r) => setTimeout(r, 100)); // past debounce
    expect(harness.events).toHaveLength(0);
    await harness.stop();
  });

  test('rapid changes coalesce into one event (debounce)', async () => {
    const stub = makeStubWatcher();
    const f = path.join(tmpRoot, 'spam.md');
    fs.writeFileSync(f, '# first');
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      debounceMs: 50,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    // 5 rapid change events on the same path.
    for (let i = 0; i < 5; i++) {
      stub.fireChange(f);
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => harness.events.length === 1, 500);
    expect(harness.events).toHaveLength(1);
    await harness.stop();
  });

  test('read failure between debounce and flush logs warn, no emit', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      debounceMs: 30,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    // File never existed.
    stub.fireAdd(path.join(tmpRoot, 'ghost.md'));
    await new Promise((r) => setTimeout(r, 150));
    expect(harness.events).toHaveLength(0);
    expect(harness.logs.some((l) => l.level === 'warn' && l.msg.includes('failed to read'))).toBe(true);
    await harness.stop();
  });
});

describe('FileWatcherSource — Linux ENOSPC handling', () => {
  test('ENOSPC error surfaces a paste-ready sysctl hint', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
      _watchFactory: () => stub.watcher,
    });
    const harness = new IngestionTestHarness();
    const startPromise = harness.run(source);
    stub.fireReady();
    await startPromise;

    stub.fireError(new Error('ENOSPC: System limit for number of file watchers reached'));
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.logs.some((l) => l.level === 'warn' && l.msg.includes('ENOSPC'))).toBe(true);
    expect(harness.logs.some((l) => l.level === 'error' && l.msg.includes('fs.inotify.max_user_watches'))).toBe(true);
    await harness.stop();
  });
});

describe('FileWatcherSource — healthCheck', () => {
  test('returns ok when watcher is alive with watched dirs', async () => {
    const stub = makeStubWatcher();
    const source = createFileWatcherSource({
      brainDir: tmpRoot,
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
