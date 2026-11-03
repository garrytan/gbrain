import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeConversationFormatCoverageCheck } from '../src/commands/doctor/checks/conversation-coverage.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

async function seedGranularTranscript(excluded = false): Promise<void> {
  await engine.putPage('conversations/example-thread', {
    type: 'slack-thread',
    title: 'Example thread',
    timeline: '',
    compiled_truth: [
      '## Transcript',
      '',
      '9.03.12 -- Speaker A -- an invented turn',
      '9.04.55 -- Speaker B -- another turn',
    ].join('\n'),
    frontmatter: excluded ? { conversation_parseable: false } : {},
  });
}

test('format coverage includes eligible granular conversation aliases', async () => {
  await seedGranularTranscript();

  const check = await computeConversationFormatCoverageCheck(engine);

  expect(check.status).toBe('warn');
  expect(check.message).toContain('_no_match=1');
});

test('format coverage excludes granular pages opted out of extraction', async () => {
  await seedGranularTranscript(true);

  const check = await computeConversationFormatCoverageCheck(engine);

  expect(check.status).toBe('ok');
  expect(check.message).toContain('No conversation-type pages');
});
