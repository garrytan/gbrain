/**
 * BrainEngine parity — the harness reads the memory-trust evals (gbrain-evals Cat 37-39) set up and score through.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getFactsByIds returns { id, source_id, fact, entity_slug, expired_at, superseded_by } for each stored id
 *    (a missing id answers nothing, a repeated id once), by id. findLiveFactsByText returns { id, fact } for the facts
 *    of one source whose text is exactly one of the texts and that are active (not expired, not past valid_until), by id. listPageIdSlugs returns
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
 *    page_aliases, page_purges) and names every other record by its keyspace, and it scans every stored record. So these cases
 *    compare which tokens each engine finds and the slugs they are about, never the table and column names of a hit.
 *    withManagedPersistencePaused(fn) turns managed persistence off without moving mode_epoch, runs fn and puts the
 *    prior enabled value back only while the brain row is still paused at the same epoch with no new brain-wide
 *    topology change (compare-and-set): a real activation or deactivation during fn is kept and reported as
 *    paused_state_changed, a change to one source is not; a throw is rethrown after the restore, carrying the restore
 *    error too when the restore also fails. The evals wrote enabled=true unconditionally before, which turned a classic brain managed.
 *  - Review round 1 regressions (each failed on the head before the fix): a config value that parses as JSON was
 *    missed on Rust; hasColumn said no trust columns for takes and timeline entries on Rust; a page purge's key columns
 *    were not scanned on Rust; the SQL scan lowercased a non-ASCII pattern in JavaScript but each value in the
 *    database; activeOnly kept a deleted page's fence facts; hits were sorted in UTF-16 order on the SQL engines; a
 *    nested pause restored too early; a cancelled request left the brain paused (Postgres); a deactivation of a
 *    paused brain that released its pre-activation claims was undone by the restore. The lost-reply case pins the
 *    recovery command's behavior (gbrain sources writer activate turns the brain back on with a new epoch).
 *  - Review round 2 regressions (each failed on the base before the fix): a change to one source during fn stopped the
 *    restore; a failed restore after a throw was lost (a string or a frozen error); activeOnly kept a deleted page's
 *    wanted links (SQL), aliases and sealed timeline (Rust) and a fact past its valid_until; Rust left out the link
 *    relationships and transitions under activeOnly, a token in a config key, a page alias and a whole jsonb number or
 *    boolean; equal values came back in different orders before the limit. Review round 3: a restore that threw before
 *    returning a promise hid fn's error; activeOnly kept the aliases of a hard-deleted page; Rust read a whole jsonb
 *    number with an exponent (1e-7) and a derived alias's display text only outside page_aliases; a pause token an older
 *    gbrain took (its topology_changes counted every change) let the restore turn the brain back on after a brain-wide
 *    deactivation. Parity follow-up (each failed on the Rust arm before the fix): Rust printed a 17-digit jsonb number
 *    from an f64 (a tie of two shortest forms, a literal parsed one bit off), skipped a generation's whole-number
 *    completeness, and scanned the dates of a link transition and relationship, which are not SQL text columns.
 *  - Seam: real engines; ids and timestamps are compared by shape, not by literal. The both-errors case alone replaces
 *    the engine's restoreManagedPersistence with a rejecting, then a throwing, stub (deleted in finally): no real store
 *    fails a restore on demand. The owner-upgrade case wraps pauseManagedPersistence to return the token an older gbrain
 *    returned (deleted in finally): one process cannot run two gbrain versions.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import type { ManagedPausePrior } from '../../src/core/engine-sql/eval-harness-reads.ts';
import { withRequestSignal } from '../../src/core/request-signal.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { deactivatePersistence } from '../../src/core/persistence/deactivation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const fact = (engine: BrainEngine, text: string, entity: string | null, sourceId = 'default') =>
  engine.insertFact({ fact: text, entity_slug: entity, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: sourceId });

const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());

/** Runs `run` with a fresh GBRAIN_HOME (the persistence administration keeps its markers and locks there). */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-eval-harness-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => run(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

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

  parityTest('hasColumn reports the trust tier and write origin of takes and timeline entries', {
    methods: ['hasColumn'],
  }, async (engine) => {
    const probes = [['takes', 'trust_tier'], ['takes', 'write_origin'], ['timeline_entries', 'trust_tier'], ['timeline_entries', 'write_origin']] as const;
    const result = Object.fromEntries(await Promise.all(probes.map(async ([t, c]) => [`${t}.${c}`, await engine.hasColumn(t, c)])));
    expect(result).toEqual(Object.fromEntries(probes.map(([t, c]) => [`${t}.${c}`, true])));
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

  /** Whether any hit of the scan holds `token` in its value. */
  const found = async (engine: BrainEngine, token: string, opts: { activeOnly?: boolean; tables?: string[] } = {}) =>
    (await engine.scanTextColumns({ pattern: token, activeOnly: opts.activeOnly ?? false, ...(opts.tables ? { tables: opts.tables } : {}) }))
      .some(h => h.value.toLowerCase().includes(token.toLowerCase()));

  parityTest('scanTextColumns finds a token in a config value that parses as a JSON array, a JSON string or a JSON object key', {
    methods: ['setConfig', 'scanTextColumns'],
  }, async (engine) => {
    await engine.setConfig('eval.scan.array', '["cfgarraytoken"]');
    await engine.setConfig('eval.scan.string', '"cfgstringtoken"');
    await engine.setConfig('eval.scan.key', '{"cfgkeytoken": 1}');
    const result = { array: await found(engine, 'cfgarraytoken'), string: await found(engine, 'cfgstringtoken'), key: await found(engine, 'cfgkeytoken') };
    expect(result).toEqual({ array: true, string: true, key: true });
    return result;
  });

  parityTest('scanTextColumns finds the stored text of a non-ASCII pattern', {
    methods: ['putPage', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/greek', { type: 'note', title: 'Greek', compiled_truth: 'The word ΟΣ ends here.' });
    const result = await slugsByToken(engine, ['ΟΣ'], false);
    expect(result).toEqual({ 'ΟΣ': ['notes/greek'] });
    return result;
  });

  parityTest('scanTextColumns finds a page purge by the content hash and source its key holds', {
    methods: ['upsertPagePurges', 'scanTextColumns'],
  }, async (engine) => {
    const hash = 'cafe0123'.padEnd(64, '0');
    await engine.upsertPagePurges({ sourceId: 'default', contentHashes: [hash], slug: 'notes/purged', requestId: null });
    const hits = await engine.scanTextColumns({ pattern: 'cafe0123', activeOnly: false, tables: ['page_purges'] });
    const result = hits.map(h => [h.table, h.column, h.value === hash, h.slug]);
    expect(result).toEqual([['page_purges', 'content_hash', true, 'notes/purged']]);
    return result;
  });

  parityTest('scanTextColumns with activeOnly leaves out every record of a deleted page, a fence fact included', {
    methods: ['putPage', 'insertFacts', 'softDeletePages', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/fenced', { type: 'note', title: 'Fenced', compiled_truth: 'A page that held fencepagetoken.' });
    await engine.insertFacts([{ fact: 'the fence said fencefacttoken', entity_slug: null, visibility: 'world', source: 'test', embedding: null,
      row_num: 1, source_markdown_slug: 'notes/fenced' } as NewFact & { row_num: number; source_markdown_slug: string }], { source_id: 'default' });
    const before = { page: await found(engine, 'fencepagetoken', { activeOnly: true }), fact: await found(engine, 'fencefacttoken', { activeOnly: true }) };
    await engine.softDeletePages(['notes/fenced'], { sourceId: 'default' });
    const result = {
      before,
      live: { page: await found(engine, 'fencepagetoken', { activeOnly: true }), fact: await found(engine, 'fencefacttoken', { activeOnly: true }) },
      all: { page: await found(engine, 'fencepagetoken'), fact: await found(engine, 'fencefacttoken') },
    };
    expect(result).toEqual({ before: { page: true, fact: true }, live: { page: false, fact: false }, all: { page: true, fact: true } });
    return result;
  });

  parityTest('scanTextColumns orders hits by UTF-8 bytes before the limit', {
    methods: ['putPage', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/sort-emoji', { type: 'note', title: 'Sort one', compiled_truth: 'sortprobe x\u{1F600}' });
    await engine.putPage('notes/sort-private', { type: 'note', title: 'Sort two', compiled_truth: 'sortprobe x\uE000' });
    const [first] = await engine.scanTextColumns({ pattern: 'sortprobe', activeOnly: false, tables: ['pages'], limit: 1 });
    // A negative limit is refused on every engine (test/eval-harness-sql-pin.test.ts; the Rust store member refuses it).
    const result = { first: first?.slug ?? null };
    expect(result).toEqual({ first: 'notes/sort-private' });
    return result;
  });

  parityTest('scanTextColumns with activeOnly keeps a live page\'s wanted links and leaves out a deleted page\'s', {
    methods: ['putPage', 'getPage', 'replaceWantedLinkRows', 'softDeletePages', 'scanTextColumns'],
  }, async (engine) => {
    const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title}.` });
    for (const [slug, token] of [['notes/wants-live', 'wantedlivetoken'], ['notes/wants-gone', 'wantedgonetoken']] as const) {
      await engine.putPage(slug, note(slug));
      const origin = await engine.getPage(slug, { sourceId: 'default' });
      await engine.replaceWantedLinkRows({ pageId: Number(origin!.id), sourceId: 'default' }, {
        rows: [{ producer: 'body', ref_kind: 'name', target_source_id: 'default', target_ref: token, link_type: '', context: `see ${token}` }],
        producers: ['body'], readAt: '2026-01-02T03:04:05.678Z' });
    }
    await engine.softDeletePages(['notes/wants-gone'], { sourceId: 'default' });
    const result = {
      live: { kept: await found(engine, 'wantedlivetoken', { activeOnly: true }), deleted: await found(engine, 'wantedgonetoken', { activeOnly: true }) },
      all: { kept: await found(engine, 'wantedlivetoken'), deleted: await found(engine, 'wantedgonetoken') },
    };
    expect(result).toEqual({ live: { kept: true, deleted: false }, all: { kept: true, deleted: true } });
    return result;
  });

  parityTest('scanTextColumns with activeOnly keeps the link transitions and relationships of live pages', {
    methods: ['putPage', 'writeManualLinkTransitions', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/rel-from', { type: 'note', title: 'From', compiled_truth: 'A page.' });
    await engine.putPage('people/rel-to', { type: 'person', title: 'To', compiled_truth: 'A person.' });
    await engine.writeManualLinkTransitions({ from: 'notes/rel-from', to: 'people/rel-to', linkType: 'reltypetoken', sourceId: 'default' }, [{ kind: 'start', occurred_on: '2026-02-03' }]);
    const result = { live: await found(engine, 'reltypetoken', { activeOnly: true }), all: await found(engine, 'reltypetoken') };
    expect(result).toEqual({ live: true, all: true });
    return result;
  });

  parityTest('scanTextColumns finds a token in a config key', {
    methods: ['setConfig', 'scanTextColumns'],
  }, async (engine) => {
    await engine.setConfig('eval.scan.cfgnametoken', 'plain value');
    const result = { all: await found(engine, 'cfgnametoken'), live: await found(engine, 'cfgnametoken', { activeOnly: true }) };
    expect(result).toEqual({ all: true, live: true });
    return result;
  });

  parityTest('scanTextColumns with activeOnly leaves out the sealed timeline of a deleted page', {
    methods: ['putPage', 'sealChunks', 'softDeletePages', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/sealed', { type: 'note', title: 'Sealed', compiled_truth: 'A sealed page.', timeline: '- 2026-11-20: sealtimelinetoken moved' });
    await engine.sealChunks('notes/sealed', [{ chunk_index: 0, chunk_text: 'A sealed page.', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
    const before = await found(engine, 'sealtimelinetoken', { activeOnly: true });
    await engine.softDeletePages(['notes/sealed'], { sourceId: 'default' });
    const result = { before, live: await found(engine, 'sealtimelinetoken', { activeOnly: true }), all: await found(engine, 'sealtimelinetoken') };
    expect(result).toEqual({ before: true, live: false, all: true });
    return result;
  });

  parityTest('scanTextColumns breaks a tie of equal values by slug before the limit', {
    methods: ['putPage', 'scanTextColumns'],
  }, async (engine) => {
    for (const slug of ['notes/tie-c', 'notes/tie-a', 'notes/tie-b']) {
      await engine.putPage(slug, { type: 'note', title: 'Tie', compiled_truth: 'tieprobe the same body' });
    }
    const hits = await engine.scanTextColumns({ pattern: 'tieprobe', activeOnly: false, tables: ['pages'] });
    const [first] = await engine.scanTextColumns({ pattern: 'tieprobe', activeOnly: false, tables: ['pages'], limit: 1 });
    const result = { slugs: hits.map(h => h.slug), first: first?.slug ?? null };
    expect(result).toEqual({ slugs: ['notes/tie-a', 'notes/tie-b', 'notes/tie-c'], first: 'notes/tie-a' });
    return result;
  });

  parityTest('scanTextColumns finds a page alias, and activeOnly leaves out the aliases of a deleted page', {
    methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'softDeletePages', 'deletePage', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('companies/aliased-live', { type: 'company', title: 'Live', compiled_truth: 'A company.' });
    await engine.putPage('companies/aliased-gone', { type: 'company', title: 'Gone', compiled_truth: 'A company.' });
    await engine.putPage('companies/aliased-purged', { type: 'company', title: 'Purged', compiled_truth: 'A company.' });
    await engine.setPageAliases('companies/aliased-live', 'default', ['AliasLiveToken']);
    await engine.setPageAliases('companies/aliased-gone', 'default', ['AliasGoneToken']);
    await engine.setPageAliases('companies/aliased-purged', 'default', ['AliasPurgedToken']);
    // A derived alias keeps its display text, which can differ from the normalized alias (two spaces here, one there).
    await engine.replaceDerivedAliases('companies/aliased-live', 'default',
      [{ alias_norm: 'aliasdisplay token', origin: 'declared', case_sensitive: false, alias_text: 'AliasDisplay  Token' }]);
    await engine.softDeletePages(['companies/aliased-gone'], { sourceId: 'default' });
    // A hard delete removes the page and leaves its alias rows behind; they are no longer live.
    await engine.deletePage('companies/aliased-purged', { sourceId: 'default' });
    const inAliases = async (token: string) => (await engine.scanTextColumns({ pattern: token, activeOnly: false, tables: ['page_aliases'] }))
      .map(h => [h.value, h.slug]);
    const result = {
      all: { live: await found(engine, 'aliaslivetoken'), gone: await found(engine, 'aliasgonetoken') },
      live: { live: await found(engine, 'aliaslivetoken', { activeOnly: true }), gone: await found(engine, 'aliasgonetoken', { activeOnly: true }),
        purged: await found(engine, 'aliaspurgedtoken', { activeOnly: true }) },
      slugs: await slugsByToken(engine, ['aliaslivetoken'], true),
      displayText: await inAliases('aliasdisplay  token'),
    };
    expect(result).toEqual({ all: { live: true, gone: true }, live: { live: true, gone: false, purged: false },
      slugs: { aliaslivetoken: ['companies/aliased-live'] }, displayText: [['AliasDisplay  Token', 'companies/aliased-live']] });
    return result;
  });

  parityTest('scanTextColumns finds a number or a boolean stored as a whole jsonb value', {
    methods: ['putPage', 'putRawData', 'readPageRedactionRows', 'setRawDataValue', 'scanTextColumns'],
  }, async (engine) => {
    const page = await engine.putPage('notes/raw-scalar', { type: 'note', title: 'Raw', compiled_truth: 'A page with raw data.' });
    await engine.putRawData('notes/raw-scalar', 'crm', { placeholder: 'x' });
    await engine.putRawData('notes/raw-scalar', 'mail', { placeholder: 'y' });
    await engine.putRawData('notes/raw-scalar', 'web', { placeholder: 'z' });
    const [first, second, third] = (await engine.readPageRedactionRows(page.id, 'default', 'notes/raw-scalar')).rawData;
    await engine.setRawDataValue(page.id, first!.id, 4815162342);
    await engine.setRawDataValue(page.id, second!.id, true);
    // JavaScript writes 1e-7 with an exponent; Postgres prints a jsonb number as plain decimals.
    await engine.setRawDataValue(page.id, third!.id, 1e-7);
    const hits = await engine.scanTextColumns({ pattern: '4815162342', activeOnly: false });
    const result = { number: hits.map(h => [h.value, h.slug]), boolean: (await engine.scanTextColumns({ pattern: 'true', activeOnly: false }))
      .some(h => h.value === 'true' && h.slug === 'notes/raw-scalar'),
      exponent: (await engine.scanTextColumns({ pattern: '0.0000001', activeOnly: false })).map(h => [h.value, h.slug]) };
    expect(result).toEqual({ number: [['4815162342', 'notes/raw-scalar']], boolean: true, exponent: [['0.0000001', 'notes/raw-scalar']] });
    return result;
  });

  parityTest('scanTextColumns gives every digit of a long jsonb number as Postgres prints it', {
    methods: ['putPage', 'putRawData', 'readPageRedactionRows', 'setRawDataValue', 'scanTextColumns'],
  }, async (engine) => {
    const page = await engine.putPage('notes/raw-long', { type: 'note', title: 'Raw', compiled_truth: 'A page with long numbers.' });
    await engine.putRawData('notes/raw-long', 'crm', { placeholder: 'x' });
    await engine.putRawData('notes/raw-long', 'mail', { placeholder: 'y' });
    await engine.putRawData('notes/raw-long', 'web', { placeholder: 'z' });
    const [first, second, third] = (await engine.readPageRedactionRows(page.id, 'default', 'notes/raw-long')).rawData;
    // 17 significant digits: an exact tie of two shortest forms, and a number a fast float parser reads one bit off.
    await engine.setRawDataValue(page.id, first!.id, 100000000000000.12);
    await engine.setRawDataValue(page.id, second!.id, 123456789.12345679);
    // 20 digits: a JavaScript number keeps 17 of them on every engine, so the scan finds the JSON.stringify digits.
    await engine.setRawDataValue(page.id, third!.id, 12345678901234567890);
    const values = async (pattern: string) =>
      (await engine.scanTextColumns({ pattern, activeOnly: false })).filter(h => h.slug === 'notes/raw-long').map(h => h.value);
    const result = { tie: await values('100000000000000.12'), off_by_one_bit: await values('123456789.12345679'),
      twenty_digits: await values('1234567890123456') };
    expect(result).toEqual({ tie: ['100000000000000.12'], off_by_one_bit: ['123456789.12345679'], twenty_digits: ['12345678901234567000'] });
    return result;
  });

  parityTest('scanTextColumns finds a token in a derived generation\'s completeness stored as a whole jsonb number', {
    methods: ['transaction', 'activateGenerationRows', 'scanTextColumns'],
  }, async (engine) => {
    await engine.transaction(async tx => {
      await tx.activateGenerationRows({ sourceId: 'default', kind: 'scan-kind', ownerKey: 'owner' }, null, { generation: 1, runId: null,
        operationId: 'op-scan', inputPin: null, inputSize: null, completeness: JSON.stringify(8675309), setHash: 'hash', restoreOf: null,
        activationId: null, locator: null }, []);
    });
    const hits = (await engine.scanTextColumns({ pattern: '8675309', activeOnly: false })).map(h => h.value);
    expect(hits).toEqual(['8675309']);
    return hits;
  });

  parityTest('scanTextColumns does not scan the dates of a link transition or relationship, which are not text columns', {
    methods: ['putPage', 'writeManualLinkTransitions', 'scanTextColumns'],
  }, async (engine) => {
    await engine.putPage('notes/date-from', { type: 'note', title: 'From', compiled_truth: 'A page.' });
    await engine.putPage('people/date-to', { type: 'person', title: 'To', compiled_truth: 'A person.' });
    await engine.writeManualLinkTransitions({ from: 'notes/date-from', to: 'people/date-to', linkType: 'datetypetoken', sourceId: 'default' },
      [{ kind: 'start', occurred_on: '1986-03-27' }, { kind: 'end', occurred_on: '1987-04-28' }]);
    const result = { link_type: await found(engine, 'datetypetoken'), start: await found(engine, '1986-03-27'), end: await found(engine, '1987-04-28') };
    expect(result).toEqual({ link_type: true, start: false, end: false });
    return result;
  });

  parityTest('findLiveFactsByText and scanTextColumns with activeOnly leave out a fact whose valid_until has passed', {
    methods: ['insertFact', 'findLiveFactsByText', 'scanTextColumns'],
  }, async (engine) => {
    const lapsed = { fact: 'lapsedfacttoken held until 2020', entity_slug: 'people/alice-example', visibility: 'world', source: 'test', embedding: null,
      valid_from: new Date('2019-01-01T00:00:00Z'), valid_until: new Date('2020-01-01T00:00:00Z') } as NewFact;
    const current = { ...lapsed, fact: 'currentfacttoken holds until 2099', valid_until: new Date('2099-01-01T00:00:00Z') } as NewFact;
    await engine.insertFact(lapsed, { source_id: 'default' });
    await engine.insertFact(current, { source_id: 'default' });
    const result = {
      byText: (await engine.findLiveFactsByText('default', [lapsed.fact, current.fact])).map(r => r.fact),
      live: { lapsed: await found(engine, 'lapsedfacttoken', { activeOnly: true }), current: await found(engine, 'currentfacttoken', { activeOnly: true }) },
      all: { lapsed: await found(engine, 'lapsedfacttoken'), current: await found(engine, 'currentfacttoken') },
    };
    expect(result).toEqual({ byText: [current.fact], live: { lapsed: false, current: true }, all: { lapsed: true, current: true } });
    return result;
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

  /** The brain row the writer admin state reads, and the rest of that state (sources, worktrees, bindings, hosts). */
  const brainState = async (engine: BrainEngine) => {
    const state = JSON.parse(await engine.readWriterAdminState()) as { brain: { enabled: boolean; mode_epoch: number | string } } & Record<string, unknown>;
    const { brain, ...rest } = state;
    return { enabled: brain.enabled, epoch: Number(brain.mode_epoch), rest: JSON.stringify(rest) };
  };
  const setEnabled = async (engine: BrainEngine, enabled: boolean) => { await (await engine.writerReleaseStore()).setBrainEnabled(enabled); };

  parityTest('withManagedPersistencePaused pauses a managed brain without moving mode_epoch and restores it after fn', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    await setEnabled(engine, true);
    const before = await brainState(engine);
    let during: Awaited<ReturnType<typeof brainState>> | null = null;
    const out = await engine.withManagedPersistencePaused(async () => { during = await brainState(engine); return 'ran'; });
    const after = await brainState(engine);
    const result = { out, during: { enabled: during!.enabled, sameEpoch: during!.epoch === before.epoch, sameRest: during!.rest === before.rest },
      after: { enabled: after.enabled, sameEpoch: after.epoch === before.epoch, sameRest: after.rest === before.rest } };
    expect(result).toEqual({ out: { result: 'ran', restore: 'restored' }, during: { enabled: false, sameEpoch: true, sameRest: true },
      after: { enabled: true, sameEpoch: true, sameRest: true } });
    return result;
  });

  parityTest('withManagedPersistencePaused leaves a classic brain classic', {
    methods: ['readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    const before = await brainState(engine);
    const out = await engine.withManagedPersistencePaused(async () => (await brainState(engine)).enabled);
    const after = await brainState(engine);
    const result = { before: before.enabled, out, after: after.enabled, sameEpoch: after.epoch === before.epoch };
    expect(result).toEqual({ before: false, out: { result: false, restore: 'restored' }, after: false, sameEpoch: true });
    return result;
  });

  parityTest('withManagedPersistencePaused restores the prior state and then rethrows when fn throws', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    await setEnabled(engine, true);
    const before = await brainState(engine);
    const thrown = await engine.withManagedPersistencePaused(async () => { throw new Error('import failed'); }).then(() => 'resolved', (e: Error) => e.message);
    const after = await brainState(engine);
    const result = { thrown, enabled: after.enabled, sameEpoch: after.epoch === before.epoch };
    expect(result).toEqual({ thrown: 'import failed', enabled: true, sameEpoch: true });
    return result;
  });

  parityTest('withManagedPersistencePaused keeps an activation or deactivation that ran during fn and reports paused_state_changed', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    const before = await brainState(engine);
    const activated = await engine.withManagedPersistencePaused(async () => { await setEnabled(engine, true); });
    const afterActivate = await brainState(engine);
    const deactivated = await engine.withManagedPersistencePaused(async () => { await setEnabled(engine, false); });
    const afterDeactivate = await brainState(engine);
    const result = {
      activated: activated.restore, afterActivate: { enabled: afterActivate.enabled, epoch: afterActivate.epoch - before.epoch },
      deactivated: deactivated.restore, afterDeactivate: { enabled: afterDeactivate.enabled, epoch: afterDeactivate.epoch - before.epoch },
    };
    expect(result).toEqual({ activated: 'paused_state_changed', afterActivate: { enabled: true, epoch: 1 },
      deactivated: 'paused_state_changed', afterDeactivate: { enabled: false, epoch: 2 } });
    return result;
  });

  parityTest('withManagedPersistencePaused refuses a second pause on the same brain while one is held', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    await setEnabled(engine, true);
    const out = await engine.withManagedPersistencePaused(async () =>
      engine.withManagedPersistencePaused(async () => 'nested').then(() => 'ok', (e: { code?: string }) => e.code ?? 'refused'));
    const after = await brainState(engine);
    const result = { out, enabled: after.enabled };
    expect(result).toEqual({ out: { result: 'managed_pause_held', restore: 'restored' }, enabled: true });
    return result;
  });

  parityTest('withManagedPersistencePaused restores the brain when its request is cancelled during fn', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused'],
  }, async (engine) => {
    await setEnabled(engine, true);
    const controller = new AbortController();
    const out = await withRequestSignal(controller.signal, () => engine.withManagedPersistencePaused(async () => { controller.abort(); return 'aborted'; }));
    const after = await brainState(engine);
    const result = { out, enabled: after.enabled };
    expect(result).toEqual({ out: { result: 'aborted', restore: 'restored' }, enabled: true });
    return result;
  });

  parityTest('withManagedPersistencePaused keeps a deactivation that released pre-activation claims during fn', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused', 'getWorktreeBinding'],
    timeout: 60_000,
  }, async (engine, backend: ParityBackend) => withHome(async (home) => {
    const root = join(home, 'checkout');
    await Bun.write(join(root, 'example.md'), 'generic example');
    await createSource(engine, backend, 'work', {}, root);
    try {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
      await setEnabled(engine, true);
      const before = await brainState(engine);
      const out = await engine.withManagedPersistencePaused(async () => (await deactivatePersistence(engine)).pre_activation_claims?.length ?? 0);
      const after = await brainState(engine);
      const result = { out, enabled: after.enabled, sameEpoch: after.epoch === before.epoch };
      expect(result).toEqual({ out: { result: 1, restore: 'paused_state_changed' }, enabled: false, sameEpoch: true });
      return result;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));

  /** Records one committed topology change of `sourceId` ('*' is brain-wide), as a lifecycle writer does. */
  const topologyChange = (engine: BrainEngine, sourceId: string, operation: string, requestId: string) =>
    engine.transaction(tx => tx.insertTopologyChange({ principalId: 'd0000000-0000-4000-8000-0000000000f2', requestId, digest: 'e'.repeat(64), operation,
      sourceId, sourceIncarnation: null, worktreeIds: [], state: 'committed', recovery: null, terminalBytes: 4096, outcome: { source_id: sourceId } }));

  parityTest('withManagedPersistencePaused restores the brain after a change to another source during fn, and keeps a brain-wide change', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused', 'insertTopologyChange'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await setEnabled(engine, true);
    const before = await brainState(engine);
    const sourceChange = await engine.withManagedPersistencePaused(async () => {
      await topologyChange(engine, 'work', 'company-brain-connect', 'd0000000-0000-4000-8000-0000000000a1');
    });
    const afterSource = await brainState(engine);
    const brainChange = await engine.withManagedPersistencePaused(async () => {
      await topologyChange(engine, '*', 'writer_deactivate', 'd0000000-0000-4000-8000-0000000000a2');
    });
    const afterBrain = await brainState(engine);
    const result = {
      sourceChange: sourceChange.restore, afterSource: { enabled: afterSource.enabled, sameEpoch: afterSource.epoch === before.epoch },
      brainChange: brainChange.restore, afterBrain: { enabled: afterBrain.enabled, sameEpoch: afterBrain.epoch === before.epoch },
    };
    expect(result).toEqual({ sourceChange: 'restored', afterSource: { enabled: true, sameEpoch: true },
      brainChange: 'paused_state_changed', afterBrain: { enabled: false, sameEpoch: true } });
    return result;
  });

  parityTest('withManagedPersistencePaused leaves the brain paused, and says why, when an owner upgrade and a deactivation run during fn', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'withManagedPersistencePaused', 'pauseManagedPersistence', 'insertTopologyChange'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await topologyChange(engine, 'work', 'company-brain-connect', 'd0000000-0000-4000-8000-0000000000b1');
    await setEnabled(engine, true);
    // The pause ran on the gbrain before an owner upgrade: its token held topology_changes, a count of every topology
    // change (the brain-wide ones plus the one source change above), not brain_topology_changes.
    const target = engine as unknown as { pauseManagedPersistence: BrainEngine['pauseManagedPersistence'] };
    const current = engine.pauseManagedPersistence.bind(engine);
    target.pauseManagedPersistence = async () => {
      const prior = await current() as unknown as Record<string, string | boolean>;
      const everyChange = Number(prior.brain_topology_changes) + 1;
      return { enabled: prior.enabled, mode_epoch: prior.mode_epoch, topology_changes: String(everyChange) } as unknown as ManagedPausePrior;
    };
    let outcome: unknown;
    try {
      // A brain-wide deactivation during fn makes the brain-wide count equal the old token's count of every change.
      outcome = await engine.withManagedPersistencePaused(async () => {
        await topologyChange(engine, '*', 'writer_deactivate', 'd0000000-0000-4000-8000-0000000000b2');
      }).then(o => o.restore, (e: { code?: string; message?: string }) => ({ code: e.code, names: /gbrain sources writer activate/.test(e.message ?? '') }));
    } finally {
      delete (target as Partial<typeof target>).pauseManagedPersistence;
    }
    const after = await brainState(engine);
    const result = { outcome, enabled: after.enabled };
    expect(result).toEqual({ outcome: { code: 'managed_pause_token_outdated', names: true }, enabled: false });
    return result;
  });

  parityTest('withManagedPersistencePaused gives the caller both errors when fn throws and the restore also fails', {
    methods: ['writerReleaseStore', 'withManagedPersistencePaused'],
  }, async (engine) => {
    await setEnabled(engine, true);
    const restoreFailure = new Error('restore failed');
    const target = engine as unknown as { restoreManagedPersistence: BrainEngine['restoreManagedPersistence'] };
    target.restoreManagedPersistence = () => Promise.reject(restoreFailure);
    const errorOf = (e: unknown) => {
      const err = e as { message?: string; restoreError?: unknown; errors?: unknown[] };
      return { name: e instanceof AggregateError ? 'AggregateError' : typeof e, message: err.message ?? String(e),
        restoreError: err.restoreError === restoreFailure, errors: err.errors?.map(x => x === restoreFailure ? 'restore' : String((x as Error)?.message ?? x)) ?? null };
    };
    let outcomes: unknown[];
    try {
      const frozen = Object.freeze(new Error('frozen import failed'));
      outcomes = [
        await engine.withManagedPersistencePaused(async () => { throw new Error('import failed'); }).then(() => 'resolved', errorOf),
        await engine.withManagedPersistencePaused(async () => { throw 'import failed as text'; }).then(() => 'resolved', errorOf),
        await engine.withManagedPersistencePaused(async () => { throw frozen; }).then(() => 'resolved', errorOf),
      ];
      // A restore that throws before it returns a promise.
      target.restoreManagedPersistence = () => { throw restoreFailure; };
      outcomes.push(await engine.withManagedPersistencePaused(async () => { throw new Error('import failed before a throwing restore'); })
        .then(() => 'resolved', errorOf));
    } finally {
      delete (target as Partial<typeof target>).restoreManagedPersistence;
    }
    await setEnabled(engine, true);
    const result = { outcomes };
    expect(result).toEqual({ outcomes: [
      { name: 'object', message: 'import failed', restoreError: true, errors: null },
      { name: 'AggregateError', message: 'withManagedPersistencePaused: fn failed and the restore failed; the brain may still be paused', restoreError: true, errors: ['import failed as text', 'restore'] },
      { name: 'AggregateError', message: 'withManagedPersistencePaused: fn failed and the restore failed; the brain may still be paused', restoreError: true, errors: ['frozen import failed', 'restore'] },
      { name: 'object', message: 'import failed before a throwing restore', restoreError: true, errors: null },
    ] });
    return result;
  });

  parityTest('a pause whose reply was lost leaves the brain at enabled=false, and activation turns it back on with a new epoch', {
    methods: ['writerReleaseStore', 'readWriterAdminState', 'pauseManagedPersistence'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    try {
      await setEnabled(engine, true);
      const before = await brainState(engine);
      await engine.pauseManagedPersistence();
      const lost = await brainState(engine);
      await activatePersistence(engine, { confirmQuiesced: true });
      const after = await brainState(engine);
      const result = { lost: { enabled: lost.enabled, sameEpoch: lost.epoch === before.epoch }, after: { enabled: after.enabled, epochMoved: after.epoch > before.epoch } };
      expect(result).toEqual({ lost: { enabled: false, sameEpoch: true }, after: { enabled: true, epochMoved: true } });
      return result;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));
});
