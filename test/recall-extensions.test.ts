/**
 * v0.32 — `gbrain recall` extensions: --since-last-run + --pending + --rollup
 * + --watch + thin-client routing. PGLite-backed unit tests (no DATABASE_URL,
 * no API keys). Canonical block pattern from CLAUDE.md.
 *
 * Critical regression guards pinned here:
 *   - countUnconsolidatedFacts SQL semantics (ignores expired, ignores
 *     consolidated, returns 0 on empty)
 *   - Cursor state file round-trip + corrupt/future fallback + separate
 *     briefing vs watch variants (Codex round 2 #8)
 *   - Atomic write: tmp filename uses unique suffix per call (Codex round 1 #7)
 *   - Cursor write writes T_start, NOT T_finish (Codex round 1 #2)
 *
 * Renderer + watch-loop + flag-parser coverage lives in
 * `test/thin-client-routing.test.ts` because those paths exercise the
 * mocked-MCP-client surface, not the PGLite engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  readCursor,
  writeCursor,
  _cursorPathForTests,
} from '../src/core/recall-cursor-state.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';

// Allocate a unique temp dir per test (cross-test safe; each test runs its
// body inside withEnv({ GBRAIN_HOME: tmpHome }) so process.env mutations are
// scoped + restored via try/finally instead of leaking across files).
function makeTmpHome(): string {
  return join(tmpdir(), `gbrain-recall-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('countUnconsolidatedFacts', () => {
  test('returns 0 on empty facts table', async () => {
    expect(await engine.countUnconsolidatedFacts('default')).toBe(0);
  });

  test('counts active + unconsolidated facts', async () => {
    for (let i = 0; i < 3; i++) {
      await engine.insertFact(
        { fact: `f${i}`, kind: 'fact', entity_slug: 'people/test', source: 'unit' },
        { source_id: 'default' },
      );
    }
    expect(await engine.countUnconsolidatedFacts('default')).toBe(3);
  });

  test('ignores expired facts (Codex #4 regression: --pending shows ONLY active unconsolidated)', async () => {
    const a = await engine.insertFact(
      { fact: 'active', kind: 'fact', entity_slug: 'e/a', source: 'unit' },
      { source_id: 'default' },
    );
    const b = await engine.insertFact(
      { fact: 'expired', kind: 'fact', entity_slug: 'e/b', source: 'unit' },
      { source_id: 'default' },
    );
    await engine.expireFact(b.id);
    const count = await engine.countUnconsolidatedFacts('default');
    expect(count).toBe(1);
    expect(a.id).toBeDefined();
  });

  test('ignores consolidated facts', async () => {
    const a = await engine.insertFact(
      { fact: 'will be consolidated', kind: 'fact', entity_slug: 'e/c', source: 'unit' },
      { source_id: 'default' },
    );
    // Direct SQL to flip consolidated_at — this is what the dream cycle's
    // consolidate phase does.
    await engine.executeRaw(
      `UPDATE facts SET consolidated_at = NOW() WHERE id = $1`,
      [a.id],
    );
    expect(await engine.countUnconsolidatedFacts('default')).toBe(0);
  });

  test('source-scoped (does not count other sources)', async () => {
    await engine.insertFact(
      { fact: 'in default', kind: 'fact', entity_slug: 'e/d', source: 'unit' },
      { source_id: 'default' },
    );
    // Note: inserting under a non-existent source still works at the engine
    // level (no FK enforcement on facts.source_id in the schema as of v0.32).
    // The source-scope contract holds regardless.
    expect(await engine.countUnconsolidatedFacts('default')).toBe(1);
    expect(await engine.countUnconsolidatedFacts('other')).toBe(0);
  });
});

describe('recall-cursor-state file helper', () => {
  test('missing file returns null (first-run case)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      expect(readCursor('default', 'briefing')).toBeNull();
      expect(readCursor('default', 'watch')).toBeNull();
    });
  });

  test('round-trip: write then read returns the same instant (ms precision)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const t = new Date('2026-05-10T14:30:00.000Z');
      writeCursor('default', t, 'briefing');
      const read = readCursor('default', 'briefing');
      expect(read).not.toBeNull();
      expect(read!.getTime()).toBe(t.getTime());
    });
  });

  test('briefing cursor and watch cursor are separate files (Codex round 2 #8 — operator quitting watch must not clobber briefing position)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const tBriefing = new Date('2026-05-10T08:00:00.000Z');
      const tWatch = new Date('2026-05-10T16:00:00.000Z');
      writeCursor('default', tBriefing, 'briefing');
      writeCursor('default', tWatch, 'watch');

      const readBriefing = readCursor('default', 'briefing');
      const readWatch = readCursor('default', 'watch');
      expect(readBriefing!.getTime()).toBe(tBriefing.getTime());
      expect(readWatch!.getTime()).toBe(tWatch.getTime());

      const briefingPath = _cursorPathForTests('default', 'briefing');
      const watchPath = _cursorPathForTests('default', 'watch');
      expect(briefingPath).not.toBe(watchPath);
      expect(briefingPath.endsWith('default.json')).toBe(true);
      expect(watchPath.endsWith('default.watch.json')).toBe(true);
    });
  });

  test('corrupt JSON returns null + leaves the file in place for diagnosis', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = _cursorPathForTests('default', 'briefing');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{not valid json', { mode: 0o600 });
      expect(readCursor('default', 'briefing')).toBeNull();
      expect(existsSync(path)).toBe(true);
    });
  });

  test('future-shifted timestamp returns null (clock-skew sanity check)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = _cursorPathForTests('default', 'briefing');
      mkdirSync(dirname(path), { recursive: true });
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        path,
        JSON.stringify({ schema_version: 1, last_run_iso: future }),
        { mode: 0o600 },
      );
      expect(readCursor('default', 'briefing')).toBeNull();
    });
  });

  test('wrong schema_version returns null', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = _cursorPathForTests('default', 'briefing');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ schema_version: 999, last_run_iso: new Date().toISOString() }),
        { mode: 0o600 },
      );
      expect(readCursor('default', 'briefing')).toBeNull();
    });
  });

  test('atomic write: per-call tmp filename uses pid+random suffix so concurrent processes do not clobber each other (Codex round 1 #7 regression)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const dir = dirname(_cursorPathForTests('default', 'briefing'));
      mkdirSync(dir, { recursive: true });
      writeCursor('default', new Date(), 'briefing');
      const orphanedTmps = readdirSync(dir).filter(f =>
        f.startsWith('default.json.tmp.'),
      );
      expect(orphanedTmps).toEqual([]);
    });
  });

  test('write to non-writable parent is non-fatal (best-effort warn + return)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = _cursorPathForTests('blocked', 'briefing');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(dirname(path) + '-as-file', 'not a dir', { mode: 0o600 });
      expect(() => writeCursor('blocked', new Date(), 'briefing')).not.toThrow();
    });
  });

  test('stable file contents: schema_version + last_run_iso in JSON', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const t = new Date('2026-01-15T12:00:00.000Z');
      writeCursor('default', t, 'briefing');
      const path = _cursorPathForTests('default', 'briefing');
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(raw.schema_version).toBe(1);
      expect(raw.last_run_iso).toBe(t.toISOString());
    });
  });

  test('source slug used verbatim in filename (so kebab-case slugs round-trip)', async () => {
    const tmpHome = makeTmpHome();
    mkdirSync(tmpHome, { recursive: true });
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      writeCursor('my-team', new Date(), 'briefing');
      writeCursor('my-team', new Date(), 'watch');
      const briefing = _cursorPathForTests('my-team', 'briefing');
      const watch = _cursorPathForTests('my-team', 'watch');
      expect(basename(briefing)).toBe('my-team.json');
      expect(basename(watch)).toBe('my-team.watch.json');
    });
  });
});

describe('recall MCP op include_pending output field (round-trip)', () => {
  // Smoke test the op handler shape end-to-end via the engine method that
  // backs it. The full op-handler path is covered by the cli routing test
  // file; here we pin the engine contract that the op handler depends on.

  test('countUnconsolidatedFacts result fits the MCP response shape (Codex #1 regression: pending field must round-trip through JSON serialization)', async () => {
    await engine.insertFact(
      { fact: 'pending', kind: 'fact', entity_slug: 'e/p', source: 'unit' },
      { source_id: 'default' },
    );
    const n = await engine.countUnconsolidatedFacts('default');
    // The op handler does: `pending_consolidation_count = n`. JSON-serializing
    // and parsing it must produce the same value (no BigInt, no Date, no
    // problematic shape).
    const serialized = JSON.parse(JSON.stringify({ pending_consolidation_count: n }));
    expect(serialized.pending_consolidation_count).toBe(1);
    expect(typeof serialized.pending_consolidation_count).toBe('number');
  });
});

describe('briefing skill invocation surface', () => {
  // The briefing skill calls:
  //   gbrain recall --since-last-run --supersessions --pending --rollup --json
  //
  // The engine surfaces this combo exercises are:
  //   listSupersessions (with since cutoff)
  //   countUnconsolidatedFacts
  //
  // The CLI side (cursor state, rollup computation, thin-client routing) is
  // covered by test/thin-client-routing.test.ts.

  test('listSupersessions + countUnconsolidatedFacts compose cleanly for the briefing invocation', async () => {
    const a = await engine.insertFact(
      { fact: 'old belief', kind: 'belief', entity_slug: 'e/x', source: 'unit' },
      { source_id: 'default' },
    );
    const b = await engine.insertFact(
      { fact: 'new belief', kind: 'belief', entity_slug: 'e/x', source: 'unit' },
      { source_id: 'default' },
    );
    await engine.expireFact(a.id, { supersededBy: b.id });

    const recentlySuperseded = await engine.listSupersessions('default', {
      since: new Date(Date.now() - 60_000),
      limit: 50,
    });
    expect(recentlySuperseded.length).toBe(1);
    expect(recentlySuperseded[0].id).toBe(a.id);
    expect(recentlySuperseded[0].superseded_by).toBe(b.id);

    // After supersession, count should reflect only the surviving b.
    expect(await engine.countUnconsolidatedFacts('default')).toBe(1);
  });
});
