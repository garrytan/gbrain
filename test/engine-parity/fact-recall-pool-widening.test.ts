/**
 * BrainEngine parity — the fact recall pool members (listNearestFacts, listSlotRows, listPoolUnbackedKeys,
 * listCallOffCueFacts, listPoolEntityPairs) under a world-only scope, for restricted callers whose world-only list is
 * widened by their own member page or a private-facts grant, and for a plain world-only reader.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member reads exactly poolWhere (engine-sql/facts-trust.ts) for every caller: a plain world-only
 *    reader sees world facts only and never a fact held on a private page (with excludePrivate) or another member's
 *    page; a member sees its own member-page fact; a grant reaches the private facts of its source whose pages are open.
 *    The answers are byte-identical on PGLite, Postgres and Rust.
 *  - Regression: before the merge of main 8d2e667543 the Rust store members refused a widened world-only pool
 *    ('visibility widened by member pages or grants'); they now send the widening (store-members/fact-codec.ts poolArgs).
 *    A widening the store applied too broadly would show a private-page fact to a world-only reader.
 *  - Why existing coverage misses it: fact-pool-widening.test.ts covers listFactsForRelevance and
 *    countUncomparableFacts only; the recall-member cases in facts-rest-sites.test.ts read as the no-caller record.
 *  - Seam: none. Real engines, typed methods only (putPage, insertFacts, the five members) under withCallerAccess.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { basisEmbedding, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { ALICE_PAGE, BOB_PAGE, CALLERS } from './fact-widening-fixture.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CONVERSATION = 'cli:extract-conversation-facts:chat';
const page = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: title, timeline: '', frontmatter });

/** One fact per visibility rule. Each fact has its own entity (no page), so every member's answer names the facts it saw. */
const ROWS: Array<{ name: string; visibility: 'world' | 'private'; holding: string; source?: string }> = [
  { name: 'world-open', visibility: 'world', holding: 'notes/open' },
  { name: 'world-on-private-page', visibility: 'world', holding: 'notes/private' },
  { name: 'world-on-readers-page', visibility: 'world', holding: 'notes/readers' },
  { name: 'own-member', visibility: 'private', holding: ALICE_PAGE },
  { name: 'other-member', visibility: 'private', holding: BOB_PAGE },
  { name: 'granted-open', visibility: 'private', holding: 'notes/open' },
  { name: 'granted-fence', visibility: 'private', holding: 'notes/open', source: 'fence' },
  { name: 'private-on-private-page', visibility: 'private', holding: 'notes/private' },
];

async function seed(engine: BrainEngine) {
  await engine.putPage('notes/open', page('Open'));
  await engine.putPage('notes/private', page('Private', { visibility: 'private' }));
  await engine.putPage('notes/readers', page('Readers', { readable_by: ['member:alice-example'] }));
  await engine.putPage(ALICE_PAGE, page('alice-example', { readable_by: ['member:alice-example'] }));
  await engine.putPage(BOB_PAGE, page('bob-example', { readable_by: ['member:bob-example'] }));
  await engine.insertFacts(ROWS.map((r, i) => ({
    fact: `${r.name} trip was called off`, kind: 'fact', entity_slug: `people/${r.name}`, visibility: r.visibility,
    source: r.source ?? CONVERSATION, source_session: 'session-recall-widening', source_markdown_slug: r.holding, row_num: i + 1,
    dimension: 'location', value: `city-${r.name}`, valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
    embedding: basisEmbedding(0), embedding_model: 'm1',
  })) as never, { source_id: SRC });
}

const entityName = (slug: string | null) => (slug ?? '').replace(/^people\//, '');

/** What each recall member shows each caller, for one world-only scope. */
async function recallByCaller(engine: BrainEngine, excludePrivate: boolean) {
  const scope = { sourceIds: [SRC], worldOnly: true, excludePrivate } as never;
  const column = (await engine.readFactsEmbeddingColumn())!;
  const vector = { literal: `[${Array.from(basisEmbedding(0)).join(',')}]`, type: (column.type === 'halfvec' ? 'halfvec' : 'vector') as 'halfvec' | 'vector', model: 'm1', dims: 1536 };
  const keys = ROWS.map(r => `people/${r.name}`);
  const out: Record<string, Record<string, string[]>> = {};
  for (const [name, caller] of Object.entries(CALLERS)) {
    out[name] = await withCallerAccess(caller, async () => ({
      nearest: sorted((await engine.listNearestFacts({ scope, vector, declared: column.dims > 0, limit: 50 })).map(r => entityName(r.entity_slug))),
      slots: sorted((await engine.listSlotRows(scope, keys.map(k => ({ source_id: SRC, entity_slug: k, dimension: 'location' })))).map(r => entityName(r.entity_slug))),
      unbacked: sorted((await engine.listPoolUnbackedKeys(scope, keys, 50)).map(r => entityName(r.entity_slug))),
      cues: sorted((await engine.listCallOffCueFacts(scope, keys.map(k => ({ source_id: SRC, entity_slug: k })))).map(r => entityName(r.entity_slug))),
      pairs: sorted((await engine.listPoolEntityPairs(scope, {})).map(r => entityName(r.entity_slug))),
    }));
  }
  return out;
}

/** The facts each caller sees through every member: a conversation fact is never a grant's (a grant reaches page-extracted facts), so slots differ. */
function expected(base: readonly string[]) {
  const all = (extra: string[]) => sorted([...base, ...extra]);
  const same = (names: string[], slots = names) => ({ nearest: names, slots, unbacked: names, cues: names, pairs: names });
  return {
    plain: same(all([])),
    alice: same(all(['own-member'])),
    granted: same(all(['granted-fence']), all([])),
    grantedOther: same(all([])),
    aliceGranted: same(all(['granted-fence', 'own-member']), all(['own-member'])),
  };
}

describe('engine parity: the fact recall pool members under a widened world-only scope', () => {
  parityTest('a world-only recall pool shows each caller its world facts, its own member fact and its granted page-extracted fact, and no other private fact',
    { methods: ['putPage', 'insertFacts', 'readFactsEmbeddingColumn', 'listNearestFacts', 'listSlotRows', 'listPoolUnbackedKeys',
  'listCallOffCueFacts', 'listPoolEntityPairs'] }, async (engine: BrainEngine) => {
      await seed(engine);
      const out = await recallByCaller(engine, false);
      // Without excludePrivate (a local reader) a world fact on a private or readers page stays in: the page gate is excludePrivate's.
      expect(out).toEqual(expected(['world-on-private-page', 'world-on-readers-page', 'world-open']));
      return out;
    });

  parityTest('with excludePrivate a world-only recall pool never shows a fact held on a private page, a readers page or another member\'s page',
    { methods: ['putPage', 'insertFacts', 'readFactsEmbeddingColumn', 'listNearestFacts', 'listSlotRows', 'listPoolUnbackedKeys',
  'listCallOffCueFacts', 'listPoolEntityPairs'] }, async (engine: BrainEngine) => {
      await seed(engine);
      const out = await recallByCaller(engine, true);
      expect(out).toEqual(expected(['world-open']));
      return out;
    });
});
