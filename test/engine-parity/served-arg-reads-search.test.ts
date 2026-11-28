/**
 * Served parity (both routes) for three remote reads that take their scope from the client's own arguments, through the
 * real MCP dispatch: `open_loops` (the open loops of the brain), `search_exact` (a phrase over page chunks, rescanned
 * chunk by chunk) and a relational `query` ("who works at <entity>", which looks up pages by the name's basename).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Rust embedded and Rust served (env and config routes) a remote caller (a stdio client with world
 *    rows only, and a member) gets the same open loops, the same phrase hits and the same relational answer; no answer
 *    carries a marker of a private page or of a page whose readers do not name the caller.
 *  - Regression: listOpenLoops, listExactRescanChunks and findExactBasenameCandidates were not in the served typed-read
 *    list, so on a served brain the open loops, the exact-phrase rescan and the relational name lookup were refused
 *    (engine_capability_missing).
 *  - Why existing coverage misses it: no served case called open_loops or search_exact, and the served query cases never
 *    asked a relational question.
 *  - Seam: pages, links and facts through putPage, sealChunks, addLink and insertFacts; the reads are the real dispatchToolCall.
 */
import { afterAll, describe } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BOB, assertAnswered, call, installFakeEmbedder, put, removeFakeEmbedder, seedEntityBrain, seedMembers, stable } from '../helpers/served-arg-reads.ts';

const { parityTest } = parityArms(testBackends());

afterAll(() => removeFakeEmbedder());

const CALLERS = [['client', {}], ['member', { stdioMember: BOB }]] as const;

describe('served parity: open loops, the exact phrase search and the relational query', () => {
  parityTest('open_loops answers the same for a stdio client and a member', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'listOpenLoops'], timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of CALLERS) answers[who] = stable(await call(engine, 'open_loops', {}, ctx));
    assertAnswered(answers);
    return answers;
  });

  parityTest('search_exact finds a phrase on the same pages for a stdio client and a member, and none the caller may not read', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'listExactRescanChunks'], timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    // More than three chunks of one page hold the phrase, which makes the search rescan that page's chunks.
    await put(engine, 'notes/rescan', 'note', 'Rescan', 'rescan page', {}, ['probemark rescan 1', 'probemark rescan 2', 'probemark rescan 3', 'probemark rescan 4', 'probemark rescan 5']);
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of CALLERS) {
      answers[`${who}/probemark`] = stable(await call(engine, 'search_exact', { phrase: 'probemark' }, ctx));
      answers[`${who}/limit50`] = stable(await call(engine, 'search_exact', { phrase: 'probemark', limit: 50 }, ctx));
    }
    assertAnswered(answers, Object.fromEntries(Object.keys(answers).map(name => [name, 'notes/world-ref'])));
    return answers;
  });

  parityTest('a relational query ("who works at ...") answers the same for a stdio client and a member', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'setConfig', 'findExactBasenameCandidates'], timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await engine.setConfig('search.relational_retrieval', 'true');
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of CALLERS) {
      answers[`${who}/query`] = stable(await call(engine, 'query', { query: 'who works at Alice Example' }, ctx));
      answers[`${who}/search`] = stable(await call(engine, 'search', { query: 'who invested in alice-example' }, ctx));
    }
    assertAnswered(answers);
    return answers;
  });
});
