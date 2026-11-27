/**
 * BrainEngine parity: the entity identity members of engine-sql/entity-identities.ts (linkEntityIdentityRow,
 * unlinkEntityIdentityRow, listEntityIdentityRows, readEntityIdentityIdsForPages, readCanonicalTwin), which
 * src/core/entity-identity.ts and src/core/google/counterparty.ts used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member gives the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). A link puts a live page in one group (re-linking moves it); a
 *    group has at most one canonical member; `canonical: null` keeps the flag only while the page stays in its group;
 *    a link to a missing or soft-deleted page throws the identity page-not-found error. An unlink removes a live or
 *    soft-deleted page from the named group only. The list keeps live members by entity, canonical first, source,
 *    then slug, under the entity, seed-slug, seed-source, source-grant and page-policy filters. The page lookup
 *    returns the cross product of the asked sources and slugs. The canonical twin is the live canonical member of
 *    the page's group in another source. A hard page delete drops the membership; a soft delete hides it until a
 *    restore. Each case asserts the exact answer, so one arm alone also checks it.
 *  - Regression: an engine that keeps two canonical members, keeps the flag across a group move, unlinks from the
 *    wrong group, lists a soft-deleted or private member, seeds a group from a page outside the caller's grant, or
 *    leaves a membership behind a hard delete, merges or splits a person's pages across sources. A Rust store that
 *    shows an owner-only source's member page to a non-owner caller leaks it; the store hides it as the SQL forms do.
 *  - Why existing coverage misses it: test/entity-identity.test.ts runs the caller functions on PGLite only.
 *  - Order: byte order (PGLite's collation and the Rust store). A Postgres database with a locale collation orders
 *    punctuation differently (TODOS.md); the order case re-sorts the Postgres answer and asserts its set.
 *  - Seam: none for the parity cases (typed methods only). The refusal case drives `unionLinksAcrossIdentity` over a
 *    stub engine whose `listEntityIdentityRows` is the Rust store member over a stub addon.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { unionLinksAcrossIdentity } from '../../src/core/entity-identity.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());
type Backend = Parameters<typeof createSource>[1];

function page(title: string, frontmatter: Record<string, unknown> = {}): PageInput {
  return { type: 'person' as never, title, compiled_truth: `${title} body`, timeline: '', frontmatter };
}

const link = (engine: BrainEngine, entityId: string, sourceId: string, slug: string, canonical: boolean | null = null, confidence = 1) =>
  engine.linkEntityIdentityRow({ entityId, slug, sourceId, confidence, establishedBy: 'manual', canonical });

/** A list row with its stamp checked and dropped: `established_at` is the write time on every engine. */
async function list(engine: BrainEngine, filter: Parameters<BrainEngine['listEntityIdentityRows']>[0]) {
  const found = await engine.listEntityIdentityRows(filter);
  return found.map(({ established_at, ...rest }) => {
    expect(established_at).toBeInstanceOf(Date);
    return rest;
  });
}

const member = (entity_id: string, source_id: string, slug: string, title: string, canonical = false, confidence = 1) =>
  ({ entity_id, source_id, slug, title, confidence, established_by: 'manual', canonical });

/** Two sources holding the same person, written out of byte order. */
async function people(engine: BrainEngine, backend: Backend) {
  await createSource(engine, backend, 'other');
  await engine.putPage('people/alice-example', page('Alice (other)'), { sourceId: 'other' });
  await engine.putPage('people/alice-example', page('Alice Example'));
  await engine.putPage('people/charlie-example', page('Charlie Example'));
}

describe('engine parity: entity identities', () => {
  parityTest(
    'linkEntityIdentityRow keeps one canonical member, keeps the flag within the group and drops it on a move',
    { methods: ['putPage', 'softDeletePage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await people(engine, backend);
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'other', 'people/alice-example');
      const first = await list(engine, { entityId: 'g-alice' });
      expect(first).toEqual([
        member('g-alice', 'default', 'people/alice-example', 'Alice Example', true),
        member('g-alice', 'other', 'people/alice-example', 'Alice (other)'),
      ]);
      // canonical: true demotes the old canonical member in the same write.
      await link(engine, 'g-alice', 'other', 'people/alice-example', true);
      const swapped = await list(engine, { entityId: 'g-alice' });
      expect(swapped).toEqual([
        member('g-alice', 'other', 'people/alice-example', 'Alice (other)', true),
        member('g-alice', 'default', 'people/alice-example', 'Alice Example'),
      ]);
      // A re-link within the group with canonical null keeps the flag and takes the new confidence.
      await link(engine, 'g-alice', 'other', 'people/alice-example', null, 0.5);
      const kept = await list(engine, { entityId: 'g-alice' });
      expect(kept[0]).toEqual(member('g-alice', 'other', 'people/alice-example', 'Alice (other)', true, 0.5));
      // A move to another group with canonical null drops it; the old group has no canonical member left.
      await link(engine, 'g-other', 'other', 'people/alice-example');
      const moved = await list(engine, {});
      expect(moved).toEqual([
        member('g-alice', 'default', 'people/alice-example', 'Alice Example'),
        member('g-other', 'other', 'people/alice-example', 'Alice (other)', false, 1),
      ]);
      // canonical false clears it.
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'default', 'people/alice-example', false);
      const cleared = await list(engine, { entityId: 'g-alice' });
      expect(cleared).toEqual([member('g-alice', 'default', 'people/alice-example', 'Alice Example')]);
      // No live page: the identity page-not-found error, and nothing written.
      await engine.softDeletePage('people/charlie-example');
      const errors: string[] = [];
      for (const slug of ['people/nobody', 'people/charlie-example']) {
        await link(engine, 'g-x', 'default', slug).catch((e: Error) => { errors.push(e.message); });
      }
      expect(errors).toEqual([
        'page not found: people/nobody (source default) — the identity key is (source_id, slug)',
        'page not found: people/charlie-example (source default) — the identity key is (source_id, slug)',
      ]);
      expect(await list(engine, { entityId: 'g-x' })).toEqual([]);
      return { first, swapped, kept, moved, cleared, errors };
    },
  );

  parityTest(
    'unlinkEntityIdentityRow removes a live or soft-deleted page from the named group only',
    { methods: ['putPage', 'softDeletePage', 'restorePage', 'linkEntityIdentityRow', 'unlinkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await people(engine, backend);
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'other', 'people/alice-example');
      await link(engine, 'g-charlie', 'default', 'people/charlie-example');
      const wrong = await engine.unlinkEntityIdentityRow({ entityId: 'g-charlie', slug: 'people/alice-example', sourceId: 'default' });
      const wrongSource = await engine.unlinkEntityIdentityRow({ entityId: 'g-alice', slug: 'people/charlie-example', sourceId: 'other' });
      const missing = await engine.unlinkEntityIdentityRow({ entityId: 'g-alice', slug: 'people/nobody', sourceId: 'default' });
      const live = await engine.unlinkEntityIdentityRow({ entityId: 'g-alice', slug: 'people/alice-example', sourceId: 'other' });
      await engine.softDeletePage('people/charlie-example');
      const soft = await engine.unlinkEntityIdentityRow({ entityId: 'g-charlie', slug: 'people/charlie-example', sourceId: 'default' });
      const again = await engine.unlinkEntityIdentityRow({ entityId: 'g-charlie', slug: 'people/charlie-example', sourceId: 'default' });
      await engine.restorePage('people/charlie-example');
      const after = await list(engine, {});
      expect({ wrong, wrongSource, missing, live, soft, again }).toEqual({ wrong: false, wrongSource: false, missing: false, live: true, soft: true, again: false });
      expect(after).toEqual([member('g-alice', 'default', 'people/alice-example', 'Alice Example', true)]);
      return { wrong, wrongSource, missing, live, soft, again, after };
    },
  );

  parityTest(
    'listEntityIdentityRows composes the entity, seed slug, seed source and source grant filters',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await people(engine, backend);
      await createSource(engine, backend, 'third');
      await engine.putPage('people/alice-example', page('Alice (third)'), { sourceId: 'third' });
      await engine.putPage('people/al', page('Al'), { sourceId: 'third' });
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'other', 'people/alice-example');
      await link(engine, 'g-third', 'third', 'people/alice-example');
      await link(engine, 'g-third', 'third', 'people/al');
      await link(engine, 'g-charlie', 'default', 'people/charlie-example');
      const keys = async (filter: Parameters<BrainEngine['listEntityIdentityRows']>[0]) =>
        (await list(engine, filter)).map((r) => `${r.entity_id}:${r.source_id}:${r.slug}`);
      const out = {
        all: await keys({}),
        entity: await keys({ entityId: 'g-third' }),
        // A slug alone seeds from every source: both groups that hold a page with that slug.
        slug: await keys({ slug: 'people/alice-example' }),
        seeded: await keys({ slug: 'people/alice-example', slugSourceId: 'third' }),
        // The grant limits the members and the seed: a seed page outside it finds no group.
        granted: await keys({ slug: 'people/alice-example', allowedSources: ['default'] }),
        outside: await keys({ slug: 'people/al', allowedSources: ['default', 'other'] }),
        both: await keys({ entityId: 'g-alice', allowedSources: ['other'] }),
        none: await keys({ entityId: 'g-nobody' }),
      };
      expect(out).toEqual({
        all: ['g-alice:default:people/alice-example', 'g-alice:other:people/alice-example', 'g-charlie:default:people/charlie-example',
          'g-third:third:people/al', 'g-third:third:people/alice-example'],
        entity: ['g-third:third:people/al', 'g-third:third:people/alice-example'],
        slug: ['g-alice:default:people/alice-example', 'g-alice:other:people/alice-example', 'g-third:third:people/al', 'g-third:third:people/alice-example'],
        seeded: ['g-third:third:people/al', 'g-third:third:people/alice-example'],
        granted: ['g-alice:default:people/alice-example'],
        outside: [],
        both: ['g-alice:other:people/alice-example'],
        none: [],
      });
      return out;
    },
  );

  parityTest(
    'listEntityIdentityRows under excludePrivate hides private members and seeds under the caller\'s page policy',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await people(engine, backend);
      await engine.putPage('people/alice-private', page('Alice Private', { visibility: 'private' }));
      await engine.putPage('people/alice-readers', page('Alice Readers', { readable_by: ['alice-example'] }));
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'default', 'people/alice-private');
      await link(engine, 'g-alice', 'default', 'people/alice-readers');
      await link(engine, 'g-alice', 'other', 'people/alice-example');
      const slugs = async (filter: Parameters<BrainEngine['listEntityIdentityRows']>[0]) =>
        (await list(engine, filter)).map((r) => `${r.source_id}:${r.slug}`);
      const read = (access: Parameters<typeof withCallerAccess>[0], filter: Parameters<BrainEngine['listEntityIdentityRows']>[0]) =>
        withCallerAccess(access, () => slugs({ ...filter, excludePrivate: true }));
      const out = {
        open: await slugs({ entityId: 'g-alice' }),
        member: await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true }, { entityId: 'g-alice' }),
        granted: await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true }, { entityId: 'g-alice' }),
        stranger: await read({ identity: ['member:bob-example'], hidePrivate: true }, { entityId: 'g-alice' }),
        // A private seed page finds no group for a caller that cannot read it.
        privateSeed: await read({ identity: ['member:bob-example'], hidePrivate: true }, { slug: 'people/alice-private' }),
        grantedSeed: await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true },
          { slug: 'people/alice-private', allowedSources: ['default'] }),
      };
      expect(out).toEqual({
        open: ['default:people/alice-example', 'default:people/alice-private', 'default:people/alice-readers', 'other:people/alice-example'],
        member: ['default:people/alice-example', 'default:people/alice-readers', 'other:people/alice-example'],
        granted: ['default:people/alice-example', 'default:people/alice-private', 'default:people/alice-readers', 'other:people/alice-example'],
        stranger: ['default:people/alice-example', 'other:people/alice-example'],
        privateSeed: [],
        grantedSeed: ['default:people/alice-example', 'default:people/alice-private', 'default:people/alice-readers'],
      });
      return out;
    },
  );

  parityTest(
    'listEntityIdentityRows under excludePrivate serves a caller under a pending folder prefix the same on every arm',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await people(engine, backend);
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      // Every arm reads the folder rules and the pending prefixes (the Rust store keeps them: rust/docs/store/access_rules.md).
      const rows = await withCallerAccess({
        identity: ['member:alice-example'], folderCoverage: [{ source_id: 'default', prefix: 'people/' }], hidePrivate: true,
      }, () => list(engine, { entityId: 'g-alice', excludePrivate: true }));
      return rows.map((r) => r.slug);
    },
  );

  for (const [label, config] of [['an owner_only flag', { owner_only: true }], ['an imessage-kind source', { kind: 'imessage' }]] as const) {
    for (const seed of [false, true]) {
      parityTest(
        `listEntityIdentityRows under excludePrivate hides ${seed ? 'a seed page' : 'a member page'} of ${label} from a non-owner caller`,
        { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
        async (engine, backend) => {
          await people(engine, backend);
          await createSource(engine, backend, 'texts', config);
          await engine.putPage('people/alice-example', page('Alice (texts)'), { sourceId: 'texts' });
          await link(engine, 'g-alice', 'default', 'people/alice-example', true);
          await link(engine, 'g-alice', 'texts', 'people/alice-example');
          // Every arm hides the owner-only page; the Rust store applies the same page test as readIdentitySiblingCandidates.
          const rows = await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true, owner: false }, () =>
            list(engine, seed ? { slug: 'people/alice-example', slugSourceId: 'texts', excludePrivate: true } : { entityId: 'g-alice', excludePrivate: true }));
          const keys = rows.map((r) => `${r.source_id}:${r.slug}`);
          // The owner-only page never shows, nor the group it seeds (the SQL form may hide more while the source exists).
          expect(keys.filter((k) => k.startsWith('texts:'))).toEqual([]);
          if (seed) expect(keys).toEqual([]);
          return keys;
        },
      );
    }
  }

  parityTest(
    'readEntityIdentityIdsForPages returns the live members of the cross product of the asked sources and slugs',
    { methods: ['putPage', 'softDeletePage', 'linkEntityIdentityRow', 'readEntityIdentityIdsForPages'] },
    async (engine, backend) => {
      await people(engine, backend);
      await engine.putPage('people/charlie-example', page('Charlie (other)'), { sourceId: 'other' });
      await engine.putPage('people/gone', page('Gone'));
      await link(engine, 'g-alice', 'default', 'people/alice-example', true);
      await link(engine, 'g-alice', 'other', 'people/alice-example');
      await link(engine, 'g-charlie', 'other', 'people/charlie-example');
      await link(engine, 'g-gone', 'default', 'people/gone');
      await engine.softDeletePage('people/gone');
      // The SQL leaves the order to the plan; the callers key the rows, so the case sorts them.
      const sorted = (r: Array<{ entity_id: string; source_id: string; slug: string }>) =>
        [...r].sort((a, b) => `${a.source_id}\0${a.slug}`.localeCompare(`${b.source_id}\0${b.slug}`)).map((x) => `${x.entity_id}:${x.source_id}:${x.slug}`);
      const out = {
        cross: sorted(await engine.readEntityIdentityIdsForPages([
          { sourceId: 'default', slug: 'people/alice-example' }, { sourceId: 'other', slug: 'people/charlie-example' }, { sourceId: 'default', slug: 'people/gone' },
        ])),
        empty: await engine.readEntityIdentityIdsForPages([]),
        unknown: await engine.readEntityIdentityIdsForPages([{ sourceId: 'third', slug: 'people/alice-example' }]),
      };
      expect(out).toEqual({
        cross: ['g-alice:default:people/alice-example', 'g-alice:other:people/alice-example', 'g-charlie:other:people/charlie-example'],
        empty: [],
        unknown: [],
      });
      return out;
    },
  );

  parityTest(
    'listEntityIdentityRows orders by entity, canonical first, source, then slug in byte order',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'ab');
      await createSource(engine, backend, 'a-z');
      // Byte order and a linguistic collation disagree on each pair here: '-' < '.' < '0' < '_' < 'a'.
      const slugs = ['people/ab', 'people/a_b', 'people/a0', 'people/a.b', 'people/a-b'];
      for (const slug of slugs) await engine.putPage(slug, page(slug));
      for (const src of ['ab', 'a-z']) await engine.putPage('people/x', page(`x ${src}`), { sourceId: src });
      for (const slug of slugs) await link(engine, 'g-b', 'default', slug);
      await link(engine, 'g-b', 'ab', 'people/x');
      await link(engine, 'g-b', 'a-z', 'people/x');
      await link(engine, 'g-a', 'default', 'people/ab');
      await link(engine, 'g-b', 'default', 'people/a_b', true);
      let keys = (await list(engine, {})).map((r) => `${r.entity_id}:${r.source_id}:${r.slug}`);
      // Postgres orders by the database collation (TODOS.md): compare its set in byte order.
      if (backend === 'postgres') keys = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const expected = ['g-a:default:people/ab', 'g-b:default:people/a_b', 'g-b:a-z:people/x', 'g-b:ab:people/x',
        'g-b:default:people/a-b', 'g-b:default:people/a.b', 'g-b:default:people/a0'];
      if (backend === 'postgres') expect(keys).toEqual([...expected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      else expect(keys).toEqual(expected);
      return backend === 'postgres' ? [...expected] : keys;
    },
  );

  parityTest(
    'a hard page delete drops the membership; a soft delete hides it until a restore',
    { methods: ['putPage', 'deletePage', 'softDeletePage', 'restorePage', 'linkEntityIdentityRow', 'listEntityIdentityRows', 'readCanonicalTwin'] },
    async (engine, backend) => {
      await people(engine, backend);
      await link(engine, 'g-alice', 'other', 'people/alice-example', true);
      await link(engine, 'g-alice', 'default', 'people/alice-example');
      await link(engine, 'g-charlie', 'default', 'people/charlie-example');
      const twin = await engine.readCanonicalTwin('default', 'people/alice-example');
      const self = await engine.readCanonicalTwin('other', 'people/alice-example');
      const lonely = await engine.readCanonicalTwin('default', 'people/charlie-example');
      await engine.softDeletePage('people/alice-example', { sourceId: 'other' });
      const hidden = (await list(engine, { entityId: 'g-alice' })).map((r) => r.source_id);
      const hiddenTwin = await engine.readCanonicalTwin('default', 'people/alice-example');
      await engine.restorePage('people/alice-example', { sourceId: 'other' });
      const restored = (await list(engine, { entityId: 'g-alice' })).map((r) => `${r.source_id}:${r.canonical}`);
      await engine.deletePage('people/charlie-example');
      // A page written again at the slug is a new page: it is in no group.
      await engine.putPage('people/charlie-example', page('Charlie Again'));
      const gone = await list(engine, { entityId: 'g-charlie' });
      const out = { twin, self, lonely, hidden, hiddenTwin, restored, gone };
      expect(out).toEqual({
        twin: [{ slug: 'people/alice-example', source_id: 'other' }],
        self: [],
        lonely: [],
        hidden: ['default'],
        hiddenTwin: [],
        restored: ['other:true', 'default:false'],
        gone: [],
      });
      return out;
    },
  );

  parityTest(
    'a NaN or infinite confidence is stored and listed back as the SQL engines keep it, and never breaks a listing',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityIdentityRows'] },
    async (engine) => {
      const values: Array<[string, number]> = [['people/a-nan', NaN], ['people/b-inf', Infinity], ['people/c-neg-inf', -Infinity], ['people/d-finite', 0.1 + 0.2]];
      for (const [slug, confidence] of values) {
        await engine.putPage(slug, page(slug));
        await link(engine, 'g-float', 'default', slug, null, confidence);
      }
      const rows = await list(engine, { entityId: 'g-float' });
      const shown = rows.map(r => `${r.slug} ${typeof r.confidence} ${String(r.confidence)}`);
      expect(shown).toEqual(['people/a-nan number NaN', 'people/b-inf number Infinity', 'people/c-neg-inf number -Infinity', 'people/d-finite number 0.30000000000000004']);
      // The JSON a CLI or MCP answer prints: JSON has no NaN or Infinity, so all three print as null.
      return { shown, json: JSON.stringify(rows.map(r => ({ slug: r.slug, confidence: r.confidence }))) };
    },
  );
});

describe('entity identity union: a refused Rust read is not "no identity"', () => {
  test('unionLinksAcrossIdentity rethrows the Rust refusal and keeps its fallback for any other error', async () => {
    const addonCalls: string[] = [];
    // The addon half of the Rust engine: any call reaching it is recorded.
    const brain = new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { addonCalls.push(String(prop)); void args; return Promise.resolve([]); } });
    const base = [{ from_slug: 'people/bob-example', to_slug: 'people/alice-example', link_type: 'mentions', context: '' }] as never[];
    const stub = (rows: BrainEngine['listEntityIdentityRows']) => ({
      kind: 'pglite',
      getConfig: async () => 'true',
      listEntityIdentityRows: rows,
    }) as unknown as BrainEngine;
    const viaStore: BrainEngine['listEntityIdentityRows'] = (filter) =>
      (STORE_MEMBERS.listEntityIdentityRows as (b: unknown, f: unknown) => Promise<never>)(brain, filter);
    // A member's lineage read is served now (row 32e-b-2: test/engine-parity/labelled-only-reads.test.ts, and the translator cases in
    // test/rust-private-reads-policy.test.ts). A labelled-only member speaking for an audience of several identities still widens
    // the page policy past what the store reads, so the store member refuses typed.
    const widened = <T>(fn: () => Promise<T>) => withCallerAccess({
      identity: ['member:alice-example'], hidePrivate: true, labelledOnly: true,
      audienceIdentities: [['member:alice-example'], ['member:bob-example']],
    }, fn);
    const run = (engine: BrainEngine) => widened(() => unionLinksAcrossIdentity(engine, 'people/alice-example', base, 'in',
      { sourceId: 'default', excludePrivate: true } as never));
    const refused = await run(stub(viaStore)).then(() => null, (e: unknown) => (e as { code?: string }).code);
    const fallback = await run(stub(async () => { throw new Error('connection reset'); }));
    expect(refused).toBe('engine_capability_missing');
    expect(addonCalls).toEqual([]);
    expect(fallback).toEqual(base);
  });
});
