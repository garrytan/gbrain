/**
 * #8972: a conversation page longer than the judge's window (JUDGE_BODY_CHARS) on the automatic path.
 *
 * Protects: a revision whose judge input is unchanged (the tail grew past the window) makes no paid call and writes no
 * events; a re-judged generation that read every text the live events came from replaces them instead of piling up;
 * a generation that did not (an edited head, or rows recorded before the judged window was stored) stays additive (#7013).
 * Fails when: a growing long conversation is judged again on the same window, or each run adds a reworded copy of its
 * events.
 * Seams: an injected judge that rewords `what` on every call, as a real model does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { JUDGE_BODY_CHARS, type ChronicleJudge, type ChronicleJudgeInput } from '../src/core/chronicle/extract-events.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { readChronicleDuplicateEvents } from '../src/core/chronicle/ledger-stats.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

/** One clock for the whole file: the test's dates and every chronicle run read it, so a run that crosses 00:00 UTC cannot move the cutoff day. */
const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const SLUG = 'conversations/launch-thread';

/** Chat lines numbered from `from` until the body reaches `chars`. */
function messages(from: number, chars: number, speaker = 'alice-example'): string {
  const lines: string[] = [];
  let n = from;
  while (lines.join('\n').length < chars) lines.push(`${speaker}: message ${n++} about the beta launch plan and the next steps for it.`);
  return lines.join('\n');
}
const conversation = (body: string, title = 'Launch thread') => `---\ntype: conversation\ntitle: ${title}\ndate: ${today}\n---\n\n${body}`;

async function put(ctx: OperationContext, content: string): Promise<void> {
  const current = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await operationsByName.put_page.handler(ctx, { slug: SLUG, content, ...(current ? { expected_revision: current.revision } : {}) });
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
/** Two events per call; the wording of `what` changes on every call, as a model's does. */
function rewordingJudge() {
  const inputs: ChronicleJudgeInput[] = [];
  const judge: ChronicleJudge = async (input) => {
    inputs.push(input);
    const n = inputs.length;
    return { events: [
      { when: today, who: ['people/alice-example'], what: `Alice agreed to ship the beta (wording ${n})`, kind: 'decision' },
      { when: today, who: ['people/bob-example'], what: `Bob committed to the launch checklist (wording ${n})`, kind: 'commitment' },
    ] };
  };
  return Object.assign(judge, { inputs });
}
async function run(engine: BrainEngine, judge: ChronicleJudge) {
  await settle(engine);
  return runPhaseChronicle(engine, { judge, now: () => NOW });
}
async function liveEvents(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ what: string }>(
    "SELECT frontmatter->'event'->>'what' AS what FROM pages WHERE type='event' AND deleted_at IS NULL ORDER BY what")).map((r) => r.what);
}
async function retiredEvents(engine: BrainEngine): Promise<number> {
  return (await engine.executeRaw<{ n: number }>(
    "SELECT count(*)::int AS n FROM pages WHERE type='event' AND deleted_at IS NOT NULL AND frontmatter->>'retired_by'='life-chronicle'"))[0].n;
}
async function ledger(engine: BrainEngine) {
  return (await engine.executeRaw<{ state: string; reason: string | null }>(
    'SELECT state, reason FROM chronicle_page_state ORDER BY decided_at, updated_at')).map((r) => [r.state, r.reason]);
}
async function dueRetries(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second' WHERE state='failed' AND next_attempt_at IS NOT NULL");
}
async function reservations(engine: BrainEngine): Promise<number> {
  return (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chronicle_judge_reservations'))[0].n;
}

afterEach(() => { resetGateway(); });

describe('#8972: long conversation pages', () => {
  test('a tail that grows past the window is not judged again and adds no events', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    expect(judge.inputs).toHaveLength(1);
    for (const n of [1, 2, 3]) {
      body += `\nbob-example: tail message ${n}, well past the judged window.`;
      await put(ctx, conversation(body));
      const r = await run(engine, judge);
      expect(r.details).toMatchObject({ judged: 0, events_written: 0, reasons: { judge_input_unchanged: 1 } });
    }
    expect(judge.inputs).toHaveLength(1);
    expect(await reservations(engine)).toBe(1);
    expect(await liveEvents(engine)).toEqual(['Alice agreed to ship the beta (wording 1)', 'Bob committed to the launch checklist (wording 1)']);
    expect(await ledger(engine)).toEqual([['extracted', null], ['skipped', 'judge_input_unchanged'], ['skipped', 'judge_input_unchanged'],
      ['skipped', 'judge_input_unchanged']]);
    expect(await readChronicleDuplicateEvents(engine)).toEqual({ pages: 0, surplus: 0 });
  }), 180_000);

  test('a re-judge of the same window (the title changed) replaces the earlier events', () => brain(async ({ engine, ctx }) => {
    const body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    await put(ctx, conversation(`${body}\nbob-example: one more.`, 'Launch thread (renamed)'));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    expect(r.details).toMatchObject({ judged: 1, events_written: 2, events_retired: 2 });
    expect(await liveEvents(engine)).toEqual(['Alice agreed to ship the beta (wording 2)', 'Bob committed to the launch checklist (wording 2)']);
    expect(await retiredEvents(engine)).toBe(2);
  }), 180_000);

  test('a short conversation that grows past the window keeps its text in the window: the first truncated run replaces', () => brain(async ({ engine, ctx }) => {
    const head = messages(1, 5_000);
    await put(ctx, conversation(head));
    const judge = rewordingJudge();
    await run(engine, judge);
    await put(ctx, conversation(`${head}\n${messages(1_000, JUDGE_BODY_CHARS, 'bob-example')}`));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    expect(r.details).toMatchObject({ judged: 1, events_retired: 2 });
    expect(await liveEvents(engine)).toEqual(['Alice agreed to ship the beta (wording 2)', 'Bob committed to the launch checklist (wording 2)']);
  }), 180_000);

  test('an edited head moves the window: the new run is judged and stays additive (#7013)', () => brain(async ({ engine, ctx }) => {
    const body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    await put(ctx, conversation(`carol-example: an earlier message pasted in at the top.\n${body}`));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    expect(r.details).toMatchObject({ judged: 1, events_written: 2, events_retired: 0 });
    expect(await liveEvents(engine)).toHaveLength(4);
  }), 180_000);

  test('a row recorded before the upgrade (no judged window) is judged once more, additively, then never again', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    await engine.executeRaw('UPDATE chronicle_page_state SET judge_input_hash=NULL, judge_window_chars=NULL, judge_window_hash=NULL');
    for (const n of [1, 2]) {
      body += `\nbob-example: tail message ${n}.`;
      await put(ctx, conversation(body));
      await run(engine, judge);
    }
    expect(judge.inputs).toHaveLength(2);
    expect(await liveEvents(engine)).toHaveLength(4);
    expect(await retiredEvents(engine)).toBe(0);
    // Doctor's chronicle_duplicate_events: the pre-upgrade run's two events sit beside the newest run's two.
    expect(await readChronicleDuplicateEvents(engine)).toEqual({ pages: 1, surplus: 2 });
  }), 180_000);
test('a judge that keeps failing on an unchanged window is paid at most the attempt limit across revisions', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    let calls = 0;
    const failing: ChronicleJudge = async () => { calls++; return { events: [], failure: 'truncated' }; };
    await run(engine, failing);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      body += `\nbob-example: tail message ${n}.`;
      await put(ctx, conversation(body));
      await run(engine, failing);
    }
    expect(calls).toBe(5);
    expect((await ledger(engine)).at(-1)).toEqual(['failed', 'judge_input_failed']);
    expect(await reservations(engine)).toBe(5);
  }), 180_000);

  test('events a chronicle retirement removed (a deleted and restored page) are judged again', () => brain(async ({ engine, ctx }) => {
    const body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    const revision = async () => (await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true }))!.revision;
    await operationsByName.delete_page.handler(ctx, { slug: SLUG, expected_revision: await revision() });
    await run(engine, judge); // the orphan sweep retires the deleted page's events
    expect(await liveEvents(engine)).toHaveLength(0);
    await operationsByName.restore_page.handler(ctx, { slug: SLUG, expected_revision: await revision() });
    await put(ctx, conversation(`${body}\nbob-example: back again.`));
    await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    expect(await liveEvents(engine)).toHaveLength(2);
  }), 180_000);

  test('a privacy change re-judges a page whose text did not change, and its events take the new visibility', () => brain(async ({ engine, ctx }) => {
    const body = messages(1, 2_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    await put(ctx, `---\ntype: conversation\ntitle: Launch thread\ndate: ${today}\nvisibility: private\n---\n\n${body}`);
    await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    const stamps = await engine.executeRaw<{ visibility: string }>(
      "SELECT frontmatter->>'visibility' AS visibility FROM pages WHERE type='event' AND deleted_at IS NULL");
    expect(stamps.map((s) => s.visibility)).toEqual(['private', 'private']);
  }), 180_000);

  test('a live event no ledger row accounts for keeps a re-judged long page additive', () => brain(async ({ engine, ctx }) => {
    const body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = rewordingJudge();
    await run(engine, judge);
    await engine.executeRaw("UPDATE chronicle_page_state SET event_slugs='{}', event_hashes='{}'");
    await put(ctx, conversation(`${body}\nbob-example: one more.`, 'Launch thread (renamed)'));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(2);
    expect(r.details).toMatchObject({ judged: 1, events_retired: 0 });
    expect(await liveEvents(engine)).toHaveLength(4);
  }), 180_000);
});

describe('#8972 fix round: what counts as judged, and what exhausts a page', () => {
  /** A judge whose proposals come from `events(n)` on its n-th call (1-based). */
  function scriptedJudge(events: (n: number) => Array<{ when: string; what: string }>) {
    let calls = 0;
    const judge: ChronicleJudge = async () => {
      calls++;
      return { events: events(calls).map((e) => ({ when: e.when, who: ['people/alice-example'], what: e.what, kind: 'decision' as const })) };
    };
    return Object.assign(judge, { calls: () => calls });
  }
  const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

  test('runs on an unconfigured provider never exhaust the page', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    let unavailable = 0;
    const noProvider: ChronicleJudge = async () => { unavailable++; return { events: [], failure: 'llm_unavailable' }; };
    await run(engine, noProvider);
    for (const n of [1, 2, 3, 4, 5]) {
      body += `\nbob-example: tail message ${n}.`;
      await put(ctx, conversation(body));
      await run(engine, noProvider);
    }
    expect(unavailable).toBe(6);
    const judge = rewordingJudge();
    body += '\nbob-example: the provider is configured now.';
    await put(ctx, conversation(body));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(1);
    expect(r.details).toMatchObject({ judged: 1, events_written: 2 });
    expect((await ledger(engine)).at(-1)).toEqual(['extracted', null]);
  }), 180_000);

  test('judged runs a newer revision superseded while they ran never exhaust the page', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    let racing = 0;
    const judge = rewordingJudge();
    const raced: ChronicleJudge = async (input) => {
      racing++;
      body += `\nbob-example: tail message ${racing}, written while the judge ran.`;
      await put(ctx, conversation(body));
      return judge(input);
    };
    for (let n = 0; n < 6; n++) await run(engine, raced);
    expect(racing).toBe(6);
    expect((await ledger(engine)).filter(([, reason]) => reason === 'superseded').length).toBeGreaterThanOrEqual(5);
    expect((await ledger(engine)).filter(([, reason]) => reason === 'judge_input_failed')).toEqual([]);
    const r = await run(engine, judge);
    expect(r.details).toMatchObject({ judged: 1 });
    expect((await ledger(engine)).at(-1)).toEqual(['extracted', null]);
  }), 180_000);

  test('an over_cap generation stays cached at the same cap and is judged again when the cap is raised', () => brain(async ({ engine, ctx }) => {
    await engine.setConfig('chronicle.max_events_per_page', '2');
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const judge = scriptedJudge((n) => [1, 2, 3].map((i) => ({ when: today, what: `Decision ${i} (wording ${n})` })));
    await run(engine, judge);
    expect(await liveEvents(engine)).toHaveLength(2);
    body += '\nbob-example: tail message 1.';
    await put(ctx, conversation(body));
    const same = await run(engine, judge);
    expect(same.details).toMatchObject({ judged: 0, reasons: { judge_input_unchanged: 1 } });
    expect(judge.calls()).toBe(1);
    await engine.setConfig('chronicle.max_events_per_page', '5');
    body += '\nbob-example: tail message 2.';
    await put(ctx, conversation(body));
    const raised = await run(engine, judge);
    expect(judge.calls()).toBe(2);
    expect(raised.details).toMatchObject({ judged: 1, events_written: 3 });
  }), 180_000);

  test('a generation that dropped future-dated proposals is judged again once when the cutoff day moves', () => brain(async ({ engine, ctx }) => {
    const yesterday = day(-1);
    const page = (body: string, end: string) => `---\ntype: conversation\ntitle: Launch thread\ndate: ${yesterday}\nend: ${end}\n---\n\n${body}`;
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, page(body, yesterday));
    const judge = scriptedJudge((n) => [{ when: yesterday, what: `Kickoff (wording ${n})` }, { when: today, what: `Launch (wording ${n})` }]);
    const first = await run(engine, judge);
    expect(first.details).toMatchObject({ judged: 1, events_written: 1 });
    body += '\nbob-example: tail message 1.';
    await put(ctx, page(body, yesterday));
    await run(engine, judge);
    expect(judge.calls()).toBe(1);
    // The conversation now runs into today: the judge reads the same text, but today's proposal is no longer future-dated.
    for (const n of [2, 3]) {
      body += `\nbob-example: tail message ${n}.`;
      await put(ctx, page(body, today));
      await run(engine, judge);
    }
    expect(judge.calls()).toBe(2);
    expect(await liveEvents(engine)).toEqual(['Kickoff (wording 2)', 'Launch (wording 2)']);
  }), 180_000);

  test('a held result after a failed attempt does not stand for the judged input', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    const four = [1, 2, 3, 4];
    let calls = 0;
    const judge: ChronicleJudge = async () => {
      calls++;
      if (calls === 2) return { events: [], failure: 'truncated' };
      const kept = calls === 1 ? four : [1];
      return { events: kept.map((i) => ({ when: today, who: ['people/alice-example'], what: `Decision ${i} (wording ${calls})`, kind: 'decision' as const })) };
    };
    await run(engine, judge);
    await put(ctx, conversation(`${body}\nbob-example: renamed.`, 'Launch thread (renamed)'));
    await run(engine, judge);
    expect((await ledger(engine)).at(-1)).toEqual(['failed', 'judge_truncated']);
    await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second' WHERE state='failed'");
    await run(engine, judge); // the retry shrinks four events to one: held, nothing published
    expect(calls).toBe(3);
    expect(await liveEvents(engine)).toHaveLength(4);
    expect((await engine.executeRaw<{ h: string | null }>(
      "SELECT judge_input_hash AS h FROM chronicle_page_state WHERE state='extracted' ORDER BY decided_at DESC, updated_at DESC LIMIT 1"))[0].h).toBeNull();
    body += '\nbob-example: renamed.\nbob-example: tail message 1.';
    await put(ctx, conversation(body, 'Launch thread (renamed)'));
    await run(engine, judge);
    expect(calls).toBe(4);
  }), 180_000);
test('transient chat errors before one counted failure do not exhaust the page, and it is judged once the provider recovers', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    let calls = 0;
    const flaky: ChronicleJudge = async () => { calls++; return { events: [], failure: calls < 5 ? 'chat_error' : 'truncated' }; };
    await run(engine, flaky);
    for (let n = 0; n < 4; n++) { await dueRetries(engine); await run(engine, flaky); }
    expect(calls).toBe(5);
    expect((await ledger(engine)).at(-1)).toEqual(['failed', 'judge_truncated']);
    const judge = rewordingJudge();
    body += '\nbob-example: the provider is back.';
    await put(ctx, conversation(body));
    const r = await run(engine, judge);
    expect(judge.inputs).toHaveLength(1);
    expect(r.details).toMatchObject({ judged: 1, events_written: 2 });
  }), 180_000);

  test('retries of the current revision count toward the attempt limit: unchanged text is paid at most 5 times', () => brain(async ({ engine, ctx }) => {
    let body = messages(1, JUDGE_BODY_CHARS + 1_000);
    await put(ctx, conversation(body));
    let calls = 0;
    const failing: ChronicleJudge = async () => { calls++; return { events: [], failure: 'truncated' }; };
    await run(engine, failing);
    for (let n = 0; n < 3; n++) { await dueRetries(engine); await run(engine, failing); }
    expect(calls).toBe(4);
    body += '\nbob-example: tail message 1.';
    await put(ctx, conversation(body));
    for (let n = 0; n < 6; n++) { await dueRetries(engine); await run(engine, failing); }
    expect(calls).toBe(5);
    expect((await ledger(engine)).at(-1)).toEqual(['failed', 'judge_input_failed']);
  }), 180_000);
});
