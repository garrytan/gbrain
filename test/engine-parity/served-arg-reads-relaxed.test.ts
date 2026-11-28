/**
 * Served parity (both routes) for the two remote reads that run only on a brain whose remote private-page policy is
 * relaxed (`search.remote_private_pages` = visible) and that has no members: the `context_pack` entity card (which then
 * reads the owner's pinned questions) and `rank_entities` (entities ranked by their name variants over every page the
 * caller may read).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Rust embedded and Rust served (env and config routes) a remote stdio client on a relaxed brain
 *    with no members gets the same entity card (pinned questions included) and the same entity ranking. With the policy relaxed, a private page
 *    is readable by design, so these cases pin the answer, not a hidden marker.
 *  - Regression: listPinnedQuestions and listNameVariantCandidates were not in the served typed-read list, so on a served
 *    brain both reads were refused (engine_capability_missing).
 *  - Why existing coverage misses it: the served cases all run on a default-policy brain, where a remote caller reads the
 *    caller-scoped variants (listVisibleNameVariantCandidates) and cannot list pinned questions at all.
 *  - Seam: pages through putPage and sealChunks, the question through insertPinnedQuestion; the reads are the real
 *    dispatchToolCall.
 */
import { afterAll, describe } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { assertNotRefused, call, installFakeEmbedder, put, removeFakeEmbedder, seedEntityBrain, stable } from '../helpers/served-arg-reads.ts';

const { parityTest } = parityArms(testBackends());

afterAll(() => removeFakeEmbedder());

describe('served parity: pinned questions and entity ranking on a relaxed brain with no members', () => {
  parityTest('context_pack and rank_entities answer the same for a stdio client', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'setConfig', 'insertPinnedQuestion', 'listPinnedQuestions', 'listNameVariantCandidates'],
    timeout: 120_000,
  }, async (engine) => {
    installFakeEmbedder();
    // The policy is read once per engine: set it before the first remote call.
    await engine.setConfig('search.remote_private_pages', 'visible');
    // No readers-only page: a readers list makes the brain restricted, and a restricted brain is never relaxed.
    await seedEntityBrain(engine, { readersOnlyPage: false });
    await put(engine, 'people/dr-alice-example', 'person', 'Dr Alice Example', 'a second page for the same person');
    await engine.insertPinnedQuestion({ sourceId: 'default', slug: 'questions/q1', question: 'Who leads probemark?', scopeSlugPrefix: null, scopeEntity: null,
      state: 'active', inactiveReason: null, publishMode: 'published', createdBy: 'test' } as never);
    const answers: Record<string, unknown> = {
      card: stable(await call(engine, 'context_pack', { entities: 'Alice Example' })),
      ranked: stable(await call(engine, 'rank_entities', { types: ['person'] })),
    };
    assertNotRefused(answers, { card: 'Alice Example', ranked: 'people/alice-example' });
    return answers;
  });
});
