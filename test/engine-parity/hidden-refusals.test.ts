/**
 * BrainEngine parity: two reads a caller used to run through `executeRaw` inside a fail-soft catch, so a Rust brain
 * took the fallback while its answer could still look whole. `mentions/newer-mentions.ts` read the entity page's date
 * (a context_pack card then carried no newer mentions), and `search/saved-facts-match.ts` headStems read which query
 * terms each name head matches after stemming (a search then applied a correction to the wrong fact).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    `readPageReferenceDate` answers a live page's `COALESCE(effective_date, updated_at)` as UTC microsecond text and
 *    null for a missing or soft-deleted page; a context card lists the referrers dated after the entity; `matchHeadStems`
 *    names the terms each head matches by stem; a correction that shares no named word with an older fact leaves that
 *    fact uncorrected. With another full-text language the Rust engine refuses the saved-facts match visibly
 *    (engine_capability_missing) instead of answering "no saved facts".
 *  - Regression: a caller that swallows a refusal returns null or an empty map, so the card drops its newer mentions and
 *    a correction lands on a fact about another name, while every arm still answers.
 *  - Why existing coverage misses it: the census compares a fixture with no dated mentions and no correction cue, and the
 *    facts-trust parity cases call matchSavedFacts, not the stemming read after it.
 *  - Seam: none. Pages, links and facts are written with `putPage`, `addLink` and `insertFact`; the two callers run as
 *    production code (`readNewerMentions`, `matchingSavedFacts`).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import { readNewerMentions } from '../../src/core/mentions/newer-mentions.ts';
import { matchingSavedFacts } from '../../src/core/search/saved-facts-match.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const page = (title: string, effective?: string) => ({
  type: 'note' as const, title, compiled_truth: `${title}.`, timeline: '', frontmatter: {},
  ...(effective ? { effective_date: new Date(effective), effective_date_source: 'date' as const } : {}),
});
/** A local caller's operation context, as the CLI builds it, with response meta on so the saved-facts block runs. */
const local = (engine: BrainEngine) => ({ engine, remote: false, sourceId: SRC, emitResponseMeta: () => {} }) as unknown as OperationContext;

async function remember(engine: BrainEngine, facts: Array<{ fact: string; day: number }>): Promise<void> {
  for (const { fact, day } of facts) {
    await engine.insertFact({ fact, source: 'mcp:remember', entity_slug: null, valid_from: new Date(Date.UTC(2026, 4, day)) }, { source_id: SRC });
  }
}

describe('engine parity: reads a fail-soft caller used to run as raw SQL', () => {
  parityTest('readPageReferenceDate answers the effective date, else the update time, and null for a gone or missing page', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'readPageReferenceDate'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', page('Alice Example', '2026-01-02T03:04:05.123Z'));
    await engine.putPage('notes/undated', page('Undated'));
    await engine.putPage('notes/gone', page('Gone', '2026-02-01T00:00:00Z'));
    await engine.softDeletePage('notes/gone');
    const undated = await engine.readPageReferenceDate(SRC, 'notes/undated');
    const updated = (await engine.getPage('notes/undated'))!.updated_at;
    const answer = {
      dated: await engine.readPageReferenceDate(SRC, 'people/alice-example'),
      undated: { shape: ISO_US.test(String(undated)), isUpdateTime: String(undated).slice(0, 23) === new Date(updated).toISOString().slice(0, 23) },
      gone: await engine.readPageReferenceDate(SRC, 'notes/gone'),
      missing: await engine.readPageReferenceDate(SRC, 'notes/never-written'),
      otherSource: await engine.readPageReferenceDate('elsewhere', 'people/alice-example'),
    };
    expect(answer).toEqual({ dated: '2026-01-02T03:04:05.123000Z', undated: { shape: true, isUpdateTime: true }, gone: null, missing: null, otherSource: null });
    return answer;
  });

  parityTest('a context card lists the referrers dated after the entity, newest first', {
    methods: ['putPage', 'addLink', 'readPageReferenceDate'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', page('Alice Example', '2026-02-01T00:00:00Z'));
    await engine.putPage('notes/older', page('Older note', '2026-01-15T00:00:00Z'));
    await engine.putPage('notes/newer', page('Newer note', '2026-03-01T00:00:00Z'));
    await engine.putPage('notes/newest', page('Newest note', '2026-04-01T00:00:00Z'));
    for (const from of ['notes/older', 'notes/newer', 'notes/newest']) await engine.addLink(from, 'people/alice-example', 'mentions alice', 'mentions');
    const m = await readNewerMentions(engine, SRC, 'people/alice-example', { excludePrivate: false, keepVisibility: ['private', 'world'] });
    const answer = m && { since: m.since, rows: m.rows.map(r => ({ date: r.date, slug: r.slug, title: r.title })), more: m.more };
    expect(answer?.since).toBe('2026-02-01T00:00:00.000000Z');
    expect(answer?.rows.map(r => r.slug)).toEqual(['notes/newest', 'notes/newer']);
    return answer;
  });

  parityTest('matchHeadStems names the query terms each head matches by stem; a stopword term matches nothing', {
    methods: ['matchHeadStems'],
  }, async (engine) => {
    const rows = await engine.matchHeadStems(['widget', 'running', 'acme', 'widgets'], ['widgets', 'runs', 'zebra', 'the']);
    const none = await engine.matchHeadStems([], ['widgets']);
    expect(rows).toEqual([{ h: 'widget', i: [1] }, { h: 'running', i: [2] }, { h: 'acme', i: [] }, { h: 'widgets', i: [1] }]);
    expect(none).toEqual([]);
    return { rows, none };
  });

  // The older fact writes "Widget" as a name, which matches the query word "widgets" only by stem. The correction shares
  // two query words with it but not that name, so it corrects nothing. Without the stems the name is not seen, and the
  // correction would mark the widget fact corrected.
  parityTest('a correction that shares no named word with an older fact leaves it uncorrected (names matched by stem)', {
    methods: ['insertFact', 'matchSavedFacts', 'matchHeadStems'],
  }, async (engine) => {
    await remember(engine, [
      { fact: 'Widget revenue quarterly is 50000', day: 1 },
      { fact: 'correction: revenue quarterly is 60000', day: 2 },
    ]);
    const out = await matchingSavedFacts(local(engine), { sourceId: SRC }, 'widgets revenue quarterly');
    const answer = { facts: out.facts.map(f => ({ fact: f.fact, corrected_by: f.corrected_by ?? null })), corrections: out.correctedBy.size };
    expect(answer).toEqual({ facts: [{ fact: 'Widget revenue quarterly is 50000', corrected_by: null }], corrections: 0 });
    return answer;
  });

  // Under the german configuration the saved-facts match stems German on every engine (the Rust store ports the
  // German Snowball dictionary, keyword/stem_german.rs). The words stem alike on PGLite and Postgres 16, whose German
  // stemmers differ for the feminine -in/-innen endings (test/engine-parity/fts-german.test.ts).
  parityTest('with the german full-text language every engine answers the saved-facts match with German stems', {
    methods: ['insertFact', 'matchSavedFacts'],
  }, async (engine) => withEnv({ GBRAIN_FTS_LANGUAGE: 'german' }, async () => {
    resetFtsLanguageCache();
    try {
      await remember(engine, [{ fact: 'Umsatz des Quartals 50000', day: 1 }]);
      const out = await matchingSavedFacts(local(engine), { sourceId: SRC }, 'umsatzes quartal');
      expect(out.facts.map(f => f.fact)).toEqual(['Umsatz des Quartals 50000']);
      return out.facts.map(f => f.fact);
    } finally {
      resetFtsLanguageCache();
    }
  }));
});
