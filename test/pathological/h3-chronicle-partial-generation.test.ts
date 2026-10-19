/**
 * #7013 (Life Chronicle): an empty or partial re-derivation never retires the previous event generation.
 *
 * Protects: after a depth page's revision is re-judged, its earlier automatic events stay live unless the new
 * generation is complete and non-empty. An honest empty judge answer ('[]'), a generation whose every proposal the
 * date screen dropped, one the 'chronicle.max_events_per_page' cap trimmed, and one judged from a body longer than the
 * judge reads (JUDGE_BODY_CHARS) publish what they have and retire nothing; the new revision's ledger row is still
 * 'extracted', so the same content is not judged (paid for) again. A complete clean replacement still retires the
 * events it no longer produces, and a page that stops being chronicle-shaped still retires its events.
 * Fails when: an empty or partial generation soft-deletes ('retired_by: life-chronicle') an event the previous
 * generation published, on a managed brain (maintenance intents) or an unmanaged one (direct transactions).
 * Seams: the gateway's stub chat transport ('__setChatTransportForTests', no paid calls) behind the real default judge,
 * so the judge reads only its body window. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { JUDGE_BODY_CHARS } from '../../src/core/chronicle/extract-events.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { _resetBudgetTrackerWarningsForTest } from '../../src/core/budget/budget-tracker.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const today = new Date().toISOString().slice(0, 10);
const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'notes/acme-example-sync';
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const TAIL = 'Bob owns the launch email.';
const ALICE = 'Alice agreed to ship the beta';
const BOB = 'Bob owns the launch email';
const meeting = (body: string, type = 'meeting') => `---\ntype: ${type}\ntitle: Acme example sync\ndate: ${today}\n---\n\n${body}\n`;
const ev = (what: string, when = today) => ({ when, who: ['people/alice-example'], what, kind: 'commitment' });
const BOTH_LIVE = [{ what: ALICE, deleted: false, retired_by: null }, { what: BOB, deleted: false, retired_by: null }];

interface Brain {
  engine: BrainEngine;
  put(content: string): Promise<void>;
  phase(): Promise<Record<string, unknown>>;
}

/** The stub chat model behind the default judge: 'answer' sees the user prompt the judge built (its body window). */
function stubJudge(answer: (prompt: string) => unknown[]): string[] {
  const prompts: string[] = [];
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1]!;
    const prompt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    prompts.push(prompt);
    const text = JSON.stringify(answer(prompt));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: opts.model ?? 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
  return prompts;
}

async function managed(databaseUrl: string | undefined, run: (brain: Brain) => Promise<void>): Promise<void> {
  await managedBrain(async ({ engine, ctx }) => {
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    await run({
      engine,
      put: async (content) => {
        const current = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
        await operationsByName.put_page.handler(ctx, { slug: SLUG, content, ...(current ? { expected_revision: current.revision } : {}) });
      },
      phase: async () => {
        await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
        return (await runPhaseChronicle(engine)).details as Record<string, unknown>;
      },
    });
  }, { databaseUrl });
}

async function unmanaged(databaseUrl: string | undefined, run: (brain: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-chronicle-7013-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await engine.setConfig('chronicle.auto_settle_seconds', '0');
        await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
        await run({
          engine,
          put: async (content) => { await importFromContent(engine, SLUG, content, { noEmbed: true, sourceId: 'default' }); },
          phase: async () => (await runPhaseChronicle(engine)).details as Record<string, unknown>,
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function events(engine: BrainEngine) {
  return engine.executeRaw<{ what: string; deleted: boolean; retired_by: string | null }>(
    "SELECT frontmatter->'event'->>'what' AS what, deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by FROM pages WHERE type='event' ORDER BY what");
}

/** The ledger row of the depth page's current revision. */
async function currentRow(engine: BrainEngine) {
  return engine.executeRaw<{ state: string; reason: string | null }>(
    "SELECT c.state, c.reason FROM chronicle_page_state c JOIN pages p ON p.id=c.page_id AND p.content_hash=c.content_hash WHERE p.slug=$1 AND p.source_id='default'",
    [SLUG]);
}

/** Generation 1 publishes Alice's and Bob's events from a short body. */
async function firstGeneration(brain: Brain): Promise<void> {
  await brain.put(meeting(`${BODY} ${TAIL}`));
  expect(await brain.phase()).toMatchObject({ judged: 1, extracted: 1, events_written: 2 });
  expect(await events(brain.engine)).toEqual(BOTH_LIVE);
}

afterEach(() => { __setChatTransportForTests(null); resetGateway(); _resetBudgetTrackerWarningsForTest(); });

for (const { backend, databaseUrl } of pathologicalArms()) {
  for (const [mode, brain] of [['managed', managed], ['unmanaged', unmanaged]] as const) {
    describe(`#7013 chronicle re-derivation never retires on an empty or partial generation (${backend}, ${mode})`, () => {
      test('an honest empty answer retires nothing and the new revision is not judged again', () => brain(databaseUrl, async (b) => {
        let answer: unknown[] = [ev(ALICE), ev(BOB)];
        const prompts = stubJudge(() => answer);
        await firstGeneration(b);
        answer = [];
        await b.put(meeting(`${BODY} Wording changed. ${TAIL}`));
        expect(await b.phase()).toMatchObject({ judged: 1, no_events: 1, events_written: 0, events_retired: 0, reasons: { no_events: 1 } });
        expect(await events(b.engine)).toEqual(BOTH_LIVE);
        expect(await currentRow(b.engine)).toEqual([{ state: 'extracted', reason: 'no_events' }]);
        expect(prompts.length).toBe(2);
        expect(await b.phase()).toMatchObject({ judged: 0, events_retired: 0 });
        expect(prompts.length).toBe(2);
        expect(await events(b.engine)).toEqual(BOTH_LIVE);
      }), 180_000);

      test('a generation whose every proposal the date screen drops retires nothing', () => brain(databaseUrl, async (b) => {
        let answer: unknown[] = [ev(ALICE), ev(BOB)];
        stubJudge(() => answer);
        await firstGeneration(b);
        answer = [ev('Offsite planning session', future)];
        await b.put(meeting(`${BODY} Offsite next week. ${TAIL}`));
        expect(await b.phase()).toMatchObject({ judged: 1, no_events: 1, events_written: 0, events_retired: 0, events_dropped: { future_dated: 1 } });
        expect(await events(b.engine)).toEqual(BOTH_LIVE);
        expect(await currentRow(b.engine)).toEqual([{ state: 'extracted', reason: 'future_dated' }]);
      }), 180_000);

      test('a generation the per-page cap trims retires nothing', () => brain(databaseUrl, async (b) => {
        let answer: unknown[] = [ev(ALICE), ev(BOB)];
        stubJudge(() => answer);
        await firstGeneration(b);
        await b.engine.setConfig('chronicle.max_events_per_page', '1');
        answer = [ev(ALICE), ev('Carol joined the beta review')];
        await b.put(meeting(`${BODY} Carol joined. ${TAIL}`));
        expect(await b.phase()).toMatchObject({ judged: 1, extracted: 1, events_written: 1, events_retired: 0, events_dropped: { over_cap: 1 } });
        expect(await events(b.engine)).toEqual(BOTH_LIVE);
        expect(await currentRow(b.engine)).toEqual([{ state: 'extracted', reason: null }]);
      }), 180_000);

      test('a generation judged from a truncated body retires nothing past the window', () => brain(databaseUrl, async (b) => {
        const prompts = stubJudge((prompt) => (prompt.includes(TAIL) ? [ev(ALICE), ev(BOB)] : [ev(ALICE)]));
        await firstGeneration(b);
        const long = BODY + 'The team walked through every launch metric in detail. '.repeat(Math.ceil(JUDGE_BODY_CHARS / 50)) + TAIL;
        expect(long.length).toBeGreaterThan(JUDGE_BODY_CHARS);
        await b.put(meeting(long));
        expect(await b.phase()).toMatchObject({ judged: 1, extracted: 1, events_written: 1, events_retired: 0 });
        expect(prompts.length).toBe(2);
        expect(prompts[1]!.includes(TAIL)).toBe(false);
        expect(await events(b.engine)).toEqual(BOTH_LIVE);
        expect(await currentRow(b.engine)).toEqual([{ state: 'extracted', reason: null }]);
      }), 180_000);

      test('control: a complete clean replacement still retires the event it no longer produces', () => brain(databaseUrl, async (b) => {
        let answer: unknown[] = [ev(ALICE), ev(BOB)];
        stubJudge(() => answer);
        await firstGeneration(b);
        answer = [ev(ALICE)];
        await b.put(meeting(`${BODY} Bob handed the email to Alice.`));
        expect(await b.phase()).toMatchObject({ judged: 1, extracted: 1, events_written: 1, events_retired: 1 });
        expect(await events(b.engine)).toEqual([{ what: ALICE, deleted: false, retired_by: null }, { what: BOB, deleted: true, retired_by: 'life-chronicle' }]);
        expect(await currentRow(b.engine)).toEqual([{ state: 'extracted', reason: null }]);
      }), 180_000);

      test('control: a depth page that stops being a meeting still retires its events without a model call', () => brain(databaseUrl, async (b) => {
        const prompts = stubJudge(() => [ev(ALICE), ev(BOB)]);
        await firstGeneration(b);
        await b.put(meeting(`${BODY} ${TAIL}`, 'note'));
        expect(await b.phase()).toMatchObject({ judged: 0, events_retired: 2 });
        expect(prompts.length).toBe(1);
        expect(await events(b.engine)).toEqual([{ what: ALICE, deleted: true, retired_by: 'life-chronicle' }, { what: BOB, deleted: true, retired_by: 'life-chronicle' }]);
      }), 180_000);
    });
  }
}
