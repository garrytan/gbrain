/**
 * issue #3944 — chat-key presence is judged on env + FILE plane, shared.
 *
 * Autopilot's dispatch loop read `engine.getConfig('anthropic_api_key')`
 * (the DB plane) while doctor's loadRecommendationContext read the file
 * plane — a DB-only key made autopilot dispatch chat jobs that doctor's
 * planner classified as blocked. Both now share
 * `chatApiKeyConfigured(fileCfg)` from brain-score-recommendations.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { chatApiKeyConfigured } from '../src/core/brain-score-recommendations.ts';

describe('#3944 chatApiKeyConfigured', () => {
  test('no env, no file key → false (a DB-only key is invisible by design)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      // The helper takes NO engine — the DB plane cannot influence it. A
      // DB-only `gbrain config set anthropic_api_key` therefore reads as
      // not-configured, matching doctor's file-plane verdict.
      expect(chatApiKeyConfigured(null)).toBe(false);
      expect(chatApiKeyConfigured(undefined)).toBe(false);
      expect(chatApiKeyConfigured({})).toBe(false);
    });
  });

  test('file-plane key → true', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(chatApiKeyConfigured({ anthropic_api_key: 'sk-file' })).toBe(true);
    });
  });

  test('env key → true even without file config', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-env' }, () => {
      expect(chatApiKeyConfigured(null)).toBe(true);
    });
  });

  test('empty-string file key → false (falsy, same as absent)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(chatApiKeyConfigured({ anthropic_api_key: '' })).toBe(false);
    });
  });
});

describe('#3944 both planner surfaces share the helper (source guard)', () => {
  // Autopilot's dispatch loop runs deep inside the daemon poll cycle (engine +
  // queue + timers) — not unit-runnable, so the plane choice is pinned
  // structurally. The helper's BEHAVIOR is covered above.
  test('autopilot no longer probes the DB plane for the chat key', () => {
    // test-reads-source-ok: the dispatch loop cannot run hermetically; this pins that the DB-plane read does not creep back.
    const src = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf-8');
    expect(src).not.toContain("getConfig('anthropic_api_key')");
    expect(src).toContain('chatApiKeyConfigured(fileCfg)');
  });

  test('doctor context uses the same shared helper', () => {
    // test-reads-source-ok: pins that context.ts and autopilot resolve the chat key through ONE helper, not two drifting copies.
    const src = readFileSync(join(import.meta.dir, '../src/core/remediation/context.ts'), 'utf-8');
    expect(src).toContain('chatApiKeyConfigured(fileCfg)');
    expect(src).not.toContain('process.env.ANTHROPIC_API_KEY ||');
  });
});
