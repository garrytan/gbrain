/** #7937: source-grounded speaker provenance survives real event publication and timeline reads.
 * Inject only the judge; parse real transcript turns and persist event pages on either backend.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { runChronicleExtract, buildChronicleEvents, chronicleJudgeContext, isValidProposal } from '../src/core/chronicle/extract-events.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { assignChronicleEventSlugs } from '../src/core/chronicle/event-identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { diagnoseMalformedProposals } from '../src/core/chronicle/proposal-diagnostics.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';

const day = '2026-09-10';
const claim = 'The example client is still awaiting an answer about the test contract.';
const answer = 'The example client received the answer this morning.';
const body = `## User\n\n${answer}\n\n## Assistant\n\n${claim}\n\n## User\n\nPlease check the original thread before answering.\n`;
const page = { slug: 'conversations/speaker-example', type: 'conversation', title: 'Synthetic contract conversation', compiled_truth: body, frontmatter: { date: day } };
const proposal = { when: day, who: ['people/client-example'], what: claim, kind: 'event', evidence_quote: claim };
const ctx = chronicleJudgeContext(page);
const build = (events: unknown[], context = ctx) => buildChronicleEvents(events as typeof proposal[], context,
  { slug: page.slug, visibility: 'world', contentHash: 'test-hash' }, { tz: 'UTC', now: new Date('2026-09-11T00:00:00Z'), maxEvents: 10 }).events;

let engine: BrainEngine;
let close: () => Promise<void>;
beforeAll(async () => {
  if (process.env.GBRAIN_TEST_BACKEND === 'postgres') {
    const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
    engine = pg.engine; close = pg.close;
  } else {
    const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema();
    engine = pg; close = () => pg.disconnect();
  }
}, 120_000);
afterAll(async () => { await close(); });

test('assistant claims stay attributed in stored pages and public timeline summaries, including replay', async () => {
  await engine.putPage(page.slug, page);
  const judge = async () => ({ events: [proposal] });
  for (let replay = 0; replay < 2; replay++) {
    expect(await runChronicleExtract(engine, { slug: page.slug, judge })).toMatchObject({ status: 'extracted', events_written: replay === 0 ? 1 : 0 });
    const rows = await operationsByName.chronicle_day.handler({ engine, remote: false, sourceId: 'default' } as OperationContext, { date: day }) as Array<{ summary: string; page_slug: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(`Assistant said: ${claim}`);
    expect(rows[0].page_slug).toBe(page.slug);
    const stored = await engine.getPage(build([proposal])[0].slug);
    expect(stored?.title).toStartWith('Assistant said:');
    expect(stored?.compiled_truth).toContain(`Assistant said: ${claim}`);
    expect(stored?.frontmatter.event).toMatchObject({ what: claim, attributed_to: 'Assistant', evidence_quote: claim, depth: page.slug });
  }
}, 120_000);

test('attribution is derived from matching source turns, not proposed speaker names', () => {
  const [event] = build([{ ...proposal, attributed_to: 'user' }]);
  expect(event.frontmatter.event).toMatchObject({ attributed_to: 'Assistant' });
  expect(event.summary).toBe(`Assistant said: ${claim}`);
  const [user] = build([{ ...proposal, what: answer, evidence_quote: answer }]);
  expect(user.frontmatter.event).toMatchObject({ attributed_to: 'User' });
});

test('absent, empty, unmatched, cross-turn and ambiguous quotes never become unattributed facts', () => {
  for (const quote of [undefined, '', '   ', 'Invented evidence not present in any turn', `${answer}\n${claim}`]) {
    const [event] = build([{ ...proposal, evidence_quote: quote }]);
    expect(event.summary).toBe(`Conversation report (speaker unverified): ${claim}`);
    expect(event.frontmatter.event).toMatchObject({ attributed_to: null });
    expect(event.frontmatter.event).not.toHaveProperty('evidence_quote');
  }
  const repeated = chronicleJudgeContext({ ...page, compiled_truth: body.replace(answer, claim) });
  expect(build([proposal], repeated)[0].summary).toStartWith('Conversation report (speaker unverified):');
  const unparsed = chronicleJudgeContext({ ...page, compiled_truth: claim });
  expect(build([proposal], unparsed)[0].summary).toStartWith('Conversation report (speaker unverified):');
  const folded = chronicleJudgeContext({ ...page, compiled_truth: body.replace(claim, `## Trickster Voice\n\n${claim}`) });
  expect(build([proposal], folded)[0].summary).toStartWith('Conversation report (speaker unverified):');
  expect(isValidProposal({ ...proposal, evidence_quote: { speaker: 'User' } })).toBe(false);
  expect(diagnoseMalformedProposals([{ ...proposal, evidence_quote: { speaker: 'User' } }]))
    .toMatchObject({ code: 'wrong_type', field: 'evidence_quote', shape: 'object', invalid: 1 });
});

test('ordinary prose meetings retain their event rendering and identity', () => {
  const meeting = chronicleJudgeContext({ ...page, type: 'meeting', compiled_truth: 'The example team reviewed the contract and agreed to proceed.' });
  const [event] = build([{ ...proposal, what: 'Reviewed the contract' }], meeting);
  expect(event.summary).toBe('Reviewed the contract');
  expect(event.frontmatter.event).not.toHaveProperty('attributed_to');
});

test('same-day same-summary reports from different speakers retain their own identity across reordering', () => {
  const events = build([{ ...proposal, what: 'Discussed answer status' }, { ...proposal, what: 'Discussed answer status', evidence_quote: answer }]);
  const assigned = assignChronicleEventSlugs(events, new Map());
  expect(new Set(assigned.map((e) => e.slug)).size).toBe(2);
  const reversed = assignChronicleEventSlugs([...events].reverse(), new Map()).reverse();
  expect(reversed.map((e) => e.slug)).toEqual(assigned.map((e) => e.slug));
});

test('managed publication carries attribution into the canonical event and projection, preserving an existing speaker identity', async () => {
  await managedBrain(async ({ engine: managed, ctx: operationContext }) => {
    let round = 0;
    const publish = async (events: typeof proposal[]) => {
      const current = await managed.readPageSnapshot(page.slug, { sourceId: 'default' });
      await operationsByName.put_page.handler(operationContext, { slug: page.slug,
        content: `---\ntype: conversation\ntitle: Synthetic conversation\ndate: ${day}\n---\n\n${body}\nRound ${++round}.`,
        ...(current ? { expected_revision: current.revision } : {}) });
      await runChronicleBackfill(managed, { yes: true });
      await managed.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
      expect((await runPhaseChronicle(managed, { judge: async () => ({ events }) })).details)
        .toMatchObject({ events_written: events.length });
    };
    await publish([proposal]);
    const stored = await managed.getPage(build([proposal])[0].slug);
    expect(stored?.frontmatter.event).toMatchObject({ attributed_to: 'Assistant', evidence_quote: claim });
    expect(stored?.title).toStartWith('Assistant said:');
    const rows = await operationsByName.chronicle_day.handler(operationContext, { date: day }) as Array<{ summary: string }>;
    expect(rows.map((r) => r.summary)).toEqual([`Assistant said: ${claim}`]);
    const userReport = { ...proposal, what: 'Discussed answer status', evidence_quote: answer };
    const assistantReport = { ...proposal, what: 'Discussed answer status' };
    await publish([userReport]);
    const originalSlug = build([userReport])[0].slug;
    expect((await managed.getPage(originalSlug))?.frontmatter.event).toMatchObject({ attributed_to: 'User' });

    // Assistant sorts before User, but must not steal the existing User base slug.
    await publish([assistantReport, userReport]);
    expect((await managed.getPage(originalSlug))?.frontmatter.event).toMatchObject({ attributed_to: 'User', evidence_quote: answer });
    const after = await operationsByName.chronicle_day.handler(operationContext, { date: day }) as Array<{ summary: string }>;
    expect(after.map((r) => r.summary).sort()).toEqual(['Assistant said: Discussed answer status', 'User said: Discussed answer status']);
  }, { databaseUrl: process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined });
}, 120_000);
