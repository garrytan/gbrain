import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { computeConversationFormatCoverageCheck } from '../src/commands/doctor.ts';

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
});

/** A summary-only page: headings + short bullets, no transcript shape.
 *  Mirrors the seven pages observed in #4193 (5-30 nonblank lines). */
const SLACK_SUMMARY_BODY = [
  '## Highlights',
  '',
  '- Shipped the new onboarding flow',
  '- Reviewed the quarterly metrics doc',
  '',
  '## Decisions',
  '',
  '- Move the launch to next week',
  '- Alice owns the follow-up doc',
].join('\n');

/** Transcript-claiming page (explicit `## Transcript` section) whose turn
 *  shape no builtin matches — must STILL count as a parser miss. */
const UNSUPPORTED_TRANSCRIPT_BODY = [
  '## Transcript',
  '',
  '9.03.12 -- Alice -- kicking off',
  '9.04.55 -- Bob -- sounds good',
  '9.06.20 -- Alice -- shipping it',
].join('\n');

/** Body matching the builtin `imessage-slack` pattern (its own test_positive shape). */
const SUPPORTED_TRANSCRIPT_BODY = [
  '**Alice Example** (2024-03-15 9:00 AM): hello',
  '**Bob Example** (2024-03-15 9:02 AM): hi there',
  '**Alice Example** (2024-03-15 9:05 AM): shipping it',
].join('\n');

async function seedPage(slug: string, type: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
  });
}

describe('conversation_format_coverage summary-only handling (#4193)', () => {
  test('a slack/meeting summary page (headings + bullets) is not _no_match coverage debt', async () => {
    await seedPage('slack-weekly-summary', 'slack', SLACK_SUMMARY_BODY);
    await seedPage('meeting-standup-notes', 'meeting', SLACK_SUMMARY_BODY);

    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.name).toBe('conversation_format_coverage');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('_summary_only=2');
    expect(check.message).not.toContain('_no_match');
  });

  test('a transcript-claiming page with an unsupported turn shape still counts as a miss', async () => {
    await seedPage('meeting-odd-transcript', 'meeting', UNSUPPORTED_TRANSCRIPT_BODY);

    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('_no_match=1');
  });

  test('supported transcript patterns keep their current results in the denominator', async () => {
    await seedPage('slack-real-transcript', 'slack', SUPPORTED_TRANSCRIPT_BODY);
    await seedPage('slack-weekly-summary', 'slack', SLACK_SUMMARY_BODY);

    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('imessage-slack=1');
    expect(check.message).toContain('_summary_only=1');
  });

  test('mixed brain: summaries excluded from the denominator, real misses still warn', async () => {
    // 1 supported + 1 unsupported transcript + 2 summaries.
    // Old math: 3/4 unmatched = 75% -> warn either way, but with summaries
    // wrongly in the numerator. New math: 1/2 transcript-claiming unmatched
    // = 50% -> warn, with the summaries reported separately.
    await seedPage('slack-real-transcript', 'slack', SUPPORTED_TRANSCRIPT_BODY);
    await seedPage('meeting-odd-transcript', 'meeting', UNSUPPORTED_TRANSCRIPT_BODY);
    await seedPage('slack-weekly-summary', 'slack', SLACK_SUMMARY_BODY);
    await seedPage('meeting-standup-notes', 'meeting', SLACK_SUMMARY_BODY);

    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1/2');
    expect(check.message).toContain('_summary_only=2');
  });

  test('no conversation pages -> not-applicable ok', async () => {
    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No conversation-type pages');
  });
});
