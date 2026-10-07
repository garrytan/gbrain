/**
 * #6192: over MCP the rateable answer's `answer_id` lived only in
 * `_meta.retrieval`, which many hosts never show the model, so an agent could
 * not call `rate_answer`. The id and the call now ride a visible text block.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const RATE_LINE_MAX_CHARS = 160;
import { _resetFeedbackRecordingForTests } from '../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import { __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { withEnv } from './helpers/with-env.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';

const PAGES = [
  { slug: 'notes/widget-handbook', title: 'Widget handbook', body: 'The widget program ships widgets. Widget pricing is tiered.' },
  { slug: 'notes/widget-roadmap', title: 'Widget roadmap', body: 'Widget roadmap: the next widget milestone ships in spring.' },
];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetFeedbackRecordingForTests();
  _resetFeedbackSettingsCacheForTests();
  __resetProcessNoticeLedgerForTests();
  for (const p of PAGES) {
    await engine.putPage(p.slug, { type: 'note', title: p.title, compiled_truth: p.body });
    await installFixtureChunks(engine, p.slug, await prepareMarkdownChunks({ compiled_truth: p.body, timeline: '' }));
  }
  await engine.setConfig('embedding_disabled', 'true');
  await engine.setConfig('feedback.enabled', 'true');
});

async function call(op: 'search' | 'query', query: string) {
  return withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, op, { query }, { remote: true, transport: 'stdio', sourceId: 'default' }));
}

function visible(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? '').join('\n');
}

describe('the rateable answer id is model-visible (#6192)', () => {
  for (const op of ['search', 'query'] as const) {
    test(`${op}: content carries the answer_id and the rate_answer call, within the line cap`, async () => {
      const res = await call(op, 'widget pricing');
      const answerId = (res._meta?.retrieval as { answer_id?: string } | undefined)?.answer_id;
      expect(answerId).toMatch(/^ans_/);
      const text = visible(res);
      expect(text).toContain(`rate_answer { answer_id: "${answerId}", rating: 1-5 }`);
      const line = text.split('\n').find((l) => l.includes(answerId!))!;
      expect(line.length).toBeLessThanOrEqual(RATE_LINE_MAX_CHARS);
    });
  }

  test('the coaching wording follows the how_to_rate cadence; every other rateable answer gets the short line', async () => {
    const first = visible(await call('search', 'widget pricing'));
    expect(first).toContain('Rate this answer after you use it: rate_answer');
    const second = await call('search', 'widget roadmap');
    const secondId = (second._meta?.retrieval as { answer_id?: string }).answer_id;
    expect(visible(second)).toContain(`Rate after use: rate_answer { answer_id: "${secondId}", rating: 1-5 }`);
  });

  test('feedback off: no answer id, no rate line', async () => {
    await engine.setConfig('feedback.enabled', 'false');
    _resetFeedbackSettingsCacheForTests();
    const res = await call('search', 'widget pricing');
    expect(visible(res)).not.toContain('rate_answer');
    expect((res._meta?.retrieval as { answer_id?: string } | undefined)?.answer_id).toBeUndefined();
  });
});

describe('retrieval_feedback_health: many answers, zero ratings (#6192)', () => {
  async function doctorCheck() {
    const { retrievalFeedbackEntry } = await import('../src/commands/doctor/checks/retrieval-feedback.ts');
    const checks = (await retrievalFeedbackEntry.run({ engine, progress: { heartbeat() {} } } as never)) as Array<{ name: string; status: string; message: string; fix?: unknown }>;
    return checks.find((c) => c.name === 'retrieval_feedback_health')!;
  }
  async function seedAnswers(n: number) {
    for (let i = 0; i < n; i++) await engine.executeRaw(`INSERT INTO retrieval_events (id, op) VALUES ($1, 'search')`, [`ans_seed_${i}`]);
  }

  test('50 recorded answers and no rating warns that the host may hide the answer id, with a read-only fix', async () => {
    await seedAnswers(50);
    const check = await doctorCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('none was rated');
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'feedback', 'status', '--json']);
  });

  test('below the threshold it stays ok', async () => {
    await seedAnswers(49);
    expect((await doctorCheck()).status).toBe('ok');
  });
});
