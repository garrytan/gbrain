/**
 * The end-of-run schema warning in `runImport` (commands/import.ts) used one `executeRaw` count statement, which refused a
 * cancelled request. It reads `getStats` now, whose statements an engine sends without a request check, so a request cancelled
 * after the pages were written would still run the count: the warning is best effort and is skipped for a cancelled request.
 *
 * Protects: an import whose request is cancelled after the last page is written sends no `getStats` and prints no warning,
 * and an uncancelled import still reads the stats once.
 * Fails when the warning reads `getStats` for a cancelled request.
 * Hermetic PGLite in-memory; GBRAIN_HOME is a temp directory.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runImport } from '../src/commands/import.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

/** The engine with `getStats` counted; `cancelAfterWrite` aborts the request once the page transaction returns (the last step before the warning). */
function spied(cancelAfterWrite: AbortController | null) {
  const calls = { getStats: 0 };
  const view = new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'getStats') return (...args: unknown[]) => { calls.getStats++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
    if (key === 'transaction' && cancelAfterWrite) return async (...args: unknown[]) => { const out = await (value as (...a: unknown[]) => unknown).apply(target, args); if (!cancelAfterWrite.signal.aborted) cancelAfterWrite.abort(new Error('client went away')); return out; };
    return value.bind(target);
  } }) as unknown as BrainEngine;
  return { calls, view };
}

let page = 0;
function importDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-warning-abort-'));
  writeFileSync(join(dir, 'a.md'), `---\ntype: note\n---\n# A${++page}\n\nbody ${page}\n`);
  return dir;
}

test('an import cancelled after its last page does not read getStats for the schema warning', async () => {
  const controller = new AbortController();
  const { calls, view } = spied(controller);
  await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, () =>
    withRequestSignal(controller.signal, () => runImport(view, [importDir(), '--no-embed', '--json'])));
  expect(controller.signal.aborted).toBe(true);
  expect(calls.getStats).toBe(0);
});

test('an uncancelled import still reads getStats once for the schema warning', async () => {
  const { calls, view } = spied(null);
  await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, () =>
    runImport(view, [importDir(), '--no-embed', '--json']));
  expect(calls.getStats).toBe(1);
});
