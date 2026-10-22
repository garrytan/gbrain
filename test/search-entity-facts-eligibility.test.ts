/**
 * The saved facts search and query return for an entity the query names
 * (search/entity-facts.ts) follow the same row eligibility as every other fact
 * read arm: a fact whose source page is quarantined, or one a purge marked
 * for re-derivation, is not returned; its unaffected sibling still is.
 * Trusted and remote readers. PGLite-only; fixture text is invented.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

const SLUG = 'companies/zzq-widgets';
const JUNK = 'notes/zzq-junk-import';
const QUARANTINED = 'Invented: Zzq Widgets moved its depot to Ventura.';
const REDERIVE = 'Invented: Zzq Widgets pays suppliers in 90 days.';
const OPEN = 'Invented: Zzq Widgets renewal is on Friday.';
const PROSE = 'Zzq Widgets is an invented company.';
let engine: PGLiteEngine;
let rederiveId = 0;

async function call(tool: string, params: Record<string, unknown>, remote: boolean): Promise<string> {
  const r = await dispatchToolCall(engine, tool, params, remote
    ? { remote: true, transport: 'stdio', sourceId: 'default' } : { remote: false, sourceId: 'default' });
  return r.content.map(c => c.text).join('\n');
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ['search', { query: 'Zzq Widgets renewal' }],
  ['query', { query: 'Zzq Widgets renewal', expand: false }],
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  await engine.putPage(SLUG, { type: 'company', title: 'Zzq Widgets', compiled_truth: PROSE, timeline: '', frontmatter: {} } as never, { sourceId: 'default' });
  await installFixtureChunks(engine, SLUG, [{ chunk_index: 0, chunk_text: PROSE, chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  await engine.putPage(JUNK, { type: 'note', title: 'Zzq import', compiled_truth: 'Imported text.', timeline: '', frontmatter: {} } as never, { sourceId: 'default' });
  for (const [fact, page] of [[QUARANTINED, JUNK], [REDERIVE, SLUG], [OPEN, SLUG]] as const) {
    const { id } = await engine.insertFact({ fact, kind: 'fact', entity_slug: 'zzq-widgets', source: 'test', visibility: 'world' }, { source_id: 'default' });
    await engine.executeRaw(`UPDATE facts SET source_markdown_slug = $1 WHERE id = $2`, [page, id]);
    if (fact === REDERIVE) rederiveId = Number(id);
  }
}, 120_000);

afterAll(async () => { resetGateway(); await engine.disconnect(); });

describe('entity saved facts follow fact row eligibility', () => {
  test('control: every fact about the named entity is returned', async () => {
    for (const [tool, params] of CASES) for (const remote of [false, true]) {
      const text = await call(tool, params, remote);
      for (const fact of [QUARANTINED, REDERIVE, OPEN]) expect(text).toContain(fact);
    }
  }, 120_000);

  test('a quarantined-page fact and a re-derive fact are hidden; the sibling stays', async () => {
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "junk_pattern", "detail": "test"}}'::jsonb WHERE slug = $1`, [JUNK]);
    await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason) VALUES ('facts', $1, 'default', 'test')`, [String(rederiveId)]);
    const leaks: string[] = [];
    for (const [tool, params] of CASES) for (const remote of [false, true]) {
      const text = await call(tool, params, remote);
      if (text.includes(QUARANTINED)) leaks.push(`${tool} remote=${remote} quarantined`);
      if (text.includes(REDERIVE)) leaks.push(`${tool} remote=${remote} rederive`);
      if (!text.includes(OPEN)) leaks.push(`${tool} remote=${remote} lost sibling`);
    }
    expect(leaks).toEqual([]);
  }, 120_000);
});
