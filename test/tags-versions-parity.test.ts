/**
 * Tags and page versions parity: addTag, removeTag, getTags, createVersion,
 * getVersions and revertToVersion store, return and refuse the same things on
 * PGLite and Postgres (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * Rust engine contract. Differences pinned here, with the engine the Rust
 * engine must match:
 * - An undefined argument. PGLite binds undefined as SQL NULL: addTag with an
 *   undefined tag fails the not-null check (23502), and removeTag, getTags and
 *   revertToVersion with an undefined tag, slug or version id quietly match
 *   nothing. Postgres refuses each of them before SQL (UNDEFINED_VALUE). Rust
 *   matches Postgres: an undefined argument is refused before SQL. A null tag
 *   is 23502 on addTag and a no-op on removeTag on both engines.
 * Everything else below is one answer on both engines, and Rust must give it:
 * - Tags are exact strings: case, spaces, '' and emoji are kept as given; a
 *   number is stored as its text. getTags and version tags come back in
 *   code-point (C collation) order: ['', ' a ', '5', 'A', 'B', 'a', 'z', 'é'].
 *   Postgres sorts with the database collation, so its brain here is created
 *   with LC_COLLATE 'C'; on an en_US database Postgres gives en_US order
 *   (follow-up collation_en_us_check).
 * - An explicit addTag claims the tag ('added'); a frontmatter add claims only
 *   a legacy row whose tag_source is NULL and never takes over an 'added' row.
 * - addTag and removeTag work on a soft-deleted page. removeTag of a missing
 *   page or tag does nothing. A source that does not exist is refused with
 *   "Page source does not exist: <id>" before any change.
 * - getTags with sourceIds [] falls back to the scalar source ('default').
 * - getVersions is newest first; equal snapshot_at sorts by id, newest first.
 *   limit 0 returns none; a negative limit is 2201W; a fractional, NaN or
 *   Infinity limit is 22P02. An empty sourceId or empty sourceIds reads every
 *   source.
 * - revertToVersion restores compiled_truth and frontmatter only (title,
 *   timeline and tags stay), moves updated_at, and adds no version. A version
 *   id of another page, an unknown id, an unknown page or a source that does
 *   not hold the version is a silent no-op. A NaN or fractional id is 22P02.
 *   Without sourceId it changes only the page that owns the version.
 * - frontmatter round-trips through jsonb: -0 becomes 0 and integers past
 *   2^53 lose precision as JS numbers. valid_from '2026-02-30' reads as null.
 *
 * 1. Protects: addTag, removeTag, getTags, createVersion, getVersions and
 *    revertToVersion: tag text and order, the tag claim rules, soft-deleted
 *    and private pages, source scope precedence, version snapshot fields,
 *    change reasons, valid time, tie order, limit clamps, revert scope and the
 *    refusal for each invalid input.
 * 2. Fails when: an engine changes a stored or returned value, a claim rule,
 *    a scope or privacy predicate, the version tie order or a limit clamp, a
 *    revert starts to restore or skip a field or to touch another page, or an
 *    invalid input starts to be accepted or refused with another code.
 * 3. Existing coverage: test/engine-parity (typed-methods branch) has happy
 *    path cases for each method; test/get-tags-remote-privacy.test.ts and
 *    test/get-versions-*.test.ts cover features on one engine. No file
 *    compares edge inputs, refusals or tie order across the two engines.
 * 4. Real seams: the engines' public methods. Timestamps, deletion and
 *    legacy tag rows are set with SQL so each case is pinned.
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
    return { refused: err.code ?? String(err.message) };
  }
}

/** A version without its generated fields: ids, the snapshot time and the revision uuid. */
function versionView(v: object): Record<string, unknown> {
  const { id, page_id, snapshot_at, knowledge_revision, ...rest } = v as Record<string, unknown>;
  expect(typeof id).toBe('number');
  expect(typeof page_id).toBe('number');
  expect(snapshot_at).toBeInstanceOf(Date);
  expect(String(knowledge_revision)).toMatch(/^[0-9a-f-]{36}$/);
  return rest;
}

for (const kind of backends) {
  describe(`tags and versions (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const raw = (sql: string) => engine.executeRaw<Record<string, unknown>>(sql);
    const page = (slug: string, body = 'x', sourceId?: string, frontmatter: Record<string, unknown> = {}, title = slug, timeline = '') =>
      engine.putPage(slug, { type: 'note' as never, title, compiled_truth: body, timeline, frontmatter } as never, sourceId ? { sourceId } as never : undefined);
    const tagRows = async () => (await raw(`SELECT p.source_id, p.slug, t.tag, t.tag_source FROM tags t JOIN pages p ON p.id = t.page_id
      ORDER BY p.source_id, p.slug, t.tag COLLATE "C"`)).map((r) => `${r.source_id}:${r.slug} ${JSON.stringify(String(r.tag).length > 20 ? 'long' : r.tag)} ${r.tag_source}`);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1, { collation: 'C' }));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await raw(`INSERT INTO sources (id, name) VALUES ('src-b', 'src-b') ON CONFLICT DO NOTHING`);
      await page('notes/a');
      await page('notes/a', 'x', 'src-b');
      await page('notes/b');
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('addTag: exact text, code-point order, claim rules and refusals', async () => {
      const add = (slug: string, tag: unknown, opts?: unknown) => outcome(() => engine.addTag(slug, tag as never, opts as never));
      // Added out of order, so the read order comes from the engine.
      const adds: Record<string, unknown> = {};
      for (const tag of ['z', 'A', 'a', 'é', 'B', 'z', '', ' a ', '🙂', 'x'.repeat(5000), 5]) adds[`tag:${String(tag).slice(0, 8)}`] = await add('notes/a', tag);
      adds.otherSource = await add('notes/a', 'only-b', { sourceId: 'src-b' });
      expect(Object.values(adds).every((v) => v === 'done')).toBe(true);
      const refusals = {
        nul: await add('notes/a', 'a\u0000b'),
        nullTag: await add('notes/a', null),
        missingPage: await add('notes/none', 'z'),
        missingSource: await add('notes/a', 'z', { sourceId: 'nope' }),
      };
      expect(refusals).toEqual({
        nul: { refused: '22021' },
        nullTag: { refused: '23502' },
        missingPage: { refused: 'addTag failed: page "notes/none" (source=default) not found' },
        missingSource: { refused: 'Page source does not exist: nope' },
      });
      record(kind, 'undefinedTagAdd', await add('notes/a', undefined), pinned);
      // Claim rules: an explicit add claims; a frontmatter add adopts only a legacy NULL row.
      const claims = {
        fm: await add('notes/b', 'fm', { tagSource: 'frontmatter' }),
        fmThenAdded: await add('notes/b', 'fm'),
        fmAgain: await add('notes/b', 'fm', { tagSource: 'frontmatter' }),
        legacy: await raw(`INSERT INTO tags (page_id, tag, tag_source) SELECT id, 'legacy', NULL FROM pages WHERE slug = 'notes/b' AND source_id = 'default'`).then(() => 'done'),
        legacyFm: await add('notes/b', 'legacy', { tagSource: 'frontmatter' }),
        fmOnly: await add('notes/b', 'fm-only', { tagSource: 'frontmatter' }),
      };
      const rows = await tagRows();
      expect(rows).toEqual([
        'default:notes/a "" added', 'default:notes/a " a " added', 'default:notes/a "5" added', 'default:notes/a "A" added',
        'default:notes/a "B" added', 'default:notes/a "a" added', 'default:notes/a "long" added', 'default:notes/a "z" added',
        'default:notes/a "é" added', 'default:notes/a "🙂" added',
        'default:notes/b "fm" added', 'default:notes/b "fm-only" frontmatter', 'default:notes/b "legacy" frontmatter',
        'src-b:notes/a "only-b" added',
      ]);
      record(kind, 'addTag', { adds, refusals, claims, rows });
    });

    test('getTags: scope precedence, soft-deleted and private pages, missing slugs', async () => {
      const get = (slug: string, opts?: unknown) => outcome(() => engine.getTags(slug, opts as never).then((t) => t.map((x) => (x.length > 20 ? 'long' : x))));
      const reads: Record<string, unknown> = {
        scalarDefault: await get('notes/a'),
        otherSource: await get('notes/a', { sourceId: 'src-b' }),
        federated: await get('notes/a', { sourceIds: ['src-b', 'default'] }),
        federatedWinsOverScalar: await get('notes/a', { sourceIds: ['src-b'], sourceId: 'default' }),
        emptyIdsFallsBack: await get('notes/b', { sourceIds: [] }),
        missingSlug: await get('notes/none'),
        missingSource: await get('notes/a', { sourceId: 'nope' }),
      };
      expect(reads.scalarDefault).toEqual({ ok: ['', ' a ', '5', 'A', 'B', 'a', 'long', 'z', 'é', '🙂'] });
      expect(reads.federated).toEqual({ ok: ['', ' a ', '5', 'A', 'B', 'a', 'only-b', 'long', 'z', 'é', '🙂'] });
      expect(reads.federatedWinsOverScalar).toEqual({ ok: ['only-b'] });
      expect(reads.emptyIdsFallsBack).toEqual({ ok: ['fm', 'fm-only', 'legacy'] });
      record(kind, 'undefinedSlugGet', await get(undefined as never), pinned);
      // Soft-deleted: listed unless liveOnly; add and remove still apply.
      await raw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/b'`);
      const deleted = {
        all: await get('notes/b'),
        liveOnly: await get('notes/b', { liveOnly: true }),
        addOnDeleted: await outcome(() => engine.addTag('notes/b', 'after-delete')),
        removeOnDeleted: await outcome(() => engine.removeTag('notes/b', 'fm-only')),
        after: await get('notes/b'),
      };
      expect(deleted).toEqual({
        all: { ok: ['fm', 'fm-only', 'legacy'] }, liveOnly: { ok: [] }, addOnDeleted: 'done', removeOnDeleted: 'done',
        after: { ok: ['after-delete', 'fm', 'legacy'] },
      });
      await raw(`UPDATE pages SET deleted_at = NULL WHERE slug = 'notes/b'`);
      // Private: excludePrivate hides a page marked visibility: private.
      await raw(`UPDATE pages SET frontmatter = '{"visibility": "private"}'::jsonb WHERE slug = 'notes/b'`);
      const privacy = { excluded: await get('notes/b', { excludePrivate: true }), trusted: await get('notes/b') };
      expect(privacy).toEqual({ excluded: { ok: [] }, trusted: { ok: ['after-delete', 'fm', 'legacy'] } });
      await raw(`UPDATE pages SET frontmatter = '{}'::jsonb WHERE slug = 'notes/b'`);
      record(kind, 'getTags', { reads, deleted, privacy });
    });

    test('removeTag: exact match, source scope, silent no-ops and refusals', async () => {
      const rm = (slug: string, tag: unknown, opts?: unknown) => outcome(() => engine.removeTag(slug, tag as never, opts as never));
      const removes = {
        z: await rm('notes/a', 'z'),
        zAgain: await rm('notes/a', 'z'),
        otherCase: await rm('notes/a', 'b'),
        missingPage: await rm('notes/none', 'z'),
        wrongSource: await rm('notes/a', 'A', { sourceId: 'src-b' }),
        nullTag: await rm('notes/a', null),
        missingSource: await rm('notes/a', 'A', { sourceId: 'nope' }),
      };
      expect(removes).toEqual({
        z: 'done', zAgain: 'done', otherCase: 'done', missingPage: 'done', wrongSource: 'done', nullTag: 'done',
        missingSource: { refused: 'Page source does not exist: nope' },
      });
      record(kind, 'undefinedTagRemove', await rm('notes/a', undefined), pinned);
      const after = await engine.getTags('notes/a');
      expect(after.map((x) => (x.length > 20 ? 'long' : x))).toEqual(['', ' a ', '5', 'A', 'B', 'a', 'long', 'é', '🙂']);
      record(kind, 'removeTag', { removes, after, rows: await tagRows() });
    });

    test('createVersion and getVersions: snapshot fields, reasons, valid time, tie order, limits and scope', async () => {
      await page('notes/v', 'Body v1', undefined, { stage: 'one', z: 1, a: { y: 2, b: 3 }, valid_from: '2026-02-30', valid_until: '2026-03-01' }, 'Title 1', '- 2026-01-01: t1');
      for (const tag of ['b', 'B', 'a']) await engine.addTag('notes/v', tag);
      const v1 = await engine.createVersion('notes/v');
      await page('notes/v', 'Body v2', undefined, { stage: 'two' }, 'Title 2', '- 2026-01-02: t2');
      const v2 = await engine.createVersion('notes/v', { reason: 'edited by hand' });
      const created = [v1, v2].map((v) => {
        const view = versionView(v);
        return { compiled_truth: view.compiled_truth, frontmatter: view.frontmatter, timeline: view.timeline, title: view.title, type: view.type, tags: view.tags, is_deleted: view.is_deleted, change_reason: view.change_reason, body_storage: view.body_storage };
      });
      expect(created.map((c) => [c.compiled_truth, c.tags, c.change_reason])).toEqual([
        ['Body v1', ['B', 'a', 'b'], null], ['Body v2', ['B', 'a', 'b'], 'edited by hand'],
      ]);
      // Equal snapshot times: the newer id comes first.
      await raw(`UPDATE page_versions SET snapshot_at = '2026-01-01T00:00:00Z' WHERE page_id = ${Number(v1.page_id)}`);
      const list: Array<Record<string, unknown>> = (await engine.getVersions('notes/v')).map((v) => ({ isV1: v.id === v1.id, ...versionView(v) }));
      expect(list.map((v) => [v.isV1, v.replaced_because, v.valid_from, v.valid_until])).toEqual([
        [false, 'edited by hand', null, null], [true, null, null, '2026-03-01'],
      ]);
      const metaKeys = Object.keys((await engine.getVersions('notes/v', { includeBody: false }))[0]!).sort();
      expect(metaKeys).not.toContain('compiled_truth');
      expect(metaKeys).not.toContain('timeline');
      const count = (opts: object) => outcome(() => engine.getVersions('notes/v', opts as never).then((r) => r.length));
      const limits = {
        zero: await count({ limit: 0 }), one: await count({ limit: 1 }), nullLimit: await count({ limit: null }),
        negative: await count({ limit: -1 }), fractional: await count({ limit: 1.5 }), nan: await count({ limit: NaN }), infinity: await count({ limit: Infinity }),
      };
      expect(limits).toEqual({
        zero: { ok: 0 }, one: { ok: 1 }, nullLimit: { ok: 2 },
        negative: { refused: '2201W' }, fractional: { refused: '22P02' }, nan: { refused: '22P02' }, infinity: { refused: '22P02' },
      });
      const scope = {
        unknownSource: await count({ sourceId: 'nope' }), emptySource: await count({ sourceId: '' }), emptyIds: await count({ sourceIds: [] }),
        missingSlug: await outcome(() => engine.getVersions('notes/none').then((r) => r.length)),
      };
      expect(scope).toEqual({ unknownSource: { ok: 0 }, emptySource: { ok: 2 }, emptyIds: { ok: 2 }, missingSlug: { ok: 0 } });
      // A private snapshot is hidden from an excludePrivate reader.
      await raw(`UPDATE page_versions SET frontmatter = '{"visibility": "private"}'::jsonb WHERE id = ${Number(v1.id)}`);
      const privateRead = (await engine.getVersions('notes/v', { excludePrivate: true })).map((v) => v.compiled_truth);
      expect(privateRead).toEqual(['Body v2']);
      await raw(`UPDATE page_versions SET frontmatter = '{"stage": "one", "z": 1, "a": {"y": 2, "b": 3}, "valid_from": "2026-02-30", "valid_until": "2026-03-01"}'::jsonb WHERE id = ${Number(v1.id)}`);
      // Soft-deleted page, missing page, empty body and jsonb number round-trips.
      await page('notes/w', 'W1');
      await raw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/w'`);
      const edges = {
        deleted: await outcome(() => engine.createVersion('notes/w').then((v) => [v.compiled_truth, v.is_deleted])),
        missing: await outcome(() => engine.createVersion('notes/none')),
        emptyBody: await outcome(async () => { await page('notes/e', ''); const v = await engine.createVersion('notes/e'); return [v.compiled_truth, v.timeline, v.frontmatter]; }),
        numbers: await outcome(async () => {
          await page('notes/n', 'é🙂\u2028', undefined, { k: 'é🙂', big: 12345678901234567890, neg0: -0, tiny: 1.5e300 });
          const v = await engine.createVersion('notes/n');
          return [v.compiled_truth, v.frontmatter];
        }),
      };
      expect(edges).toEqual({
        deleted: { ok: ['W1', true] },
        missing: { refused: 'createVersion failed: page "notes/none" (source=default) not found' },
        emptyBody: { ok: ['', '', {}] },
        numbers: { ok: ['é🙂\u2028', { k: 'é🙂', big: 12345678901234567000, neg0: 0, tiny: 1.5e300 }] },
      });
      await raw(`UPDATE pages SET deleted_at = NULL WHERE slug = 'notes/w'`);
      record(kind, 'versions', { created, list, metaKeys, limits, scope, privateRead, edges });
    });

    test('revertToVersion: restored fields, updated_at, silent no-ops, refusals and source scope', async () => {
      const [v1] = (await engine.getVersions('notes/v')).filter((v) => v.compiled_truth === 'Body v1');
      await engine.addTag('notes/v', 'c');
      await raw(`UPDATE pages SET updated_at = '2026-01-01T00:00:00Z' WHERE slug = 'notes/v'`);
      const revert = await outcome(() => engine.revertToVersion('notes/v', v1!.id));
      const after = await engine.getPage('notes/v');
      const [{ moved }] = await raw(`SELECT updated_at > '2026-01-02T00:00:00Z'::timestamptz AS moved FROM pages WHERE slug = 'notes/v'`);
      const restored = {
        revert, body: after?.compiled_truth, frontmatter: after?.frontmatter, title: after?.title, timeline: after?.timeline,
        tags: await engine.getTags('notes/v'), updatedAtMoved: moved, versions: (await engine.getVersions('notes/v')).length,
      };
      expect(restored).toEqual({
        revert: 'done', body: 'Body v1', frontmatter: { stage: 'one', z: 1, a: { y: 2, b: 3 }, valid_from: '2026-02-30', valid_until: '2026-03-01' },
        title: 'Title 2', timeline: '- 2026-01-02: t2', tags: ['B', 'a', 'b', 'c'], updatedAtMoved: true, versions: 2,
      });
      // No-ops: nothing matches, nothing changes, nothing is refused.
      await page('notes/v', 'Body v3', undefined, { stage: 'three' }, 'Title 2', '- 2026-01-02: t2');
      const [w1] = await engine.getVersions('notes/w');
      const noOps = {
        otherPagesVersion: await outcome(() => engine.revertToVersion('notes/v', w1!.id)),
        unknownId: await outcome(() => engine.revertToVersion('notes/v', 2_000_000_000)),
        unknownPage: await outcome(() => engine.revertToVersion('notes/none', v1!.id)),
        sourceWithoutVersion: await outcome(() => engine.revertToVersion('notes/v', v1!.id, { sourceId: 'src-b' })),
        body: '',
      };
      noOps.body = String((await engine.getPage('notes/v'))?.compiled_truth);
      expect(noOps).toEqual({ otherPagesVersion: 'done', unknownId: 'done', unknownPage: 'done', sourceWithoutVersion: 'done', body: 'Body v3' });
      const refusals = {
        nan: await outcome(() => engine.revertToVersion('notes/v', NaN)),
        fractional: await outcome(() => engine.revertToVersion('notes/v', 1.5)),
      };
      expect(refusals).toEqual({ nan: { refused: '22P02' }, fractional: { refused: '22P02' } });
      record(kind, 'undefinedVersionRevert', await outcome(() => engine.revertToVersion('notes/v', undefined as never)), pinned);
      // Same slug in two sources: an unscoped revert changes only the page that owns the version.
      await page('notes/a', 'B body 1', 'src-b');
      const b1 = await engine.createVersion('notes/a', { sourceId: 'src-b' });
      await page('notes/a', 'B body 2', 'src-b');
      await page('notes/a', 'D body 2');
      const cross = {
        revert: await outcome(() => engine.revertToVersion('notes/a', b1.id)),
        defaultBody: (await engine.getPage('notes/a'))?.compiled_truth,
        otherBody: (await engine.getPage('notes/a', { sourceId: 'src-b' }))?.compiled_truth,
        unscopedVersions: (await engine.getVersions('notes/a')).map((v) => v.compiled_truth),
      };
      expect(cross).toEqual({ revert: 'done', defaultBody: 'D body 2', otherBody: 'B body 1', unscopedVersions: ['B body 1'] });
      record(kind, 'revert', { restored, noOps, refusals, cross });
    });
  });
}

describe('tags and versions: engines agree', () => {
  test('every shared case gives one answer, and each pinned difference holds', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    const expected: Record<TestBackend, Record<string, unknown>> = {
      pglite: { undefinedTagAdd: { refused: '23502' }, undefinedSlugGet: { ok: [] }, undefinedTagRemove: 'done', undefinedVersionRevert: 'done' },
      postgres: {
        undefinedTagAdd: { refused: 'UNDEFINED_VALUE' }, undefinedSlugGet: { refused: 'UNDEFINED_VALUE' },
        undefinedTagRemove: { refused: 'UNDEFINED_VALUE' }, undefinedVersionRevert: { refused: 'UNDEFINED_VALUE' },
      },
    };
    for (const b of backends) expect({ engine: b, pins: pinned.get(b) }).toEqual({ engine: b, pins: expected[b] });
  });
});
