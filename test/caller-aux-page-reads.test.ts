/**
 * #8395: the auxiliary page reads (core memory, strict entity resolution,
 * retrieval pointers, pull-brief counterparties and edits) apply the same
 * caller policy as get_page.
 *
 * 1. Protects: a member-bound caller gets the pages its readers allow and
 *    nothing more, and the operator's privacy opt-out applies to these reads
 *    the way it applies to get_page.
 * 2. Fails when: one of these reads uses the identity-less privacy fragment,
 *    so a bound member loses its own readable_by pages, or when the swap lets
 *    another member's restricted page through.
 * 3. Existing coverage: member-read-access pins the engine read paths.
 * 4. Real seams: PGLite, real pages, the caller-access record a bound remote
 *    request runs under; repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listCorePages } from '../src/core/core-memory.ts';
import { entityReferenceCandidates, resolveStrictEntityReference } from '../src/core/entities/resolve.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { assembleBrief, resolvePullCounterparty } from '../src/core/context/proactive-brief.ts';
import { withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember } from '../src/core/access/members.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'source-a';
const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const SECRET = 'people/carol-example';

let engine: PGLiteEngine;

function as<T>(member: 'alice' | 'bob' | null, hidePrivate: boolean, fn: () => Promise<T>): Promise<T> {
  return withCallerAccess({ identity: member ? [`member:${member}-example`] : [], hidePrivate, applyRemoteReadPolicy: true, restricted: true }, fn);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
  await addMember(engine, 'alice-example');
  await addMember(engine, 'bob-example');
  const today = new Date().toISOString().slice(0, 10);
  for (const [slug, title, fm] of [
    [ALICE, 'Alice Example', { readable_by: ['alice-example'] }],
    [BOB, 'Bob Example', { readable_by: ['bob-example'] }],
    [SECRET, 'Carol Example', { visibility: 'private' }],
  ] as const) {
    await engine.putPage(slug, { type: 'person', title, compiled_truth: `Standing guidance for ${title}.`, frontmatter: { always_load: true, ...fm } }, { sourceId: SRC });
    await engine.addTimelineEntry(slug, { date: today, summary: `Timeline note for ${title}` }, { sourceId: SRC });
  }
}, 60_000);

afterAll(async () => {
  __resetPrivateVisibilityCacheForTests();
  await engine.disconnect();
});

const core = (forCaller = true) => listCorePages(engine, { sourceIds: [SRC], excludePrivate: true, forCaller }).then(pages => pages.map(p => p.slug).sort());

describe('#8395 auxiliary page reads follow the caller', () => {
  test('core memory lists the pages the bound member may read', async () => {
    expect(await as('alice', true, core)).toEqual([ALICE]);
    expect(await as('bob', true, core)).toEqual([BOB]);
    expect(await as(null, true, core)).toEqual([]);
    expect(await as('alice', false, core)).toEqual([ALICE, SECRET]);
  });

  test('local core reads keep the plain privacy fragment, even with the read hatch open', async () => {
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      __resetPrivateVisibilityCacheForTests();
      expect(await core(false)).toEqual([]);
      expect(await core(true)).toEqual([SECRET]);
    });
    __resetPrivateVisibilityCacheForTests();
  });

  test('strict entity resolution and refusal candidates', async () => {
    await as('alice', true, async () => {
      expect(await resolveStrictEntityReference(engine, SRC, ALICE, { excludePrivate: true, forCaller: true })).toEqual({ slug: ALICE, arm: 'exact_page' });
      expect(await entityReferenceCandidates(engine, SRC, 'Alice Example', { excludePrivate: true, forCaller: true })).toContain(ALICE);
      expect((await resolveStrictEntityReference(engine, SRC, BOB, { excludePrivate: true, forCaller: true })).slug).toBeNull();
      expect((await resolveStrictEntityReference(engine, SRC, SECRET, { excludePrivate: true, forCaller: true })).slug).toBeNull();
    });
    await as('alice', false, async () => {
      expect((await resolveStrictEntityReference(engine, SRC, SECRET, { excludePrivate: true, forCaller: true })).slug).toBe(SECRET);
    });
    await as('bob', true, async () => {
      expect((await resolveStrictEntityReference(engine, SRC, ALICE, { excludePrivate: true, forCaller: true })).slug).toBeNull();
      expect(await entityReferenceCandidates(engine, SRC, 'Alice Example', { excludePrivate: true, forCaller: true })).not.toContain(ALICE);
    });
  });

  test('derived decisions without forCaller keep the plain privacy fragment, even with the read hatch open', async () => {
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      __resetPrivateVisibilityCacheForTests();
      expect((await resolveStrictEntityReference(engine, SRC, SECRET, { excludePrivate: true })).slug).toBeNull();
      expect(await entityReferenceCandidates(engine, SRC, 'Carol Example', { excludePrivate: true })).not.toContain(SECRET);
      expect((await resolveStrictEntityReference(engine, SRC, SECRET, { excludePrivate: true, forCaller: true })).slug).toBe(SECRET);
    });
    __resetPrivateVisibilityCacheForTests();
  });

  test('retrieval pointers, pull counterparties and brief edits', async () => {
    for (const who of ['alice', 'bob'] as const) {
      await as(who, true, async () => {
        const block = await resolveEntitiesToPointers(engine, SRC, [{ query: 'Alice Example', display: 'Alice Example' }] as never, { excludePrivate: true, forCaller: true });
        expect(block?.pointers.some(p => p.slug === ALICE) ?? false).toBe(who === 'alice');
        expect((await resolvePullCounterparty(engine, SRC, ALICE, { excludePrivate: true, forCaller: true }))?.slug ?? null).toBe(who === 'alice' ? ALICE : null);
        const brief = await assembleBrief(engine, { trigger: 'pull', local: false, counterparties: [{ slug: ALICE, source_id: SRC, display: 'Alice Example', confidence: 1 }], clock: { now: Date.now(), stopAt: Date.now() + 30_000 } });
        expect(brief?.text.includes('Timeline note for Alice Example') ?? false).toBe(who === 'alice');
      });
    }
  }, 30_000);

  test('local retrieval pointers, pull counterparties and briefs keep the plain privacy fragment, even with the read hatch open', async () => {
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      __resetPrivateVisibilityCacheForTests();
      const block = await resolveEntitiesToPointers(engine, SRC, [{ query: 'Carol Example', display: 'Carol Example' }] as never, { excludePrivate: true });
      expect(block?.pointers.some(p => p.slug === SECRET) ?? false).toBe(false);
      expect((await resolvePullCounterparty(engine, SRC, SECRET, { excludePrivate: true }))?.slug ?? null).toBe(null);
      const brief = await assembleBrief(engine, { trigger: 'pull', local: true, counterparties: [{ slug: SECRET, source_id: SRC, display: 'Carol Example', confidence: 1 }], clock: { now: Date.now(), stopAt: Date.now() + 30_000 } });
      expect(brief?.text.includes('Timeline note for Carol Example') ?? false).toBe(false);
      expect((await resolvePullCounterparty(engine, SRC, SECRET, { excludePrivate: true, forCaller: true }))?.slug ?? null).toBe(SECRET);
    });
    __resetPrivateVisibilityCacheForTests();
  }, 30_000);
});
