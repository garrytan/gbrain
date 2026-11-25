/**
 * BrainEngine parity: the fact reads and supersession writes a remember, a review and a retire send (engine-sql/facts-trust.ts,
 * called from facts/*.ts, ops/facts.ts and persistence/memory-*.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readFactEntitySlugById, readSupersessionReplacement, linkSupersededFact, listFactsToRetireFromPage,
 *    listFactProvenance, readMemberPageWithdrawal, readFactVisibility, readReplacementTarget, readPairFactRow,
 *    expireSupersededFact, restoreSupersededFact, readFactActivity, readReviewAcceptedMark and listFactRowsByIds return the same
 *    observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the Rust brain refused all fourteen with engine_capability_missing, so a remember that replaces a fact, a
 *    proposal review that supersedes or restores a pair, a retire of a page's facts and a recall of facts by id stopped on a Rust
 *    brain, and an engine that answered one differently would change which fact a write replaces, refuses or ends.
 *  - Why existing coverage misses it: test/engine-parity/facts-rest-sites.test.ts compares these members together with members the
 *    Rust brain still refuses, so its Rust arm stops at the first of those and never reaches these.
 *  - Seam: none. The facts, pages and withdrawals are seeded through typed members. Fact ids differ between arms: rows are named by
 *    fact text. Generated timestamps are compared by shape or by relation, never by value. readMemberPageWithdrawal is compared
 *    for a member that is not the page owner with no folder rule; the owner read and the folder rules are not modelled by the
 *    Rust brain (it refuses them), so they are not part of this case.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const at = (s: string) => new Date(s);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const PG_TEXT = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;
const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: 'x', frontmatter });

type Seed = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

/** Insert facts one by one, in array order, and name each id by its fact text (each row keeps a fixed valid_from). */
async function remember(engine: BrainEngine, rows: Seed[], sourceId = SRC): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const r = await engine.insertFact({ source: 'mcp:remember', entity_slug: null, valid_from: new Date(Date.UTC(2026, 4, 1 + i)), ...row }, { source_id: sourceId });
    ids.set(row.fact, r.id);
  }
  return ids;
}

/** Fence-style rows (they carry `source_markdown_slug`, which insertFact does not), named by fact text. */
async function fenced(engine: BrainEngine, rows: Array<Record<string, unknown> & { fact: string }>, sourceId = SRC): Promise<Map<string, number>> {
  const res = await engine.insertFacts(rows.map((r, i) => ({
    entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: i + 1, valid_from: new Date(Date.UTC(2026, 6, 1 + i)), ...r,
  })) as never, { source_id: sourceId });
  return new Map(rows.map((r, i) => [r.fact, Number(res.ids[i])]));
}

/** Maps generated ids back to the names a case gave them. */
const namer = (names: Map<string, number>) => {
  const byId = new Map([...names].map(([name, id]) => [Number(id), name]));
  return (id: number | string | bigint) => byId.get(Number(id)) ?? `unknown:${id}`;
};

describe('engine parity: the fact reads and supersession writes of a remember, a review and a retire', () => {
  parityTest('readFactEntitySlugById, readSupersessionReplacement and linkSupersededFact read the pair a supersession ends and link the old fact to the new one', {
    methods: ['readFactEntitySlugById', 'readSupersessionReplacement', 'linkSupersededFact', 'insertFact', 'insertFacts', 'transaction',
      'listFactsByEntity'],
  }, async (engine) => {
    const loose = await remember(engine, [
      { fact: 'about an entity', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'about nobody', valid_from: at('2026-01-02T00:00:00Z') },
      { fact: 'old claim', entity_slug: 'people/a', valid_from: at('2026-01-03T00:00:00Z'), valid_until: at('2026-04-01T00:00:00Z') },
    ]);
    const page = await fenced(engine, [
      { fact: 'old row', entity_slug: 'people/a', source_markdown_slug: 'notes/p', valid_from: at('2026-02-01T00:00:00Z') },
      { fact: 'new row', entity_slug: 'people/a', source_markdown_slug: 'notes/p', valid_from: at('2026-03-01T00:00:00Z') },
      { fact: 'row elsewhere', entity_slug: 'people/a', source_markdown_slug: 'notes/q', valid_from: at('2026-03-02T00:00:00Z') },
    ]);
    const ids = new Map([...loose, ...page]);
    const id = (n: string) => ids.get(n)!;
    const name = namer(ids);
    const view = (r: Awaited<ReturnType<BrainEngine['readSupersessionReplacement']>>) => r === null ? null : {
      row_num: r.row_num === null ? null : Number(r.row_num), same_page: r.same_page, valid_from: iso(r.valid_from), old_from: iso(r.old_from), old_until: iso(r.old_until),
    };
    const slugs = {
      entity: await engine.readFactEntitySlugById(id('about an entity')),
      none: await engine.readFactEntitySlugById(id('about nobody')),
      missing: await engine.readFactEntitySlugById(999_999),
    };
    const replacement = {
      samePage: view(await engine.readSupersessionReplacement(id('new row'), id('old row'))),
      otherPage: view(await engine.readSupersessionReplacement(id('row elsewhere'), id('old row'))),
      loose: view(await engine.readSupersessionReplacement(id('about an entity'), id('old claim'))),
      bothNoPage: view(await engine.readSupersessionReplacement(id('about nobody'), id('about an entity'))),
      newGone: view(await engine.readSupersessionReplacement(999_999, id('old row'))),
      oldGone: view(await engine.readSupersessionReplacement(id('new row'), 999_999)),
    };
    const pointer = async (n: string) => {
      const row = (await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false, limit: 100 } as never)).find(r => r.fact === n)!;
      return row.superseded_by == null ? null : name(row.superseded_by);
    };
    const before = await pointer('old row');
    await engine.transaction(tx => tx.linkSupersededFact(id('old row'), id('new row')));
    const linked = await pointer('old row');
    await engine.transaction(tx => tx.linkSupersededFact(id('old row'), id('row elsewhere')));
    const relinked = await pointer('old row');
    await engine.transaction(tx => tx.linkSupersededFact(999_999, id('new row')));
    const missingNew = await engine.transaction(tx => tx.linkSupersededFact(id('old claim'), 999_999)).then(() => 'linked', () => 'refused');
    const afterMissing = await pointer('old claim');
    const out = { slugs, replacement, before, linked, relinked, missingNew, afterMissing };
    expect(slugs).toEqual({ entity: 'people/a', none: null, missing: null });
    expect(replacement.samePage).toMatchObject({ same_page: true });
    expect(replacement.otherPage).toMatchObject({ same_page: false });
    expect(replacement.bothNoPage).toMatchObject({ same_page: true, row_num: null });
    expect(replacement.newGone).toBeNull();
    expect(replacement.oldGone).toBeNull();
    expect(out).toMatchObject({ before: null, linked: 'new row', relinked: 'row elsewhere', missingNew: 'refused', afterMissing: null });
    return out;
  });

  parityTest('listFactsToRetireFromPage lists the active facts a session or a page context produced, in id order', {
    methods: ['listFactsToRetireFromPage', 'insertFact', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'by session', entity_slug: 'people/a', source_session: 'sess-1' },
      { fact: 'by exact context', entity_slug: 'people/a', context: 'notes/p' },
      { fact: 'by context pattern', entity_slug: 'people/a', context: 'notes/p#section' },
      { fact: 'unrelated', entity_slug: 'people/a', context: 'notes/q', source_session: 'sess-2' },
      { fact: 'already expired', entity_slug: 'people/a', source_session: 'sess-1' },
    ]);
    await remember(engine, [{ fact: 'in other source', entity_slug: 'people/a', source_session: 'sess-1' }], 'other');
    await engine.expireFact(ids.get('already expired')!);
    const name = namer(ids);
    const read = async (sourceId: string, session: string, slug: string, pattern: string) =>
      (await engine.listFactsToRetireFromPage(sourceId, session, slug, pattern)).map(r => ({ fact: name(r.id), entity: r.entity_slug, slug: r.source_markdown_slug, row_num: r.row_num }));
    const out = {
      all: await read(SRC, 'sess-1', 'notes/p', 'notes/p#%'),
      sessionOnly: await read(SRC, 'sess-1', 'none', 'none%'),
      none: await read(SRC, 'sess-9', 'none', 'none%'),
      otherSource: (await engine.listFactsToRetireFromPage('other', 'sess-1', 'none', 'none%')).length,
    };
    expect(out.all.map(r => r.fact)).toEqual(['by session', 'by exact context', 'by context pattern']);
    expect(out.sessionOnly.map(r => r.fact)).toEqual(['by session']);
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('listFactProvenance reads the stored provenance of the named facts of one source', {
    methods: ['listFactProvenance', 'insertFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'from remember', entity_slug: 'people/a', source: 'mcp:remember' },
      { fact: 'from a cli', entity_slug: 'people/a', source: 'cli:capture' },
      { fact: 'from nowhere', entity_slug: 'people/a', source: 'hook:agent-session' },
    ]);
    const elsewhere = await remember(engine, [{ fact: 'in other source', entity_slug: 'people/a', source: 'mcp:remember' }], 'other');
    const name = namer(new Map([...ids, ...elsewhere]));
    const read = async (sourceId: string, wanted: number[]) =>
      (await engine.listFactProvenance(sourceId, wanted)).map(r => ({ fact: name(r.id), source: r.source })).sort((a, b) => a.fact.localeCompare(b.fact));
    const out = {
      two: await read(SRC, [ids.get('from remember')!, ids.get('from a cli')!, 999_999]),
      otherSource: await read(SRC, [elsewhere.get('in other source')!]),
      inOther: await read('other', [elsewhere.get('in other source')!]),
      none: await read(SRC, []),
    };
    expect(out.two).toEqual([{ fact: 'from a cli', source: 'cli:capture' }, { fact: 'from remember', source: 'mcp:remember' }]);
    expect(out.otherSource).toEqual([]);
    expect(out.inOther).toEqual([{ fact: 'in other source', source: 'mcp:remember' }]);
    return out;
  });

  parityTest('readFactVisibility, readWithdrawalAnchor and readFactActivity read one fact of the source, or null', {
    methods: ['readFactVisibility', 'readWithdrawalAnchor', 'readFactActivity', 'insertFact', 'insertFactWithdrawal', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'a world fact', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'a private fact', entity_slug: 'people/a', visibility: 'private' },
      { fact: 'a withdrawn fact', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'a lapsed fact', entity_slug: 'people/a', visibility: 'world', valid_until: at('2020-01-01T00:00:00Z') },
      { fact: 'an expired fact', entity_slug: 'people/a', visibility: 'world' },
    ]);
    await engine.expireFact(ids.get('an expired fact')!);
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'a withdrawn fact', '*', '2026-06-01T00:00:00Z')).toBe(true);
    const id = (n: string) => ids.get(n)!;
    const out = {
      visibility: {
        world: await engine.readFactVisibility(id('a world fact'), SRC),
        private: await engine.readFactVisibility(id('a private fact'), SRC),
        wrongSource: await engine.readFactVisibility(id('a world fact'), 'other'),
        missing: await engine.readFactVisibility(999_999, SRC),
      },
      anchor: {
        plain: await engine.readWithdrawalAnchor(id('a world fact'), SRC),
        withdrawn: await engine.readWithdrawalAnchor(id('a withdrawn fact'), SRC),
        wrongSource: await engine.readWithdrawalAnchor(id('a withdrawn fact'), 'other'),
        missing: await engine.readWithdrawalAnchor(999_999, SRC),
      },
      activity: {
        active: await engine.readFactActivity(id('a world fact'), SRC),
        lapsed: await engine.readFactActivity(id('a lapsed fact'), SRC),
        expired: await engine.readFactActivity(id('an expired fact'), SRC),
        wrongSource: await engine.readFactActivity(id('a world fact'), 'other'),
        missing: await engine.readFactActivity(999_999, SRC),
      },
    };
    expect(out.anchor.withdrawn).toEqual({ withdrawn: true });
    expect(out.anchor.plain).toEqual({ withdrawn: false });
    expect(out.activity.active!.active).toBe(true);
    expect(out.activity.lapsed!.active).toBe(false);
    expect(out.activity.expired!.active).toBe(false);
    expect(out.visibility.private).toEqual({ visibility: 'private' });
    return out;
  });


  parityTest('readReplacementTarget reads the fact a replace names, with the withdrawal ledger and the remote floor applied', {
    methods: ['readReplacementTarget', 'transaction', 'insertFacts', 'putPage', 'insertFactWithdrawal'],
  }, async (engine) => {
    await engine.putPage('memory/members/alice-example', note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    const ids = await fenced(engine, [
      { fact: 'open row', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'hidden row', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden', visibility: 'private' },
      { fact: 'own page row', entity_slug: 'people/a', source_markdown_slug: 'memory/members/alice-example', visibility: 'private' },
      { fact: 'withdrawn row', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
    ]);
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'withdrawn row', '*', '2026-06-01T00:00:00Z')).toBe(true);
    const view = (row: Awaited<ReturnType<BrainEngine['readReplacementTarget']>>) =>
      row === null ? null : { fact: row.fact, visibility: row.visibility, expired: row.expired_at != null, withdrawn: row.withdrawn, page: row.source_markdown_slug };
    const out: Record<string, unknown> = {};
    for (const name of ['open row', 'hidden row', 'own page row', 'withdrawn row']) {
      const targetId = ids.get(name)!;
      out[name] = {
        local: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, ownPage: null })),
        remote: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, excludePrivate: true, ownPage: null })),
        remoteOwn: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, excludePrivate: true, ownPage: 'memory/members/alice-example' })),
        locked: await engine.transaction(async tx => view(await tx.readReplacementTarget({ targetId, sourceId: SRC, ownPage: null, lock: true }))),
        otherSource: view(await engine.readReplacementTarget({ targetId, sourceId: 'other', ownPage: null })),
      };
    }
    expect(out['withdrawn row']).toMatchObject({ local: { withdrawn: true } });
    expect(out['open row']).toMatchObject({ local: { withdrawn: false }, remote: { fact: 'open row' }, otherSource: null });
    expect((out['hidden row'] as { remote: unknown }).remote).toBeNull();
    expect((out['own page row'] as { remoteOwn: unknown }).remoteOwn).not.toBeNull();
    expect(await engine.readReplacementTarget({ targetId: 999_999, sourceId: SRC, ownPage: null })).toBeNull();
    return out;
  });


  parityTest('readMemberPageWithdrawal finds the withdrawal a save onto a member page meets: its own subject first, another subject only for a row the member reads', {
    methods: ['readMemberPageWithdrawal', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'putPage'],
  }, async (engine) => {
    const PAGE = 'memory/members/alice-example';
    await engine.putPage(PAGE, note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/bob-only', note('Bob only', { readable_by: ['bob-example'] }));
    const ids = await fenced(engine, [
      { fact: 'own subject claim', entity_slug: 'people/a', source_markdown_slug: PAGE, visibility: 'private' },
      { fact: 'wildcard claim', entity_slug: 'people/a', source_markdown_slug: PAGE },
      { fact: 'entity claim on bob page', entity_slug: 'people/a', source_markdown_slug: 'notes/bob-only' },
      { fact: 'entity claim on open page', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
    ]);
    for (const id of ids.values()) await engine.expireFact(id);
    const T = '2026-06-01T00:00:00Z';
    await engine.insertFactWithdrawal(SRC, 'private', 'own subject claim', PAGE, T);
    await engine.insertFactWithdrawal(SRC, 'world', 'wildcard claim', '*', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'entity claim on bob page', 'people/a', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'entity claim on open page', 'people/a', T);
    const view = (row: Awaited<ReturnType<BrainEngine['readMemberPageWithdrawal']>>) => {
      if (row === null) return null;
      expect(row.withdrawn_at).toMatch(PG_TEXT);
      return { subject: row.subject, visibility: row.visibility };
    };
    const ask = async (fact: string, visibility: string, extra: Record<string, unknown> = {}) => view(await engine.readMemberPageWithdrawal({
      sourceId: SRC, visibility, fact, entitySlug: 'people/a', page: PAGE, owner: false, identity: ['member:alice-example'], satisfied: [], ...extra,
    }));
    const out = {
      ownSubject: await ask('own subject claim', 'private'),
      wildcard: await ask('wildcard claim', 'world'),
      bobPage: await ask('entity claim on bob page', 'world'),
      openPage: await ask('entity claim on open page', 'world'),
      noEntity: await ask('entity claim on open page', 'world', { entitySlug: null }),
      wrongVisibility: await ask('wildcard claim', 'private'),
      unknown: await ask('never withdrawn', 'world'),
      otherSource: await ask('wildcard claim', 'world', { sourceId: 'other' }),
    };
    expect(out.ownSubject).toEqual({ subject: PAGE, visibility: 'private' });
    expect(out.wildcard).toEqual({ subject: '*', visibility: 'world' });
    expect(out.unknown).toBeNull();
    return out;
  });


  parityTest('expireSupersededFact and restoreSupersededFact move the old fact of a pair and back, once; readPairFactRow reads it', {
    methods: ['readPairFactRow', 'expireSupersededFact', 'restoreSupersededFact', 'insertFact', 'transaction'],
  }, async (engine) => {
    const ids = await remember(engine, [
      { fact: 'old claim', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'new claim', entity_slug: 'people/a', valid_from: at('2026-02-01T00:00:00Z') },
    ]);
    const name = namer(ids);
    const oldId = ids.get('old claim')!, newId = ids.get('new claim')!;
    const row = async (id: number, lock = false) => {
      const r = await engine.readPairFactRow(id, lock);
      return r === null ? null : {
        fact: r.fact, source_id: r.source_id, entity: r.entity_slug, visibility: r.visibility, expired: r.expired_at != null,
        valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), superseded_by: r.superseded_by == null ? null : name(r.superseded_by as number),
        row_num: r.row_num, page: r.source_markdown_slug,
      };
    };
    const before = await row(oldId);
    const locked = await engine.transaction(async tx => {
      const r = await tx.readPairFactRow(oldId, true);
      return r === null ? null : r.fact;
    });
    const wrongSource = await engine.expireSupersededFact({ oldId, sourceId: 'other', newId, until: null });
    const expiredAt = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: '2026-03-01T00:00:00Z' });
    const afterExpire = await row(oldId);
    const secondExpire = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null });
    const wrongPointer = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: 999_999 });
    const restored = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: newId });
    const afterRestore = await row(oldId);
    const secondRestore = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: newId });
    const nowExpire = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null });
    const nowIso = iso(new Date());
    const afterNow = await row(oldId);
    const out = {
      before, locked, wrongSource, expiredAt, afterExpire, secondExpire, wrongPointer, restored, afterRestore, secondRestore, nowExpire,
      afterNow: { ...afterNow!, valid_until: afterNow!.valid_until! >= afterNow!.valid_from! && afterNow!.valid_until! <= nowIso! },
      missing: await row(999_999),
    };
    expect(out).toMatchObject({ wrongSource: 0, expiredAt: 1, secondExpire: 0, wrongPointer: 0, restored: 1, secondRestore: 0, nowExpire: 1, missing: null });
    expect(out.afterExpire).toMatchObject({ expired: true, valid_until: '2026-03-01T00:00:00.000Z', superseded_by: 'new claim' });
    expect(out.afterRestore).toMatchObject({ expired: false, valid_until: null, superseded_by: null });
    return out;
  });


  parityTest('readReviewAcceptedMark finds an expired fact whose context carries the mark', {
    methods: ['readReviewAcceptedMark', 'insertFact', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'marked and expired', entity_slug: 'people/a', context: 'forgotten: review:7' },
      { fact: 'marked and active', entity_slug: 'people/a', context: 'forgotten: review:7' },
      { fact: 'unmarked and expired', entity_slug: 'people/a', context: 'something else' },
      { fact: 'no context and expired', entity_slug: 'people/a' },
    ]);
    for (const n of ['marked and expired', 'unmarked and expired', 'no context and expired']) await engine.expireFact(ids.get(n)!);
    const name = namer(ids);
    const ask = async (n: string, mark: string, sourceId = SRC) => {
      const r = await engine.readReviewAcceptedMark(ids.get(n)!, sourceId, mark);
      return r === null ? null : name(r.id);
    };
    const out = {
      found: await ask('marked and expired', 'review:7'),
      activeFact: await ask('marked and active', 'review:7'),
      otherMark: await ask('marked and expired', 'review:8'),
      unmarked: await ask('unmarked and expired', 'review:7'),
      noContext: await ask('no context and expired', 'review:7'),
      wrongSource: await ask('marked and expired', 'review:7', 'other'),
    };
    expect(out).toEqual({ found: 'marked and expired', activeFact: null, otherMark: null, unmarked: null, noContext: null, wrongSource: null });
    return out;
  });

  parityTest('listFactRowsByIds reads whole fact rows of the named ids within the named sources', {
    methods: ['listFactRowsByIds', 'insertFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'first', entity_slug: 'people/a', visibility: 'world', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'second', entity_slug: 'people/a', visibility: 'private', valid_from: at('2026-01-02T00:00:00Z') },
    ]);
    const elsewhere = await remember(engine, [{ fact: 'third', entity_slug: 'people/a', valid_from: at('2026-01-03T00:00:00Z') }], 'other');
    const name = namer(new Map([...ids, ...elsewhere]));
    const read = async (sources: string[], wanted: number[]) =>
      (await engine.listFactRowsByIds(sources, wanted)).map(r => ({
        fact: r.fact, name: name(r.id), source: r.source_id, entity: r.entity_slug, visibility: r.visibility, from: iso(r.valid_from), kind: r.kind,
        expired: r.expired_at != null,
      })).sort((a, b) => a.fact.localeCompare(b.fact));
    const every = [...ids.values(), ...elsewhere.values()];
    const out = {
      both: await read([SRC, 'other'], every),
      one: await read([SRC], every),
      someIds: await read([SRC, 'other'], [ids.get('second')!, 999_999]),
      noSources: await read([], every),
      noIds: await read([SRC], []),
    };
    expect(out.both.map(r => r.fact)).toEqual(['first', 'second', 'third']);
    expect(out.one.map(r => r.fact)).toEqual(['first', 'second']);
    expect(out.someIds.map(r => r.fact)).toEqual(['second']);
    expect(out.noSources).toEqual([]);
    expect(out.noIds).toEqual([]);
    return out;
  });
});
