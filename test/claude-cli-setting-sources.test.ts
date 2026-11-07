/**
 * The claude-cli child must not read the invoking user's CLAUDE.md, memory or
 * settings when the installed CLI can exclude them without giving up the
 * subscription login. `--setting-sources ""` does that from claude CLI
 * 2.1.314; earlier CLIs still applied some excluded settings, and an
 * unidentifiable CLI is treated as old. These tests pin the argv on both sides
 * of that gate with a POSIX shell stub at GBRAIN_CLAUDE_CLI_BIN that answers
 * `--version` and records the argv of every other call. No live account is used.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  ClaudeCliLanguageModel,
  MIN_SETTING_SOURCES_CLI_VERSION,
  resetSettingSourcesSupport,
  versionAtLeast,
} from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const OK = {
  type: 'result', subtype: 'success', is_error: false, result: 'OK', stop_reason: 'end_turn',
  session_id: 'synthetic-session', num_turns: 1,
  usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

const options = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }] } as LanguageModelV2CallOptions;

/** Run `calls` calls (in parallel when `parallel`) against a stub whose `--version` prints `versionLine`
 * and exits `versionExit`; return the argv of the last call and how many `--version` probes ran. */
async function runStub(versionLine: string, opts: { calls?: number; parallel?: boolean; versionExit?: number } = {}): Promise<{ argv: string[]; probes: number }> {
  const calls = opts.calls ?? 1;
  const dir = mkdtempSync(join(tmpdir(), 'claude-setting-sources-'));
  const argvPath = join(dir, 'argv');
  const bodyPath = join(dir, 'body.json');
  const probesPath = join(dir, 'probes');
  writeFileSync(bodyPath, JSON.stringify(OK));
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo x >> "${probesPath}"; printf '%s\\n' '${versionLine}'; exit ${opts.versionExit ?? 0}; fi`,
    'cat > /dev/null',
    `for a in "$@"; do printf '[%s]\\n' "$a" >> "${argvPath}"; done`,
    `cat "${bodyPath}"`,
  ].join('\n') + '\n');
  chmodSync(bin, 0o755);
  try {
    resetSettingSourcesSupport();
    await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, async () => {
      const one = () => new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(options);
      if (opts.parallel) await Promise.all(Array.from({ length: calls }, one));
      else for (let i = 0; i < calls; i++) await one();
    });
    const lines = readFileSync(argvPath, 'utf8').trimEnd().split('\n');
    const probes = existsSync(probesPath) ? readFileSync(probesPath, 'utf8').trimEnd().split('\n').length : 0;
    return { argv: lines.slice(-(lines.length / calls)), probes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argvFor = async (versionLine: string) => (await runStub(versionLine)).argv;

afterEach(() => resetSettingSourcesSupport());

describe('versionAtLeast', () => {
  test('compares numerically, not lexically', () => {
    expect(versionAtLeast('2.1.314', '2.1.314')).toBe(true);
    expect(versionAtLeast('2.1.316', '2.1.314')).toBe(true);
    expect(versionAtLeast('2.10.0', '2.1.314')).toBe(true);
    expect(versionAtLeast('3.0.0', '2.1.314')).toBe(true);
    expect(versionAtLeast('2.1.313', '2.1.314')).toBe(false);
    expect(versionAtLeast('2.0.999', '2.1.314')).toBe(false);
    expect(versionAtLeast(null, '2.1.314')).toBe(false);
  });
});

describe('claude-cli passes --setting-sources "" only from the first CLI that honors it', () => {
  test(`CLI at ${MIN_SETTING_SOURCES_CLI_VERSION} gets an empty --setting-sources`, async () => {
    const argv = await argvFor('2.1.314 (Claude Code)');
    const at = argv.indexOf('[--setting-sources]');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv[at + 1]).toBe('[]');
  });

  test('a newer CLI gets it too, next to the existing isolation flags', async () => {
    const argv = await argvFor('2.1.316 (Claude Code)');
    expect(argv).toContain('[--setting-sources]');
    expect(argv).toContain('[--strict-mcp-config]');
    expect(argv).toContain('[--disable-slash-commands]');
  });

  test('a CLI one patch earlier does not get it', async () => {
    expect(await argvFor('2.1.313 (Claude Code)')).not.toContain('[--setting-sources]');
  });

  test('a CLI whose version cannot be read does not get it', async () => {
    expect(await argvFor('claude: version unavailable')).not.toContain('[--setting-sources]');
  });

  test('a CLI that exits non-zero from --version does not get it, even when it printed a version', async () => {
    expect((await runStub('2.1.316 (Claude Code)', { versionExit: 1 })).argv).not.toContain('[--setting-sources]');
  });

  test('a readable version is probed once per binary across sequential calls', async () => {
    const { argv, probes } = await runStub('2.1.316 (Claude Code)', { calls: 3 });
    expect(probes).toBe(1);
    expect(argv).toContain('[--setting-sources]');
  });

  test('concurrent first calls share one probe', async () => {
    const { argv, probes } = await runStub('2.1.316 (Claude Code)', { calls: 3, parallel: true });
    expect(probes).toBe(1);
    expect(argv).toContain('[--setting-sources]');
  });

  test('an unreadable version is not remembered, so the next call probes again', async () => {
    expect((await runStub('claude: version unavailable', { calls: 2 })).probes).toBe(2);
  });
});
