/**
 * BrainEngine parity — versions + raw_files families.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: page version snapshots (create / list / revert / newest at a tier), raw sidecar
 *    data and file metadata rows (listFiles' order included) behave identically on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that snapshots the wrong fields, orders history
 *    differently, reverts the wrong source's row, or drifts on
 *    (source, storage_path) upsert identity — page history, `gbrain
 *    revert`, enrichment sidecars and image assets all read these.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and has no versions/raw/files cases;
 *    per-engine unit tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Version/file ids are sequence-generated, so observables map them to
 *    body text or storage paths and never return the raw id.
 */
import { describe, expect } from 'bun:test';
import type { FileRow } from '../../src/core/engine.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

// FileRow.size_bytes is a JS number on every engine (the files.size_bytes column is BIGINT; Postgres used to
// return it as a BigInt). It is part of the compared view, and `sizeOf` refuses any other type.
const FILE_KEYS = ['source_id', 'page_slug', 'filename', 'storage_path', 'mime_type', 'size_bytes', 'content_hash', 'metadata', 'created_at'] as const;
const fileView = (f: FileRow | null) => (f ? pick(f, FILE_KEYS) : null);
const sizeOf = (f: FileRow | null) => {
  if (f?.size_bytes == null) return null;
  expect(typeof f.size_bytes).toBe('number');
  return f.size_bytes;
};

describe('engine parity: versions', () => {
  parityTest(
    'createVersion snapshots the current page; getVersions lists snapshots newest-first',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      await engine.putPage('notes/ver-a', {
        type: 'note', title: 'Draft one', compiled_truth: 'Body v1.', timeline: '- 2026-01-01: started', frontmatter: { stage: 'draft' },
      });
      const v1 = await engine.createVersion('notes/ver-a');
      await engine.putPage('notes/ver-a', {
        type: 'note', title: 'Draft two', compiled_truth: 'Body v2.', timeline: '- 2026-01-01: started', frontmatter: { stage: 'final' },
      });
      const v2 = await engine.createVersion('notes/ver-a');
      expect(v1.compiled_truth).toBe('Body v1.');
      expect(v2.compiled_truth).toBe('Body v2.');
      expect(v2.id).not.toBe(v1.id);
      const list = await engine.getVersions('notes/ver-a');
      const body = list.map((v) => v.compiled_truth);
      // The two explicit snapshots are in the history, newest first.
      expect(body.indexOf('Body v2.')).toBeLessThan(body.indexOf('Body v1.'));
      const limited = await engine.getVersions('notes/ver-a', { limit: 1 });
      expect(limited).toHaveLength(1);
      const meta = await engine.getVersions('notes/ver-a', { includeBody: false });
      expect('compiled_truth' in meta[0]!).toBe(false);
      const view = (v: (typeof list)[number]) => ({ ...pick(v, ['title', 'type', 'compiled_truth', 'timeline', 'frontmatter', 'tags', 'snapshot_at'] as const) });
      return {
        created: [view(v1), view(v2)],
        list: list.map(view),
        limited: limited.map(view),
        metaTitles: meta.map((m) => m.title),
      };
    },
  );

  parityTest(
    'createVersion snapshots the page\'s stamped trust tier and write origin, not the snapshot writer\'s',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      const declared = <T>(tier: string, origin: Record<string, unknown> | null, fn: (tx: typeof engine) => Promise<T>) =>
        engine.transaction(async (tx) => {
          await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, origin ? JSON.stringify(origin) : '']);
          return fn(tx);
        });
      const trust = (version: object) => {
        const v = version as { trust_tier?: unknown; write_origin?: unknown };
        return {
          tier: v.trust_tier ?? null,
          origin: typeof v.write_origin === 'string' ? JSON.parse(v.write_origin) : v.write_origin ?? null,
        };
      };
      const body = { type: 'note' as const, title: 'Trusted', compiled_truth: 'Curated body.', timeline: '' };
      await declared('operator_curated', { channel: 'import' }, tx => tx.putPage('notes/trusted', body));
      const curated = trust(await engine.createVersion('notes/trusted'));
      expect(curated).toEqual({ tier: 'operator_curated', origin: { channel: 'import' } });
      const byAgent = trust(await declared('agent_written', { channel: 'agent' }, tx => tx.createVersion('notes/trusted')));
      expect(byAgent).toEqual(curated);
      await engine.putPage('notes/plain', { ...body, title: 'Plain' });
      const plain = trust(await engine.createVersion('notes/plain'));
      expect(plain).toEqual({ tier: 'unknown', origin: null });
      const listed = (await engine.getVersions('notes/trusted')).map(v => 'trust_tier' in v);
      return { curated, byAgent, plain, listed };
    },
  );

  parityTest(
    'createVersion stamps a sync\'s Git reason; getVersions shows it, withheld from a remote reader when the successor is private',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      const put = (body: string, frontmatter: Record<string, unknown>) =>
        engine.putPage('notes/why', { type: 'note', title: 'Why', compiled_truth: body, timeline: '', frontmatter });
      await put('Body v1.', {});
      const created = await engine.createVersion('notes/why', { reason: 'Fix the typo', reasonSource: { commit: 'c1', path: 'notes/why.md' } });
      await put('Body v2.', { visibility: 'private' });
      await engine.createVersion('notes/why', { reason: 'Hide the draft', historyGap: true });
      await put('Body v3.', {});
      await engine.createVersion('notes/why', { reason: 'Open it again', historyGap: false });
      await put('Body v4.', {});
      await engine.createVersion('notes/why', { reason: 'Last word' });
      await put('Body v5.', {});
      await engine.createVersion('notes/why', { reason: null });
      const view = (rows: Awaited<ReturnType<typeof engine.getVersions>>) => rows.map((v) => ['compiled_truth' in v ? v.compiled_truth : '-', v.replaced_because ?? null]);
      const seen = {
        // createVersion returns the inserted row, so its stored change_reason too.
        created: (created as { change_reason?: string | null }).change_reason ?? null,
        trusted: view(await engine.getVersions('notes/why')),
        remote: view(await engine.getVersions('notes/why', { excludePrivate: true })),
        remoteMeta: (await engine.getVersions('notes/why', { excludePrivate: true, includeBody: false })).map((v) => v.replaced_because ?? null),
      };
      expect(seen).toEqual({
        created: 'Fix the typo',
        trusted: [['Body v5.', null], ['Body v4.', 'Last word'], ['Body v3.', 'Open it again'], ['Body v2.', 'Hide the draft'], ['Body v1.', 'Fix the typo']],
        remote: [['Body v5.', null], ['Body v4.', 'Last word'], ['Body v3.', 'Open it again'], ['Body v1.', null]],
        remoteMeta: [null, 'Last word', 'Open it again', null],
      });
      return seen;
    },
  );

  parityTest(
    'readLatestVersionIdAtTier answers the page\'s newest version stamped with the tier, or null',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'getPage', 'createVersion', 'readLatestVersionIdAtTier'] },
    async (engine) => {
      const body = { type: 'note' as const, title: 'Tiered', compiled_truth: 'Body.', timeline: '' };
      await engine.putPage('notes/tiered', body);
      const plain = await engine.createVersion('notes/tiered');
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(
          ['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
          ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'import' })],
        );
        await tx.putPage('notes/tiered', { ...body, compiled_truth: 'Curated body.' });
      });
      const curatedOne = await engine.createVersion('notes/tiered');
      const curatedTwo = await engine.createVersion('notes/tiered');
      await engine.putPage('notes/other', { ...body, title: 'Other' });
      await engine.createVersion('notes/other');
      const pageId = (await engine.getPage('notes/tiered'))!.id;
      const otherId = (await engine.getPage('notes/other'))!.id;
      const curated = await engine.readLatestVersionIdAtTier(pageId, 'operator_curated');
      const unknown = await engine.readLatestVersionIdAtTier(pageId, 'unknown');
      expect(curated).toBe(curatedTwo.id);
      // putPage may snapshot the prior body too, so the newest unknown version is the plain snapshot or a later one.
      expect(unknown).not.toBeNull();
      expect(unknown!).toBeGreaterThanOrEqual(plain.id);
      expect(unknown!).toBeLessThan(curatedOne.id);
      return {
        curatedIsNewest: curated === curatedTwo.id,
        unknownBeforeCurated: unknown !== null && unknown >= plain.id && unknown < curatedOne.id,
        agentWritten: await engine.readLatestVersionIdAtTier(pageId, 'agent_written'),
        otherCurated: await engine.readLatestVersionIdAtTier(otherId, 'operator_curated'),
        missingPage: await engine.readLatestVersionIdAtTier(pageId + otherId + 1000, 'operator_curated'),
      };
    },
  );

  parityTest(
    'createVersion on a missing page throws; getVersions of a missing page is empty',
    { methods: ['createVersion', 'getVersions'] },
    async (engine) => {
      let threw = false;
      try {
        await engine.createVersion('notes/no-such-page');
      } catch (error) {
        threw = true;
        expect(String((error as Error).message)).toContain('not found');
      }
      expect(threw).toBe(true);
      return { threw, versions: await engine.getVersions('notes/no-such-page') };
    },
  );

  parityTest(
    'revertToVersion restores body and frontmatter from the snapshot',
    { methods: ['putPage', 'createVersion', 'revertToVersion', 'getPage'] },
    async (engine) => {
      await engine.putPage('notes/rev-a', {
        type: 'note', title: 'Revertable', compiled_truth: 'Original body.', timeline: '', frontmatter: { stage: 'one' },
      });
      const snap = await engine.createVersion('notes/rev-a');
      await engine.putPage('notes/rev-a', {
        type: 'note', title: 'Revertable', compiled_truth: 'Edited body.', timeline: '', frontmatter: { stage: 'two' },
      });
      const edited = await engine.getPage('notes/rev-a');
      expect(edited?.compiled_truth).toBe('Edited body.');
      await engine.revertToVersion('notes/rev-a', snap.id);
      const reverted = await engine.getPage('notes/rev-a');
      expect(reverted?.compiled_truth).toBe('Original body.');
      expect(reverted?.frontmatter.stage).toBe('one');
      return { edited: pick(edited!, ['compiled_truth', 'frontmatter'] as const), reverted: pick(reverted!, ['slug', 'title', 'compiled_truth', 'frontmatter'] as const) };
    },
  );

  parityTest(
    'versions are source-scoped: a same-slug page in another source keeps its own history and revert target',
    { methods: ['putPage', 'createVersion', 'getVersions', 'revertToVersion', 'getPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'ver-other');
      await engine.putPage('notes/shared', { type: 'note', title: 'Default', compiled_truth: 'Default v1.', timeline: '' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Other', compiled_truth: 'Other v1.', timeline: '' }, { sourceId: 'ver-other' });
      await engine.createVersion('notes/shared', { sourceId: 'default' });
      const otherSnap = await engine.createVersion('notes/shared', { sourceId: 'ver-other' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Default', compiled_truth: 'Default v2.', timeline: '' });
      await engine.putPage('notes/shared', { type: 'note', title: 'Other', compiled_truth: 'Other v2.', timeline: '' }, { sourceId: 'ver-other' });
      const defaultBodies = (await engine.getVersions('notes/shared', { sourceId: 'default' })).map((v) => v.compiled_truth);
      const otherBodies = (await engine.getVersions('notes/shared', { sourceId: 'ver-other' })).map((v) => v.compiled_truth);
      expect(defaultBodies).toContain('Default v1.');
      expect(defaultBodies).not.toContain('Other v1.');
      expect(otherBodies).toContain('Other v1.');
      expect(otherBodies).not.toContain('Default v1.');
      await engine.revertToVersion('notes/shared', otherSnap.id, { sourceId: 'ver-other' });
      const defaultPage = await engine.getPage('notes/shared', { sourceId: 'default' });
      const otherPage = await engine.getPage('notes/shared', { sourceId: 'ver-other' });
      expect(defaultPage?.compiled_truth).toBe('Default v2.');
      expect(otherPage?.compiled_truth).toBe('Other v1.');
      return {
        defaultBodies: sorted(defaultBodies),
        otherBodies: sorted(otherBodies),
        defaultPage: defaultPage?.compiled_truth,
        otherPage: otherPage?.compiled_truth,
      };
    },
  );

  parityTest(
    'a change reason stamps the versions after a mark; getVersions reads it as replaced_because',
    { methods: ['putPage', 'getPage', 'createVersion', 'readLatestVersionId', 'stampVersionChangeReason', 'getVersions'] },
    async (engine) => {
      const write = (body: string) => engine.putPage('notes/why', { type: 'note', title: 'Why', compiled_truth: body, timeline: '' });
      await write('Body one.');
      const pageId = Number((await engine.getPage('notes/why'))!.id);
      const none = await engine.readLatestVersionId(pageId);
      const v1 = await engine.createVersion('notes/why');
      const latestIsV1 = (await engine.readLatestVersionId(pageId)) === Number(v1.id);
      const first = await engine.stampVersionChangeReason({ pageId, afterVersionId: 0, reason: 'first edit' });
      await write('Body two.');
      const v2 = await engine.createVersion('notes/why');
      const second = await engine.stampVersionChangeReason({ pageId, afterVersionId: Number(v1.id), reason: 'second edit' });
      await write('Body three.');
      const v3 = await engine.createVersion('notes/why', { reason: 'imported reason' });
      const nothing = await engine.stampVersionChangeReason({ pageId, afterVersionId: Number(v3.id), reason: 'too late' });
      const missing = { latest: await engine.readLatestVersionId(987_654), stamped: await engine.stampVersionChangeReason({ pageId: 987_654, afterVersionId: 0, reason: 'none' }) };
      const latestIsV3 = (await engine.readLatestVersionId(pageId)) === Number(v3.id);
      const history = (await engine.getVersions('notes/why')).map(v => [v.compiled_truth, v.replaced_because ?? null]);
      expect({ none, latestIsV1, first, second, nothing, latestIsV3 }).toEqual({ none: null, latestIsV1: true, first: 1, second: 1, nothing: 0, latestIsV3: true });
      expect(history).toEqual([['Body three.', 'imported reason'], ['Body two.', 'second edit'], ['Body one.', 'first edit']]);
      expect(missing).toEqual({ latest: null, stamped: 0 });
      return { none, latestIsV1, first, second, nothing, latestIsV3, missing, history, created: [v2, v3].map(v => (v as { change_reason?: string | null }).change_reason ?? null) };
    },
  );

  // #8635 on the Rust engine: a sync import passes the (commit, path) its reason came from; a purge that tombstoned that
  // pair drops the reason on every arm (page-state/versions.ts stampableReason; the store reads the tombstone in its write).
  parityTest(
    'createVersion stores the import reason and drops one whose commit and path a purge tombstoned',
    { methods: ['putPage', 'createVersion', 'getVersions', 'writeReasonPurgeTombstones'] },
    async (engine) => {
      await engine.writeReasonPurgeTombstones('default', [{ commit_sha: 'b'.repeat(40), path: 'notes/why.md' }]);
      const write = (title: string) => engine.putPage('notes/why', { type: 'note', title, compiled_truth: `${title}.`, timeline: '' });
      const source = (commit: string) => ({ commit: commit.repeat(40), path: 'notes/why.md' });
      await write('First');
      const first = await engine.createVersion('notes/why', { sourceId: 'default', reason: 'Add the first note', reasonSource: source('a') });
      await write('Second');
      const purged = await engine.createVersion('notes/why', { sourceId: 'default', reason: 'Name a private deal', reasonSource: source('b') });
      await write('Third');
      const empty = await engine.createVersion('notes/why', { sourceId: 'default', reason: '', reasonSource: source('b') });
      await write('Live');
      const created = [first, purged, empty].map((v) => (v as { change_reason?: string | null }).change_reason ?? null);
      expect(created).toEqual(['Add the first note', null, '']);
      const history = (await engine.getVersions('notes/why')).map((v) => [v.title, v.replaced_because ?? null]);
      expect(history).toEqual([['Third', ''], ['Second', null], ['First', 'Add the first note']]);
      return { created, history };
    },
  );

  /** A page whose snapshots differ in privacy: private, named readers, world, pinned question, then a world live page. */
  async function privateHistory(engine: Parameters<Parameters<typeof parityTest>[2]>[0]): Promise<void> {
    const edits: Array<[string, Record<string, unknown>]> = [
      ['Private draft', { visibility: 'private' }],
      ['Team draft', { readable_by: ['alice-example', 'group:team-a'] }],
      ['World draft', {}],
      ['Pinned draft', { pinned_question: true }],
      ['Aliased draft', { access: 'restricted' }],
    ];
    for (const [title, frontmatter] of edits) {
      await engine.putPage('notes/hist', { type: 'note', title, compiled_truth: `${title}.`, timeline: '', frontmatter });
      await engine.createVersion('notes/hist');
    }
    await engine.putPage('notes/hist', { type: 'note', title: 'Live', compiled_truth: 'Live.', timeline: '' });
    await engine.putPage('notes/private-live', { type: 'note', title: 'Shown once', compiled_truth: 'One.', timeline: '' });
    await engine.createVersion('notes/private-live');
    await engine.putPage('notes/private-live', { type: 'note', title: 'Now private', compiled_truth: 'Two.', timeline: '', frontmatter: { visibility: 'private' } });
    await engine.putPage('notes/team-live', { type: 'note', title: 'Team v1', compiled_truth: 'One.', timeline: '' });
    await engine.createVersion('notes/team-live');
    await engine.putPage('notes/team-live', { type: 'note', title: 'Team now', compiled_truth: 'Two.', timeline: '', frontmatter: { readable_by: 'alice-example' } });
  }

  parityTest(
    'getVersions under excludePrivate hides a hidden live page and every private, pinned or reader-named snapshot',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      await privateHistory(engine);
      const titles = async (slug: string, opts: { excludePrivate?: boolean; limit?: number; includeBody?: boolean } = {}) =>
        (await engine.getVersions(slug, opts)).map((v) => v.title);
      const open = await titles('notes/hist');
      const hidden = await titles('notes/hist', { excludePrivate: true });
      const limited = await titles('notes/hist', { excludePrivate: true, limit: 1 });
      const meta = await titles('notes/hist', { excludePrivate: true, includeBody: false });
      const privateLive = await titles('notes/private-live', { excludePrivate: true });
      const teamLive = await titles('notes/team-live', { excludePrivate: true });
      expect(open).toEqual(expect.arrayContaining(['Private draft', 'Team draft', 'World draft', 'Pinned draft', 'Aliased draft']));
      expect(hidden).toContain('World draft');
      expect(hidden).not.toContain('Private draft');
      expect(hidden).not.toContain('Team draft');
      expect(hidden).not.toContain('Pinned draft');
      expect(hidden).not.toContain('Aliased draft');
      expect(limited).toEqual([hidden[0]]);
      expect(meta).toEqual(hidden);
      expect(privateLive).toEqual([]);
      expect(teamLive).toEqual([]);
      const reasons = (await engine.getVersions('notes/hist', { excludePrivate: true })).map((v) => v.replaced_because ?? null);
      return { open, hidden, limited, meta, privateLive, teamLive, reasons };
    },
  );

  parityTest(
    'getVersions under excludePrivate withholds a snapshot\'s reason when the next snapshot is private or names readers',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      const edits: Array<[string, Record<string, unknown>, string]> = [
        ['World one', {}, 'before a private edit'],
        ['Private two', { visibility: 'private' }, 'private edit'],
        ['World three', {}, 'before a reader-named edit'],
        ['Team four', { readable_by: ['alice-example'] }, 'reader-named edit'],
        ['World five', {}, 'before a world edit'],
        ['World six', {}, 'before the live page'],
      ];
      for (const [title, frontmatter, reason] of edits) {
        await engine.putPage('notes/succ', { type: 'note', title, compiled_truth: `${title}.`, timeline: '', frontmatter });
        await engine.createVersion('notes/succ', { reason });
      }
      await engine.putPage('notes/succ', { type: 'note', title: 'Live', compiled_truth: 'Live.', timeline: '' });
      const read = async (excludePrivate: boolean) =>
        (await engine.getVersions('notes/succ', { excludePrivate })).map((v) => [v.title, v.replaced_because ?? null]);
      const trusted = await read(false);
      const world = await read(true);
      expect(trusted).toContainEqual(['World one', 'before a private edit']);
      expect(world).toContainEqual(['World one', null]);
      expect(world).toContainEqual(['World three', null]);
      expect(world).toContainEqual(['World five', 'before a world edit']);
      expect(world).toContainEqual(['World six', 'before the live page']);
      return { trusted, world };
    },
  );

  parityTest(
    'pruneInlineVersionsById deletes exactly the named inline versions of the live page, honors the type fence and keep, and records the history gap',
    { methods: ['putPage', 'getPage', 'createVersion', 'getVersions', 'pruneInlineVersionsById', 'softDeletePage', 'pickValidTimeEdition'] },
    async (engine) => {
      const slug = 'notes/history';
      const labels = new Map<string, string>();
      await engine.putPage(slug, { type: 'note', title: 'History', compiled_truth: 'Body.', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      const ids: number[] = [];
      for (let i = 1; i <= 8; i++) { const v = await engine.createVersion(slug, { sourceId: 'default' }); ids.push(Number(v.id)); labels.set(String(v.id), `v${i}`); }
      const pageId = Number((await engine.getPage(slug, { sourceId: 'default' }))!.id);
      const gap = async () => (await engine.pickValidTimeEdition({ pageId, asOf: '2026-07-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 1_000_000 }))?.gap_at instanceof Date;
      const kept = async () => (await engine.getVersions(slug, { sourceId: 'default', includeBody: false })).map((v) => labels.get(String(v.id)) ?? 'unlabelled');
      const page = { pageId, sourceId: 'default', slug };
      const gapBefore = await gap();
      const refused = [
        await engine.pruneInlineVersionsById(page, []),
        await engine.pruneInlineVersionsById({ ...page, slug: 'notes/moved' }, [ids[0]!]),
        await engine.pruneInlineVersionsById({ ...page, sourceId: 'other' }, [ids[0]!]),
        await engine.pruneInlineVersionsById({ ...page, type: 'person' }, [ids[0]!]),
        await engine.pruneInlineVersionsById({ ...page, pageId: 987_654 }, [ids[0]!]),
      ];
      const afterRefused = await kept();
      const gapRefused = await gap();
      const sparedNewest = await engine.pruneInlineVersionsById({ ...page, keep: 7 }, [ids[0]!, ids[7]!, 424_242]);
      const afterKeep = await kept();
      const named = await engine.pruneInlineVersionsById({ ...page, type: 'note' }, [ids[2]!, ids[3]!, ids[3]!]);
      const afterNamed = await kept();
      const again = await engine.pruneInlineVersionsById({ ...page, type: 'note' }, [ids[2]!, ids[3]!]);
      const gapAfter = await gap();
      await engine.softDeletePage(slug, { sourceId: 'default' });
      const deleted = await engine.pruneInlineVersionsById(page, [ids[1]!]);
      const result = { gapBefore, refused, afterRefused, gapRefused, sparedNewest, afterKeep, named, afterNamed, again, gapAfter, deleted };
      expect(result).toEqual({
        gapBefore: false, refused: [0, 0, 0, 0, 0], afterRefused: ['v8', 'v7', 'v6', 'v5', 'v4', 'v3', 'v2', 'v1'], gapRefused: false, sparedNewest: 1,
        afterKeep: ['v8', 'v7', 'v6', 'v5', 'v4', 'v3', 'v2'], named: 2, afterNamed: ['v8', 'v7', 'v6', 'v5', 'v2'], again: 0, gapAfter: true, deleted: 0,
      });
      return result;
    },
  );

  parityTest(
    'pruneHoldingPageVersions keeps the newest five versions, deletes the older ones and records the history gap',
    { methods: ['putPage', 'getPage', 'createVersion', 'getVersions', 'pruneHoldingPageVersions', 'pickValidTimeEdition'] },
    async (engine) => {
      const slug = 'memory/unattributed';
      const labels = new Map<string, string>();
      await engine.putPage(slug, { type: 'note', title: 'Held', compiled_truth: 'Held body.', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      for (let i = 1; i <= 8; i++) labels.set(String((await engine.createVersion(slug, { sourceId: 'default' })).id), `v${i}`);
      const pageId = Number((await engine.getPage(slug, { sourceId: 'default' }))!.id);
      const gap = async () => (await engine.pickValidTimeEdition({ pageId, asOf: '2026-07-01', excludePrivate: false, pinOrd: null, inlineMaxBytes: 1_000_000 }))?.gap_at instanceof Date;
      const kept = async () => (await engine.getVersions(slug, { sourceId: 'default', includeBody: false })).map((v) => labels.get(String(v.id)) ?? 'unlabelled');
      const gapBefore = await gap();
      const pruned = await engine.pruneHoldingPageVersions(pageId);
      const afterFirst = await kept();
      const again = await engine.pruneHoldingPageVersions(pageId);
      const unknown = await engine.pruneHoldingPageVersions(987_654);
      await engine.putPage('notes/few', { type: 'note', title: 'Few', compiled_truth: 'Few.', timeline: '' });
      await engine.createVersion('notes/few');
      const fewId = Number((await engine.getPage('notes/few'))!.id);
      const few = await engine.pruneHoldingPageVersions(fewId);
      const result = { gapBefore, pruned, afterFirst, again, unknown, few, gapAfter: await gap(), fewVersions: (await engine.getVersions('notes/few')).length };
      expect(result).toEqual({
        gapBefore: false, pruned: 3, afterFirst: ['v8', 'v7', 'v6', 'v5', 'v4'], again: 0, unknown: 0, few: 0, gapAfter: true, fewVersions: 1,
      });
      return result;
    },
  );

  parityTest(
    'getVersions under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      await privateHistory(engine);
      const read = (access: Parameters<typeof withCallerAccess>[0], slug = 'notes/hist') => withCallerAccess(access, async () =>
        (await engine.getVersions(slug, { excludePrivate: true })).map((v) => v.title));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:bob-example'], hidePrivate: true });
      const memberTeam = await read({ identity: ['member:alice-example'], hidePrivate: true }, 'notes/team-live');
      const strangerTeam = await read({ identity: ['member:bob-example'], hidePrivate: true }, 'notes/team-live');
      expect(member).toContain('Team draft');
      expect(member).not.toContain('Private draft');
      expect(granted).toContain('Private draft');
      expect(granted).not.toContain('Pinned draft');
      expect(stranger).not.toContain('Team draft');
      expect(memberTeam).toContain('Team v1');
      expect(strangerTeam).toEqual([]);
      return { member, granted, stranger, memberTeam, strangerTeam };
    },
  );

  parityTest(
    'getVersions under excludePrivate withholds a reason whose successor is hidden from the caller or was pruned',
    { methods: ['putPage', 'createVersion', 'getVersions'] },
    async (engine) => {
      const slug = 'notes/why';
      const write = (body: string, frontmatter: Record<string, unknown>) =>
        engine.putPage(slug, { type: 'note', title: 'Why', compiled_truth: body, timeline: '', frontmatter });
      const steps: Array<[string, Record<string, unknown>, string]> = [
        ['One.', { visibility: 'world' }, 'r1'],
        ['Two.', { visibility: 'world' }, 'r2'],
        ['Three.', { visibility: 'private' }, 'r3'],
        ['Four.', { readable_by: ['bob-example'] }, 'r4'],
      ];
      for (const [body, frontmatter, reason] of steps) {
        await write(body, frontmatter);
        await engine.createVersion(slug, { sourceId: 'default', reason });
      }
      await write('Live.', { visibility: 'world' });
      const reasons = (access?: Parameters<typeof withCallerAccess>[0], target = slug) => {
        const run = async () => (await engine.getVersions(target, access ? { excludePrivate: true } : {}))
          .map((v) => `${v.compiled_truth?.length ? v.compiled_truth : 'large'}:${v.replaced_because ?? null}`);
        return access ? withCallerAccess(access, run) : run();
      };
      const trusted = await reasons();
      const alice = await reasons({ identity: ['member:alice-example'], hidePrivate: true });
      const bob = await reasons({ identity: ['member:bob-example'], hidePrivate: true });
      const aliceGranted = await reasons({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      expect(trusted).toEqual(['Four.:r4', 'Three.:r3', 'Two.:r2', 'One.:r1']);
      expect(alice).toEqual(['Two.:null', 'One.:r1']);
      expect(bob).toEqual(['Four.:r4', 'Two.:null', 'One.:r1']);
      expect(aliceGranted).toEqual(['Three.:null', 'Two.:null', 'One.:r1']);

      // A prune deletes the small version's successor: its reason stays from every excludePrivate reader.
      await engine.putPage('notes/grown', { type: 'note', title: 'Grown', compiled_truth: 'Small.', timeline: '' });
      await engine.createVersion('notes/grown', { sourceId: 'default', reason: 'grew' });
      await engine.putPage('notes/grown', { type: 'note', title: 'Grown', compiled_truth: 'x'.repeat(1024 * 1024 + 1), timeline: '' });
      for (let i = 0; i < 6; i++) await engine.createVersion('notes/grown', { sourceId: 'default' });
      const short = (rows: string[]) => rows.map((r) => r.startsWith('x') ? `large:${r.split(':').pop()}` : r);
      const prunedTrusted = short(await reasons(undefined, 'notes/grown'));
      const prunedRemote = short(await reasons({ identity: [], hidePrivate: true }, 'notes/grown'));
      expect(prunedTrusted).toEqual([...Array(5).fill('large:null'), 'Small.:grew']);
      expect(prunedRemote).toEqual([...Array(5).fill('large:null'), 'Small.:null']);
      return { trusted, alice, bob, aliceGranted, prunedTrusted, prunedRemote };
    },
  );
});

describe('engine parity: raw data + files', () => {
  parityTest(
    'putRawData upserts per (page, source); getRawData filters by source',
    { methods: ['putPage', 'putRawData', 'getRawData'] },
    async (engine) => {
      await engine.putPage('people/raw-alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '' });
      await engine.putRawData('people/raw-alice', 'crustdata', { headline: 'CEO', followers: 10 });
      await engine.putRawData('people/raw-alice', 'linkedin', { title: 'Founder', skills: ['a', 'b'] });
      await engine.putRawData('people/raw-alice', 'crustdata', { headline: 'CEO at Acme', followers: 11 });
      const all = await engine.getRawData('people/raw-alice');
      const one = await engine.getRawData('people/raw-alice', 'crustdata');
      const none = await engine.getRawData('people/raw-alice', 'unknown-source');
      const noPage = await engine.getRawData('people/raw-nobody');
      expect(all).toHaveLength(2);
      expect(one).toHaveLength(1);
      expect(one[0]!.data).toEqual({ headline: 'CEO at Acme', followers: 11 });
      expect(none).toEqual([]);
      expect(noPage).toEqual([]);
      const view = (r: (typeof all)[number]) => pick(r, ['source', 'data', 'fetched_at'] as const);
      return { all: sorted(all.map(view), (r) => r.source), one: one.map(view), none, noPage };
    },
  );

  parityTest(
    'raw data follows the page soft-delete; includeDeleted opts in; sources scope same-slug pages',
    { methods: ['putPage', 'putRawData', 'getRawData', 'softDeletePage', 'restorePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'raw-other');
      await engine.putPage('notes/raw-shared', { type: 'note', title: 'D', compiled_truth: 'D.', timeline: '' });
      await engine.putPage('notes/raw-shared', { type: 'note', title: 'O', compiled_truth: 'O.', timeline: '' }, { sourceId: 'raw-other' });
      await engine.putRawData('notes/raw-shared', 'feed', { who: 'default' }, { sourceId: 'default' });
      await engine.putRawData('notes/raw-shared', 'feed', { who: 'other' }, { sourceId: 'raw-other' });
      const defaultRows = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      const otherRows = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'raw-other' });
      await engine.softDeletePage('notes/raw-shared', { sourceId: 'default' });
      const hidden = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      const shown = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default', includeDeleted: true });
      const otherStill = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'raw-other' });
      await engine.restorePage('notes/raw-shared', { sourceId: 'default' });
      const restored = await engine.getRawData('notes/raw-shared', 'feed', { sourceId: 'default' });
      expect(defaultRows.map((r) => r.data)).toEqual([{ who: 'default' }]);
      expect(otherRows.map((r) => r.data)).toEqual([{ who: 'other' }]);
      expect(hidden).toEqual([]);
      expect(shown.map((r) => r.data)).toEqual([{ who: 'default' }]);
      expect(restored.map((r) => r.data)).toEqual([{ who: 'default' }]);
      return {
        defaultRows: defaultRows.map((r) => r.data),
        otherRows: otherRows.map((r) => r.data),
        hidden: hidden.map((r) => r.data),
        shown: shown.map((r) => r.data),
        otherStill: otherStill.map((r) => r.data),
        restored: restored.map((r) => r.data),
      };
    },
  );

  parityTest(
    'upsertFile creates then no-ops on same hash, updates in place on a new hash; getFile reads by identity',
    { methods: ['upsertFile', 'getFile'] },
    async (engine) => {
      const spec = {
        filename: 'photo.png', storage_path: 'assets/photo.png', mime_type: 'image/png', size_bytes: 1234,
        content_hash: 'hash-1', metadata: { width: 10, height: 20 },
      };
      const created = await engine.upsertFile(spec);
      const same = await engine.upsertFile(spec);
      const replaced = await engine.upsertFile({ ...spec, content_hash: 'hash-2', size_bytes: 4321, metadata: { width: 11, height: 21 } });
      const read = await engine.getFile('default', 'assets/photo.png');
      const missing = await engine.getFile('default', 'assets/missing.png');
      const wrongSource = await engine.getFile('other-source', 'assets/photo.png');
      expect(created.created).toBe(true);
      expect(same.created).toBe(false);
      expect(replaced.created).toBe(false);
      expect(same.id).toBe(created.id);
      expect(replaced.id).toBe(created.id);
      expect(read?.content_hash).toBe('hash-2');
      expect(Number(read?.size_bytes)).toBe(4321);
      return { created: created.created, same: same.created, replaced: replaced.created, read: fileView(read), size: sizeOf(read), missing, wrongSource };
    },
  );

  parityTest(
    'listFilesForPage returns the files attached to that page only',
    { methods: ['putPage', 'upsertFile', 'listFilesForPage', 'getFile'] },
    async (engine) => {
      const alice = await engine.putPage('people/file-alice', { type: 'person', title: 'Alice', compiled_truth: 'A.', timeline: '' });
      const bob = await engine.putPage('people/file-bob', { type: 'person', title: 'Bob', compiled_truth: 'B.', timeline: '' });
      await engine.upsertFile({ page_slug: 'people/file-alice', page_id: alice.id, filename: 'b.png', storage_path: 'a/b.png', content_hash: 'h-b', mime_type: 'image/png', size_bytes: 2 });
      await engine.upsertFile({ page_slug: 'people/file-alice', page_id: alice.id, filename: 'a.png', storage_path: 'a/a.png', content_hash: 'h-a', mime_type: 'image/png', size_bytes: 1 });
      await engine.upsertFile({ page_slug: 'people/file-bob', page_id: bob.id, filename: 'c.png', storage_path: 'a/c.png', content_hash: 'h-c' });
      await engine.upsertFile({ filename: 'orphan.png', storage_path: 'a/orphan.png', content_hash: 'h-o' });
      const forAlice = await engine.listFilesForPage(alice.id);
      const forBob = await engine.listFilesForPage(bob.id);
      const orphan = await engine.getFile('default', 'a/orphan.png');
      expect(forAlice).toHaveLength(2);
      expect(forBob).toHaveLength(1);
      expect(orphan?.page_id).toBeNull();
      expect(forAlice.map(sizeOf).sort()).toEqual([1, 2]);
      return {
        alice: sorted(forAlice.map(fileView), (f) => f!.storage_path),
        aliceSizes: forAlice.map((f) => `${f.storage_path}:${sizeOf(f)}`).sort(),
        bob: forBob.map(fileView),
        orphan: fileView(orphan),
        empty: await engine.listFilesForPage(-1),
      };
    },
  );

  // `gbrain files list [slug]` reads listFiles: the census found the Rust engine refused it (its SQL ran through
  // sqlQueryForEngine). Equal filenames under one slug come back in insertion (id) order on every engine.
  parityTest(
    'listFiles lists every file by page slug then filename, or one slug in any source, up to the limit',
    { methods: ['upsertFile', 'listFiles'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.upsertFile({ page_slug: 'people/bob', filename: 'b.png', storage_path: 'default/b.png', content_hash: 'h1' });
      await engine.upsertFile({ source_id: 'work', page_slug: 'people/alice', filename: 'z.png', storage_path: 'work/z.png', content_hash: 'h2', mime_type: 'image/png', size_bytes: 9 });
      await engine.upsertFile({ filename: 'loose.png', storage_path: 'default/loose.png', content_hash: 'h3' });
      await engine.upsertFile({ page_slug: 'people/alice', filename: 'a.png', storage_path: 'default/a.png', content_hash: 'h4' });
      await engine.upsertFile({ source_id: 'work', page_slug: 'people/alice', filename: 'a.png', storage_path: 'work/a.png', content_hash: 'h5' });
      const paths = (rows: FileRow[]) => rows.map((f) => f.storage_path);
      const all = await engine.listFiles({ limit: 100 });
      expect(paths(all)).toEqual(['default/a.png', 'work/a.png', 'work/z.png', 'default/b.png', 'default/loose.png']);
      const alice = await engine.listFiles({ pageSlug: 'people/alice', limit: 100 });
      expect(paths(alice)).toEqual(['default/a.png', 'work/a.png', 'work/z.png']);
      return {
        all: all.map(fileView),
        firstTwo: paths(await engine.listFiles({ limit: 2 })),
        alice: alice.map(fileView),
        nobody: await engine.listFiles({ pageSlug: 'people/nobody', limit: 100 }),
        none: await engine.listFiles({ limit: 0 }),
      };
    },
  );
});

describe('engine parity: attachments follow a renamed page', () => {
  parityTest(
    'updateSlug moves the page\'s attachments by page id; a slug-only one and another page\'s stay',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'getFile', 'getPage'] },
    async (engine) => {
      await engine.putPage('notes/move-me', { type: 'note', title: 'Move me', compiled_truth: 'x', timeline: '' });
      await engine.putPage('notes/other', { type: 'note', title: 'Other', compiled_truth: 'y', timeline: '' });
      const moved = (await engine.getPage('notes/move-me'))!.id;
      const other = (await engine.getPage('notes/other'))!.id;
      const file = (storage_path: string, page_id: number | null) => engine.upsertFile({
        source_id: 'default', page_slug: 'notes/move-me', page_id, filename: storage_path.split('/').pop()!, storage_path,
        mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {},
      });
      await file('a/bound.png', moved);
      await file('a/loose.png', null);
      await file('a/foreign.png', other);
      expect(await engine.updateSlug('notes/move-me', 'notes/moved', { sourceId: 'default' })).toBe(1);
      const slugOf = async (path: string) => (await engine.getFile('default', path))?.page_slug ?? null;
      const out = { bound: await slugOf('a/bound.png'), loose: await slugOf('a/loose.png'), foreign: await slugOf('a/foreign.png') };
      expect(out).toEqual({ bound: 'notes/moved', loose: 'notes/move-me', foreign: 'notes/move-me' });
      return out;
    },
  );

  parityTest(
    'updateSlug leaves a slug-only attachment an earlier rename left behind when an unrelated page reused the name',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'getFile'] },
    async (engine) => {
      await engine.putPage('notes/reused', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' });
      expect(await engine.updateSlug('notes/reused', 'notes/first-owner', { sourceId: 'default' })).toBe(1);
      await engine.upsertFile({ source_id: 'default', page_slug: 'notes/reused', page_id: null, filename: 'left.png', storage_path: 'b/left.png', mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {} });
      await engine.putPage('notes/reused', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' });
      expect(await engine.updateSlug('notes/reused', 'notes/second-owner', { sourceId: 'default' })).toBe(1);
      const left = (await engine.getFile('default', 'b/left.png'))?.page_slug ?? null;
      expect(left).toBe('notes/reused');
      return { left };
    },
  );

  parityTest(
    'updateSlug leaves a slug-only attachment when a later page reuses the name after the earlier page was deleted',
    { methods: ['putPage', 'upsertFile', 'updateSlug', 'deletePages', 'getFile'] },
    async (engine) => {
      await engine.putPage('notes/scrubbed', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' });
      expect(await engine.updateSlug('notes/scrubbed', 'notes/gone-owner', { sourceId: 'default' })).toBe(1);
      await engine.upsertFile({ source_id: 'default', page_slug: 'notes/scrubbed', page_id: null, filename: 'kept.png', storage_path: 'c/kept.png', mime_type: 'image/png', size_bytes: 1, content_hash: 'h', metadata: {} });
      await engine.deletePages(['notes/gone-owner'], { sourceId: 'default' });
      await engine.putPage('notes/scrubbed', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' });
      expect(await engine.updateSlug('notes/scrubbed', 'notes/new-owner', { sourceId: 'default' })).toBe(1);
      const kept = (await engine.getFile('default', 'c/kept.png'))?.page_slug ?? null;
      expect(kept).toBe('notes/scrubbed');
      return { kept };
    },
  );
});
