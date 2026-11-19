/**
 * #5892: `foresights think --json` stdout is JSON only; the AI SDK warning that a
 * claude-cli model triggers lands on stderr.
 *
 * Protects: the real CLI path from the command through the gateway to the
 * `ai` package's warning logger, with a fake `claude` binary
 * (GBRAIN_CLAUDE_CLI_BIN) and an isolated keyless PGLite brain.
 * Regression: the `ai` default logger printing its banner with
 * `console.info` before the JSON, so `JSON.parse(stdout)` throws.
 * Existing coverage: test/ai-sdk-warnings.test.ts pins the writer in-process;
 * this pins that the CLI process actually loads it before the first call.
 * `foresights query --json` is not included: on a brain with no embedding
 * provider it takes the keyword-only path and never reaches the gateway.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let root: string;
let home: string;
let env: Record<string, string | undefined>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-json-stdout-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const claude = join(root, 'claude');
  const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'The alpha widget is blue.', stop_reason: 'end_turn', session_id: 's', num_turns: 1, usage: { input_tokens: 12, output_tokens: 34 } };
  writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify(envelope)}'\n`);
  chmodSync(claude, 0o755);
  env = { GBRAIN_CLAUDE_CLI_BIN: claude, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, AI_SDK_LOG_WARNINGS: undefined };
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, env, timeoutMs: 120_000 });
  expect(init.exitCode, init.stderr).toBe(0);
  const set = await runCli(['config', 'set', 'models.think', 'claude-cli:claude-opus-5-5'], { home, env });
  expect(set.exitCode, set.stderr).toBe(0);
}, 180_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('--json stdout with an AI SDK warning (#5892)', () => {
  test('foresights think --json: stdout parses as JSON and the warning is on stderr', async () => {
    const r = await runCli(['think', 'what color is the alpha widget', '--json'], { home, env, timeoutMs: 120_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { answer?: string; modelUsed?: string };
    expect(parsed.answer).toBe('The alpha widget is blue.');
    expect(parsed.modelUsed).toBe('claude-cli:claude-opus-5-5');
    expect(r.stdout).not.toContain('AI SDK Warning');
    expect(r.stderr).toContain('AI SDK Warning (claude-cli / claude-opus-5-5): The feature "specificationVersion" is used in a compatibility mode.');
  }, 120_000);
});
