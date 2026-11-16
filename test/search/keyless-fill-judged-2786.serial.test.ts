/**
 * Two faults of the System One checks around the keyless any-word fill:
 *
 * 1. A row from a source on `decide.egress.deny_sources` is never sent to the
 *    provider, yet the evidence (S3) and injection (S5) checks counted it in
 *    `judged`, and the fill kept such a row as if it had been checked. A
 *    candidate counts as judged only when the provider answered for it, and a
 *    fill row no acting check answered for is left out.
 * 2. An error after the any-word lookup (in the row stages or the checks)
 *    failed the whole request; it now returns the rows the search had without
 *    the fill and reports the keyword arm incomplete, and the search and query
 *    operations return their reference rows when the rerun with the fill fails.
 *
 * Keyless PGLite brain (no embedding key) with a fixture decide transport.
 * Serial: mutates GBRAIN_HOME and the process-global gateway.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { resetDecideSearchCache } from '../../src/core/search/decide-stage.ts';
import { chooseFill } from '../../src/core/ops/search-fill.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

const QUERY = 'SSO Starter plan';
const PAGES: Array<[string, string, string]> = [
  ['default', 'company/pricing', 'Our Starter plan costs 29 dollars a month. The Pro plan adds SSO and audit logs.'],
  ['default', 'company/decisions', 'We keep SSO on the Pro plan, not the Starter plan, because support load grows.'],
  ['default', 'company/calls/carol-example', 'carol-example asked whether SSO could come with Starter for her team.'],
  ['work', 'work/plan-review', 'The SSO rollout for the Starter plan is reviewed weekly.'],
  ['work', 'work/calls/dave-example', 'dave-example asked whether SSO could come with Starter next quarter.'],
];
const DENIED_FILL = 'work/calls/dave-example';
const ALLOWED_FILL = 'company/calls/carol-example';

let engine: PGLiteEngine;
let home: string;
let prevHome: string | undefined;
let sent: string[] = [];

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-fill-judged-2786-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('work', 'work') ON CONFLICT DO NOTHING`);
  for (const [sourceId, slug, body] of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug.split('/').pop()!, compiled_truth: body }, { sourceId });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
  }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    sent.push(...Object.values(body.questions as Record<string, { instructions: unknown }>).map(q => JSON.stringify(q.instructions)));
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id.startsWith('injection:') ? 0.05 : 0.9 }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }));
  });
  for (const [k, v] of Object.entries({
    'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
    'decide.slots.evidence.mode': 'on', 'decide.slots.evidence.threshold': '0.5', 'decide.slots.evidence.force_on': 'true', 'decide.slots.evidence.min_keep': '1',
    'decide.slots.injection.mode': 'on', 'decide.slots.injection.threshold': '0.7',
    'decide.egress.deny_sources': '["work"]',
  })) await engine.setConfig(k, v);
  resetDecideSearchCache();
}, 120_000);

afterAll(async () => {
  __setDecideTransportForTests(null as never);
  await flushDecideWrites();
  __resetDecideStoreForTests();
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function search(e: BrainEngine = engine, anyWordFill = true) {
  let meta: HybridSearchMeta | undefined;
  sent = [];
  const results = await hybridSearch(e, QUERY, { limit: 20, expansion: false, anyWordFill, onMeta: m => { meta = m; } });
  return { results, meta };
}

describe('GST-2786: rows never sent to the provider are not counted as judged', () => {
  test('a denied-source row is not sent, not counted judged, and a denied fill row is left out', async () => {
    const { results, meta } = await search();
    const slugs = results.map(r => r.slug);
    expect(sent.some(text => text.includes('dave-example') || text.includes('rollout'))).toBe(false);
    expect(slugs).toContain(ALLOWED_FILL);
    expect(results.find(r => r.slug === ALLOWED_FILL)?.keyword_fill).toBe(true);
    expect(slugs).not.toContain(DENIED_FILL);
    const answered = results.filter(r => r.source_id !== 'work').length;
    expect(meta?.decide?.evidence?.judged).toBe(answered);
    expect(meta?.decide?.injection?.judged).toBe(answered);
  });
});

describe('GST-2786: an error after the any-word lookup returns the rows without the fill', () => {
  test('a row stage that throws on a fill row keeps the page and reports the keyword arm incomplete', async () => {
    const reference = (await search(engine, false)).results;
    // A fill row whose text is not a string makes a row stage after the lookup throw (a TypeError), as any late fault would.
    const failing = new Proxy(engine, { get: (target, prop) => prop === 'searchKeyword'
      ? async (q: string, o?: { orFill?: boolean }) => {
        const rows = await target.searchKeyword(q, o as never);
        return o?.orFill ? rows.map(r => ({ ...r, chunk_text: 42 as unknown as string })) : rows;
      }
      : Reflect.get(target, prop, target) });
    const { results, meta } = await search(failing as BrainEngine);
    expect(results.map(r => r.slug)).toEqual(reference.map(r => r.slug));
    expect(meta?.degraded?.find(d => d.stage === 'keyword_candidates_incomplete')?.reason).toBe('provider_error');
  });

  test('the operations return their reference rows when the rerun with the fill fails', async () => {
    const row = (slug: string, extra: Partial<SearchResult> = {}) => ({ slug, score: 1, chunk_text: slug, ...extra }) as SearchResult;
    const reference = { results: [row('a'), row('b')] };
    const page = await chooseFill([...reference.results, row('fill', { keyword_fill: true })], reference, 10,
      async () => { throw new Error('a stage failed on the fill rows'); }, t => t.results, async rows => ({ rows }));
    expect(page).toBe(reference);
  });
});
