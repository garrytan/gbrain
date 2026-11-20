/**
 * A brain whose engine keeps no core-edit notices (the Rust engine) refuses listPendingCoreNotices by name, and the
 * three callers say the pending remote edits are unknown instead of reporting none.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the session-start core block carries one "unknown" line in place of the notices; `gbrain core status`
 *    sets `pending_notices: null` with `pending_notices_unknown` (and prints a notices line); doctor `core_memory`
 *    warns that remote edits are unknown and sets the same two details. Any other read error is reported the
 *    same way with its own code; only a brain from before the notices table reads no notices.
 *  - Regression: pendingCoreNotices caught every error and returned [], so a Rust brain (or a failed read) printed
 *    no notice, status listed zero pending edits and doctor passed: an empty read standing in for a read that never ran.
 *  - Why existing coverage misses it: test/core-memory.test.ts runs on PGLite, which never refuses, and
 *    test/engine-parity/core-notices.test.ts pins the member's refusal, not its callers.
 *  - Seam: a PGLite engine whose listPendingCoreNotices refuses as the Rust engine does (capabilityMissing).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { loadCoreBlock, pendingCoreNotices, readPendingCoreNotices } from '../src/core/core-memory.ts';
import { coreMemoryCheck } from '../src/commands/doctor/checks/core-memory.ts';
import { runCore } from '../src/commands/core.ts';

let engine: PGLiteEngine;
/** A second brain whose notices table is dropped, as on a brain from before the table. */
let old: PGLiteEngine;

beforeAll(async () => {
  old = new PGLiteEngine();
  await old.connect({});
  await old.initSchema();
  await old.executeRaw('DROP TABLE core_edit_notices');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('memory.core.enabled', 'true');
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Prefers tea.', timeline: '', frontmatter: { always_load: true } });
}, 60_000);
afterAll(async () => {
  if (engine) await engine.disconnect();
  if (old) await old.disconnect();
}, 60_000);

function refuse(): () => void {
  const spy = spyOn(engine, 'listPendingCoreNotices').mockImplementation(async () => { throw capabilityMissing('pages', 'listPendingCoreNotices'); });
  return () => spy.mockRestore();
}

async function captured(run: () => Promise<void>): Promise<string> {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await run();
    return log.mock.calls.map(c => String(c[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('core-edit notices refused by the engine', () => {
  test('the core block carries one unknown line naming the member, and the same revision', async () => {
    const before = await loadCoreBlock(engine, { excludePrivate: true });
    const restore = refuse();
    try {
      const block = await loadCoreBlock(engine, { excludePrivate: true });
      expect(block.revision).toBe(before.revision);
      expect(block.text).toContain('Remote edits to core pages are unknown on this brain: ');
      expect(block.text).toContain('listPendingCoreNotices');
      expect(before.text).not.toContain('Remote edits to core pages are unknown');
    } finally {
      restore();
    }
  });

  test('gbrain core status --json reports pending_notices null with the refusal', async () => {
    const restore = refuse();
    try {
      const status = JSON.parse(await captured(() => runCore(engine, ['status', '--json'])));
      expect(status.pending_notices).toBeNull();
      expect(status.pending_notices_unknown).toMatchObject({ code: 'engine_capability_missing' });
      expect(String(status.pending_notices_unknown.message)).toContain('listPendingCoreNotices');
      const text = await captured(() => runCore(engine, ['status']));
      expect(text).toContain('  notices: Remote edits to core pages are unknown on this brain: ');
    } finally {
      restore();
    }
  });

  test('doctor core_memory warns that remote edits are unknown', async () => {
    const restore = refuse();
    try {
      const check = await coreMemoryCheck(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('remote edits to core pages are unknown on this brain (');
      expect(check.details).toMatchObject({ pending_notices: null, pending_notices_unknown: { code: 'engine_capability_missing' } });
    } finally {
      restore();
    }
    const ok = await coreMemoryCheck(engine);
    expect(ok.details).toMatchObject({ pending_notices: 0 });
    expect((ok.details as Record<string, unknown>).pending_notices_unknown).toBeUndefined();
  });

  test('a plain read error is not "no notices": pendingCoreNotices throws it and every caller reports it as unknown', async () => {
    const spy = spyOn(engine, 'listPendingCoreNotices').mockImplementation(async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); });
    try {
      const err = await pendingCoreNotices(engine).then(() => null, (e: unknown) => e) as Error | null;
      expect(err?.message).toBe('connection reset');
      expect(await readPendingCoreNotices(engine)).toEqual({ notices: [], unknown: { code: 'ECONNRESET', message: 'connection reset' } });
      const block = await loadCoreBlock(engine, { excludePrivate: true });
      expect(block.text).toContain('Prefers tea.');
      expect(block.text).toContain('Remote edits to core pages are unknown on this brain: connection reset');
      const status = JSON.parse(await captured(() => runCore(engine, ['status', '--json'])));
      expect(status.pending_notices).toBeNull();
      expect(status.pending_notices_unknown).toEqual({ code: 'ECONNRESET', message: 'connection reset' });
      const check = await coreMemoryCheck(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('remote edits to core pages are unknown on this brain (connection reset)');
      expect(check.details).toMatchObject({ pending_notices: null, pending_notices_unknown: { code: 'ECONNRESET' } });
    } finally {
      spy.mockRestore();
    }
    const codeless = spyOn(engine, 'listPendingCoreNotices').mockImplementation(async () => { throw new Error('boom'); });
    try {
      expect((await readPendingCoreNotices(engine)).unknown).toEqual({ code: 'read_failed', message: 'boom' });
    } finally {
      codeless.mockRestore();
    }
    const restore = refuse();
    try {
      const err = await pendingCoreNotices(engine).then(() => null, (e: unknown) => e) as { code?: string } | null;
      expect(err?.code).toBe('engine_capability_missing');
    } finally {
      restore();
    }
  });

  test('a brain from before the notices table reads no notices, and a different missing table still throws', async () => {
    expect(await pendingCoreNotices(old)).toEqual([]);
    expect(await readPendingCoreNotices(old)).toEqual({ notices: [], unknown: null });
    const spy = spyOn(engine, 'listPendingCoreNotices').mockImplementation(async () => { throw Object.assign(new Error('relation "pages" does not exist'), { code: '42P01' }); });
    try {
      await expect(pendingCoreNotices(engine)).rejects.toThrow('relation "pages" does not exist');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
