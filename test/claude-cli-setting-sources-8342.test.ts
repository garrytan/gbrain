/**
 * #8342: the claude-cli child must not read the user's own Claude Code
 * settings and instructions (~/.claude/CLAUDE.md, settings.json): they would
 * steer gbrain's background calls. `--setting-sources ""` loads no settings
 * source and keeps the subscription login. The child gets it only when
 * `claude --version` reports SETTING_SOURCES_MIN_VERSION or newer, probed once
 * per binary; an older or unreadable version keeps today's argv, and a probe
 * that exited non-zero is tried again on the next call.
 *
 * A POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN plays the CLI and records its
 * argv; no live CLI or provider account is used.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel, SETTING_SOURCES_MIN_VERSION } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, result: 'OK', stop_reason: 'end_turn', session_id: 'synthetic-session', num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 } };
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stub(versionLine: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-setting-sources-'));
  dirs.push(dir);
  const response = join(dir, 'response.json');
  writeFileSync(response, JSON.stringify(SUCCESS));
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo probe >> "${dir}/probes"; echo '${versionLine}'; exit 0; fi`,
    'cat > /dev/null',
    `: > "${dir}/argv"`,
    `for a in "$@"; do printf '[%s]\\n' "$a" >> "${dir}/argv"; done`,
    `cat "${response}"`,
  ].join('\n') + '\n');
  chmodSync(bin, 0o755);
  const call = async (extraEnv: Record<string, string | undefined> = {}) => {
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin, ...extraEnv }, () => new ClaudeCliLanguageModel('claude-sonnet-5-5').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }],
    } as LanguageModelV2CallOptions));
    return readFileSync(join(dir, 'argv'), 'utf8').trimEnd().split('\n').map((l) => l.slice(1, -1));
  };
  const probes = () => { try { return readFileSync(join(dir, 'probes'), 'utf8').trimEnd().split('\n').length; } catch { return 0; } };
  return { call, probes };
}

const settingSources = (argv: string[]) => {
  const i = argv.indexOf('--setting-sources');
  return i < 0 ? null : argv[i + 1];
};

describe('claude-cli keeps the user\'s own settings and CLAUDE.md out of the child (#8342)', () => {
  test(`${SETTING_SOURCES_MIN_VERSION} and newer: --setting-sources "" on every call, probed once per binary`, async () => {
    const s = stub('2.1.316 (Claude Code)');
    expect(settingSources(await s.call())).toBe('');
    expect(settingSources(await s.call())).toBe('');
    expect(s.probes()).toBe(1);
    expect(settingSources(await stub(`${SETTING_SOURCES_MIN_VERSION} (Claude Code)`).call())).toBe('');
  });

  test('a --version that ignores SIGTERM is killed at 5 s, runs in the clean cwd, and the call goes on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-setting-sources-hang-'));
    dirs.push(dir);
    const bin = join(dir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then pwd > "${dir}/probe-cwd"; trap '' TERM; sleep 30; echo '2.1.316 (Claude Code)'; exit 0; fi`,
      'cat > /dev/null',
      `: > "${dir}/argv"`,
      `for a in "$@"; do printf '[%s]\\n' "$a" >> "${dir}/argv"; done`,
      `echo '${JSON.stringify(SUCCESS)}'`,
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);
    const started = Date.now();
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, () => new ClaudeCliLanguageModel('claude-sonnet-5-5').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }],
    } as LanguageModelV2CallOptions));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(settingSources(readFileSync(join(dir, 'argv'), 'utf8').trimEnd().split('\n').map((l) => l.slice(1, -1)))).toBeNull();
    expect(readFileSync(join(dir, 'probe-cwd'), 'utf8').trim()).not.toBe(process.cwd());
  }, 30_000);

  test('GBRAIN_CLAUDE_CLI_USER_SETTINGS=1 opts back in: no --setting-sources and no version probe', async () => {
    const s = stub('2.1.316 (Claude Code)');
    const argv = await s.call({ GBRAIN_CLAUDE_CLI_USER_SETTINGS: '1' });
    expect(settingSources(argv)).toBeNull();
    expect(argv).toContain('--settings');
    expect(s.probes()).toBe(0);
    expect(settingSources(await s.call({ GBRAIN_CLAUDE_CLI_USER_SETTINGS: '0' }))).toBe('');
  });

  test('a --version that exits non-zero is not remembered: the next call probes again and gets --setting-sources ""', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-setting-sources-flaky-'));
    dirs.push(dir);
    const bin = join(dir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo probe >> "${dir}/probes"; if [ ! -f "${dir}/warm" ]; then : > "${dir}/warm"; exit 1; fi; echo '2.1.316 (Claude Code)'; exit 0; fi`,
      'cat > /dev/null',
      `: > "${dir}/argv"`,
      `for a in "$@"; do printf '[%s]\\n' "$a" >> "${dir}/argv"; done`,
      `echo '${JSON.stringify(SUCCESS)}'`,
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);
    const call = async () => {
      await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, () => new ClaudeCliLanguageModel('claude-sonnet-5-5').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }],
      } as LanguageModelV2CallOptions));
      return readFileSync(join(dir, 'argv'), 'utf8').trimEnd().split('\n').map((l) => l.slice(1, -1));
    };
    expect(settingSources(await call())).toBeNull();
    expect(settingSources(await call())).toBe('');
    expect(settingSources(await call())).toBe('');
    expect(readFileSync(join(dir, 'probes'), 'utf8').trimEnd().split('\n').length).toBe(2);
  });

  test('an older or unreadable version keeps today\'s argv', async () => {
    for (const line of ['2.1.313 (Claude Code)', '2.0.60 (Claude Code)', 'not a version']) {
      const argv = await stub(line).call();
      expect(settingSources(argv)).toBeNull();
      expect(argv).toContain('--settings');
    }
  });
});
