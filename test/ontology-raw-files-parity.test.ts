/**
 * Ontology, raw data and files parity: mergeOntologyFact, getOntology,
 * discoverOntologyDimensions, findOntologyConflicts, putRawData, getRawData,
 * upsertFile, getFile and listFilesForPage store, return and refuse the same
 * things on PGLite and Postgres (in-memory PGLite; Postgres too when
 * DATABASE_URL is set).
 *
 * Rust engine contract. Differences pinned here, with the engine the Rust
 * engine must match:
 * - An undefined argument. PGLite binds undefined as SQL NULL: a write fails
 *   the not-null check (23502) and a read matches nothing. Postgres refuses
 *   it before SQL (UNDEFINED_VALUE). Rust matches Postgres.
 * - putRawData with data null. PGLite stores a JSON null; Postgres binds SQL
 *   NULL and fails the not-null check (23502). Rust matches Postgres.
 * - A date the server cannot read. PGLite lets the server parse validFrom
 *   and asof: an impossible date ('2026-02-30') is 22008 and text that is not
 *   a date is 22007. Postgres parses them in JS first: text that is not a
 *   date is refused with "Invalid Date", and an impossible date silently
 *   becomes another date (2026-03-02). Open decision; until it is made, Rust
 *   refuses both before any write.
 * Everything else below is one answer on both engines, and Rust must give it:
 * - mergeOntologyFact: dimensions are normalized (trim, lower case, spaces
 *   and hyphens to '_', aliases such as 'job title' -> 'role'); a dimension
 *   outside the seed list is stored 'quarantined'. Values dedup after trim and
 *   lower case. The same provenance again is 'noop'; another provenance of
 *   the current value is 'corroborated' (stored expired); a later different
 *   value is 'superseded_prior' and closes the prior at its valid_from; an
 *   earlier different value is 'inserted' and closes nothing. confidence
 *   outside 0..1 or NaN and a visibility other than private/world are 23514;
 *   any other status is stored as given. An unknown source is 23503.
 * - getOntology resolves one value per dimension: newest valid_from, then
 *   confidence, then id. It hides observations whose provenance or entity
 *   page is soft-deleted, skips quarantined rows unless asked, and treats
 *   visibility [] as "nothing". sourceIds [] falls back to sourceId, and no
 *   source scope reads every source.
 * - findOntologyConflicts groups by entity slug and dimension across every
 *   source it may read, and lists each conflict's values in fact id order.
 * - getRawData lists rows by page source, then raw-data source. An unscoped
 *   putRawData writes to every page with that slug. Rows follow the page's
 *   soft delete on read, but putRawData still writes to a soft-deleted page.
 * - Files are keyed by storage_path alone: an upsert from another source
 *   takes over the existing row (the source_id stays, the page link is
 *   replaced). listFilesForPage is in created_at order, then id, and still
 *   lists the files of a soft-deleted page.
 *
 * 1. Protects: the nine methods above: normalization, dedup and supersede
 *    actions, the stored fact columns, as-of, confidence, quarantine,
 *    visibility, privacy, diary and deleted-page gates, source scope, conflict
 *    grouping and value order, raw-data order and scope, file identity, file
 *    order and the refusal for each invalid input.
 * 2. Fails when: an engine changes a merge action, a stored column, a read
 *    gate, a scope rule, an order, a file takeover rule, or starts to accept
 *    or refuse an input with another code.
 * 3. Existing coverage: test/engine-parity (typed-methods branch) has happy
 *    path cases for each method; test/chronicle-ontology*.test.ts,
 *    test/export-raw-include-deleted.test.ts and test/engine-upsertFile.test.ts
 *    cover features on one engine. No file compares edge inputs, refusals or
 *    row order across the two engines.
 * 4. Real seams: the engines' public methods. Deletion, created_at ties and
 *    row moves inside the table are set with SQL so each case is pinned.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

/** One case result per engine, compared at the end of the file. */
const seen = new Map<TestBackend, Record<string, unknown>>();
/** Results that differ by design, checked against the pinned values per engine. */
const pinned = new Map<TestBackend, Record<string, unknown>>();
const backends = testBackends();
const startedAt = Date.now();

function record(kind: TestBackend, name: string, value: unknown, into = seen): void {
  const run = into.get(kind) ?? {};
  run[name] = value;
  into.set(kind, run);
}

/** 'done' for a call that returns nothing, the value otherwise, or the refusal code (the message when there is no code). */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    return value === undefined ? 'done' : { ok: value };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { refused: err.code ?? (e instanceof TypeError ? 'TypeError' : String(err.message)) };
  }
}

/** A timestamp as ISO text, or 'now' when the engine filled it in during this run. */
function when(v: unknown): unknown {
  if (!(v instanceof Date)) return v;
  return v.getTime() >= startedAt - 60_000 ? 'now' : v.toISOString();
}

/** A merge result without its generated ids. */
function action(r: unknown): unknown {
  const x = r as { ok?: { action: string; factId: unknown; supersededId: unknown } };
  return x.ok ? `${x.ok.action}${x.ok.factId == null ? '' : ' +id'}${x.ok.supersededId == null ? '' : ' closes'}` : r;
}

for (const kind of backends) {
  describe(`ontology, raw data and files (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const raw = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql);
    const page = (slug: string, sourceId?: string, frontmatter: Record<string, unknown> = {}) =>
      engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: 'x', timeline: '', frontmatter } as never, sourceId ? { sourceId } as never : undefined);
    const merge = (o: Record<string, unknown>) => outcome(() => engine.mergeOntologyFact({ entitySlug: 'people/alice', dimension: 'role', value: 'engineer', source: 'notes/m1', ...o } as never)).then(action);
    const ontology = (opts?: Record<string, unknown>, slug = 'people/alice') => outcome(() => engine.getOntology(slug, opts as never)).then((r) => {
      const x = r as { ok?: Array<Record<string, unknown>> };
      return x.ok ? x.ok.map(({ fact_id, valid_from, valid_to, ...rest }) => {
        expect(typeof fact_id).toBe('number');
        return { ...rest, valid_from: when(valid_from), valid_to: when(valid_to) };
      }) : r;
    });

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await raw(`INSERT INTO sources (id, name) VALUES ('src-b', 'src-b') ON CONFLICT DO NOTHING`);
      for (const slug of ['people/alice', 'notes/m1', 'notes/m2', 'life/diary/d1', 'notes/gone']) await page(slug);
      await page('notes/priv', undefined, { visibility: 'private' });
      await page('people/alice', 'src-b');
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('mergeOntologyFact: normalization, merge actions, stored columns and refusals', async () => {
      const actions = {
        first: await merge({ validFrom: '2026-01-01T00:00:00Z' }),
        sameAgain: await merge({ validFrom: '2026-01-01T00:00:00Z' }),
        sameAfterTrimAndCase: await merge({ value: ' Engineer ', validFrom: '2026-01-01T00:00:00Z' }),
        sameLaterDate: await merge({ validFrom: '2026-01-05T00:00:00Z' }),
        otherProvenance: await merge({ source: 'notes/m2', validFrom: '2026-01-03T00:00:00Z' }),
        otherProvenanceUndated: await merge({ source: 'notes/m2' }),
        aliasSupersedes: await merge({ dimension: 'Job Title', value: 'cto', source: 'notes/m2', validFrom: '2026-03-01T00:00:00Z' }),
        backdated: await merge({ value: 'intern', source: 'notes/m2', validFrom: '2025-01-01T00:00:00Z' }),
        novel: await merge({ dimension: 'Favorite-Color', value: 'blue', validFrom: '2026-01-01T00:00:00Z' }),
        novelAsActive: await merge({ dimension: 'pet', value: 'cat', status: 'active', confidence: 0.2, validFrom: '2026-01-01T00:00:00Z' }),
        undatedFirst: await merge({ dimension: 'location', value: 'SF' }),
        undatedSupersedes: await merge({ dimension: 'location', value: 'NYC', source: 'notes/m2' }),
        privateProvenance: await merge({ dimension: 'employer', value: 'acme', source: 'notes/priv', visibility: 'world', validFrom: '2026-01-01T00:00:00Z' }),
        diaryProvenance: await merge({ dimension: 'affect', value: 'happy', source: 'life/diary/d1', validFrom: '2026-01-01T00:00:00Z' }),
        deletedProvenance: await merge({ dimension: 'expertise', value: 'rust', source: 'notes/gone', validFrom: '2026-01-01T00:00:00Z' }),
        otherSource: await merge({ value: 'chef', sourceId: 'src-b', validFrom: '2026-01-02T00:00:00Z' }),
        unknownStatus: await merge({ dimension: 'risk_tolerance', value: 'low', status: 'weird', validFrom: '2026-01-01T00:00:00Z' }),
        blankDimension: await merge({ dimension: '  ', value: 'x', validFrom: '2026-01-01T00:00:00Z' }),
      };
      expect(actions).toEqual({
        first: 'inserted +id', sameAgain: 'noop', sameAfterTrimAndCase: 'noop', sameLaterDate: 'noop',
        otherProvenance: 'corroborated +id', otherProvenanceUndated: 'noop', aliasSupersedes: 'superseded_prior +id closes',
        backdated: 'inserted +id', novel: 'inserted +id', novelAsActive: 'inserted +id', undatedFirst: 'inserted +id',
        undatedSupersedes: 'superseded_prior +id closes', privateProvenance: 'inserted +id', diaryProvenance: 'inserted +id',
        deletedProvenance: 'inserted +id', otherSource: 'inserted +id', unknownStatus: 'inserted +id', blankDimension: 'inserted +id',
      });
      const refusals = {
        undefinedValue: await merge({ dimension: 'decision_style', value: undefined }),
        nullValue: await merge({ dimension: 'decision_style', value: null }),
        nanConfidence: await merge({ dimension: 'decision_style', value: 'slow', confidence: Number.NaN }),
        confidenceAboveOne: await merge({ dimension: 'decision_style', value: 'slow', confidence: 5 }),
        unknownVisibility: await merge({ dimension: 'decision_style', value: 'slow', visibility: 'secret' }),
        unknownSource: await merge({ dimension: 'decision_style', value: 'slow', sourceId: 'nope' }),
        nulByte: await merge({ dimension: 'decision_style', value: 'a\u0000b' }),
      };
      expect(refusals).toEqual({
        undefinedValue: { refused: 'TypeError' }, nullValue: { refused: 'TypeError' }, nanConfidence: { refused: '23514' },
        confidenceAboveOne: { refused: '23514' }, unknownVisibility: { refused: '23514' }, unknownSource: { refused: '23503' },
        nulByte: { refused: '22021' },
      });
      record(kind, 'undefinedProvenanceMerge', await merge({ dimension: 'decision_style', value: 'fast', source: undefined }), pinned);
      // Dates: kept on a separate entity so a stored row cannot change the shared cases.
      const dates = {
        impossible: await merge({ entitySlug: 'people/zed', dimension: 'reliability', value: 'high', validFrom: '2026-02-30' }),
        notADate: await merge({ entitySlug: 'people/zed', dimension: 'reliability', value: 'low', validFrom: 'not a date' }),
        asofNotADate: await ontology({ asof: 'not a date' }, 'people/zed'),
        stored: (await raw(`SELECT valid_from FROM facts WHERE entity_slug = 'people/zed' ORDER BY id`)).map((r) => when(r.valid_from)),
      };
      record(kind, 'unreadableDates', dates, pinned);
      await raw(`DELETE FROM facts WHERE entity_slug = 'people/zed'`);
      const rows: Array<Record<string, unknown>> = (await raw(`SELECT source_id, dimension, value, dim_status, confidence, source_markdown_slug AS prov, visibility, fact,
          valid_from, valid_until, expired_at IS NULL AS live, consolidated_into IS NOT NULL AS corroborates, superseded_by IS NOT NULL AS superseded
        FROM facts ORDER BY id`)).map((r) => ({ ...r, confidence: Number(r.confidence), valid_from: when(r.valid_from), valid_until: when(r.valid_until) }));
      expect(rows.map((r) => `${r.source_id} ${r.dimension}=${r.value} ${r.dim_status} from=${r.valid_from} until=${r.valid_until}${r.live ? '' : ' expired'}${r.corroborates ? ' corroborates' : ''}${r.superseded ? ' superseded' : ''}`)).toEqual([
        'default role=engineer active from=2026-01-01T00:00:00.000Z until=2026-03-01T00:00:00.000Z superseded',
        'default role=engineer active from=2026-01-03T00:00:00.000Z until=null expired corroborates',
        'default role=cto active from=2026-03-01T00:00:00.000Z until=null',
        'default role=intern active from=2025-01-01T00:00:00.000Z until=null',
        'default favorite_color=blue quarantined from=2026-01-01T00:00:00.000Z until=null',
        'default pet=cat active from=2026-01-01T00:00:00.000Z until=null',
        'default location=SF active from=now until=now superseded',
        'default location=NYC active from=now until=null',
        'default employer=acme active from=2026-01-01T00:00:00.000Z until=null',
        'default affect=happy active from=2026-01-01T00:00:00.000Z until=null',
        'default expertise=rust active from=2026-01-01T00:00:00.000Z until=null',
        'src-b role=chef active from=2026-01-02T00:00:00.000Z until=null',
        'default risk_tolerance=low weird from=2026-01-01T00:00:00.000Z until=null',
        'default =x quarantined from=2026-01-01T00:00:00.000Z until=null',
      ]);
      expect(rows[0]).toMatchObject({ fact: 'role: engineer', confidence: 0.7, prov: 'notes/m1', visibility: 'private' });
      record(kind, 'merge', { actions, refusals, rows });
    });

    test('getOntology: resolution, as-of, gates and source scope', async () => {
      await raw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
      const dims = (r: unknown) => (Array.isArray(r) ? r.map((v: { dimension: string; value: string }) => `${v.dimension}=${v.value}`) : r);
      const reads = {
        current: await ontology(),
        asofFebruary: await ontology({ asof: '2026-02-01T00:00:00Z' }),
        asof2025: await ontology({ asof: '2025-06-01T00:00:00Z' }),
        withQuarantined: await ontology({ includeQuarantined: true }),
        minConfidence: await ontology({ minConfidence: 0.5 }),
        nanMinConfidence: await ontology({ minConfidence: Number.NaN }),
        noVisibility: await ontology({ visibility: [] }),
        worldOnly: await ontology({ visibility: ['world'] }),
        excludePrivate: await ontology({ excludePrivate: true }),
        excludeDiary: await ontology({ excludeDiary: true }),
        otherSource: await ontology({ sourceId: 'src-b' }),
        emptyIdsFallBack: await ontology({ sourceIds: [], sourceId: 'src-b' }),
        federated: await ontology({ sourceIds: ['default'] }),
        missingEntity: await ontology(undefined, 'people/none'),
      };
      expect(dims(reads.current)).toEqual(['affect=happy', 'employer=acme', 'location=NYC', 'pet=cat', 'role=cto']);
      expect((reads.current as unknown[])[4]).toEqual({ dimension: 'role', value: 'cto', confidence: 0.7, source: 'notes/m2', status: 'active', valid_from: '2026-03-01T00:00:00.000Z', valid_to: null });
      // Unscoped reads every source, so the src-b value dated 2026-01-02 is the newest role before February.
      expect(dims(reads.asofFebruary)).toEqual(['affect=happy', 'employer=acme', 'pet=cat', 'role=chef']);
      expect(dims(reads.asof2025)).toEqual(['role=intern']);
      expect(dims(reads.withQuarantined)).toEqual(['=x', 'affect=happy', 'employer=acme', 'favorite_color=blue', 'location=NYC', 'pet=cat', 'risk_tolerance=low', 'role=cto']);
      expect(dims(reads.minConfidence)).toEqual(['affect=happy', 'employer=acme', 'location=NYC', 'role=cto']);
      expect(reads.nanMinConfidence).toEqual([]);
      expect(reads.noVisibility).toEqual([]);
      expect(dims(reads.worldOnly)).toEqual(['employer=acme']);
      expect(dims(reads.excludePrivate)).toEqual(['affect=happy', 'location=NYC', 'pet=cat', 'role=cto']);
      expect(dims(reads.excludeDiary)).toEqual(['employer=acme', 'location=NYC', 'pet=cat', 'role=cto']);
      expect(dims(reads.otherSource)).toEqual(['role=chef']);
      expect(dims(reads.emptyIdsFallBack)).toEqual(['role=chef']);
      expect(dims(reads.federated)).toEqual(dims(reads.current));
      expect(reads.missingEntity).toEqual([]);
      record(kind, 'undefinedEntityRead', await outcome(() => engine.getOntology(undefined as never)), pinned);
      record(kind, 'getOntology', reads);
    });

    test('discoverOntologyDimensions and findOntologyConflicts: counts, grouping and value order', async () => {
      const discover = {
        all: await outcome(() => engine.discoverOntologyDimensions()),
        otherSource: await outcome(() => engine.discoverOntologyDimensions({ sourceId: 'src-b' })),
        emptyIdsReadAll: await outcome(() => engine.discoverOntologyDimensions({ sourceIds: [] })),
      };
      const stat = (r: unknown) => ((r as { ok: Array<{ dimension: string; entities: number; observations: number }> }).ok).map((d) => `${d.dimension}:${d.entities}/${d.observations}`);
      // Corroborations are stored expired, so they do not count; quarantined and closed rows do.
      expect(stat(discover.all)).toEqual(['', 'affect:1/1', 'employer:1/1', 'expertise:1/1', 'favorite_color:1/1', 'location:1/2', 'pet:1/1', 'risk_tolerance:1/1', 'role:1/4'].map((d) => (d === '' ? ':1/1' : d)));
      expect(stat(discover.otherSource)).toEqual(['role:1/1']);
      expect(discover.emptyIdsReadAll).toEqual(discover.all);
      // Move the oldest open role value to the end of the table, so storage order is not id order.
      await raw(`UPDATE facts SET fact = fact || '' WHERE dimension = 'role' AND value = 'intern'`);
      const conflicts = async (opts?: Record<string, unknown>) => {
        const r = await outcome(() => engine.findOntologyConflicts(opts as never));
        const x = r as { ok?: Array<{ entity_slug: string; dimension: string; values: Array<{ fact_id: number } & Record<string, unknown>> }> };
        return x.ok ? x.ok.map((c) => {
          const ids = c.values.map((v) => Number(v.fact_id));
          return { entity: c.entity_slug, dimension: c.dimension, idOrder: ids.every((id, i) => i === 0 || id > ids[i - 1]), values: c.values.map(({ fact_id, ...v }) => v) };
        }) : r;
      };
      const found = {
        all: await conflicts(),
        defaultOnly: await conflicts({ sourceId: 'default' }),
        highConfidence: await conflicts({ minConfidence: 0.8 }),
        excludePrivate: await conflicts({ excludePrivate: true }),
      };
      // Unscoped, the src-b value joins the default entity's conflict: grouping is by slug, not source.
      expect(found.all).toEqual([{ entity: 'people/alice', dimension: 'role', idOrder: true, values: [
        { value: 'cto', source: 'notes/m2', confidence: 0.7 }, { value: 'intern', source: 'notes/m2', confidence: 0.7 }, { value: 'chef', source: 'notes/m1', confidence: 0.7 },
      ] }]);
      // In one source both open role values come from notes/m2, so there is no conflict.
      expect(found.defaultOnly).toEqual([]);
      expect(found.highConfidence).toEqual([]);
      expect(found.excludePrivate).toEqual(found.all);
      record(kind, 'discoverAndConflicts', { discover, found });
    });

    test('putRawData and getRawData: storage, order, scope and soft delete', async () => {
      const put = (slug: string, src: unknown, data: unknown, opts?: unknown) => outcome(() => engine.putRawData(slug, src as never, data as never, opts as never));
      const writes = {
        crustdata: await put('notes/m1', 'crustdata', { a: 1, n: null, s: 'é\u0001', nested: { b: [1, 2] } }),
        exa: await put('notes/m1', 'exa', { z: 1 }),
        replace: await put('notes/m1', 'crustdata', { a: 2 }),
        aaa: await put('notes/m1', 'aaa', { first: true }),
        otherSource: await put('people/alice', 'x', { b: true }, { sourceId: 'src-b' }),
        everySameSlugPage: await put('people/alice', 'y', { both: true }),
        array: await put('notes/m2', 'arr', [1, 'two']),
        string: await put('notes/m2', 'str', 'hello'),
        numbers: await put('notes/m2', 'big', { n: 12345678901234567890, neg: -0, f: 1.5e300 }),
        emptySourceName: await put('notes/m2', '', {}),
        softDeletedPage: await put('notes/gone', 'x', { d: 1 }),
      };
      expect(Object.values(writes).every((w) => w === 'done')).toBe(true);
      const refusals = {
        missingPage: await put('notes/none', 'x', {}),
        missingInSource: await put('notes/m1', 'x', {}, { sourceId: 'src-b' }),
        nulByte: await put('notes/m2', 'nb', { s: 'a\u0000b' }),
      };
      expect(refusals).toEqual({
        missingPage: { refused: 'putRawData failed: page "notes/none" not found' },
        missingInSource: { refused: 'putRawData failed: page "notes/m1" (source=src-b) not found' },
        nulByte: { refused: '22P05' },
      });
      record(kind, 'putRawDataEdges', {
        nullData: await put('notes/m2', 'nul', null),
        undefinedData: await put('notes/m2', 'und', undefined),
        undefinedSourceName: await put('notes/m2', undefined, {}),
      }, pinned);
      await raw(`DELETE FROM raw_data WHERE source = 'nul'`);
      // Rewrite the first row so it moves to the end of the table; the read order must not follow storage.
      await put('notes/m1', 'crustdata', { a: 3 });
      await raw(`UPDATE raw_data SET data = data WHERE source = 'aaa'`);
      const get = (slug: string, src?: string, opts?: unknown) => outcome(() => engine.getRawData(slug, src, opts as never)).then((r) => {
        const x = r as { ok?: Array<Record<string, unknown>> };
        return x.ok ? x.ok.map((row) => { expect(row.fetched_at).toBeInstanceOf(Date); return `${row.source}=${JSON.stringify(row.data)}`; }) : r;
      });
      await put('notes/priv', 'x', { p: 1 });
      const reads = {
        page: await get('notes/m1'),
        oneSource: await get('notes/m1', 'exa'),
        sameSlugUnscoped: await get('people/alice'),
        sameSlugScoped: await get('people/alice', undefined, { sourceId: 'src-b' }),
        federated: await get('people/alice', undefined, { sourceIds: ['src-b'] }),
        emptyIdsFallBack: await get('people/alice', undefined, { sourceIds: [], sourceId: 'src-b' }),
        values: await get('notes/m2'),
        emptySourceNameReadsAll: await get('notes/m2', ''),
        softDeleted: await get('notes/gone'),
        softDeletedIncluded: await get('notes/gone', undefined, { includeDeleted: true }),
        privateExcluded: await get('notes/priv', undefined, { excludePrivate: true }),
        privateIncluded: await get('notes/priv'),
        missingPage: await get('notes/none'),
      };
      expect(reads).toEqual({
        page: ['aaa={"first":true}', 'crustdata={"a":3}', 'exa={"z":1}'],
        oneSource: ['exa={"z":1}'],
        sameSlugUnscoped: ['y={"both":true}', 'x={"b":true}', 'y={"both":true}'],
        sameSlugScoped: ['x={"b":true}', 'y={"both":true}'],
        federated: ['x={"b":true}', 'y={"both":true}'],
        emptyIdsFallBack: ['x={"b":true}', 'y={"both":true}'],
        values: ['={}', 'arr=[1,"two"]', 'big={"f":1.5e+300,"n":12345678901234567000,"neg":0}', 'str="hello"'],
        emptySourceNameReadsAll: ['={}', 'arr=[1,"two"]', 'big={"f":1.5e+300,"n":12345678901234567000,"neg":0}', 'str="hello"'],
        softDeleted: [],
        softDeletedIncluded: ['x={"d":1}'],
        privateExcluded: [],
        privateIncluded: ['x={"p":1}'],
        missingPage: [],
      } as never);
      record(kind, 'undefinedSlugRawRead', await get(undefined as never), pinned);
      record(kind, 'rawData', { writes, refusals, reads });
    });

    test('upsertFile, getFile and listFilesForPage: identity, takeover, order and refusals', async () => {
      const upsert = (spec: Record<string, unknown>) => outcome(() => engine.upsertFile(spec as never)).then((r) => {
        const x = r as { ok?: { id: unknown; created: boolean } };
        return x.ok ? { id: typeof x.ok.id, created: x.ok.created } : r;
      });
      const view = (r: unknown) => {
        const x = r as { ok?: Record<string, unknown> | Array<Record<string, unknown>> | null; refused?: unknown };
        if (!('ok' in x)) return r;
        const one = (row: Record<string, unknown>) => {
          const { id, page_id, created_at, ...rest } = row;
          expect(typeof id).toBe('number');
          expect(created_at).toBeInstanceOf(Date);
          return { ...rest, page_id: page_id == null ? null : page_id === pid ? 'page' : page_id };
        };
        return x.ok == null ? null : Array.isArray(x.ok) ? x.ok.map(one) : one(x.ok);
      };
      const pid = Number((await raw(`SELECT id FROM pages WHERE slug = 'notes/m2' AND source_id = 'default'`))[0].id);
      const writes = {
        first: await upsert({ filename: 'a.png', storage_path: 'img/a.png', content_hash: 'h1', page_slug: 'notes/m2', page_id: pid, size_bytes: 10, mime_type: 'image/png', metadata: { w: 1 } }),
        sameHash: await upsert({ filename: 'a.png', storage_path: 'img/a.png', content_hash: 'h1', page_slug: 'notes/m2', page_id: pid }),
        big: await upsert({ filename: 'c.png', storage_path: 'img/c.png', content_hash: 'h3', page_id: pid, size_bytes: 2 ** 40 }),
        nullMetadata: await upsert({ filename: 'e', storage_path: 'img/e4', content_hash: 'h', metadata: null }),
        negativeSize: await upsert({ filename: 'e', storage_path: 'img/e5', content_hash: 'h', size_bytes: -1 }),
      };
      expect(writes).toEqual({
        first: { id: 'number', created: true }, sameHash: { id: 'number', created: false }, big: { id: 'number', created: true },
        nullMetadata: { id: 'number', created: true }, negativeSize: { id: 'number', created: true },
      });
      // The same hash still rewrites every column: the fields left out are cleared.
      const afterSameHash = view(await outcome(() => engine.getFile('default', 'img/a.png')));
      expect(afterSameHash).toEqual({ source_id: 'default', page_slug: 'notes/m2', filename: 'a.png', storage_path: 'img/a.png', mime_type: null, size_bytes: null, content_hash: 'h1', metadata: {}, page_id: 'page' });
      const refusals = {
        fractionalSize: await upsert({ filename: 'd.png', storage_path: 'img/d.png', content_hash: 'h4', size_bytes: 1.5 }),
        sizePastBigint: await upsert({ filename: 'e', storage_path: 'img/e6', content_hash: 'h', size_bytes: 2 ** 63 }),
        unknownSource: await upsert({ source_id: 'nope', filename: 'e', storage_path: 'img/e', content_hash: 'h' }),
        unknownPage: await upsert({ filename: 'e', storage_path: 'img/e2', content_hash: 'h', page_id: 999_999 }),
        nullHash: await upsert({ filename: 'e', storage_path: 'img/e3', content_hash: null }),
      };
      expect(refusals).toEqual({
        fractionalSize: { refused: '22P02' }, sizePastBigint: { refused: '22003' }, unknownSource: { refused: '23503' },
        unknownPage: { refused: '23503' }, nullHash: { refused: '23502' },
      });
      // Another source with the same storage_path takes over the row; the row keeps its source_id.
      const takeover = {
        write: await upsert({ source_id: 'src-b', filename: 'b.png', storage_path: 'img/a.png', content_hash: 'h2' }),
        asDefault: view(await outcome(() => engine.getFile('default', 'img/a.png'))),
        asOtherSource: view(await outcome(() => engine.getFile('src-b', 'img/a.png'))),
      };
      expect(takeover).toEqual({
        write: { id: 'number', created: false },
        asDefault: { source_id: 'default', page_slug: null, filename: 'b.png', storage_path: 'img/a.png', mime_type: null, size_bytes: null, content_hash: 'h2', metadata: {}, page_id: null },
        asOtherSource: null,
      });
      // Equal created_at: the order falls back to id, not to where the row sits in the table.
      await upsert({ filename: 't1.png', storage_path: 'img/t1.png', content_hash: 't1', page_id: pid });
      await upsert({ filename: 't2.png', storage_path: 'img/t2.png', content_hash: 't2', page_id: pid });
      await raw(`UPDATE files SET created_at = '2026-01-01T00:00:00Z' WHERE page_id = ${pid}`);
      await upsert({ filename: 'c.png', storage_path: 'img/c.png', content_hash: 'h3b', page_id: pid, size_bytes: 2 ** 40 });
      await upsert({ filename: 't1.png', storage_path: 'img/t1.png', content_hash: 't1b', page_id: pid });
      const list = async (id: unknown) => {
        const r = view(await outcome(() => engine.listFilesForPage(id as never)));
        return Array.isArray(r) ? r.map((f) => `${(f as Record<string, unknown>).filename}`) : r;
      };
      const lists = {
        page: await list(pid),
        bigSize: (view(await outcome(() => engine.getFile('default', 'img/c.png'))) as Record<string, unknown>).size_bytes,
        missingPage: await list(424_242),
        nan: await list(Number.NaN),
        fractional: await list(1.5),
        softDeleted: '',
        purged: null as unknown,
      };
      await raw(`UPDATE pages SET deleted_at = now() WHERE id = ${pid}`);
      lists.softDeleted = JSON.stringify(await list(pid));
      await raw(`DELETE FROM pages WHERE id = ${pid}`);
      lists.purged = (view(await outcome(() => engine.getFile('default', 'img/t2.png'))) as Record<string, unknown>).page_id;
      expect(lists).toEqual({
        page: ['c.png', 't1.png', 't2.png'], bigSize: 2 ** 40, missingPage: [], nan: { refused: '22P02' }, fractional: { refused: '22P02' },
        softDeleted: '["c.png","t1.png","t2.png"]', purged: null,
      });
      record(kind, 'undefinedFileArgs', {
        hash: await upsert({ filename: 'e', storage_path: 'img/u1' }),
        path: await upsert({ filename: 'e', content_hash: 'h' }),
        get: view(await outcome(() => engine.getFile(undefined as never, 'img/c.png'))),
        list: await list(undefined),
      }, pinned);
      record(kind, 'files', { writes, afterSameHash, refusals, takeover, lists });
    });
  });
}

describe('ontology, raw data and files: engines agree', () => {
  test('every shared case gives one answer, and each pinned difference holds', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    const undefinedValue = { refused: 'UNDEFINED_VALUE' };
    const expected: Record<TestBackend, Record<string, unknown>> = {
      pglite: {
        undefinedProvenanceMerge: { refused: '23502' },
        unreadableDates: { impossible: { refused: '22008' }, notADate: { refused: '22007' }, asofNotADate: { refused: '22007' }, stored: [] },
        undefinedEntityRead: { ok: [] },
        putRawDataEdges: { nullData: 'done', undefinedData: { refused: '23502' }, undefinedSourceName: { refused: '23502' } },
        undefinedSlugRawRead: [],
        undefinedFileArgs: { hash: { refused: '23502' }, path: { refused: '23502' }, get: null, list: [] },
      },
      postgres: {
        undefinedProvenanceMerge: undefinedValue,
        unreadableDates: { impossible: 'inserted +id', notADate: { refused: 'Invalid Date' }, asofNotADate: { refused: 'Invalid Date' }, stored: ['2026-03-02T00:00:00.000Z'] },
        undefinedEntityRead: undefinedValue,
        putRawDataEdges: { nullData: { refused: '23502' }, undefinedData: undefinedValue, undefinedSourceName: undefinedValue },
        undefinedSlugRawRead: undefinedValue,
        undefinedFileArgs: { hash: undefinedValue, path: undefinedValue, get: undefinedValue, list: undefinedValue },
      },
    };
    for (const b of backends) expect({ engine: b, pins: pinned.get(b) }).toEqual({ engine: b, pins: expected[b] });
  });
});
