import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runReindexSearchVector } from '../src/commands/reindex-search-vector.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

interface MockState {
  calls: string[];
  rowsToReturn: { pages: number; chunks: number };
  /** In-memory config table (marker + checkpoints). Separate from `calls`
   *  so the executeRaw call-count assertions stay intact. */
  config?: Map<string, string>;
  /** Interleaved timeline of executeRaw SQL + `set:<key>` / `unset:<key>`. */
  order?: string[];
  /** Throw from executeRaw on the first SQL matching this pattern. */
  failOn?: RegExp;
}

function makeMockEngine(state: MockState): BrainEngine {
  const config = state.config ?? (state.config = new Map());
  const order = state.order ?? (state.order = []);
  return {
    executeRaw: async (sql: string) => {
      state.calls.push(sql);
      order.push(sql);
      if (state.failOn && state.failOn.test(sql)) throw new Error(`injected failure: ${state.failOn}`);
      // Inventory query — return the configured counts
      if (sql.includes('SELECT') && sql.includes('FROM pages WHERE search_vector')) {
        return [{ pages: state.rowsToReturn.pages, chunks: state.rowsToReturn.chunks }];
      }
      return [];
    },
    getConfig: async (key: string) => config.get(key) ?? null,
    setConfig: async (key: string, value: string) => {
      order.push(`set:${key}`);
      config.set(key, value);
    },
    unsetConfig: async (key: string) => {
      order.push(`unset:${key}`);
      return config.delete(key) ? 1 : 0;
    },
  } as unknown as BrainEngine;
}

const MARKER = 'fts.reindex_in_progress';
const CHUNKS_CKPT = 'backfill.fts_content_chunks.last_id';

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

describe('runReindexSearchVector', () => {
  test('--dry-run does not issue any DDL or backfill SQL', async () => {
    const state: MockState = { calls: [], rowsToReturn: { pages: 100, chunks: 500 } };
    const engine = makeMockEngine(state);

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    const result = await runReindexSearchVector(engine, { dryRun: true, json: true });

    expect(result.status).toBe('dry_run');
    expect(result.language).toBe('pt_br');
    expect(result.pagesUpdated).toBe(100);
    expect(result.chunksUpdated).toBe(500);
    expect(result.triggersRecreated).toBe(0);

    // Only the inventory query — no CREATE OR REPLACE, no UPDATE.
    expect(state.calls.length).toBe(1);
    expect(state.calls[0]).toContain('SELECT');
    expect(state.calls[0]).not.toContain('CREATE OR REPLACE');
    expect(state.calls[0]).not.toContain('UPDATE');
  });

  test('--yes recreates triggers + backfills with configured language', async () => {
    const state: MockState = { calls: [], rowsToReturn: { pages: 50, chunks: 200 } };
    const engine = makeMockEngine(state);

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    const result = await runReindexSearchVector(engine, { yes: true, json: true });

    expect(result.status).toBe('ok');
    expect(result.language).toBe('pt_br');
    expect(result.triggersRecreated).toBe(2);
    expect(result.pagesUpdated).toBe(50);
    expect(result.chunksUpdated).toBe(200);

    // 1 inventory + 2 CREATE + 2 backfill batches (mock returns no rows, so
    // the keyset loop terminates after the first batch per table) = 5 calls
    expect(state.calls.length).toBe(5);
    expect(state.calls[1]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(state.calls[1]).toContain("to_tsvector('pt_br'");
    expect(state.calls[2]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(state.calls[2]).toContain("to_tsvector('pt_br'");
    expect(state.calls[3]).toMatch(/UPDATE pages/);
    expect(state.calls[4]).toMatch(/UPDATE content_chunks/);
    expect(state.calls[4]).toContain("to_tsvector('pt_br'");
    // v120/#1647 hardening must survive the CREATE OR REPLACE (which resets
    // proconfig): both recreated bodies pin search_path.
    expect(state.calls[1]).toContain('SET search_path = pg_catalog, public');
    expect(state.calls[2]).toContain('SET search_path = pg_catalog, public');
  });

  test('default english language still recreates + backfills (no shortcut here)', async () => {
    // Note: unlike the configurable_fts_language migration, the CLI command
    // intentionally backfills even for english. The user explicitly asked for
    // it, so we honor it. The migration skips backfill for english because it
    // auto-runs on first apply.
    const state: MockState = { calls: [], rowsToReturn: { pages: 10, chunks: 30 } };
    const engine = makeMockEngine(state);

    const result = await runReindexSearchVector(engine, { yes: true, json: true });

    expect(result.status).toBe('ok');
    expect(result.language).toBe('english');
    expect(state.calls.length).toBe(5);

    // Trigger recreates (calls 1, 2) and chunks backfill (call 4) embed the
    // language literal. Pages backfill (call 3) is UPDATE-to-self that
    // re-fires the trigger, so the language literal lives in the trigger
    // function body — not in the UPDATE statement.
    expect(state.calls[1]).toContain("'english'");
    expect(state.calls[2]).toContain("'english'");
    expect(state.calls[3]).toMatch(/UPDATE pages/);
    expect(state.calls[4]).toContain("'english'");
  });

  test('SQL injection attempt falls back to english', async () => {
    const state: MockState = { calls: [], rowsToReturn: { pages: 10, chunks: 30 } };
    const engine = makeMockEngine(state);

    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    resetFtsLanguageCache();

    const result = await runReindexSearchVector(engine, { yes: true, json: true });

    expect(result.language).toBe('english');
    for (const sql of state.calls) {
      expect(sql).not.toContain('DROP TABLE');
    }
  });

  test('empty inventory still completes successfully', async () => {
    const state: MockState = { calls: [], rowsToReturn: { pages: 0, chunks: 0 } };
    const engine = makeMockEngine(state);

    const result = await runReindexSearchVector(engine, { yes: true, json: true });

    expect(result.status).toBe('ok');
    expect(result.pagesUpdated).toBe(0);
    expect(result.chunksUpdated).toBe(0);
    expect(result.triggersRecreated).toBe(2);
  });

  test('result includes durationMs', async () => {
    const state: MockState = { calls: [], rowsToReturn: { pages: 1, chunks: 1 } };
    const engine = makeMockEngine(state);

    const result = await runReindexSearchVector(engine, { yes: true, json: true });

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // #4795 — an interrupted run commits the trigger-language flip but leaves
  // rows un-backfilled. The in-progress marker + persisted checkpoint make
  // that state visible (doctor) and resumable (re-run).
  describe('interrupted-run marker + checkpoint (#4795)', () => {
    test('backfill failure leaves the in-progress marker set', async () => {
      const state: MockState = {
        calls: [], rowsToReturn: { pages: 10, chunks: 30 }, failOn: /UPDATE content_chunks/,
      };
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await expect(runReindexSearchVector(engine, { yes: true, json: true })).rejects.toThrow();
      expect(state.config!.get(MARKER)).toBe('pt_br');
    });

    test('a failure on the first DDL clears the marker — nothing landed, so doctor must not flag an incomplete reindex', async () => {
      // A missing CREATE FUNCTION privilege fails here, before either trigger
      // flipped. Leaving the marker set would be a permanent false
      // fts_reindex_incomplete whose suggested fix (re-run) fails the same way.
      const state: MockState = {
        calls: [], rowsToReturn: { pages: 10, chunks: 30 }, failOn: /update_page_search_vector/,
      };
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await expect(runReindexSearchVector(engine, { yes: true, json: true })).rejects.toThrow();
      expect(state.config!.has(MARKER)).toBe(false);
    });

    test('a failure on the first DDL restores a PRE-EXISTING marker — a previously split index must stay visible to doctor', async () => {
      // A prior run already flipped triggers and was interrupted (marker set).
      // This resume fails before any DDL lands, so the index is still split
      // exactly as before: the marker must survive with its prior value.
      for (const prior of ['pt_br', 'english']) {
        const state: MockState = {
          calls: [], rowsToReturn: { pages: 10, chunks: 30 }, failOn: /update_page_search_vector/,
          config: new Map([[MARKER, prior]]),
        };
        const engine = makeMockEngine(state);
        process.env[ENV_KEY] = 'pt_br';
        resetFtsLanguageCache();

        await expect(runReindexSearchVector(engine, { yes: true, json: true })).rejects.toThrow();
        expect(state.config!.get(MARKER)).toBe(prior);
      }
    });

    test('a failure on the second DDL keeps the marker — the pages trigger already flipped', async () => {
      const state: MockState = {
        calls: [], rowsToReturn: { pages: 10, chunks: 30 }, failOn: /update_chunk_search_vector/,
      };
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await expect(runReindexSearchVector(engine, { yes: true, json: true })).rejects.toThrow();
      expect(state.config!.get(MARKER)).toBe('pt_br');
    });

    test('the marker key is registered so `gbrain config` treats the escape hatch as a known key', () => {
      expect(KNOWN_CONFIG_KEYS).toContain(MARKER);
    });

    test('successful run sets the marker before the first CREATE OR REPLACE and clears all state at the end', async () => {
      const state: MockState = { calls: [], rowsToReturn: { pages: 10, chunks: 30 } };
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await runReindexSearchVector(engine, { yes: true, json: true });

      const order = state.order!;
      const markerAt = order.indexOf(`set:${MARKER}`);
      const firstDdlAt = order.findIndex(s => s.includes('CREATE OR REPLACE FUNCTION'));
      expect(markerAt).toBeGreaterThanOrEqual(0);
      expect(firstDdlAt).toBeGreaterThan(markerAt);
      // Marker + both checkpoints gone once both backfills return.
      expect([...state.config!.keys()]).toEqual([]);
      // The existing executeRaw shape is untouched (config goes through
      // get/set/unsetConfig, not executeRaw).
      expect(state.calls.length).toBe(5);
    });

    test('resumes the chunks backfill from the persisted checkpoint when the marker matches the language', async () => {
      const state: MockState = { calls: [], rowsToReturn: { pages: 10, chunks: 30 } };
      state.config = new Map([[MARKER, 'pt_br'], [CHUNKS_CKPT, '10000']]);
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await runReindexSearchVector(engine, { yes: true, json: true });

      const chunksUpdate = state.calls.find(s => /UPDATE content_chunks/.test(s));
      expect(chunksUpdate).toContain('id > 10000');
    });

    // Regression guard for the reset branch (passes on the unpatched tree,
    // which always emits `id > 0`; not part of the fails-on-master proof).
    test('a different target language discards the stale checkpoint', async () => {
      const state: MockState = { calls: [], rowsToReturn: { pages: 10, chunks: 30 } };
      state.config = new Map([[MARKER, 'english'], [CHUNKS_CKPT, '10000']]);
      const engine = makeMockEngine(state);
      process.env[ENV_KEY] = 'pt_br';
      resetFtsLanguageCache();

      await runReindexSearchVector(engine, { yes: true, json: true });

      const chunksUpdate = state.calls.find(s => /UPDATE content_chunks/.test(s));
      expect(chunksUpdate).toContain('id > 0');
      expect(state.config!.has(CHUNKS_CKPT)).toBe(false);
    });
  });
});
