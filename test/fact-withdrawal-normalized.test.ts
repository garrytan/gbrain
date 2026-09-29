/**
 * Write-path audit B-9: a forgotten claim must stay forgotten when extraction
 * re-emits it from unchanged prose with different punctuation, casing or
 * spacing. Fingerprints fold those differences (migration v174); ledger rows
 * recorded with the older exact fingerprint keep matching. Real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recordFactWithdrawal, isFactWithdrawn } from '../src/core/facts/withdrawal.ts';
import { FACT_WITHDRAWAL_NORMALIZED_SQL, normalizeLoweredClaim } from '../src/core/facts/withdrawal-schema.ts';
import { renderFactsTable, parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({
  rowNum: i + 1, claim, visibility: 'world' as const, kind: 'fact' as const, confidence: 1, notability: 'medium' as const, active: true,
})));
const expired = async (id: number) => (await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [id]))[0].expired;
const source = async (id: string) => { await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]); return id; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('punctuation, casing and spacing variants re-extracted after forget stay withdrawn; other claims do not', async () => {
  const sourceId = await source('normalized-reextract');
  const original = await engine.insertFact({ fact: 'Used to live in Tokyo', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  expect((await recordFactWithdrawal(engine, original.id, sourceId)).withdrawn).toBe(true);
  for (const variant of ['used to live in Tokyo.', '  USED to live — in "Tokyo"!! ', 'Used to live in Tokyo…']) {
    const reextracted = await engine.insertFact({ fact: variant, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    expect(await expired(reextracted.id)).toBe(true);
    expect(await isFactWithdrawn(engine, sourceId, 'world', variant, null)).toBe(true);
  }
  const other = await engine.insertFact({ fact: 'Used to live in Kyoto', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  expect(await expired(other.id)).toBe(false);
});

test('symbols that carry meaning in names keep their claims distinct; sentence punctuation still folds', async () => {
  const sourceId = await source('normalized-symbols');
  const insert = (fact: string) => engine.insertFact({ fact, visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  const knowsC = await insert('Knows C');
  const kept = await Promise.all(['Knows C++', 'Knows C#', 'Knows F#', 'Uses .NET', 'Uses Node.js', 'Rated 3.5 stars'].map(insert));
  for (const fact of ['Knows F', 'Uses NET', 'Uses Nodejs', 'Rated 35 stars']) expect((await recordFactWithdrawal(engine, (await insert(fact)).id, sourceId)).withdrawn).toBe(true);
  expect((await recordFactWithdrawal(engine, knowsC.id, sourceId)).withdrawn).toBe(true);
  for (const fact of kept) expect(await expired(fact.id)).toBe(false);
  for (const claim of ['Knows C++', 'Knows C#', 'Uses .NET', 'Uses Node.js']) expect(await isFactWithdrawn(engine, sourceId, 'world', claim, null)).toBe(false);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'knows c.', null)).toBe(true);

  const email = await insert('Prefers email.');
  expect((await recordFactWithdrawal(engine, email.id, sourceId)).withdrawn).toBe(true);
  expect(await expired((await insert('prefers email')).id)).toBe(true);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'Prefers   Email...', null)).toBe(true);
});

test('the JS overlay normalization matches the database for every folding rule', async () => {
  const claims = ['knows c++.', 'knows c#!', 'uses .net.', 'uses node.js, daily', 'prefers email...', 'e.g. this', 'a . b', '"quoted" — dash…', 'rated 3.5 stars.', 'tokyo 東京。'];
  const rows = await engine.executeRaw<{ claim: string; norm: string }>(`SELECT c AS claim,gbrain_fact_normalize(c) AS norm
    FROM unnest($1::text[]) c`, [claims]);
  expect(rows.map(row => normalizeLoweredClaim(row.claim))).toEqual(rows.map(row => row.norm));
});

test('discovery and the snapshot overlay strike a punctuation variant fence row', async () => {
  const sourceId = await source('normalized-overlay');
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: fence('Used to live in Tokyo.', 'Prefers email') }, { sourceId });
  const fact = await engine.insertFact({ fact: 'used to live in tokyo', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  expect((await recordFactWithdrawal(engine, fact.id, sourceId)).pages.map(page => page.slug)).toEqual(['people/alice-example']);
  const snapshot = (await engine.readPageSnapshot('people/alice-example', { sourceId }))!;
  expect(parseFactsFence(snapshot.page.compiled_truth).facts.map(f => [f.claim, f.forgotten ?? false]))
    .toEqual([['Used to live in Tokyo.', true], ['Prefers email', false]]);
});

test('exact legacy ledger rows keep matching and v174 adds folded rows wherever the claim text survives', async () => {
  const sourceId = await source('normalized-legacy');
  const kept = await engine.insertFact({ fact: 'Legacy claim, here.', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  await engine.executeRaw('UPDATE facts SET expired_at=now() WHERE id=$1', [kept.id]);
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
    VALUES ($1,'world',gbrain_fact_fingerprint_v1('Legacy claim, here.')),($1,'world',gbrain_fact_fingerprint_v1('Orphan legacy claim.'))`, [sourceId]);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'legacy claim,   HERE.', null)).toBe(true);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'Orphan legacy claim.', null)).toBe(true);
  const variant = await engine.insertFact({ fact: 'Legacy claim here', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
  expect(await expired(variant.id)).toBe(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec(FACT_WITHDRAWAL_NORMALIZED_SQL);
  expect(await expired(variant.id)).toBe(true);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'legacy claim here!', null)).toBe(true);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'Orphan legacy claim.', null)).toBe(true);
  expect(await isFactWithdrawn(engine, sourceId, 'world', 'orphan legacy claim', null)).toBe(false);
  expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals WHERE source_id=$1', [sourceId]))[0].n).toBe(3);
});

test('the claim fingerprint lookup is indexed', async () => {
  expect(await engine.executeRaw(`SELECT indexname FROM pg_indexes WHERE indexname='idx_facts_withdrawal_fingerprint'`))
    .toEqual([{ indexname: 'idx_facts_withdrawal_fingerprint' }]);
});
