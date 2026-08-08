/**
 * #2782 — patterns phase status must reflect the child subagent outcome.
 *
 * Pre-fix, runPhasePatterns returned status:ok with child_outcome:timeout and
 * zero pattern pages written (e.g. when no subagent-capable worker slot was
 * free for the whole wait window) — a silent no-op for days.
 *
 * A later fix added runPgliteSubagentsInline to this phase (patterns.ts
 * previously submitted a job and waited without anything ever claiming it on
 * PGLite — synthesize.ts already had this inline drain, patterns.ts didn't).
 * So a fake ANTHROPIC_API_KEY here now gets claimed and actually attempted;
 * the real Anthropic call fails immediately, exhausting max_attempts and
 * landing the job in 'dead' (not 'timeout' — nothing ever times out, the
 * failure is immediate). The #2782 status-reflects-outcome contract this
 * test exists to pin is now two-layered: a non-'completed' queue status or a
 * completed child with a non-'end_turn' semantic stop must not become a clean
 * pattern phase. With zero writes it fails; with partial writes it warns.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedReflections(): Promise<void> {
  // Enough recent reflections to clear min_evidence (default 3).
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [
        `wiki/personal/reflections/2026-07-0${i + 1}-reflection`,
        `Reflection ${i + 1}`,
        `Recurring theme fixture number ${i + 1}.`,
      ],
    );
  }
}

describe('runPhasePatterns child-outcome status (#2782)', () => {
  test('child completed with zero writes → status ok', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-success-'));
    try {
      await seedReflections();
      await engine.setConfig('agent.use_gateway_loop', 'true');
      __setChatTransportForTests(async () => ({
        text: 'No recurring patterns met the evidence threshold.',
        blocks: [{ type: 'text', text: 'No recurring patterns met the evidence threshold.' }],
        stopReason: 'end',
        usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult));

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('ok');
      expect(result.details.child_outcome).toBe('completed');
      expect(result.details.child_stop_reason).toBe('end_turn');
      expect(result.details.patterns_written).toBe(0);
      expect(result.error).toBeUndefined();
    } finally {
      __setChatTransportForTests(null);
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('child completed after exhausting output tokens with zero writes → status fail', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-max-tokens-'));
    try {
      await seedReflections();
      await engine.setConfig('agent.use_gateway_loop', 'true');
      __setChatTransportForTests(async () => ({
        text: 'Partial pattern analysis',
        blocks: [{ type: 'text', text: 'Partial pattern analysis' }],
        stopReason: 'length',
        usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult));

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('fail');
      expect(result.details.child_outcome).toBe('completed');
      expect(result.details.child_stop_reason).toBe('max_tokens');
      expect(result.details.patterns_written).toBe(0);
      expect(result.error?.code).toBe('PATTERNS_CHILD_MAX_TOKENS');
    } finally {
      __setChatTransportForTests(null);
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('child writes a pattern then exhausts output tokens → status warn', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-partial-write-'));
    try {
      await seedReflections();
      await engine.setConfig('agent.use_gateway_loop', 'true');
      let turn = 0;
      __setChatTransportForTests(async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            blocks: [{
              type: 'tool-call',
              toolCallId: 'tc-pattern-write',
              toolName: 'brain_put_page',
              input: {
                slug: 'wiki/personal/patterns/partial-pattern',
                content: '---\ntitle: Partial Pattern\ntype: pattern\n---\n\nEvidence-backed pattern.',
              },
            }],
            stopReason: 'tool_calls',
            usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-sonnet-4-6',
            providerId: 'anthropic',
          } satisfies ChatResult;
        }
        return {
          text: 'Partial follow-up analysis',
          blocks: [{ type: 'text', text: 'Partial follow-up analysis' }],
          stopReason: 'length',
          usage: { input_tokens: 16, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      });

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('warn');
      expect(result.details.child_outcome).toBe('completed');
      expect(result.details.child_stop_reason).toBe('max_tokens');
      expect(result.details.patterns_written).toBe(1);
      expect(result.error).toBeUndefined();
    } finally {
      __setChatTransportForTests(null);
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('child dead with zero writes → status fail (was silent ok)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-outcome-'));
    try {
      await seedReflections();

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('fail');
      expect(result.details.child_outcome).toBe('dead');
      expect(result.details.patterns_written).toBe(0);
      expect(result.error?.code).toBe('PATTERNS_CHILD_DEAD');
      expect(result.error?.class).toBe('InternalError');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('dream.patterns.subagent_timeout_ms flows to the submitted job', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-timeout-'));
    try {
      await seedReflections();
      await engine.setConfig('dream.patterns.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.patterns.subagent_wait_timeout_ms', '1');

      await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      expect(Number(jobs[0]!.timeout_ms)).toBe(600000);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);
});
