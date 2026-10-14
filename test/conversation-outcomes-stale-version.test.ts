/**
 * Lone-message extraction changed what an already-scanned conversation page
 * yields, so CONVERSATION_EXTRACTOR_VERSION moved past 1: an outcome stamped
 * by the release that dropped sub-minimum gap groups must be reported by
 * doctor `conversation_outcomes_stale` instead of passing as current.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { conversationOutcomesStaleCheck } from '../src/commands/doctor/checks/conversation-outcomes.ts';
import { CONVERSATION_EXTRACTOR_VERSION, stampExtractorVersion } from '../src/core/facts/audit-sources.ts';

function engineWithOutcomes(rows: Array<{ source_id: string; slug: string; context: string | null }>): BrainEngine {
  return { executeRaw: async () => rows } as unknown as BrainEngine;
}

describe('conversation extractor version after lone-message extraction', () => {
  test('the version is above 1, the release that dropped lone messages', () => {
    expect(CONVERSATION_EXTRACTOR_VERSION).toBeGreaterThanOrEqual(2);
  });

  test('an outcome stamped extractor_version=1 is reported stale', async () => {
    const check = await conversationOutcomesStaleCheck(engineWithOutcomes([
      { source_id: 'default', slug: 'chats/lone-text', context: 'fewer than two eligible messages; extractor_version=1' },
    ]), ['default']);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ stale: 1, sample: ['default:chats/lone-text'] });
    expect(check.message).toContain('--source-id default --slug chats/lone-text --force --dry-run');
  });

  test('an outcome stamped by this binary is current', async () => {
    const check = await conversationOutcomesStaleCheck(engineWithOutcomes([
      { source_id: 'default', slug: 'chats/lone-text', context: stampExtractorVersion('session 2026-10-01') },
    ]), ['default']);
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ stale: 0 });
  });
});
