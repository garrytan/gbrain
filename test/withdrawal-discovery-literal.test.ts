import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { discoverWithdrawalTargets } from '../src/core/facts/withdrawal-discovery.ts';
import { renderFactsTable, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const backend of testBackends()) describe(`literal withdrawal ${backend}`, () => {
let engine: BrainEngine, close: () => Promise<void>;
const sourceId = 'literal-withdrawal-example';
const otherSource = 'literal-withdrawal-other';
const fence = (claim: string, visibility: 'world' | 'private' = 'world') => renderFactsTable([
  { rowNum: 1, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true },
]);
beforeAll(async () => {
  if (backend === 'postgres') {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = fixture.engine; close = fixture.close;
  } else {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect();
  }
  for (const id of [sourceId, otherSource]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
}, 120_000);
afterAll(() => close());

async function page(slug: string, body: string, chunk: string, source = sourceId) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' }, { sourceId: source });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: chunk, chunk_source: 'compiled_truth' }], { sourceId: source });
}
async function discover(claim: string, subject = '*', visibility = 'world') {
  const [row] = await engine.executeRaw<{ hash: string }>('SELECT gbrain_fact_fingerprint($1) AS hash', [claim]);
  return (await discoverWithdrawalTargets(engine, sourceId, [{ claim, subject, visibility, fact_hash: row.hash }])).map(p => p.slug);
}

test('literal symbols and punctuation preserve exact stale-chunk matches and exclude near matches', async () => {
  const claim = 'C++ and C# use Node.js, not C; 50% alpha_beta \\ paths.';
  await page('notes/literal', 'Original prose without derived fence', claim.toUpperCase());
  await page('notes/near', '', 'C and C use Nodejs not C 50 alpha beta paths');
  await page('notes/same-other-source', '', claim, otherSource);
  expect(await discover(claim)).toEqual(['notes/literal']);
});
test('all tokens are only a shortlist: reordered and extra-token chunks do not match', async () => {
  const claim = 'literal precision token delta';
  await page('notes/ordered', '', claim);
  await page('notes/reordered', '', 'delta token precision literal');
  await page('notes/extra', '', claim + ' unrelated');
  expect(await discover(claim)).toEqual(['notes/ordered']);
});
test('subject and visibility continue to fence page evidence', async () => {
  const claim = 'visibility sentinel precise';
  await page('notes/private', fence(claim, 'private'), 'Unrelated stale chunk');
  await page('notes/world', fence(claim), 'Unrelated stale chunk');
  expect(await discover(claim, '*', 'private')).toEqual(['notes/private']);
  expect(await discover(claim, 'notes/world')).toEqual(['notes/world']);
});
test('multiple withdrawal claims retain complete candidate union', async () => {
  const claims = ['union alpha sentinel', 'union beta sentinel'];
  for (const [n, claim] of claims.entries()) await page('notes/union-' + n, '', claim);
  const rows = [];
  for (const claim of claims) {
    const [row] = await engine.executeRaw<{ hash: string }>('SELECT gbrain_fact_fingerprint($1) AS hash', [claim]);
    rows.push({ claim, subject: '*', visibility: 'world', fact_hash: row.hash });
  }
  expect((await discoverWithdrawalTargets(engine, sourceId, rows)).map(p => p.slug)).toEqual(['notes/union-0', 'notes/union-1']);
});
test('a matching malformed fence still refuses complete discovery', async () => {
  const claim = 'ambiguous matching sentinel';
  const malformed = fence(claim).replace(FACTS_FENCE_END, '');
  expect(malformed).not.toContain(FACTS_FENCE_END);
  await page('notes/malformed', malformed, 'Unrelated stale chunk');
  await expect(discover(claim)).rejects.toMatchObject({ code: 'withdrawal_provenance' });
});
test('empty claim list remains a no-op', async () => {
  expect(await discoverWithdrawalTargets(engine, sourceId, [])).toEqual([]);
});
});
