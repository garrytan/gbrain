/**
 * #6817: an expired claude-cli login reports `Failed to authenticate: OAuth session expired and could not be
 * refreshed` in an error envelope with no API status. The classifier read it as an unknown (transient) failure,
 * so `gbrain dream --drain` exited 11 and a retry loop restarted it until the login was fixed. It is an auth
 * failure: the drain must exit 1 and name the blocker.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN plays the CLI, and the drain runs through the real gateway `chat()`
 * with the claude-cli recipe, the real extract_atoms phase and the real drain-to-exit mapping.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { classifyGlobalLlmError, normalizeAIError } from '../src/core/ai/errors.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EXTRACT_ATOMS_MODEL_KEY } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { drainOutcome } from '../src/core/cycle/extract-atoms-drain-outcome.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const OAUTH_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const envelope = { type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: OAUTH_EXPIRED,
  session_id: 'synthetic-session', num_turns: 1, usage: { input_tokens: 10, output_tokens: 0 } };

async function withCli<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-oauth-'));
  const response = join(dir, 'response.json');
  writeFileSync(response, JSON.stringify(envelope));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat "${response}"\nexit 1\n`);
  chmodSync(bin, 0o755);
  try { return await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined }, run); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('claude-cli expired OAuth login (#6817)', () => {
  test('classifies as auth, raw and normalized', async () => {
    const error = await withCli(async () => {
      try {
        await new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic page' }] }] } as LanguageModelV2CallOptions);
      } catch (e) { return e; }
      throw new Error('expected the CLI call to reject');
    });
    expect(classifyGlobalLlmError(error)).toBe('auth');
    expect(classifyGlobalLlmError(normalizeAIError(error, 'chat(claude-cli:claude-sonnet-4-6)'))).toBe('auth');
  });

  test('the same words inside raw model output stay unclassified', () => {
    expect(classifyGlobalLlmError(new Error(`claude-cli exited 1\n--- raw ---\n${OAUTH_EXPIRED}`))).toBeNull();
  });

  describe('dream --drain end to end', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
    afterAll(async () => { await engine.disconnect(); });
    beforeEach(async () => {
      await resetPgliteState(engine);
      await engine.setConfig(EXTRACT_ATOMS_MODEL_KEY, 'claude-cli:claude-sonnet-4-6');
      resetGateway();
      configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });
    });
    afterEach(resetGateway);

    test('the drain stops on an auth provider failure and exits 1 naming the blocker', async () => {
      await engine.putPage('note/alice-example', { title: 'alice-example', type: 'note', compiled_truth: 'meeting notes about acme-example '.repeat(40) } as never, { sourceId: 'default' });
      const result = await withCli(() => runExtractAtomsDrainForSource(engine, { sourceId: undefined, windowSeconds: 60, maxBatches: 2 }));
      expect(result).toMatchObject({ status: 'provider_failure', stopped: 'provider_failure', provider_failure_class: 'auth' });
      expect(JSON.stringify(result)).toContain('OAuth session expired');
      expect(drainOutcome(result)).toMatchObject({ exit: 1, retryable: false, code: 'atom_drain_provider_failure', reason: 'auth' });
    }, 60_000);
  });
});
