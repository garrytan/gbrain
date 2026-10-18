/**
 * #6724: `context_pack` adds `entity_facts[]`, the packed entities' own
 * facts, beside `facts[]` (the session's hot memory, unchanged).
 *
 * Protects: a pack for X on a brain whose newest facts are about Y carries X's
 * facts, attributed to the card's (source_id, slug), with confidence,
 * attribution, provenance and trust kept; `facts[]` stays exactly the hot
 * memory a v1 consumer read before; a fact in both arrays is rendered once in
 * `text` and priced once under `budget_tokens`; a tiny budget still fits;
 * remote callers never get a private fact; a federated card's facts come from
 * its own source. Regression: the pack's only fact arm was source-wide hot
 * memory, so the packed entities' facts were often absent (#6724).
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { estimateTokens } from '../src/core/search/token-budget.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

let engine: PGLiteEngine;
const noop = { info() {}, warn() {}, error() {} };
const ctx = (remote: boolean, grant?: string[]) => ({ engine, config: { engine: 'pglite' }, logger: noop, dryRun: false, remote, sourceId: 'default',
  takesHoldersAllowList: ['world'], ...(grant ? { auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: grant } } : {}) }) as unknown as OperationContext;
const pack = async (c: OperationContext, p: Record<string, unknown>) => { __resetHotMemoryCacheForTests(); return await operationsByName.context_pack!.handler(c, p) as any; };

async function person(source: string, slug: string, title: string) {
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, $2, 'person', $3, $4, '')`, [slug, source, title, `${title} page.`]);
}
async function fact(source: string, entity: string, text: string, o: { visibility?: 'world' | 'private'; daysAgo?: number; attributed?: 'assistant' } = {}): Promise<number> {
  const { id } = await engine.insertFact({ fact: text, kind: 'fact', entity_slug: entity, visibility: o.visibility ?? 'world', source: `provenance:${text.slice(0, 12)}`, confidence: 0.9 } as never, { source_id: source });
  const at = new Date(Date.now() - (o.daysAgo ?? 0) * 86_400_000).toISOString();
  await engine.executeRaw('UPDATE facts SET created_at = $1::timestamptz, valid_from = $1::timestamptz WHERE id = $2', [at, id]);
  if (o.attributed) await engine.executeRaw('UPDATE facts SET attributed_to = $1 WHERE id = $2', [o.attributed, id]);
  return id;
}

let aliceOld: number, aliceRecent: number, alicePrivate: number;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('wiki', 'wiki', '{}') ON CONFLICT (id) DO NOTHING`);
  await person('default', 'people/alice-example', 'Alice Example');
  await person('default', 'people/bob-example', 'Bob Example');
  await person('wiki', 'people/zoe-example', 'Zoe Example');
  aliceOld = await fact('default', 'people/alice-example', 'Alice Example chairs the ALICE-OLD-SENTINEL review board.', { daysAgo: 40, attributed: 'assistant' });
  alicePrivate = await fact('default', 'people/alice-example', 'Alice Example ALICE-PRIVATE-SENTINEL salary detail.', { visibility: 'private', daysAgo: 30 });
  for (let i = 0; i < 30; i++) await fact('default', 'people/bob-example', `Bob Example BOB-HOT-${i} update.`, { daysAgo: 0 });
  aliceRecent = await fact('default', 'people/alice-example', 'Alice Example ALICE-RECENT-SENTINEL moved to Lisbon.', { daysAgo: 0 });
  await fact('wiki', 'people/zoe-example', 'Zoe Example ZOE-WIKI-SENTINEL leads the wiki.', { daysAgo: 5 });
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('#6724 context_pack entity_facts', () => {
  test("a pack for Alice carries Alice's own facts, attributed and labeled, beside unchanged hot memory", async () => {
    const res = await pack(ctx(true), { entities: 'Alice Example' });
    const old = res.entity_facts?.find((f: any) => f.fact_id === String(aliceOld));
    expect(old).toMatchObject({ source_id: 'default', slug: 'people/alice-example', entity_slug: 'people/alice-example', confidence: 0.9,
      attributed_to: 'assistant', provenance: expect.stringContaining('provenance:') });
    expect(res.facts.some((f: any) => f.fact_id === String(aliceOld))).toBe(false);
    const legacy = await pack(ctx(true), { entities: 'Bob Example' });
    expect(res.facts.map((f: any) => f.fact_id)).toEqual(legacy.facts.map((f: any) => f.fact_id));
    expect(res.text).toContain('## Entity facts');
    expect(res.text).toMatch(/\(assistant said\) .*Alice Example chairs the ALICE-OLD-SENTINEL/);
    expect(res.text.indexOf('ALICE-OLD-SENTINEL')).toBeLessThan(res.text.indexOf('## Hot memory'));
  });

  test('a fact in both arrays appears in both structured arrays and once in text', async () => {
    const res = await pack(ctx(true), { entities: 'Alice Example' });
    expect(res.entity_facts.some((f: any) => f.fact_id === String(aliceRecent))).toBe(true);
    expect(res.facts.some((f: any) => f.fact_id === String(aliceRecent))).toBe(true);
    expect(res.text.split('ALICE-RECENT-SENTINEL').length - 1).toBe(1);
  });

  test('remote callers never get a private entity fact; a trusted include_private pack does', async () => {
    expect(JSON.stringify(await pack(ctx(true), { entities: 'Alice Example' }))).not.toContain('ALICE-PRIVATE-SENTINEL');
    const local = await pack(ctx(false), { entities: 'Alice Example', include_private: true });
    expect(local.entity_facts.some((f: any) => f.fact_id === String(alicePrivate))).toBe(true);
  });

  test('budgets: a tiny budget fits, and a mid budget prices a shared fact once', async () => {
    const tiny = await pack(ctx(true), { entities: 'Alice Example', budget_tokens: 5 });
    expect(tiny.entity_facts ?? []).toEqual([]);
    for (const budget of [120, 200, 400]) {
      const res = await pack(ctx(true), { entities: 'Alice Example', budget_tokens: budget });
      expect(estimateTokens(res.text)).toBeLessThanOrEqual(budget);
      expect(res.text.split('ALICE-RECENT-SENTINEL').length - 1).toBeLessThanOrEqual(1);
    }
    for (let budget = 100; budget <= 260; budget += 8) {
      const res = await pack(ctx(true), { entities: 'Alice Example', budget_tokens: budget });
      const ids = (a: any[]) => a.map((f: any) => f.fact_id);
      if (ids(res.entity_facts).includes(String(aliceRecent)) && res.facts.length) expect(ids(res.facts)).toContain(String(aliceRecent));
      if (ids(res.entity_facts).length === 2) expect(ids(res.facts)).toContain(String(aliceRecent));
    }
    const mid = await pack(ctx(true), { entities: 'Alice Example', budget_tokens: 400 });
    expect(mid.entity_facts.map((f: any) => f.fact_id)).toContain(String(aliceRecent));
    expect(mid.text).toContain('ALICE-RECENT-SENTINEL');
  });

  test("a federated card's facts come from its own source", async () => {
    const res = await pack(ctx(true, ['default', 'wiki']), { entities: 'Zoe Example' });
    expect(res.entity_facts.map((f: any) => [f.source_id, f.slug])).toEqual([['wiki', 'people/zoe-example']]);
    expect(res.entity_facts[0].fact).toContain('ZOE-WIKI-SENTINEL');
  });
});
