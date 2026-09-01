/**
 * #4636 — the LongMemEval answer + trajectory-extractor lanes route through
 * the configured AI gateway (provider-neutral), not a raw Anthropic SDK
 * client. Pre-fix, the client stripped `provider:model` recipe ids to bare
 * model ids and sent every call to Anthropic regardless of the install's
 * configured provider, so non-Anthropic installs saw auth/404 failures on
 * every answer/extractor call — surfacing as false all-upstream_error
 * batches in the nightly quality probe.
 *
 * Hermetic: gateway chat-transport seam, in-memory PGLite, no API keys.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

import { withEnv } from './helpers/with-env.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

afterEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

function stubResult(model: string, text: string): ChatResult {
  return {
    text,
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: 'openai',
  };
}

describe('runEvalLongMemEval — gateway-routed chat lanes (#4636)', () => {
  test('answer lane calls the gateway with the full recipe id un-stripped (no raw Anthropic SDK)', async () => {
    const seenModels: string[] = [];
    configureGateway({ env: {} });
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? '');
      return stubResult(opts.model ?? '', 'stub gateway answer');
    });

    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-gateway-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--no-trajectory',
          '--limit', '1',
          '--model', 'openai:gpt-5.2',
          '--output', outPath,
        ],
        { engine },
      );
      const rows = readFileSync(outPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows[0].error).toBeUndefined();
      expect(rows[0].hypothesis).toBe('stub gateway answer');
      // The recipe id reaches the gateway UN-stripped — the gateway owns
      // provider routing. Pre-fix the provider prefix was stripped and the
      // bare id was sent to a raw Anthropic client.
      expect(seenModels.length).toBeGreaterThan(0);
      expect(seenModels[0]).toBe('openai:gpt-5.2');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('a gateway throw lands as a per-question {hypothesis: "", error} row and never aborts the run', async () => {
    configureGateway({ env: {} });
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw new Error('gateway boom: provider unavailable');
    });

    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-gateway-throw-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      // Must resolve (no rejection) even though EVERY answer call throws.
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--no-trajectory',
          '--limit', '2',
          '--model', 'openai:gpt-5.2',
          '--output', outPath,
        ],
        { engine },
      );
      const rows = readFileSync(outPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      // One row PER question — the first failure did not short-circuit the second.
      expect(rows).toHaveLength(2);
      expect(calls).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.hypothesis).toBe('');
        expect(typeof row.error).toBe('string');
        expect(row.error).toContain('gateway boom');
        // Consumers need question text/type on error rows too (denominator).
        expect(typeof row.question).toBe('string');
        expect(typeof row.question_id).toBe('string');
      }
      expect(new Set(rows.map(r => r.question_id)).size).toBe(2);
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('the default lane (no --model) reaches the gateway with an anthropic:-prefixed recipe id', async () => {
    const seenModels: string[] = [];
    configureGateway({ env: {} });
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? '');
      return stubResult(opts.model ?? '', 'stub gateway answer');
    });

    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-gateway-default-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      // GBRAIN_MODEL would beat the fallback; make sure the test exercises
      // the caller-supplied 'sonnet' alias → normalized recipe id path.
      await withEnv({ GBRAIN_MODEL: undefined }, () =>
        runEvalLongMemEval(
          [FIXTURE_PATH, '--keyword-only', '--no-trajectory', '--limit', '1', '--output', outPath],
          { engine },
        ),
      );
      expect(seenModels.length).toBeGreaterThan(0);
      // Bare alias resolved + normalized: the gateway owns provider routing,
      // so the id arrives fully qualified — never a stripped bare model name.
      expect(seenModels[0]).toMatch(/^anthropic:claude-/);
      expect(seenModels[0]).not.toMatch(/^claude-/);
      const rows = readFileSync(outPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows[0].hypothesis).toBe('stub gateway answer');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('extractor lane routes through the gateway with its own recipe id', async () => {
    const seenModels: string[] = [];
    configureGateway({ env: {} });
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? '');
      // Not valid claims JSON — extractAndInsertClaims is fail-open, so the
      // run still completes; we only assert the routing here.
      return stubResult(opts.model ?? '', 'stub gateway answer');
    });

    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-gateway-extract-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--limit', '1',
          '--model', 'openai:gpt-5.2',
          '--output', outPath,
        ],
        { engine, extractorModel: 'openai:gpt-4o-mini' },
      );
      expect(seenModels).toContain('openai:gpt-4o-mini'); // extractor lane
      expect(seenModels).toContain('openai:gpt-5.2'); // answer lane
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
