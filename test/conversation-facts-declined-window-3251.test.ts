/**
 * GST-3251: conversation fact extraction no longer loses a whole page to one window the model declines, and the
 * documented `**Speaker** (YYYY-MM-DD h:mm AM): text` page whose answer lists `**Label:** text` lines parses.
 *
 * Protects:
 * 1. A window the extraction model declines (refusal or content_filter) is retried once as two halves; the facts of
 *    every other window and half are published as a partial batch, the declined span is listed in declined_windows
 *    and failed_pages, and the page stays unfinished (no terminal row) so the next run retries it.
 * 2. Any other window failure still fails the page with nothing published.
 * 3. A page with no parseable speaker turns is listed in unparsed_pages with its cause.
 * 4. A transcript whose first answer lists bold labels is extracted instead of skipped as unparsed.
 * Fails when: one declined window drops the page's other facts, a declined window ends the page as complete, the
 * envelope omits a skipped page's cause, or the bold-label transcript is skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ExtractInput, ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { randomUUID } from 'node:crypto';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';

let engine: PGLiteEngine;
let calls: string[] = [];

const turn = (speaker: string, day: string, time: string, text: string) => `**${speaker}** (2026-03-${day} ${time}): ${text}`;
const page = (turns: string[]) => ['---', 'type: conversation', 'title: Planning chat', 'date: 2026-03-01', '---', '', ...turns, ''].join('\n');

/** Three windows a day apart; the second one's last turn carries the marker the stub model declines. */
const THREE_WINDOWS = page([
  turn('Alice Example', '01', '9:00 AM', 'Note topic-alpha for the launch.'),
  turn('Bob Example', '01', '9:01 AM', 'Agreed on topic-alpha.'),
  turn('Alice Example', '02', '9:00 AM', 'Next is topic-beta.'),
  turn('Bob Example', '02', '9:01 AM', 'Fine, topic-beta stays.'),
  turn('Alice Example', '02', '9:02 AM', 'Also topic-gamma.'),
  turn('Bob Example', '02', '9:03 AM', 'DECLINE-ME topic-delta.'),
  turn('Alice Example', '03', '9:00 AM', 'Finally topic-epsilon.'),
  turn('Bob Example', '03', '9:01 AM', 'Done with topic-epsilon.'),
]);

function stub(failure: 'refusal' | 'content_filter' | 'provider_error' = 'refusal') {
  return async (input: ExtractInput): Promise<ExtractedFact[]> => {
    calls.push(input.turnText);
    if (input.turnText.includes('DECLINE-ME')) throw Object.assign(new Error('declined'), { extractionReason: failure });
    const topics = [...new Set(input.turnText.match(/topic-[a-z]+/g) ?? [])];
    return topics.map(topic => ({ fact: `The team discussed ${topic}`, kind: 'fact', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high' }) as ExtractedFact);
  };
}

async function put(slug: string, content: string) {
  const res = await dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false });
  expect(res.isError).toBeFalsy();
}

async function extract(slug: string, extractor = stub()) {
  await disposePersistenceConsumer(engine);
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, overrideDisabled: true, extractor });
}

async function facts(slug: string) {
  const rows = await engine.executeRaw<{ fact: string; source: string }>(
    `SELECT fact, source FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND expired_at IS NULL ORDER BY fact`, [slug]);
  return { claims: rows.filter(r => !r.source.startsWith('cli:extract-conversation-facts:terminal')).map(r => r.fact), terminal: rows.some(r => r.source === TERMINAL_AUDIT_SOURCE) };
}

describe('GST-3251 conversation fact extraction', () => {
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { resetGateway(); await engine.disconnect(); });
  beforeEach(async () => {
    await disposePersistenceConsumer(engine);
    await resetPgliteState(engine);
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    calls = [];
  }, 60_000);

  for (const reason of ['refusal', 'content_filter'] as const) {
    test(`a ${reason} window keeps the other windows' facts and leaves the page to retry`, async () => {
      await put('conversations/planning', THREE_WINDOWS);
      const run = await extract('conversations/planning', stub(reason));
      expect(run.pages_failed).toBe(1);
      expect(run.pages_processed).toBe(0);
      expect(run.declined_windows).toEqual([{ slug: 'conversations/planning', start: '2026-03-02T09:02:00Z', end: '2026-03-02T09:03:00Z', reason }]);
      expect(run.failed_pages[0]!.error).toContain('declined 1 window(s): 2026-03-02T09:02:00Z..2026-03-02T09:03:00Z');
      expect(run.failed_pages[0]!.error).toContain('3 new fact(s) from the other windows were published');
      const after = await facts('conversations/planning');
      expect(after.claims).toEqual(['The team discussed topic-alpha', 'The team discussed topic-beta', 'The team discussed topic-epsilon']);
      expect(after.terminal).toBe(false);
      // Window 2 once whole, then its two halves; windows 1 and 3 once each.
      expect(calls).toHaveLength(5);

      const again = await extract('conversations/planning', stub(reason));
      expect(again.pages_skipped_completed).toBe(0);
      expect(again.pages_failed).toBe(1);
      expect(again.failed_pages[0]!.error).toContain('0 new fact(s) from the other windows were published');
      expect((await facts('conversations/planning')).claims).toHaveLength(3);
    });
  }

  test('a window whose halves both decline lists each half, and a one-message half is not split again', async () => {
    await put('conversations/short', page([
      turn('Alice Example', '01', '9:00 AM', 'Note topic-alpha.'),
      turn('Bob Example', '01', '9:01 AM', 'Agreed on topic-alpha.'),
    ]));
    const extractor = async (input: ExtractInput) => { calls.push(input.turnText); throw Object.assign(new Error('declined'), { extractionReason: 'refusal' }); };
    const run = await extract('conversations/short', extractor);
    expect(run.declined_windows.map(w => [w.start, w.end])).toEqual([['2026-03-01T09:00:00Z', '2026-03-01T09:00:00Z'], ['2026-03-01T09:01:00Z', '2026-03-01T09:01:00Z']]);
    expect(calls).toHaveLength(3);
    expect((await facts('conversations/short')).claims).toEqual([]);
  });

  test('any other window failure still fails the page and publishes nothing', async () => {
    await put('conversations/planning', THREE_WINDOWS);
    const run = await extract('conversations/planning', stub('provider_error'));
    expect(run.pages_failed).toBe(1);
    expect(run.declined_windows).toEqual([]);
    expect((await facts('conversations/planning')).claims).toEqual([]);
  });

  test('a page with no speaker turns is listed in unparsed_pages with its cause', async () => {
    await put('conversations/prose', page(['The launch review moved to next quarter.', 'Budgets stay flat for now.']));
    const run = await extract('conversations/prose');
    expect(run.pages_skipped_unparsed).toBe(1);
    expect(run.unparsed_pages).toHaveLength(1);
    expect(run.unparsed_pages[0]!.slug).toBe('conversations/prose');
    expect(run.unparsed_pages[0]!.cause).toBe('no line matched any conversation format');
  });

  test('a transcript whose answer lists bold labels is extracted, not skipped as unparsed', async () => {
    await put('conversations/options', page([
      turn('User', '01', '9:00 AM', 'Compare the topic-alpha options.'),
      [turn('Assistant', '01', '9:01 AM', 'Here they are:'), '**Option A:** fast', '**Option B:** cheap', '**Option C:** simple',
        '**Option D:** robust', '**Option E:** small', '**Option F:** quiet', '**Option G:** cheap to run', '**Option H:** easy'].join('\n'),
      turn('User', '01', '9:02 AM', 'Thanks, topic-alpha it is.'),
    ]));
    const run = await extract('conversations/options');
    expect(run.pages_skipped_unparsed).toBe(0);
    expect(run.pages_processed).toBe(1);
    expect((await facts('conversations/options')).claims).toEqual(['The team discussed topic-alpha']);
  });
});

test('GST-3251: a managed brain publishes nothing for a page with a declined window and calls the model again next run', async () => {
  await managedBrain(async brain => {
    const slug = 'conversations/planning';
    await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: THREE_WINDOWS } });
    await disposePersistenceConsumer(brain.engine);
    const run = () => runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, overrideDisabled: true, extractor: stub() });
    calls = [];
    const first = await run();
    expect(first.pages_failed).toBe(1);
    expect(first.declined_windows).toHaveLength(1);
    expect(first.failed_pages[0]!.error).toContain('no facts were published (managed brain)');
    expect(await brain.engine.executeRaw('SELECT fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default', slug])).toEqual([]);
    expect(calls).toHaveLength(5);
    calls = [];
    const again = await run();
    expect(again.pages_failed).toBe(1);
    expect(calls).toHaveLength(5);
  });
}, 120_000);
