import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runReindexSearchVector } from '../src/commands/reindex-search-vector.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

interface MockState {
  calls: string[];
  rowsToReturn: { pages: number; chunks: number };
}

function makeMockEngine(state: MockState): BrainEngine {
  return {
    executeRaw: async (sql: string) => {
      state.calls.push(sql);
      // Inventory query — return the configured counts
      if (sql.includes('SELECT') && sql.includes('FROM pages WHERE search_vector')) {
        return [{ pages: state.rowsToReturn.pages, chunks: state.rowsToReturn.chunks }];
      }
      return [];
    },
  } as unknown as BrainEngine;
}

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

    // 1 inventory + 2 CREATE + 2 backfills = 5 calls
    expect(state.calls.length).toBe(5);
    expect(state.calls[1]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(state.calls[1]).toContain("to_tsvector('pt_br'");
    expect(state.calls[2]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(state.calls[2]).toContain("to_tsvector('pt_br'");
    expect(state.calls[3]).toMatch(/UPDATE pages/);
    expect(state.calls[4]).toMatch(/UPDATE content_chunks/);
    expect(state.calls[4]).toContain("to_tsvector('pt_br'");
  });

  test('default english language still recreates + backfills (no shortcut here)', async () => {
    // Note: unlike v33 migration, the CLI command intentionally backfills even
    // for english. The user explicitly asked for it, so we honor it. v33 skips
    // backfill for english because it auto-runs on first apply.
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
});
