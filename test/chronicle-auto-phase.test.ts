/**
 * #5876 — the Life Chronicle automatic path end to end on managed PGLite:
 * write decision → `chronicle` cycle phase → events, under the rails.
 *
 * Protects: default-on extraction runs on PGLite without a worker; settle,
 * supersede and the rolling daily reservation bound judged calls; judge
 * failures are failures; the per-page budget and the no_pricing policy;
 * snapshot re-validation; generation reconciliation that never touches
 * operator edits; the ledger survives job pruning.
 * Fails when: any rail lets an extra paid call through, a failure is
 * recorded as no_events, or an operator edit is overwritten or retired.
 * Seams: injected judge (`runPhaseChronicle({ judge })`) and the gateway's
 * test chat transport for the budget cases.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import type { ChronicleJudge, ChronicleJudgeResult } from '../src/core/chronicle/extract-events.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { _resetBudgetTrackerWarningsForTest } from '../src/core/budget/budget-tracker.ts';
import { makeChronicleExtractHandler } from '../src/core/minions/handlers/chronicle-extract.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

/** PGLite in the unit lane; the e2e wrapper reruns every case on an isolated Postgres database. */
const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const meeting = (title: string, body = BODY, extra = `date: ${today}\n`) => `---\ntype: meeting\ntitle: ${title}\n${extra}---\n\n${body}`;
const ev = (what: string, kind = 'commitment') => ({ when: today, who: ['people/alice-example'], what, kind });

async function put(ctx: OperationContext, slug: string, content: string): Promise<Record<string, unknown>> {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return await operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) }) as Record<string, unknown>;
}
/** Let every pending row through its settle window (the row's own next_attempt_at gate). */
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
function countingJudge(answer: (n: number) => ChronicleJudgeResult | Promise<ChronicleJudgeResult>) {
  const judge = Object.assign((async () => answer(++judge.calls)) as ChronicleJudge, { calls: 0 });
  return judge;
}
async function rows(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; state: string; reason: string | null; attempts: number; next_attempt_at: Date | null; unpriced: boolean; cost_usd: string | null }>(
    'SELECT slug,state,reason,attempts,next_attempt_at,unpriced,cost_usd FROM chronicle_page_state ORDER BY slug, decided_at');
}
async function events(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; what: string; deleted: boolean; retired_by: string | null }>(
    `SELECT slug, frontmatter->'event'->>'what' AS what, deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by
       FROM pages WHERE type='event' ORDER BY what`);
}

afterEach(() => { __setChatTransportForTests(null); resetGateway(); _resetBudgetTrackerWarningsForTest(); });

describe('execution path (D10) and settle (D4)', () => {
  test('PGLite: write a meeting, run the phase, read the events', () => brain(async ({ engine, ctx }) => {
    const receipt = await put(ctx, 'meetings/sync', meeting('Sync'));
    expect(receipt.chronicle_backstop).toEqual({ pending: 'next_cycle', daily_remaining: 200 });
    const judge = countingJudge(() => ({ events: [ev('Alice agreed to ship the beta')] }));
    expect((await runPhaseChronicle(engine, { judge })).details).toMatchObject({ judged: 0 }); // still settling
    await settle(engine);
    const r = await runPhaseChronicle(engine, { judge });
    expect(r.details).toMatchObject({ judged: 1, extracted: 1, events_written: 1 });
    const day = await operationsByName.chronicle_day.handler(ctx, { date: today }) as Array<{ summary: string; page_slug: string }>;
    expect(day.map((d) => [d.summary, d.page_slug])).toEqual([['Alice agreed to ship the beta', 'meetings/sync']]);
  }), 120_000);

  test('three puts inside the window → one judged call, one daily slot', () => brain(async ({ engine, ctx }) => {
    for (const n of [1, 2, 3]) await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} Revision ${n}.`));
    const judge = countingJudge(() => ({ events: [ev('Alice agreed to ship the beta')] }));
    await settle(engine);
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(1);
    expect((await rows(engine)).map((r) => [r.state, r.reason])).toEqual([['skipped', 'superseded'], ['skipped', 'superseded'], ['extracted', null]]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chronicle_judge_reservations'))[0].n).toBe(1);
  }), 120_000);
});

describe('daily reservation (E3)', () => {
  test('limit 2, three pages → two judged, the third waits; backfill is exempt', () => brain(async ({ engine, ctx }) => {
    await engine.setConfig('chronicle.auto_daily_limit', '2');
    for (const n of [1, 2, 3]) await put(ctx, `meetings/m${n}`, meeting(`M${n}`));
    await settle(engine);
    const judge = countingJudge(() => ({ events: [] }));
    const first = await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(2);
    expect(first.details).toMatchObject({ deferred_daily_limit: 1, daily_remaining: 0 });
    // Workerless days do not burst: further runs inside the window judge nothing.
    await runPhaseChronicle(engine, { judge });
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(2);
    const pending = (await rows(engine)).filter((r) => r.state === 'pending');
    expect(pending).toHaveLength(1);
    const backfill = await runChronicleBackfill(engine, { yes: true });
    expect(backfill.queued).toBe(1);
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(3);
    expect((await rows(engine)).every((r) => r.state === 'extracted')).toBe(true);
  }), 120_000);

  test('retries consume reservations', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const judge = countingJudge(() => ({ events: [], failure: 'chat_error' }));
    await runPhaseChronicle(engine, { judge });
    await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second'");
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(2);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chronicle_judge_reservations'))[0].n).toBe(2);
    expect((await rows(engine))[0]).toMatchObject({ state: 'failed', reason: 'judge_chat_error', attempts: 2 });
  }), 120_000);

  test('opt-out between decision and run → zero calls', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    await engine.setConfig('auto_chronicle', 'false');
    const judge = countingJudge(() => ({ events: [ev('x')] }));
    const r = await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(0);
    expect(r.details.reason).toBe('auto_chronicle_off');
    expect((await rows(engine))[0].state).toBe('pending');
  }), 120_000);
});

describe('judge failure classes (E2/D5)', () => {
  test('a chat error is a failure with backoff, never no_events; [] is no_events; a refusal is judge_refused', () => brain(async ({ engine, ctx }) => {
    for (const n of [1, 2, 3]) await put(ctx, `meetings/m${n}`, meeting(`M${n}`));
    await settle(engine);
    const answers: Record<string, ChronicleJudgeResult> = {
      'meetings/m1': { events: [], failure: 'chat_error' }, 'meetings/m2': { events: [] }, 'meetings/m3': { events: [], failure: 'refused' },
    };
    await runPhaseChronicle(engine, { judge: async (input) => answers[input.slug] });
    const state = Object.fromEntries((await rows(engine)).map((r) => [r.slug, [r.state, r.reason, r.next_attempt_at !== null]]));
    expect(state).toEqual({
      'meetings/m1': ['failed', 'judge_chat_error', true],
      'meetings/m2': ['extracted', 'no_events', false],
      'meetings/m3': ['skipped', 'judge_refused', false],
    });
  }), 120_000);

  test('the default judge reports a thrown provider error as chat_error', () => brain(async ({ engine, ctx }) => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async () => { throw new Error('provider 503'); });
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const r = await runPhaseChronicle(engine);
    expect(r.details).toMatchObject({ judged: 1, failed: 1, no_events: 0, reasons: { judge_chat_error: 1 } });
  }), 120_000);

  test('no chat provider → no calls, no churn, the row keeps waiting', () => brain(async ({ engine, ctx }) => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const r = await runPhaseChronicle(engine);
    expect(r.status).toBe('skipped');
    expect(r.details).toMatchObject({ reason: 'no_chat_provider', fix: { actor: 'user', consent: ['credentials'] } });
    expect((await rows(engine))[0]).toMatchObject({ state: 'pending', attempts: 0 });
  }), 120_000);

  test('legacy chronicle_extract job: provider error throws, no provider is unrecoverable, [] completes', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/m1', meeting('M1'));
    await engine.executeRaw('DELETE FROM chronicle_page_state'); // a job queued by an older release, no decision row
    const handler = makeChronicleExtractHandler(engine);
    const job = { data: { slug: 'meetings/m1', sourceId: 'default' } } as never;
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
    await expect(handler(job)).rejects.toBeInstanceOf(UnrecoverableError);
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async () => { throw new Error('provider 503'); });
    const thrown = await handler(job).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
    __setChatTransportForTests(async (opts: ChatOpts) => chatReply('[]', opts.model));
    expect(await handler(job)).toMatchObject({ status: 'no_events' });
    // Content already extracted is never paid for again.
    expect(await handler(job)).toMatchObject({ status: 'skipped', reason: 'already_extracted' });
  }), 120_000);
});

function chatReply(text: string, model?: string, tokens = { input: 10, output: 10 }): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: model ?? 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    usage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
}

describe('budget (C2/E4)', () => {
  test('a priced model over the default cap stops with budget_exhausted and publishes nothing', () => brain(async ({ engine, ctx }) => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async (opts: ChatOpts) => chatReply(JSON.stringify([ev('Alice agreed to ship the beta')]), opts.model, { input: 10, output: 2_000_000 }));
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const r = await runPhaseChronicle(engine);
    expect(r.details).toMatchObject({ failed: 1, reasons: { budget_exhausted: 1 }, events_written: 0 });
    expect(await events(engine)).toEqual([]);
    expect(Number((await rows(engine))[0].cost_usd)).toBeGreaterThan(0.25);
  }), 120_000);

  test('default cap + unpriced model: warns and runs, spend marked unpriced', () => brain(async ({ engine, ctx }) => {
    configureGateway({ chat_model: 'openai:gpt-unpriced-example', env: { OPENAI_API_KEY: 'sk-test' } });
    __setChatTransportForTests(async () => chatReply(JSON.stringify([ev('Alice agreed to ship the beta')]), 'openai:gpt-unpriced-example'));
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const r = await runPhaseChronicle(engine);
    expect(r.details).toMatchObject({ judged: 1, extracted: 1, unpriced_calls: 1 });
    expect((await rows(engine))[0]).toMatchObject({ state: 'extracted', unpriced: true });
  }), 120_000);

  test('explicit cap + unpriced model: refuses with the no_pricing register command, zero calls', () => brain(async ({ engine, ctx }) => {
    configureGateway({ chat_model: 'openai:gpt-unpriced-example', env: { OPENAI_API_KEY: 'sk-test' } });
    let calls = 0;
    __setChatTransportForTests(async (opts: ChatOpts) => { calls++; return chatReply('[]', opts.model); });
    await engine.setConfig('chronicle.job_budget_usd', '0.10');
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const r = await runPhaseChronicle(engine);
    expect(calls).toBe(0);
    expect(r.status).toBe('warn');
    expect(r.details.reason).toBe('no_pricing');
    expect(JSON.stringify(r.details.no_pricing)).toContain('gbrain pricing set openai:gpt-unpriced-example --input');
    expect((await rows(engine))[0].state).toBe('pending');
  }), 120_000);
});

describe('snapshot integrity (E5) and reconciliation (E8/C12/E9)', () => {
  test('an edit or a private flip during the judge call publishes nothing', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/edit', meeting('Edit'));
    await put(ctx, 'meetings/flip', meeting('Flip'));
    await settle(engine);
    const judge: ChronicleJudge = async (input) => {
      if (input.slug === 'meetings/edit') await put(ctx, 'meetings/edit', meeting('Edit', `${BODY} Changed while judging.`));
      else await put(ctx, 'meetings/flip', meeting('Flip', BODY, `date: ${today}\nvisibility: private\n`));
      return { events: [ev(`Event of ${input.slug}`)] };
    };
    const r = await runPhaseChronicle(engine, { judge });
    expect(r.details).toMatchObject({ judged: 2, events_written: 0, reasons: { superseded: 2 } });
    expect(await events(engine)).toEqual([]);
  }), 120_000);

  test('re-extraction retires the stale event and never touches an operator-edited sibling', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting('Sync'));
    await settle(engine);
    await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta'), ev('Bob owns the launch email', 'decision')] }) });
    const [, bob] = await events(engine);
    const page = (await engine.readPageSnapshot(bob.slug, { sourceId: 'default' }))!;
    const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
    await operationsByName.put_page.handler(ctx, { slug: bob.slug, expected_revision: page.revision,
      content: serializePageToMarkdown({ ...page.page, compiled_truth: 'Bob owns the launch email (confirmed by the operator).' }, page.tags) });
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} Wording changed.`));
    await settle(engine);
    await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta in May')] }) });
    expect((await events(engine)).map((e) => [e.what, e.deleted, e.retired_by])).toEqual([
      ['Alice agreed to ship the beta', true, 'life-chronicle'],
      ['Alice agreed to ship the beta in May', false, null],
      ['Bob owns the launch email', false, null],
    ]);
  }), 120_000);

  test('a genuine [] keeps the previous generation live (#7013); a failed run retires nothing', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting('Sync'));
    await settle(engine);
    await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta')] }) });
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} v2.`));
    await settle(engine);
    await runPhaseChronicle(engine, { judge: async () => ({ events: [], failure: 'parse_failed' }) });
    expect((await events(engine)).map((e) => e.deleted)).toEqual([false]);
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} v3.`));
    await settle(engine);
    const r = await runPhaseChronicle(engine, { judge: async () => ({ events: [] }) });
    expect(r.details).toMatchObject({ judged: 1, no_events: 1, events_retired: 0 });
    expect((await events(engine)).map((e) => [e.deleted, e.retired_by])).toEqual([[false, null]]);
    expect((await rows(engine)).at(-1)).toMatchObject({ slug: 'meetings/sync', state: 'extracted', reason: 'no_events' });
  }), 120_000);

  test('a depth page that stops being a meeting retires its automatic events without a model call', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'notes/sync', meeting('Sync'));
    await settle(engine);
    await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta')] }) });
    await put(ctx, 'notes/sync', `---\ntype: note\ntitle: Sync\n---\n\n${BODY}`);
    const judge = countingJudge(() => ({ events: [] }));
    const r = await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(0);
    expect(r.details.events_retired).toBe(1);
    expect((await events(engine)).map((e) => e.retired_by)).toEqual(['life-chronicle']);
  }), 120_000);

  test('A → B → A: A\'s events are back after one more judged call', () => brain(async ({ engine, ctx }) => {
    const judge = countingJudge(() => ({ events: [ev(judgeText)] }));
    let judgeText = 'Version A decision';
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} A.`));
    await settle(engine); await runPhaseChronicle(engine, { judge });
    judgeText = 'Version B decision';
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} B.`));
    await settle(engine); await runPhaseChronicle(engine, { judge });
    judgeText = 'Version A decision';
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} A.`));
    await settle(engine); await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(3);
    expect((await events(engine)).map((e) => [e.what, e.deleted])).toEqual([['Version A decision', false], ['Version B decision', true]]);
  }), 120_000);
});

describe('ledger and discovery (E1/E6/D12)', () => {
  test('returning to extracted content before the newer revision ran costs nothing and says so', () => brain(async ({ engine, ctx }) => {
    const judge = countingJudge(() => ({ events: [ev('Version A decision')] }));
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} A.`));
    await settle(engine); await runPhaseChronicle(engine, { judge });
    await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} B.`));
    const back = await put(ctx, 'meetings/sync', meeting('Sync', `${BODY} A.`));
    expect(back.chronicle_backstop).toMatchObject({ skipped: 'already_extracted', stage: 'decision' });
    expect(back.chronicle_backstop).not.toHaveProperty('fix');
    await settle(engine); await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(1);
    expect((await events(engine)).map((e) => [e.what, e.deleted])).toEqual([['Version A decision', false]]);
  }), 120_000);

  test('extract, prune jobs, rerun backfill → zero judged calls', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/m1', meeting('M1'));
    await settle(engine);
    const judge = countingJudge(() => ({ events: [ev('x')] }));
    await runPhaseChronicle(engine, { judge });
    await engine.executeRaw('DELETE FROM minion_jobs');
    const again = await runChronicleBackfill(engine, { yes: true });
    expect(again).toMatchObject({ queued: 0, already_done: 1 });
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(1);
  }), 120_000);

  test('an invite becomes eligible once its end passes, without an edit', () => brain(async ({ engine, ctx }) => {
    await engine.setConfig('chronicle.auto_settle_seconds', '0');
    const end = new Date(Date.now() + 1500).toISOString();
    const receipt = await put(ctx, 'calendar/2026/10/standup', meeting('Standup', BODY, `start: ${new Date().toISOString()}\nend: ${end}\n`));
    expect(receipt.chronicle_backstop).toMatchObject({ skipped: 'not_yet_happened', stage: 'decision' });
    const judge = countingJudge(() => ({ events: [] }));
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(0);
    await Bun.sleep(1700);
    const r = await runPhaseChronicle(engine, { judge });
    // An ended invite projects without a chat call (invite-projection.ts).
    expect(judge.calls).toBe(0);
    expect(r.details).toMatchObject({ extracted: 1, events_written: 1 });
  }), 120_000);

  test('a managed page written without a decision is left to backfill (no_write_decision)', () => brain(async ({ engine }) => {
    await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 1000).toISOString());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage('meetings/legacy', { type: 'meeting', title: 'Legacy', compiled_truth: BODY, frontmatter: { date: today } });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const judge = countingJudge(() => ({ events: [] }));
    await runPhaseChronicle(engine, { judge });
    expect(judge.calls).toBe(0);
    expect((await rows(engine)).map((r) => [r.slug, r.state, r.reason])).toEqual([['meetings/legacy', 'skipped', 'no_write_decision']]);
  }), 120_000);
});
