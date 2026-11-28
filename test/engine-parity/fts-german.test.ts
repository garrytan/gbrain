/**
 * BrainEngine parity — the query-time full-text readers under the `german` text search configuration
 * (GBRAIN_FTS_LANGUAGE=german).
 *  - What: matchSavedFacts, matchHeadStems, wordLexemes, findCandidateDuplicates (keyword arm) and
 *    listFactsForRelevance (keyword arm) parse their text at query time, so under `german` each stems with
 *    the German Snowball dictionary and drops German stopwords, on every engine. A configuration the Rust store
 *    has no Snowball port for (`french`) stops on the Rust arm with a typed refusal naming it; the SQL engines
 *    answer.
 *  - Regression: an engine that stems German text with the English dictionary (or answers none) misses `Haus` for
 *    `Häuser`, keeps `und` as a lexeme, and so changes what a German brain recalls.
 *  - Why existing coverage misses it: every other parity case runs under the default `english` configuration.
 *  - Fixture words: PGLite (Snowball 3.0) and Postgres 16 (an older Snowball) stem German differently for the
 *    feminine endings (`Lehrerin`: `lehr` on PGLite, `lehrerin` on Postgres 16) and for `-et` after some
 *    consonants (`Widget`: `widg` vs `widget`). The words here stem alike on both, so all three arms agree; the
 *    difference itself is a named known difference (docs/designs/RUST_ENGINE.md), and the Rust engine follows
 *    PGLite.
 *  - The page keyword members (searchKeyword and its siblings) read the keyword index, whose postings the Rust
 *    store builds with the English stemmer: under `german` they stay a named Rust stop, not covered here.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import { matchingSavedFacts } from '../../src/core/search/saved-facts-match.ts';
import { isEngineCapabilityRefusal } from '../../src/core/engine-capability-refusal.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const local = (engine: BrainEngine) => ({ engine, remote: false, sourceId: SRC, emitResponseMeta: () => {} }) as unknown as OperationContext;

/** Runs `fn` under the text search configuration `config`, with the cached language reset around it. */
async function under<T>(config: string, fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_FTS_LANGUAGE: config }, async () => {
    resetFtsLanguageCache();
    try { return await fn(); } finally { resetFtsLanguageCache(); }
  });
}

async function remember(engine: BrainEngine, entity: string | null, facts: string[]): Promise<void> {
  let day = 1;
  for (const fact of facts) {
    await engine.insertFact({ fact, source: 'mcp:remember', entity_slug: entity, valid_from: new Date(Date.UTC(2026, 4, day++)) }, { source_id: SRC });
  }
}

describe('engine parity: the query-time full-text readers under the german configuration', () => {
  parityTest('matchSavedFacts stems German: Haus finds Häuser, Stadt finds Städte, on every engine', {
    methods: ['insertFact', 'matchSavedFacts'],
  }, (engine) => under('german', async () => {
    await remember(engine, null, ['Die Häuser der Städte kosten 50000', 'Der Umsatz des Quartals ist gestiegen', 'Kinder spielen draußen']);
    const out = await matchingSavedFacts(local(engine), { sourceId: SRC }, 'Haus Stadt kosten');
    const facts = out.facts.map(f => f.fact);
    expect(facts).toEqual(['Die Häuser der Städte kosten 50000']);
    return facts;
  }));

  parityTest('matchHeadStems and wordLexemes stem with the German dictionary and drop German stopwords', {
    methods: ['matchHeadStems', 'wordLexemes'],
  }, (engine) => under('german', async () => {
    const heads = await engine.matchHeadStems(['Haus', 'Straßen', 'Kinder', 'Quartal'], ['Häuser', 'Strasse', 'und', 'Kind']);
    const words = ['Häuser', 'und', 'Umsatzes', 'Entwicklungen', 'Freundschaft', '2026-01-02', 'Straße'];
    const lexemes = await engine.wordLexemes(words);
    const out = { heads: heads.map(h => [h.h, h.i]), lexemes: words.map(w => `${w}=>${(lexemes.get(w) ?? []).join('|')}`) };
    expect(out.heads).toEqual([['Haus', [1]], ['Straßen', [2]], ['Kinder', [4]], ['Quartal', []]]);
    expect(lexemes.get('Häuser')).toEqual(['haus']);
    expect(lexemes.get('und')).toEqual([]);
    return out;
  }));

  parityTest('findCandidateDuplicates and listFactsForRelevance (keyword arms) match German claims by stem', {
    methods: ['insertFact', 'findCandidateDuplicates', 'listFactsForRelevance'],
  }, (engine) => under('german', async () => {
    const ent = 'people/uma-example';
    await remember(engine, ent, ['Uma kauft Häuser in der Stadt', 'Uma liebt Kinder', 'Uma fährt Rad']);
    const dup = (await engine.findCandidateDuplicates(SRC, ent, 'Uma kaufte ein Haus', { arm: 'keyword', k: 10 })).map(r => r.fact);
    const relevance = (await engine.listFactsForRelevance({
      arm: 'keyword', scope: { sourceId: SRC, worldOnly: false, excludePrivate: false }, vector: null, terms: 'Städte Kind', limit: 10,
    })).map(r => r.fact);
    expect(dup[0]).toBe('Uma kauft Häuser in der Stadt');
    expect([...relevance].sort()).toEqual(['Uma kauft Häuser in der Stadt', 'Uma liebt Kinder']);
    return { dup, relevance };
  }));

  // Named Rust design stop: the store ports only the english and german Snowball dictionaries, so a configuration
  // without a port (`french` here) refuses with a typed refusal that names it, instead of stemming with another
  // language's dictionary. PGLite and Postgres answer.
  parityTest('under a configuration with no Snowball port in the store, the Rust engine refuses the word lexemes by name', {
    methods: ['wordLexemes'],
  }, (engine, backend) => under('french', async () => {
    const run = () => engine.wordLexemes(['maisons', 'et']);
    if (backend !== 'rust') {
      const m = await run();
      expect(m.get('et')).toEqual([]);
      return [...m].map(([w, l]) => `${w}=>${l.join('|')}`);
    }
    const refusal = await run().then(() => null, (error: unknown) => error);
    expect(isEngineCapabilityRefusal(refusal)).toBe(true);
    expect(String((refusal as Error).message)).toContain('no Snowball port for the text search configuration french');
    throw refusal;
  }));
});
