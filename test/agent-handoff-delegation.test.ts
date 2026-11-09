/**
 * Agent handoff, delegation inbox and routing on PGLite: register_agent,
 * heartbeat, delegate, inbox, claim_task, complete_task, release_task,
 * fan_out, pick_result, route, routing_stats.
 *
 * Protects:
 *   - claim_task is atomic: agents racing for one task get exactly one
 *     winner; every loser is refused task_claimed and the page names the
 *     winner (the revision-checked write is the lock);
 *   - a task addressed to agent A never shows in B's inbox and B's claim is
 *     refused task_not_addressed;
 *   - a lease that runs out reopens the task: inbox shows it open at once,
 *     another eligible agent can claim it (attempt 2), and heartbeat writes
 *     the reopen into the page;
 *   - complete and release record their outcome and note it on the thread;
 *   - fan_out + pick_result feed routing_stats (win rate) and route ranks
 *     the winner higher; routing.md rules, liveness and model targets rank
 *     deterministically with reasons; delegate with no target uses route.
 * Regressions that fail it: a claim that writes without the read revision
 * (two winners), an inbox that ignores addressing, a lease check that
 * compares strings or never reopens, stats that never read picks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { parseTask, parseThread } from '../src/core/handoff/format.ts';
import { __setHandoffClockForTests } from '../src/core/handoff/store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setHandoffClockForTests(null);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setHandoffClockForTests(null);
});

const ctx = (overrides: Partial<OperationContext> = {}): OperationContext => ({
  engine: engine as never, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, ...overrides,
} as OperationContext);

async function call<T = Record<string, any>>(name: string, params: Record<string, unknown>, c: OperationContext = ctx()): Promise<T> {
  return await operationsByName[name]!.handler(c, params) as T;
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof OperationError ? e.code : String(e)));

async function task(id: string) {
  const snap = await engine.readPageSnapshot(`delegations/${id}`, { sourceId: 'default' });
  return parseTask({ title: snap!.page.title, frontmatter: snap!.page.frontmatter, body: snap!.page.compiled_truth });
}

describe('addressing and inbox', () => {
  test('a task addressed to A is visible to A only, and B cannot claim it', async () => {
    await call('register_agent', { name: 'claude', model: 'claude-opus-5-5' });
    await call('register_agent', { name: 'chatgpt', model: 'gpt-5' });
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Build the deck', instructions: 'Ten slides.', priority: 'high', auto_ok: false });
    expect(d).toMatchObject({ to_agent: 'claude', to_model: null, routed: null });

    const a = await call('inbox', { agent: 'claude' });
    expect(a.open.map((t: any) => t.task_id)).toEqual([d.task_id]);
    expect(a.open[0]).toMatchObject({ from_agent: 'grok-bot', priority: 'high', status: 'open', ask_user: 'Delegated from grok-bot: Build the deck. Want me to take it?' });
    const b = await call('inbox', { agent: 'chatgpt' });
    expect(b.open).toEqual([]);
    expect(await refusal(call('claim_task', { task_id: d.task_id, agent: 'chatgpt' }))).toBe('task_not_addressed');
    expect((await task(d.task_id)).status).toBe('open');
  });

  test('a task addressed to a model reaches every agent on it, and auto_ok asks nobody', async () => {
    await call('register_agent', { name: 'claude-desktop', model: 'claude-opus-5-5' });
    await call('register_agent', { name: 'claude-code', model: 'claude-sonnet-5-5' });
    await call('register_agent', { name: 'chatgpt', model: 'gpt-5' });
    const d = await call('delegate', { from_agent: 'grok-bot', to_model: 'claude', title: 'Summarize comps', instructions: 'x', auto_ok: true });
    for (const agent of ['claude-desktop', 'claude-code']) {
      const box = await call('inbox', { agent });
      expect(box.open.map((t: any) => t.task_id)).toEqual([d.task_id]);
      expect(box.open[0].ask_user).toBeNull();
    }
    expect((await call('inbox', { agent: 'chatgpt' })).open).toEqual([]);
  });

  test('inbox orders by priority, then due date, then age', async () => {
    const mk = (title: string, extra: Record<string, unknown>) => call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title, instructions: 'x', ...extra });
    await mk('low one', { priority: 'low' });
    await mk('normal late', { due: '2026-12-01' });
    await mk('normal soon', { due: '2026-11-10' });
    await mk('urgent one', { priority: 'urgent' });
    const box = await call('inbox', { agent: 'claude' });
    expect(box.open.map((t: any) => t.title)).toEqual(['urgent one', 'normal soon', 'normal late', 'low one']);
  });
});

describe('claim_task', () => {
  test('agents racing for one task get exactly one winner', async () => {
    const agents = ['claude-a', 'claude-b', 'claude-c', 'claude-d'];
    for (const name of agents) await call('register_agent', { name, model: 'claude-opus-5-5' });
    for (let round = 0; round < 3; round++) {
      const d = await call('delegate', { from_agent: 'grok-bot', to_model: 'claude-opus-5-5', title: `Race ${round}`, instructions: 'x' });
      const results = await Promise.all(agents.map(agent => call('claim_task', { task_id: d.task_id, agent }).then(
        r => ({ agent, ok: true as const, holder: r.task.claimed_by as string }),
        (e: OperationError) => ({ agent, ok: false as const, code: e.code }))));
      const winners = results.filter(r => r.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter(r => !r.ok).map(r => (r as { code: string }).code)).toEqual(['task_claimed', 'task_claimed', 'task_claimed']);
      const stored = await task(d.task_id);
      expect(stored).toMatchObject({ status: 'claimed', claimedBy: winners[0]!.agent, attempts: 1 });
      expect(stored.log.filter(e => e.event === 'claimed')).toHaveLength(1);
    }
  });

  test('an expired lease reopens: inbox shows it open, another agent claims it, heartbeat writes the reopen', async () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    __setHandoffClockForTests(() => t0);
    await call('register_agent', { name: 'claude-a', model: 'claude-opus-5-5' });
    await call('register_agent', { name: 'claude-b', model: 'claude-opus-5-5' });
    const d = await call('delegate', { from_agent: 'grok-bot', to_model: 'claude-opus-5-5', title: 'Lease test', instructions: 'x' });
    const claimed = await call('claim_task', { task_id: d.task_id, agent: 'claude-a' });
    expect(claimed.task.lease_until).toBe('2026-11-08T10:15:00.000Z');
    expect(await refusal(call('claim_task', { task_id: d.task_id, agent: 'claude-b' }))).toBe('task_claimed');

    __setHandoffClockForTests(() => t0 + 16 * 60_000);
    const box = await call('inbox', { agent: 'claude-b' });
    expect(box.open.map((t: any) => [t.task_id, t.status, t.lease_expired])).toEqual([[d.task_id, 'open', true]]);
    // heartbeat writes the reopen into the page
    const hb = await call('heartbeat', { name: 'claude-b' });
    expect(hb.reopened).toEqual([d.task_id]);
    expect(await task(d.task_id)).toMatchObject({ status: 'open', claimedBy: 'claude-a' });
    const second = await call('claim_task', { task_id: d.task_id, agent: 'claude-b' });
    expect(second.task).toMatchObject({ status: 'claimed', claimed_by: 'claude-b', attempts: 2 });
    // the first holder lost the task: it can no longer complete it
    expect(await refusal(call('complete_task', { task_id: d.task_id, agent: 'claude-a', result: 'late' }))).toBe('task_not_yours');
    expect((await task(d.task_id)).log.map(e => e.event)).toEqual(['delegated', 'claimed', 'reopened', 'claimed']);
  });

  test('the holder renews by claiming again; a closed task refuses', async () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    __setHandoffClockForTests(() => t0);
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Renew', instructions: 'x' });
    await call('claim_task', { task_id: d.task_id, agent: 'claude', lease_minutes: 30 });
    __setHandoffClockForTests(() => t0 + 20 * 60_000);
    const renewed = await call('claim_task', { task_id: d.task_id, agent: 'claude' });
    expect(renewed).toMatchObject({ renewed: true, task: { attempts: 1, lease_until: '2026-11-08T10:35:00.000Z' } });
    await call('complete_task', { task_id: d.task_id, agent: 'claude', result: 'done' });
    expect(await refusal(call('claim_task', { task_id: d.task_id, agent: 'claude' }))).toBe('task_closed');
    expect(await refusal(call('claim_task', { task_id: 'no-such-task', agent: 'claude' }))).toBe('not_found');
  });
});

describe('complete and release', () => {
  test('grok-bot delegates on a thread; claude claims, picks up and completes; history shows grok-bot -> claude', async () => {
    await call('log_turn', { agent: 'grok-bot', model: 'grok-4', title: '12 Oak St listing deck', summary: 'Outline drafted.' });
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Build the deck', instructions: 'Ten slides.',
      thread_id: '12-oak-st-listing-deck', context: ['properties/12-oak-st'] });
    expect(d).toMatchObject({ thread: 'threads/12-oak-st-listing-deck', thread_noted: true });
    await call('heartbeat', { name: 'claude', model: 'claude-opus-5-5' });
    const claim = await call('claim_task', { task_id: d.task_id, agent: 'claude' });
    expect(claim.task).toMatchObject({ instructions: 'Ten slides.', context: ['properties/12-oak-st'], thread: 'threads/12-oak-st-listing-deck' });
    const packet = await call('pickup', { thread_id: '12-oak-st-listing-deck', agent: 'claude' });
    expect(packet.delegations).toEqual([{ task_id: d.task_id, title: 'Build the deck', status: 'claimed', from_agent: 'grok-bot', to: 'claude', claimed_by: 'claude' }]);
    const done = await call('complete_task', { task_id: d.task_id, agent: 'claude', result: 'Deck at decks/12-oak-st.', files: ['decks/12-oak-st'] });
    expect(done).toMatchObject({ status: 'done', thread_noted: true });
    expect(await task(d.task_id)).toMatchObject({ status: 'done', result: 'Deck at decks/12-oak-st.', files: ['decks/12-oak-st'], leaseUntil: null });
    const snap = await engine.readPageSnapshot('threads/12-oak-st-listing-deck', { sourceId: 'default' });
    const thread = parseThread({ title: snap!.page.title, frontmatter: snap!.page.frontmatter, body: snap!.page.compiled_truth });
    expect(thread.agents).toEqual(['grok-bot', 'claude']);
    expect(thread.turns.map(t => [t.agent, t.kind])).toEqual([['grok-bot', 'turn'], ['grok-bot', 'delegate'], ['claude', 'complete']]);
    expect((await call('inbox', { agent: 'claude' })).open).toEqual([]);
  });

  test('release returns the task to the inbox with the reason; only the holder may release', async () => {
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Hard one', instructions: 'x' });
    expect(await refusal(call('release_task', { task_id: d.task_id, agent: 'claude', reason: 'never claimed' }))).toBe('task_not_yours');
    await call('claim_task', { task_id: d.task_id, agent: 'claude' });
    const rel = await call('release_task', { task_id: d.task_id, agent: 'claude', reason: 'Needs MLS access' });
    expect(rel.status).toBe('released');
    const box = await call('inbox', { agent: 'claude' });
    expect(box.open.map((t: any) => [t.task_id, t.status])).toEqual([[d.task_id, 'released']]);
    expect((await task(d.task_id)).log.at(-1)).toMatchObject({ agent: 'claude', event: 'released', detail: 'Needs MLS access' });
    const again = await call('claim_task', { task_id: d.task_id, agent: 'claude' });
    expect(again.task.attempts).toBe(2);
  });
});

describe('fan_out, pick_result, routing', () => {
  test('fan_out + pick_result update routing_stats, and route ranks the winner higher', async () => {
    for (const [name, model] of [['claude', 'claude-opus-5-5'], ['chatgpt', 'gpt-5']]) await call('register_agent', { name, model });
    const fan = await call('fan_out', { from_agent: 'grok-bot', agents: ['claude', 'chatgpt'], title: 'Headline options', instructions: 'Three headlines.' });
    expect(fan.tasks.map((t: any) => t.to_agent)).toEqual(['claude', 'chatgpt']);
    expect(fan.thread_id).toBe('headline-options');
    for (const t of fan.tasks) {
      await call('claim_task', { task_id: t.task_id, agent: t.to_agent });
      await call('complete_task', { task_id: t.task_id, agent: t.to_agent, result: `${t.to_agent} headlines` });
    }
    const before = await call('routing_stats', {});
    expect(before.agents.find((a: any) => a.agent === 'claude').fan_out).toEqual({ tasks: 1, completed: 1, picked_groups: 0, wins: 0, win_rate: null });

    const pick = await call('pick_result', { task_id: fan.tasks[0].task_id });
    expect(pick).toMatchObject({ picked: fan.tasks[0].task_id, agent: 'claude', thread_noted: true });
    const stats = await call('routing_stats', {});
    const claude = stats.agents.find((a: any) => a.agent === 'claude');
    const chatgpt = stats.agents.find((a: any) => a.agent === 'chatgpt');
    expect(claude).toMatchObject({ done: 1, claims: 1, completion_rate: 1, fan_out: { tasks: 1, completed: 1, picked_groups: 1, wins: 1, win_rate: 1 } });
    expect(chatgpt.fan_out).toEqual({ tasks: 1, completed: 1, picked_groups: 1, wins: 0, win_rate: 0 });
    expect(typeof claude.median_time_to_claim_minutes).toBe('number');
    expect((await task(fan.tasks[1].task_id)).picked).toBe(false);

    const routed = await call('route', { tags: ['copy'] });
    expect(routed.targets.map((t: any) => t.target).slice(0, 2)).toEqual(['claude', 'chatgpt']);
    expect(routed.targets[0].reason).toContain('won 1/1 fan-out picks');
    // A repeat pick changes nothing.
    expect((await call('pick_result', { task_id: fan.tasks[0].task_id })).changed).toEqual([]);
  });

  test('routing.md rules, liveness and model targets rank deterministically with reasons', async () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    __setHandoffClockForTests(() => t0 - 5 * 60 * 60_000);
    await call('register_agent', { name: 'stale-bot', model: 'gpt-5' });
    __setHandoffClockForTests(() => t0);
    await call('register_agent', { name: 'claude', model: 'claude-opus-5-5', capabilities: ['decks'] });
    await call('register_agent', { name: 'gemini', model: 'gemini-3-pro' });
    await call('register_agent', { name: 'chatgpt', model: 'gpt-5' });
    await engine.putPage('routing', { type: 'note', title: 'Agent routing', compiled_truth: 'Rules for delegation.', timeline: '',
      frontmatter: { handoff_type: 'routing', live_window_minutes: 60, rules: [
        { when: { tags: ['deck'] }, prefer: ['stale-bot', 'claude'], fallback: ['model:gemini-3-pro'] },
        { when: { task_type: 'research' }, prefer: ['model:gpt-5'] },
        { when: 'default', fallback: ['chatgpt'] },
        'not a rule',
      ] } } as never, { sourceId: 'default' });

    const deck = await call('route', { tags: ['deck', 'decks'] });
    expect(deck.targets[0]).toMatchObject({ target: 'claude', kind: 'agent', live: true });
    expect(deck.targets[0].reasons).toEqual(expect.arrayContaining(['rule 1 (tags deck): preferred #2', 'live (heartbeat 0m ago)', 'capabilities decks']));
    const stale = deck.targets.find((t: any) => t.target === 'stale-bot');
    expect(stale.live).toBe(false);
    expect(stale.reason).toContain('stale (heartbeat 300m ago)');
    expect(deck.warnings).toEqual(['rule 4 is not a mapping; skipped.']);
    expect(await call('route', { tags: ['deck', 'decks'] }) as unknown).toEqual(deck as unknown); // same pages, same ranking

    const research = await call('route', { task_type: 'research', exclude: ['chatgpt'] });
    expect(research.targets[0]).toMatchObject({ target: 'model:gpt-5', kind: 'model', live: true, reasons: ['rule 2 (task_type research): preferred #1', '1 live agent(s) on this model'] });
    expect(research.targets.map((t: any) => t.target)).not.toContain('chatgpt');

    // delegate with no target takes the top route and records why
    const d = await call('delegate', { from_agent: 'grok-bot', title: 'Deck for Elm Ave', instructions: 'x', tags: ['deck'] });
    expect(d).toMatchObject({ to_agent: 'claude', to_model: null });
    expect(d.routed).toContain('rule 1 (tags deck): preferred #2');
    // route by task id reads the task's own tags (stored as page tags)
    const byTask = await call('route', { task_id: d.task_id });
    expect(byTask.tags).toEqual(['deck']);
    expect(byTask.targets[0].target).toBe('claude');
  });

  test('delegate with no target and nobody to route to is refused', async () => {
    expect(await refusal(call('delegate', { from_agent: 'grok-bot', title: 'x', instructions: 'y' }))).toBe('invalid_params');
  });
});

describe('remote callers', () => {
  test('an MCP caller can delegate, claim and complete in its write source', async () => {
    const remote = ctx({ remote: true, transport: 'stdio' } as Partial<OperationContext>);
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Remote task', instructions: 'x' }, remote);
    await call('heartbeat', { name: 'claude', model: 'claude-opus-5-5' }, remote);
    expect((await call('inbox', { agent: 'claude' }, remote)).open.map((t: any) => t.task_id)).toEqual([d.task_id]);
    await call('claim_task', { task_id: d.task_id, agent: 'claude' }, remote);
    expect((await call('complete_task', { task_id: d.task_id, agent: 'claude', result: 'ok' }, remote)).status).toBe('done');
  });
});
