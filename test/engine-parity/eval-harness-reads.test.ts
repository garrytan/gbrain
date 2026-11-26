/**
 * BrainEngine parity — the harness reads the memory-trust evals (gbrain-evals Cat 37-39) set up and score through.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getFactsByIds returns { id, source_id, fact, entity_slug, expired_at, superseded_by } for each stored id
 *    (a missing id answers nothing, a repeated id once), by id. findLiveFactsByText returns { id, fact } for the facts
 *    of one source whose text is exactly one of the texts and that have not expired, by id. listPageIdSlugs returns
 *    { id, slug, source_id, deleted_at } for every page, a soft-deleted one included, by id.
 *  - Regression: the evals ran these reads as raw SQL (facts by id, facts by text, the page id map), so on a Rust
 *    brain their setup stopped on the raw_sql refusal and Cat 37-39 could not run.
 *  - Why existing coverage misses it: listFactRowsByIds is scoped to sources and returns whole rows without the
 *    expiry fields the evals read; listAllPageRefs has no id and leaves deleted pages out.
 *    hasTable / hasColumn answer whether the schema has a table / column; listTextBearingColumns lists the
 *    text-bearing columns; scanTextColumns returns each text value that contains a pattern (case-insensitive) with
 *    the slug its row is about, and with activeOnly leaves out expired facts, deleted pages and their rows.
 *  - Difference by design (DECISION A): the Rust store has no SQL catalog. It keeps the SQL names of the tables its
 *    records map (pages, content_chunks, facts, takes, timeline_entries, sources, write_gate_*, trust_proposals,
 *    page_purges) and names every other record by its keyspace, and it scans every stored record. So these cases
 *    compare which tokens each engine finds and the slugs they are about, never the table and column names of a hit.
 *  - Seam: none. Real engines; ids and timestamps are compared by shape, not by literal.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const fact = (engine: BrainEngine, text: string, entity: string | null, sourceId = 'default') =>
  engine.insertFact({ fact: text, entity_slug: entity, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: sourceId });

const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());

describe('engine parity: the eval harness reads', () => {
  parityTest('getFactsByIds returns each stored fact with its expiry and successor, by id', {
    methods: ['insertFact', 'expireFact', 'getFactsByIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = (await fact(engine, 'alpha runs the acme-example team', 'people/alice-example')).id;
    const b = (await fact(engine, 'alpha now runs the widget-co team', 'people/alice-example')).id;
    const c = (await fact(engine, 'a fact in another source', null, 'other')).id;
    await engine.expireFact(a, { supersededBy: b });
    const rows = await engine.getFactsByIds([c, a, b, a, c + 1000]);
    const shaped = rows.map(r => ({ ...r, id: r.id === a ? 'a' : r.id === b ? 'b' : r.id === c ? 'c' : r.id,
      superseded_by: r.superseded_by === b ? 'b' : r.superseded_by, expired_at: r.expired_at === null ? null : isDate(r.expired_at) }));
    expect(shaped).toEqual([
      { id: 'a', source_id: 'default', fact: 'alpha runs the acme-example team', entity_slug: 'people/alice-example', expired_at: true, superseded_by: 'b' },
      { id: 'b', source_id: 'default', fact: 'alpha now runs the widget-co team', entity_slug: 'people/alice-example', expired_at: null, superseded_by: null },
      { id: 'c', source_id: 'other', fact: 'a fact in another source', entity_slug: null, expired_at: null, superseded_by: null },
    ]);
    expect(await engine.getFactsByIds([])).toEqual([]);
    return shaped;
  });

  parityTest('findLiveFactsByText matches the exact text of the live facts of one source, by id', {
    methods: ['insertFact', 'expireFact', 'findLiveFactsByText'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const old = (await fact(engine, 'the launch is in march', 'companies/acme-example')).id;
    const live = (await fact(engine, 'the launch is in april', 'companies/acme-example')).id;
    const again = (await fact(engine, 'the launch is in april', null)).id;
    await fact(engine, 'the launch is in april', null, 'other');
    await fact(engine, 'The launch is in April', null);
    await engine.expireFact(old);
    const rows = await engine.findLiveFactsByText('default', ['the launch is in april', 'the launch is in march', 'never stored']);
    const shaped = rows.map(r => ({ ...r, id: r.id === live ? 'live' : r.id === again ? 'again' : r.id }));
    expect(shaped).toEqual([{ id: 'live', fact: 'the launch is in april' }, { id: 'again', fact: 'the launch is in april' }]);
    expect(await engine.findLiveFactsByText('default', [])).toEqual([]);
    return shaped;
  });

  parityTest('listPageIdSlugs lists every page with its id, a soft-deleted one included, by id', {
    methods: ['putPage', 'softDeletePages', 'listPageIdSlugs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title}.` });
    const one = await engine.putPage('notes/one', note('One'));
    const two = await engine.putPage('notes/two', note('Two'));
    const three = await engine.putPage('notes/one', note('One elsewhere'), { sourceId: 'other' });
    await engine.softDeletePages(['notes/two'], { sourceId: 'default' });
    const rows = await engine.listPageIdSlugs();
    const ids = new Map([[one.id, 'one'], [two.id, 'two'], [three.id, 'three']]);
    const shaped = rows.filter(r => ids.has(r.id)).map(r => ({ id: ids.get(r.id), slug: r.slug, source_id: r.source_id, deleted: r.deleted_at === null ? null : isDate(r.deleted_at) }));
    expect(shaped).toEqual([
      { id: 'one', slug: 'notes/one', source_id: 'default', deleted: null },
      { id: 'two', slug: 'notes/two', source_id: 'default', deleted: true },
      { id: 'three', slug: 'notes/one', source_id: 'other', deleted: null },
    ]);
    expect(rows.map(r => r.id)).toEqual([...rows.map(r => r.id)].sort((x, y) => x - y));
    return shaped;
  });

  parityTest('hasTable and hasColumn answer for the tables the evals probe and refuse names that do not exist', {
    methods: ['hasTable', 'hasColumn'],
  }, async (engine) => {
    const result = {
      tables: await Promise.all(['pages', 'facts', 'takes', 'timeline_entries', 'write_gate_holds', 'trust_proposals', 'no_such_table'].map(t => engine.hasTable(t))),
      columns: await Promise.all([['takes', 'active'], ['facts', 'expired_at'], ['facts', 'trust_tier'], ['pages', 'deleted_at'], ['facts', 'no_such_column'], ['no_such_table', 'id']]
        .map(([t, c]) => engine.hasColumn(t!, c!))),
    };
    expect(result).toEqual({ tables: [true, true, true, true, true, true, false], columns: [true, true, true, true, false, false] });
    return result;
  });

  /** The slugs each token's hits are about (a hit about no page left out), sorted. */
  const slugsByToken = async (engine: BrainEngine, tokens: readonly string[], activeOnly: boolean) => {
    const out: Record<string, string[]> = {};
    for (const token of tokens) {
      const hits = await engine.scanTextColumns({ pattern: token, activeOnly });
      out[token] = [...new Set(hits.map(h => h.slug).filter((s): s is string => s !== null))].sort();
    }
    return out;
  };

  const seedTokens = async (engine: BrainEngine) => {
    const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body });
    await engine.putPage('notes/body', note('Body', 'The plan names QUILLTOKEN in its body.'));
    const takeHost = await engine.putPage('notes/take-host', note('Take host', 'A page with a take.'));
    await engine.putPage('notes/timeline-host', note('Timeline host', 'A page with a timeline entry.'));
    await engine.putPage('notes/gone', note('Gone', 'This page held GONETOKEN before it was deleted.'));
    await engine.addTakesBatch([{ page_id: takeHost.id, row_num: 1, claim: 'the bet is on taketoken', kind: 'take', holder: 'garry' }]);
    await engine.addTimelineEntry('notes/timeline-host', { date: '2026-11-20', summary: 'the launch moved, says timelinetoken', detail: '' });
    const old = (await fact(engine, 'expiredtoken was the old answer', 'people/alice-example')).id;
    await engine.expireFact(old);
    await engine.softDeletePages(['notes/gone'], { sourceId: 'default' });
  };
  const TOKENS = ['quilltoken', 'taketoken', 'timelinetoken', 'expiredtoken', 'gonetoken', 'nowheretoken'];

  parityTest('scanTextColumns finds a token in a page, a take, a timeline entry and a fact, and activeOnly leaves out expired and deleted rows', {
    methods: ['putPage', 'addTakesBatch', 'addTimelineEntry', 'insertFact', 'expireFact', 'softDeletePages', 'scanTextColumns'],
  }, async (engine) => {
    await seedTokens(engine);
    const result = { all: await slugsByToken(engine, TOKENS, false), live: await slugsByToken(engine, TOKENS, true) };
    expect(result).toEqual({
      all: { quilltoken: ['notes/body'], taketoken: ['notes/take-host'], timelinetoken: ['notes/timeline-host'], expiredtoken: ['people/alice-example'], gonetoken: ['notes/gone'], nowheretoken: [] },
      live: { quilltoken: ['notes/body'], taketoken: ['notes/take-host'], timelinetoken: ['notes/timeline-host'], expiredtoken: [], gonetoken: [], nowheretoken: [] },
    });
    // A token that sits only in a take or a timeline entry, never in a page body, is found on its own row too.
    const takeHits = await engine.scanTextColumns({ pattern: 'taketoken', activeOnly: false, tables: ['takes'] });
    const timelineHits = await engine.scanTextColumns({ pattern: 'TIMELINETOKEN', activeOnly: true, tables: ['timeline_entries'] });
    const own = { take: takeHits.map(h => [h.table, h.slug]), timeline: timelineHits.map(h => [h.table, h.slug]) };
    expect(own).toEqual({ take: [['takes', 'notes/take-host']], timeline: [['timeline_entries', 'notes/timeline-host']] });
    expect((await engine.scanTextColumns({ pattern: 'token', activeOnly: false, limit: 2 })).length).toBe(2);
    return { ...result, own };
  });

  parityTest('listTextBearingColumns names the text columns of the tables the evals scan', {
    methods: ['putPage', 'addTakesBatch', 'addTimelineEntry', 'insertFact', 'expireFact', 'softDeletePages', 'listTextBearingColumns'],
  }, async (engine) => {
    await seedTokens(engine);
    const cols = new Set((await engine.listTextBearingColumns()).map(c => `${c.table}.${c.column}`));
    const wanted = ['pages.compiled_truth', 'pages.slug', 'facts.fact', 'facts.entity_slug', 'takes.claim', 'timeline_entries.summary'];
    const present = Object.fromEntries(wanted.map(w => [w, cols.has(w)]));
    expect(present).toEqual(Object.fromEntries(wanted.map(w => [w, true])));
    return present;
  });
});
