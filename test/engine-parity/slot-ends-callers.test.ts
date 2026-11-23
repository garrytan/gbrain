/**
 * BrainEngine parity — the three readers that apply read-time slot ends and keep a best-effort catch around the read:
 * a search's saved facts about a named entity (search/entity-facts.ts `entitySavedFacts`, catch -> []), recall by question
 * (facts/question-recall.ts `rankFactsByQuestion`, catch -> `rankingUnavailable`), and the hot-memory block every MCP tool
 * call carries (facts/meta-hook.ts `getBrainHotMemoryMeta`, run by the dispatcher's `runMetaHook`, catch -> no block).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm each reader shows the saved facts of an entity whose employer changed, the old
 *    employer ended (a later one ended it, so only the new one reads as current). The Rust engine serves listSlotRows,
 *    readEntityNewestFacts and listFactRowsByIds now, so the three cases compare equal on all three arms.
 *  - Regression: a reader that catches every error would turn the refusal of a member an engine does not serve into
 *    "no facts" without a sign; each reader must show the real facts on every engine.
 *  - Why existing coverage misses it: test/facts-slot-windows-gbra574.test.ts runs on PGLite only; slot-ends-refusal.test.ts
 *    and caller-typed-reads.test.ts pin recall's CLI and op, not these three catches.
 *  - Seam: each reader's own exported function (entitySavedFacts, rankFactsByQuestion), and the dispatcher with the
 *    hot-memory hook the transports pass (dispatchToolCall, list_pages); no src change.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { CONVERSATION_FACTS_SOURCE_PREFIX } from '../../src/core/facts/audit-sources.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../../src/core/facts/meta-hook.ts';
import { rankFactsByQuestion } from '../../src/core/facts/question-recall.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { resolveQueryEntities } from '../../src/core/search/alias-fanout.ts';
import { entitySavedFacts } from '../../src/core/search/entity-facts.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const ACME = 'Alice Example works at Acme Example.';
const BETA = 'Alice Example joined Beta Example.';
const TEA = 'Alice Example likes green tea.';
const P1 = new Date('2024-01-10T00:00:00Z');
const P2 = new Date('2024-06-10T00:00:00Z');

/** The employer facts of Alice: Acme, then Beta, which ends Acme at read time; plus one fact with no slot. */
async function seed(engine: BrainEngine) {
  await engine.putPage(ALICE, { type: 'person' as const, title: 'Alice Example', compiled_truth: 'Alice Example is a person.', timeline: '' });
  const said = (fact: string, valid: Date, slug: string, row: number, value?: string): NewFact & { row_num: number; source_markdown_slug: string } => ({
    fact, entity_slug: ALICE, visibility: 'world', source: `${CONVERSATION_FACTS_SOURCE_PREFIX}:test`, embedding: null, valid_from: valid,
    row_num: row, source_markdown_slug: slug, ...(value ? { dimension: 'employer', value } : {}),
  } as NewFact & { row_num: number; source_markdown_slug: string });
  await engine.insertFacts([said(ACME, P1, 'meetings/chat-a', 1, 'Acme Example'), said(TEA, P1, 'meetings/chat-a', 2)], { source_id: 'default' });
  await engine.insertFacts([said(BETA, P2, 'meetings/chat-b', 1, 'Beta Example')], { source_id: 'default' });
}

const SCOPE = { sourceId: 'default', worldOnly: false, excludePrivate: false } as const;
/** What the readers show: the Alice facts, a quoted excerpt unwrapped, sorted. */
const shown = (facts: ReadonlyArray<{ fact: string }> | undefined) =>
  (facts ?? []).map(f => /```text\n([^\n]*)\n```/.exec(f.fact)?.[1] ?? f.fact).filter(f => f.startsWith('Alice Example')).sort();
const CURRENT = [BETA, TEA].sort();

const ctxOf = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
  logger: { info() {}, warn() {}, error() {} } }) as OperationContext;

describe('engine parity: the readers that keep a best-effort catch around the slot-end read', () => {
  parityTest('entity saved facts show the entity\'s current facts, the old employer ended', {
    methods: ['putPage', 'insertFacts', 'listSlotRows'],
  }, async (engine) => {
    await seed(engine);
    const entity = (await resolveQueryEntities(engine, 'Alice Example', { sourceId: 'default', excludePrivate: false }))[0];
    const answer = async () => shown(entity ? await entitySavedFacts(engine, entity, { remote: false, excludePrivate: false }) : undefined);
    const got = await answer();
    expect(got).toEqual(CURRENT);
    return got;
  });

  parityTest('recall by question ranks the entity\'s current facts, the old employer ended', {
    methods: ['putPage', 'insertFacts', 'listSlotRows'],
  }, async (engine) => {
    await seed(engine);
    const rank = () => rankFactsByQuestion(ctxOf(engine), { question: 'Where does Alice Example work?', params: { question: 'Where does Alice Example work?' },
      factSources: ['default'], limit: 10, scope: SCOPE, entity: null, sessionId: null, since: null, grep: null });
    const got = shown((await rank()).rows);
    // The question names the employer slot, so only the current employer is ranked; the old one is ended.
    expect(got).toContain(BETA);
    expect(got).not.toContain(ACME);
    return got;
  });

  parityTest('the hot-memory block of a tool call carries the entity\'s current facts, the old employer ended', {
    methods: ['putPage', 'insertFacts', 'listSlotRows'],
  }, async (engine) => {
    await seed(engine);
    __resetHotMemoryCacheForTests();
    const call = async () => {
      const r = await dispatchToolCall(engine, 'list_pages', { limit: 1 }, { remote: false, sourceId: 'default', metaHook: (n, ctx) => getBrainHotMemoryMeta(n, ctx) });
      return shown((r._meta as { brain_hot_memory?: { facts: Array<{ fact: string }> } } | undefined)?.brain_hot_memory?.facts);
    };
    const got = await call();
    expect(got).toEqual(CURRENT);
    return got;
  });
});
