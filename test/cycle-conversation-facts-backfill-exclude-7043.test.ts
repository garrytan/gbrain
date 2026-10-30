/**
 * #7043 (reported by @mikez93): `cycle.conversation_facts_backfill.exclude_sources`
 * names sources the backfill phase skips, so one source whose pages repeat a
 * standing prompt can be left out without turning the phase off for every
 * source. Unset (the default) skips nothing. A JSON array and a comma list
 * both work. PGLite only: the key changes which sources the phase iterates,
 * no SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConversationFactsBackfill, loadCfg } from '../src/core/cycle/conversation-facts-backfill.ts';

let engine: PGLiteEngine;
const KEY = 'cycle.conversation_facts_backfill.exclude_sources';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
  for (const id of ['source-a', 'source-b']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    await engine.putPage(`conversations/${id}-chat`, { type: 'conversation', title: `Chat in ${id}`, timeline: '', frontmatter: {},
      compiled_truth: '**Alice Example** (2024-03-15 9:00 AM): I signed the offer.\n**Bob Example** (2024-03-15 9:01 AM): Congrats!' }, { sourceId: id });
  }
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM config WHERE key = $1', [KEY]); });

describe('conversation_facts_backfill exclude_sources (#7043)', () => {
  test('unset: every source runs and nothing is reported excluded', async () => {
    expect((await loadCfg(engine)).excludeSources).toEqual([]);
    const r = await runPhaseConversationFactsBackfill(engine, { dryRun: true });
    const d = r.details as { per_source: Record<string, unknown>; sources_excluded: string[] };
    expect(Object.keys(d.per_source)).toEqual(expect.arrayContaining(['default', 'source-a', 'source-b']));
    expect(d.sources_excluded).toEqual([]);
  });

  test('a JSON array of source ids is skipped and reported', async () => {
    await engine.setConfig(KEY, '["source-b"]');
    const r = await runPhaseConversationFactsBackfill(engine, { dryRun: true });
    const d = r.details as { per_source: Record<string, unknown>; sources_excluded: string[]; sources_count: number };
    expect(Object.keys(d.per_source)).toContain('source-a');
    expect(Object.keys(d.per_source)).not.toContain('source-b');
    expect(d.sources_excluded).toEqual(['source-b']);
    expect(r.summary).toContain('exclude_sources');
  });

  test('a comma list works too, and an unknown id excludes nothing else', async () => {
    await engine.setConfig(KEY, 'source-a, source-missing');
    expect((await loadCfg(engine)).excludeSources).toEqual(['source-a', 'source-missing']);
    const r = await runPhaseConversationFactsBackfill(engine, { dryRun: true });
    const d = r.details as { per_source: Record<string, unknown>; sources_excluded: string[] };
    expect(Object.keys(d.per_source)).not.toContain('source-a');
    expect(Object.keys(d.per_source)).toContain('source-b');
    expect(d.sources_excluded).toEqual(['source-a']);
  });
});
