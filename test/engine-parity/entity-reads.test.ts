/**
 * BrainEngine parity — the entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the mention pass time, the mention-due count, identity sibling candidates (also under the private-page
 *    filter), the exact-slug lookup that splits live from retired pages, the extraction lag counts, the pages carrying
 *    an ignored privacy label, whether that notice names a git checkout, and one retirement hop (retired, its trimmed
 *    redirect target, under each hop privacy) return the same observable result on every
 *    engine arm.
 *  - Regression: an engine that counts deleted pages as due, matches a title that only contains the subject, reads a
 *    blank `merged_into` as retired, or returns a page with `readable_by` as an ignored label changes what extract,
 *    the entity resolver and the import notice report.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none. Typed methods only (no executeRaw: D18). On a brain where no mention pass ran there is no pass time
 *    and every live page is due, which is what the Rust store answers. Rows with no defined order are sorted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { ignoredPrivacyLabelRunNotice, sourceHasRepo } from '../../src/core/search/ignored-privacy-labels.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());
const tail = ' tail';

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    ({ type, title, compiled_truth: `${title} body.`, frontmatter }) as Parameters<BrainEngine['putPage']>[1];
  const pages: Array<[string, Parameters<BrainEngine['putPage']>[1], string?]> = [
    ['people/alice-example', page('person', 'Alice', { identity: 'alice-1' })],
    ['people/alice-founder', page('person', 'Founder: alice', { identity: { b: 1, a: [true] } })],
    ['people/alice-q', page('person', 'Alice', { quarantine: true })],
    ['people/alice-sis', page('person', 'Alicesis')],
    ['companies/alice', page('company', 'Alice')],
    ['people/old', page('person', 'Old', { status: 'Redirect' })],
    ['people/merged', page('person', 'Merged', { merged_into: 'people/alice-example' })],
    ['people/blank', page('person', 'Blank', { merged_into: '  ', canonical: true })],
    ['people/not-canonical', page('person', 'Not canonical', { canonical: 'No' })],
    ['people/aliases', page('person', 'Aliases', { status: 'aliases' })],
    ['people/gone', page('person', 'Gone')],
    ['notes/label', page('note', 'Label', { access: 'team-only' })],
    ['notes/label-2', page('note', 'Label two', { confidentiality: 'board' })],
    ['notes/readers', page('note', 'Readers', { access: 'team-only', readable_by: ['alice-example'] })],
    ['notes/visible', page('note', 'Visible', { access: 'team-only', visibility: 'public' })],
    ['notes/plain', page('note', 'Plain')],
    ['people/alice-example', page('person', 'Alice'), 'other'],
  ];
  for (const [slug, input, sourceId] of pages) await engine.putPage(slug, input, { sourceId: sourceId ?? 'default' });
  await engine.softDeletePage('people/gone', { sourceId: 'default' });
}

describe('engine parity: entity and mention reads', () => {
  parityTest('readMentionLastPass is null and countPagesDueForMentions counts every live page in scope before any pass',
    { methods: ['readMentionLastPass', 'countPagesDueForMentions'] }, async (engine, backend) => {
      await seed(engine, backend);
      const result = {
        last: await engine.readMentionLastPass(),
        lastDefault: await engine.readMentionLastPass('default'),
        dueAll: await engine.countPagesDueForMentions({ sourceId: null, mentionVersion: 1 }),
        dueDefault: await engine.countPagesDueForMentions({ sourceId: 'default', mentionVersion: 1 }),
        dueOther: await engine.countPagesDueForMentions({ sourceId: 'other', mentionVersion: 1, aliases: { types: ['person'], version: 1 } }),
        dueGhost: await engine.countPagesDueForMentions({ sourceId: 'no-such-source', mentionVersion: 1 }),
      };
      expect(result).toEqual({ last: null, lastDefault: null, dueAll: 16, dueDefault: 15, dueOther: 1, dueGhost: 0 });
      return result;
    });

  parityTest('readIdentitySiblingCandidates matches the title or its ": subject" suffix by slug, typed and capped',
    { methods: ['readIdentitySiblingCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const read = (limit: number, excludeQuarantined?: boolean) =>
        engine.readIdentitySiblingCandidates('default', { types: ['person'], subject: 'alice', limit, excludeQuarantined });
      const all = await read(10);
      expect(all).toEqual([
        { slug: 'people/alice-example', title: 'Alice', type: 'person', identity: 'alice-1' },
        { slug: 'people/alice-founder', title: 'Founder: alice', type: 'person', identity: '{"a": [true], "b": 1}' },
        { slug: 'people/alice-q', title: 'Alice', type: 'person', identity: null },
      ]);
      const unquarantined = (await read(10, true)).map(r => r.slug);
      expect(unquarantined).toEqual(['people/alice-example', 'people/alice-founder']);
      const capped = (await read(1)).map(r => r.slug);
      return { all, unquarantined, capped };
    });

  parityTest('readIdentitySiblingCandidates with excludePrivate applies the private-page filter',
    { methods: ['readIdentitySiblingCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const person = (frontmatter: Record<string, unknown>) =>
        ({ type: 'person', title: 'Alice', compiled_truth: 'Alice body.', frontmatter }) as Parameters<BrainEngine['putPage']>[1];
      await engine.putPage('people/alice-private', person({ visibility: 'private' }), { sourceId: 'default' });
      await engine.putPage('people/alice-readers', person({ readable_by: ['alice-example'] }), { sourceId: 'default' });
      await engine.putPage('people/alice-restricted', person({ access: 'restricted' }), { sourceId: 'default' });
      const read = (excludePrivate: boolean) =>
        engine.readIdentitySiblingCandidates('default', { types: ['person'], subject: 'alice', limit: 10, excludePrivate }).then(rows => rows.map(r => r.slug));
      const result = { open: await read(false), kept: await read(true) };
      expect(result.kept).toEqual(['people/alice-example', 'people/alice-founder', 'people/alice-q']);
      expect(result.open).toEqual([...result.kept.slice(0, 2), 'people/alice-private', 'people/alice-q', 'people/alice-readers', 'people/alice-restricted']);
      return result;
    });

  parityTest('readIdentitySiblingCandidates with excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['readIdentitySiblingCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const person = (frontmatter: Record<string, unknown>) =>
        ({ type: 'person', title: 'Alice', compiled_truth: 'Alice body.', frontmatter }) as Parameters<BrainEngine['putPage']>[1];
      await engine.putPage('people/alice-private', person({ visibility: 'private' }), { sourceId: 'default' });
      await engine.putPage('people/alice-readers', person({ readable_by: ['alice-example'] }), { sourceId: 'default' });
      await engine.putPage('people/alice-team', person({ readable_by: 'group:team-a' }), { sourceId: 'default' });
      await engine.putPage('people/alice-bob-only', person({ readable_by: ['bob-example'] }), { sourceId: 'default' });
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, () =>
        engine.readIdentitySiblingCandidates('default', { types: ['person'], subject: 'alice', limit: 10, excludePrivate: true })
          .then(rows => rows.map(r => r.slug)));
      const result = {
        member: await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true }),
        granted: await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true }),
        stranger: await read({ identity: ['member:carol-example'], hidePrivate: true }),
      };
      expect(result.stranger).toEqual(['people/alice-example', 'people/alice-founder', 'people/alice-q']);
      expect(sorted(result.member)).toEqual(sorted([...result.stranger, 'people/alice-readers', 'people/alice-team']));
      expect(sorted(result.granted)).toEqual(sorted([...result.stranger, 'people/alice-private', 'people/alice-readers']));
      return result;
    });

  parityTest('readIdentitySiblingCandidates with excludePrivate hides every page while a source is owner-only, then only the owner-only source and its concepts',
    { methods: ['readIdentitySiblingCandidates', 'putPage', 'addLink'] }, async (engine, backend) => {
      const put = (slug: string, type: string, sourceId = 'default') =>
        engine.putPage(slug, { type, title: 'Alice', compiled_truth: 'Alice body.' } as Parameters<BrainEngine['putPage']>[1], { sourceId });
      await put('people/alice-open', 'person');
      await put('concepts/alice-lineage', 'concept');
      await put('concepts/alice-plain', 'concept');
      const read = async () => {
        const out: Record<string, string[]> = {};
        for (const sourceId of ['default', 'oo-chat']) {
          out[sourceId] = (await engine.readIdentitySiblingCandidates(sourceId, { types: ['person', 'concept'], subject: 'alice', limit: 10, excludePrivate: true })).map(r => r.slug);
        }
        return out;
      };
      const before = await read();
      await createSource(engine, backend, 'oo-chat', { kind: 'imessage' });
      await put('people/alice-chat', 'person', 'oo-chat');
      // A concept in `default` synthesized from a page of the owner-only source.
      await engine.addLink('concepts/alice-lineage', 'people/alice-chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'oo-chat' });
      const member = { identity: ['member:alice-example', 'group:team-a'], hidePrivate: true };
      // No schema version is recorded on the harness brain: the closed form hides every page while any source is owner-only.
      const closed = await read();
      const closedMember = await withCallerAccess(member, read);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      // Schema version 320 or later: only the owner-only source's pages and the concept built from one are hidden.
      const fn = await withEngineScope(engine, read);
      const fnMember = await withEngineScope(engine, () => withCallerAccess(member, read));
      const result = { before, closed, closedMember, fn, fnMember };
      expect(before).toEqual({ default: ['concepts/alice-lineage', 'concepts/alice-plain', 'people/alice-open'], 'oo-chat': [] });
      expect(closed).toEqual({ default: [], 'oo-chat': [] });
      expect(closedMember).toEqual({ default: [], 'oo-chat': [] });
      expect(fn).toEqual({ default: ['concepts/alice-plain', 'people/alice-open'], 'oo-chat': [] });
      expect(fnMember).toEqual(fn);
      return result;
    });

  parityTest('findExactSlug splits live pages from retired ones; deleted and missing pages are null',
    { methods: ['findExactSlug'] }, async (engine, backend) => {
      await seed(engine, backend);
      const out: Record<string, { live: string | null; retired: string | null }> = {};
      for (const slug of ['people/alice-example', 'people/old', 'people/merged', 'people/blank', 'people/not-canonical', 'people/aliases', 'people/gone', 'people/missing']) {
        out[slug] = {
          live: await engine.findExactSlug('default', [slug], { retired: false }),
          retired: await engine.findExactSlug('default', [slug], { retired: true }),
        };
      }
      expect(out['people/merged']).toEqual({ live: null, retired: 'people/merged' });
      expect(out['people/blank']).toEqual({ live: 'people/blank', retired: null });
      expect(out['people/gone']).toEqual({ live: null, retired: null });
      // A slug list with no filter: the first live page in list order, retired or not.
      const first = {
        retiredFirst: await engine.findExactSlug('default', ['people/missing', 'people/gone', 'people/merged', 'people/blank']),
        liveFirst: await engine.findExactSlug('default', ['people/blank', 'people/merged']),
        none: await engine.findExactSlug('default', ['people/missing', 'people/gone']),
        empty: await engine.findExactSlug('default', []),
      };
      expect(first).toEqual({ retiredFirst: 'people/merged', liveFirst: 'people/blank', none: null, empty: null });
      return { out, first };
    });

  parityTest('readRetirementHop reads one hop: retired or not, the trimmed redirect target, and null for deleted or missing pages',
    { methods: ['readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('people/padded', { type: 'person', title: 'Padded', compiled_truth: 'Padded body.',
        frontmatter: { superseded_by: '  people/old  ', merged_into: 'people/blank' } } as Parameters<BrainEngine['putPage']>[1], { sourceId: 'default' });
      const out: Record<string, unknown> = {};
      for (const slug of ['people/alice-example', 'people/old', 'people/merged', 'people/blank', 'people/not-canonical', 'people/padded', 'people/gone', 'people/missing']) {
        out[slug] = await engine.readRetirementHop('default', slug, 'none');
      }
      out.other = await engine.readRetirementHop('other', 'people/merged', 'none');
      expect(out['people/alice-example']).toEqual({ slug: 'people/alice-example', type: 'person', retired: false, target: null });
      expect(out['people/merged']).toEqual({ slug: 'people/merged', type: 'person', retired: true, target: 'people/alice-example' });
      expect(out['people/old']).toEqual({ slug: 'people/old', type: 'person', retired: true, target: null });
      expect(out['people/blank']).toEqual({ slug: 'people/blank', type: 'person', retired: false, target: null });
      expect(out['people/padded']).toEqual({ slug: 'people/padded', type: 'person', retired: true, target: 'people/old' });
      expect(out['people/gone']).toBeNull();
      expect(out['people/missing']).toBeNull();
      expect(out.other).toBeNull();
      return out;
    });

  parityTest('readRetirementHop applies the hop privacy: the caller page policy, the read floor and member access',
    { methods: ['readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      const person = (frontmatter: Record<string, unknown>) =>
        ({ type: 'person', title: 'Hop', compiled_truth: 'Hop body.', frontmatter }) as Parameters<BrainEngine['putPage']>[1];
      await engine.putPage('people/hop-private', person({ visibility: 'private', merged_into: 'people/alice-example' }), { sourceId: 'default' });
      await engine.putPage('people/hop-readers', person({ readable_by: ['bob-example'] }), { sourceId: 'default' });
      const hop = async (slug: string, privacy: 'none' | 'caller' | 'floor' | 'member_access') =>
        (await engine.readRetirementHop('default', slug, privacy))?.slug ?? null;
      // The read floor under a caller is its own case below: the store refuses it typed.
      const all = async (privacies: ReadonlyArray<'none' | 'caller' | 'floor' | 'member_access'> = ['none', 'caller', 'member_access']) => {
        const r: Record<string, Record<string, string | null>> = {};
        for (const slug of ['people/hop-private', 'people/hop-readers', 'people/alice-example']) {
          r[slug] = {};
          for (const privacy of privacies) r[slug][privacy] = await hop(slug, privacy);
        }
        return r;
      };
      const result = {
        noCaller: await all(['none', 'caller', 'floor', 'member_access']),
        stranger: await withCallerAccess({ identity: ['member:carol-example'], hidePrivate: true }, all),
        bob: await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true }, all),
        granted: await withCallerAccess({ identity: ['member:carol-example'], privateReadableSources: ['default'], hidePrivate: true }, all),
      };
      expect(result.noCaller['people/hop-private'].none).toBe('people/hop-private');
      expect(result.noCaller['people/hop-private'].caller).toBeNull();
      expect(result.noCaller['people/hop-private'].floor).toBeNull();
      expect(result.stranger['people/hop-readers'].member_access).toBeNull();
      expect(result.bob['people/hop-readers'].member_access).toBe('people/hop-readers');
      expect(result.granted['people/hop-private'].caller).toBe('people/hop-private');
      for (const r of Object.values(result)) expect(new Set(Object.values(r['people/alice-example']))).toEqual(new Set(['people/alice-example']));
      return result;
    });

  // The read floor never reads the caller's readers and drops the folder pending-coverage clause for a remote caller, so the
  // store serves it as the page policy of a record with no readers, grants or coverage (retirementHopPolicy, storePageTextPolicy):
  // every arm hides the private page and a page that names the caller, and keeps the live one; the caller's own policy
  // still reads the named page. A labelled-only caller's floor still refuses typed.
  parityTest('readRetirementHop under the read floor for a remote caller hides a private page and a page that names the caller, and keeps a live one on every engine',
    { methods: ['readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('people/hop-private', ({ type: 'person', title: 'Hop', compiled_truth: 'Hop body.',
        frontmatter: { visibility: 'private' } }) as Parameters<BrainEngine['putPage']>[1], { sourceId: 'default' });
      await engine.putPage('people/hop-named', ({ type: 'person', title: 'Named', compiled_truth: 'Named body.',
        frontmatter: { readable_by: ['member:bob-example'] } }) as Parameters<BrainEngine['putPage']>[1], { sourceId: 'default' });
      const floor = await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true }, async () => ({
        hidden: (await engine.readRetirementHop('default', 'people/hop-private', 'floor'))?.slug ?? null,
        named: (await engine.readRetirementHop('default', 'people/hop-named', 'floor'))?.slug ?? null,
        namedForCaller: (await engine.readRetirementHop('default', 'people/hop-named', 'caller'))?.slug ?? null,
        live: (await engine.readRetirementHop('default', 'people/alice-example', 'floor'))?.slug ?? null,
      }));
      expect(floor).toEqual({ hidden: null, named: null, namedForCaller: 'people/hop-named', live: 'people/alice-example' });
      return floor;
    });

  parityTest('readEntityCardRows reads the card candidates: the folded title, the exact slugs, the slug LIKE pattern and the hydrate slugs, with the bounded body prefix',
    { methods: ['readEntityCardRows'] }, async (engine, backend) => {
      await seed(engine, backend);
      const page = (title: string, body: string, frontmatter: Record<string, unknown> = {}) =>
        ({ type: 'person', title, compiled_truth: body, frontmatter }) as Parameters<BrainEngine['putPage']>[1];
      await engine.putPage('people/under_score', page('Under', 'Under body.'), { sourceId: 'default' });
      await engine.putPage('people/underxscore', page('UnderX', 'UnderX body.'), { sourceId: 'default' });
      await engine.putPage('people/hidden', page('ÉLAN Hidden', 'Hidden body.', { visibility: 'private' }), { sourceId: 'default' });
      await engine.putPage('people/long', page('Long', 'é'.repeat(70_000) + tail), { sourceId: 'default' });
      const view = (rows: Awaited<ReturnType<BrainEngine['readEntityCardRows']>>) => sorted(rows.map(r => ({
        slug: r.slug, source_id: r.source_id, title: r.title, type: r.type, frontmatter: r.frontmatter,
        body: r.compiled_truth === null ? null : { chars: [...r.compiled_truth].length, head: r.compiled_truth.slice(0, 12) },
        updated: r.updated_at !== null && !Number.isNaN(new Date(r.updated_at).getTime()),
        retrieved: r.last_retrieved_at,
      })), r => r.slug);
      const slugsOf = (rows: Awaited<ReturnType<BrainEngine['readEntityCardRows']>>) => sorted(rows.map(r => r.slug));
      const result = {
        // `lower(title)`: the folded title matches; the slug list and the LIKE pattern add their own pages.
        name: view(await engine.readEntityCardRows('default', { titleLc: 'alice', slugs: ['people/old', 'people/gone'], slugLike: '%/blank' })),
        // `_` is the LIKE single-character wildcard, so both pages match.
        like: slugsOf(await engine.readEntityCardRows('default', { titleLc: 'nobody', slugs: [], slugLike: '%/under_score' })),
        folded: slugsOf(await engine.readEntityCardRows('default', { titleLc: 'élan hidden', slugs: [], slugLike: '%/none' })),
        foldedPrivate: slugsOf(await engine.readEntityCardRows('default', { titleLc: 'élan hidden', slugs: [], slugLike: '%/none' }, { excludePrivate: true })),
        hydrate: slugsOf(await engine.readEntityCardRows('default', { slugs: ['people/merged', 'people/gone', 'people/hidden', 'people/missing'] })),
        hydratePrivate: slugsOf(await engine.readEntityCardRows('default', { slugs: ['people/merged', 'people/hidden'] }, { excludePrivate: true })),
        other: slugsOf(await engine.readEntityCardRows('other', { slugs: ['people/alice-example', 'people/merged'] })),
        long: view(await engine.readEntityCardRows('default', { slugs: ['people/long'] })),
      };
      expect(result.name.map(r => r.slug)).toEqual(['companies/alice', 'people/alice-example', 'people/alice-q', 'people/blank', 'people/old']);
      expect(result.name.every(r => r.updated && r.retrieved === null)).toBe(true);
      expect(result.like).toEqual(['people/under_score', 'people/underxscore']);
      expect(result.folded).toEqual(['people/hidden']);
      expect(result.foldedPrivate).toEqual([]);
      expect(result.hydrate).toEqual(['people/hidden', 'people/merged']);
      expect(result.hydratePrivate).toEqual(['people/merged']);
      expect(result.other).toEqual(['people/alice-example']);
      expect(result.long[0].body?.chars).toBe(65_536);
      return result;
    });

  parityTest('readEntityCardRows reports when a card page was last retrieved, and null for a page never retrieved',
    { methods: ['putPage', 'getPage', 'bumpPageRetrievals', 'readEntityCardRows'] }, async (engine) => {
      const page = (title: string) => ({ type: 'person', title, compiled_truth: `${title} body.`, frontmatter: {} }) as Parameters<BrainEngine['putPage']>[1];
      await engine.putPage('people/retrieved', page('Retrieved'), { sourceId: 'default' });
      await engine.putPage('people/never', page('Never'), { sourceId: 'default' });
      const id = (await engine.getPage('people/retrieved', { sourceId: 'default' } as never))!.id;
      const before = Date.now();
      await engine.bumpPageRetrievals([Number(id)]);
      const rows = await engine.readEntityCardRows('default', { slugs: ['people/retrieved', 'people/never'] });
      // The retrieval time is the engine's clock at the bump: compared as "set, and not before the bump or in the future".
      const when = (at: Date | string | null) => {
        if (at === null) return 'null';
        const ms = new Date(at).getTime();
        return ms >= before - 1000 && ms <= Date.now() + 1000 ? 'at the bump' : `out of range: ${String(at)}`;
      };
      const out = sorted(rows.map(r => ({ slug: r.slug, retrieved: when(r.last_retrieved_at) })), r => r.slug);
      expect(out).toEqual([{ slug: 'people/never', retrieved: 'null' }, { slug: 'people/retrieved', retrieved: 'at the bump' }]);
      return out;
    });

  parityTest('readIgnoredPrivacyLabelPages returns labelled pages with no readers or visibility, by slug or since a time',
    { methods: ['readIgnoredPrivacyLabelPages'] }, async (engine, backend) => {
      await seed(engine, backend);
      const view = (rows: Awaited<ReturnType<BrainEngine['readIgnoredPrivacyLabelPages']>>) =>
        sorted(rows.map(r => ({ type: r.type, frontmatter: r.frontmatter })), r => JSON.stringify(r));
      const bySlug = view(await engine.readIgnoredPrivacyLabelPages('default',
        { slugs: ['notes/label', 'notes/readers', 'notes/visible', 'notes/plain', 'notes/label'] }));
      const since = view(await engine.readIgnoredPrivacyLabelPages('default', { since: '2000-01-01T00:00:00Z' }));
      const future = view(await engine.readIgnoredPrivacyLabelPages('default', { since: '2999-01-01T00:00:00Z' }));
      const limited = (await engine.readIgnoredPrivacyLabelPages('default', { since: '2000-01-01T00:00:00Z' }, { limit: 1 })).length;
      expect(bySlug).toEqual([{ type: 'note', frontmatter: { access: 'team-only' } }]);
      expect(since.length).toBe(2);
      return { bySlug, since, future, limited };
    });

  parityTest('the ignored-label notice says whether the source keeps a git checkout',
    { methods: ['readIgnoredPrivacyLabelPages', 'getSource', 'getConfig'] }, async (engine, backend) => {
      await seed(engine, backend);
      await createSource(engine, backend, 'checkout', {}, '/var/tmp/parity-checkout');
      await createSource(engine, backend, 'canonical', { canonical: 'git' });
      await createSource(engine, backend, 'plain', { canonical: 'db' });
      const repo = async () => Object.fromEntries(await Promise.all(['default', 'checkout', 'canonical', 'plain', 'missing']
        .map(async id => [id, await sourceHasRepo(engine, id)] as const)));
      const notice = () => ignoredPrivacyLabelRunNotice(engine, 'default', { slugs: ['notes/label'] }, 'import').then(n => n?.user_message);
      const before = { repo: await repo(), notice: await notice() };
      await engine.setConfig('sync.repo_path', '/var/tmp/parity-repo');
      const after = { repo: await repo(), notice: await notice() };
      expect(before.repo).toEqual({ default: false, checkout: true, canonical: true, plain: false, missing: false });
      expect(after.repo.default).toBe(true);
      expect(before.notice).not.toContain('git');
      expect(after.notice).toContain('pushed to git');
      return { before, after };
    });

  parityTest('readExtractionLagCounts returns one row of counts for the source',
    { methods: ['readExtractionLagCounts'] }, async (engine, backend) => {
      await seed(engine, backend);
      const row = await engine.readExtractionLagCounts({ sourceId: 'default', versionTs: '2000-01-01T00:00:00Z', attendance: true, held: true });
      expect(row).toBeDefined();
      return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, v === null ? null : Number(v)]));
    });
});
