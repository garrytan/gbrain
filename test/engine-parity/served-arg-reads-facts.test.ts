/**
 * Served parity (both routes) for the fact reads a remote caller makes through the real MCP dispatch: `recall`
 * (with a question or a query) and `query`, which look up the facts nearest a question, count the facts that cannot be compared, find the
 * later fact that calls an earlier one off, read the pages a fact came from, and read which facts a fence holds.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Rust embedded and Rust served (env and config routes) a remote caller (a stdio client with world
 *    rows only, and a member) gets the same recalled facts, the same call-off facts and the same evidence dates; none of
 *    the answers carries a marker of a private fact or of a page whose readers do not name the caller.
 *  - Regression: listNearestFacts, countUncomparableFacts, listCallOffCueFacts, listFactSourcePages and
 *    listFactHoldingRefs were not in the served typed-read list, so on a served brain every remote recall and query
 *    that reached one was refused (engine_capability_missing) or answered without its facts.
 *  - Why existing coverage misses it: the served recall cases (served-remote-think, fact-recall-pool-widening) read the
 *    candidate pool only; none asked a question with a vector, a call-off cue, a fact source page or an evidence date.
 *  - Seam: facts, pages and links through insertFacts, putPage, sealChunks and addLink; the reads are the real
 *    dispatchToolCall, with a fake embedder so the question has a vector.
 */
import { afterAll, describe } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BOB, assertAnswered, call, installFakeEmbedder, removeFakeEmbedder, seedEntityBrain, seedMembers, stable } from '../helpers/served-arg-reads.ts';

const { parityTest } = parityArms(testBackends());

afterAll(() => removeFakeEmbedder());

const CALLERS = [['client', {}], ['member', { stdioMember: BOB }]] as const;

describe('served parity: the fact reads of recall and query', () => {
  parityTest('recall and query answer the same for a stdio client and a member, and show no hidden fact', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'setConfig',
      'listNearestFacts', 'countUncomparableFacts', 'listCallOffCueFacts', 'listFactSourcePages', 'listFactHoldingRefs'],
    timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await engine.setConfig('search.fact_source_pages', 'true');
    await engine.setConfig('search.evidence_date_header', 'true');
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of CALLERS) {
      answers[`${who}/recall-question`] = stable(await call(engine, 'recall', { question: 'probemark tea trip' }, ctx));
      answers[`${who}/recall`] = stable(await call(engine, 'recall', { query: 'probemark tea' }, ctx));
      answers[`${who}/query`] = stable(await call(engine, 'query', { query: 'probemark tea trip called off', token_budget: 4000 }, ctx));
    }
    assertAnswered(answers, { 'client/recall-question': 'probemark tea trip', 'member/recall-question': 'probemark tea trip' });
    return answers;
  });
});
