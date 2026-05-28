/**
 * v0.41.16.0 — E2E test for the conversation parser cathedral against
 * a real PGLite brain.
 *
 * For each of the 12 built-in formats: seed a page through
 * `importFromContent`, run `parseConversation` against the body, assert
 * the parser identifies the correct pattern AND produces at least one
 * message AND the message timestamp lands in the expected date range.
 *
 * Per CLAUDE.md test-isolation R3+R4: uses the canonical PGLite block.
 * Hermetic (no DATABASE_URL needed); the in-memory PGLite is created
 * once per file and reset between tests.
 *
 * This is the integration test that proves the parser ↔ engine
 * interaction is correct for the dream cycle's
 * `conversation_facts_backfill` phase.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  parseConversation,
} from '../../src/core/conversation-parser/parse.ts';
import { BUILTIN_PATTERNS } from '../../src/core/conversation-parser/builtins.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { Page } from '../../src/core/types.ts';

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

/**
 * Build a conversation page body using the first test_positive sample
 * from the pattern's registry entry. Multi-line patterns get a body
 * line appended.
 */
function buildSampleBody(patternId: string): string {
  const pattern = BUILTIN_PATTERNS.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`pattern ${patternId} not found`);
  // Repeat the positive sample 3 times with slight variations to
  // simulate a multi-message conversation.
  const samples = pattern.test_positive.slice(0, 2);
  if (pattern.multi_line && pattern.captures.text_group === 0) {
    // For patterns where text comes from the next line, append a body
    // line after each header.
    return samples.flatMap((s, i) => [s, `body line ${i + 1}`]).join('\n');
  }
  return samples.join('\n');
}

describe('E2E: parser ↔ engine integration for every built-in', () => {
  for (const pattern of BUILTIN_PATTERNS) {
    test(`pattern=${pattern.id}: page imports + parser identifies pattern`, async () => {
      const slug = `conversations/test/${pattern.id}-sample`;
      const body = buildSampleBody(pattern.id);
      const frontmatter: Record<string, unknown> = {
        type: 'conversation',
        date: '2024-03-15',
      };
      if (pattern.timezone_policy === 'utc_assumed_with_warn') {
        // Some patterns warn without a timezone; provide one to avoid
        // stderr noise in the test output.
        frontmatter.timezone = 'America/Los_Angeles';
      }

      // Seed the page through the canonical import path.
      const fullBody = `---\n${Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')}\n---\n\n${body}`;
      await importFromContent(engine, slug, fullBody, {
        sourceId: 'default',
        noEmbed: true,
      });

      // Read the page back and parse it through the orchestrator
      // (mirrors what extract-conversation-facts.ts does in production).
      const page = (await engine.getPage(slug)) as Page;
      expect(page).not.toBeNull();

      const bodyToParse = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.trim();
      const result = parseConversation(bodyToParse, { page });

      expect(result.phase).toBe('regex_match');
      expect(result.matched_pattern_id).toBe(pattern.id);
      expect(result.messages.length).toBeGreaterThanOrEqual(1);

      // Every parsed message has a valid ISO timestamp.
      for (const msg of result.messages) {
        const ts = Date.parse(msg.timestamp);
        expect(Number.isFinite(ts)).toBe(true);
        // Pattern's timezone policy determines date range constraints.
        // For inline-date patterns the date is in the line; for
        // time-only patterns it's from frontmatter ('2024-03-15').
        if (pattern.date_source === 'frontmatter') {
          expect(msg.timestamp.slice(0, 10)).toBe('2024-03-15');
        }
        expect(msg.speaker.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('E2E: parser handles unparseable bodies cleanly', () => {
  test('non-chat content returns no_match without crashing', async () => {
    const slug = 'conversations/test/not-a-chat';
    const fullBody = `---\ntype: conversation\ndate: 2024-03-15\n---\n\nThis is just prose. It has no chat structure at all. Just words that flow.`;
    await importFromContent(engine, slug, fullBody, {
      sourceId: 'default',
      noEmbed: true,
    });
    const page = (await engine.getPage(slug)) as Page;
    const bodyToParse = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.trim();
    const result = parseConversation(bodyToParse, { page });
    expect(result.phase).toBe('no_match');
    expect(result.messages).toEqual([]);
  });

  test('empty body returns no_match', async () => {
    const slug = 'conversations/test/empty';
    const fullBody = `---\ntype: conversation\ndate: 2024-03-15\n---\n\n`;
    await importFromContent(engine, slug, fullBody, {
      sourceId: 'default',
      noEmbed: true,
    });
    const page = (await engine.getPage(slug)) as Page;
    const result = parseConversation(`${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.trim(), { page });
    expect(result.phase).toBe('no_match');
    expect(result.messages).toEqual([]);
  });
});

describe('E2E: D8 date derivation chain through Page', () => {
  test('frontmatter.date wins over epoch default', async () => {
    const slug = 'conversations/test/date-derive';
    const body = '**[18:37] 👤 Alice:** hi';
    const fullBody = `---\ntype: conversation\ndate: 2026-05-24\ntimezone: America/Los_Angeles\n---\n\n${body}`;
    await importFromContent(engine, slug, fullBody, {
      sourceId: 'default',
      noEmbed: true,
    });
    const page = (await engine.getPage(slug)) as Page;
    const result = parseConversation(
      `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.trim(),
      { page },
    );
    expect(result.matched_pattern_id).toBe('telegram-bracket');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].timestamp).toBe('2026-05-24T18:37:00Z');
  });
});
