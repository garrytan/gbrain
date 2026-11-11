/**
 * #8469: conversation_format_coverage sampled pages by the canonical
 * conversation types only, while extraction expands them to the granular
 * collector types (`slack-thread`, `slack-dm-day`, `email-digest`) through
 * pageTypesForAllowed. Unparseable transcripts stored under a granular type
 * were never sampled, so the check reported nothing about them.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeConversationFormatCoverageCheck } from '../src/commands/doctor/checks/conversation-coverage.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

async function putThread(frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage('slack/thread-acme-example', {
    type: 'slack-thread', title: 'Thread with alice-example', timeline: '', frontmatter,
    compiled_truth: ['## Transcript', '', '9.03.12 -- alice-example -- an invented turn', '9.04.55 -- bob-example -- another turn'].join('\n'),
  });
}

test('an unparseable transcript stored under a granular conversation type is sampled', async () => {
  await putThread();
  const check = await computeConversationFormatCoverageCheck(engine);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('_no_match=1');
  expect(check.details).toMatchObject({ sampled: 1 });
});

test('a granular page opted out of extraction stays out of the sample', async () => {
  await putThread({ conversation_parseable: false });
  const check = await computeConversationFormatCoverageCheck(engine);
  expect(check.status).toBe('ok');
  expect(check.message).toContain('No conversation-type pages');
});
