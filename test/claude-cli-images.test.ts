import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { claudeImageInput } from '../src/core/ai/providers/claude-cli-images.ts';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const makePrompt = (data: Uint8Array | URL | string, mediaType = 'image/png') => [
  { role: 'user', content: [{ type: 'text', text: 'Read exactly.' }, { type: 'file', mediaType, data }] },
] as LanguageModelV2Prompt;

test('text callers retain the existing text protocol', () => {
  expect(claudeImageInput([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], 'hello')).toBeUndefined();
});
for (const data of [new Uint8Array([1, 2, 3]), 'AQID', new URL('data:image/png;base64,AQID')]) {
  test(`inline ${data.constructor.name} reaches the structured image block`, () => {
    const wire = JSON.parse(claudeImageInput(makePrompt(data), 'Read exactly.')!);
    expect(wire.message.content).toEqual([{ type: 'text', text: 'Read exactly.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }]);
  });
}
for (const data of [new URL('https://example.invalid/image.png'), new URL('file:///tmp/private.png'), '', 'invalid base64']) {
  test('invalid image data refuses before starting a child', () => {
    expect(() => claudeImageInput(makePrompt(data), 'read')).toThrow();
  });
}
test('mismatched mime and oversized bytes refuse before provider spend', () => {
  expect(() => claudeImageInput(makePrompt(new URL('data:image/jpeg;base64,AQID')), 'read')).toThrow('mismatch');
  expect(() => claudeImageInput(makePrompt(new Uint8Array(20 * 1024 * 1024 + 1)), 'read')).toThrow('oversized');
  expect(() => claudeImageInput(makePrompt(new Uint8Array([1]), 'image/svg+xml'), 'read')).toThrow('unsupported');
});

test('real subprocess receives inline bytes and the existing tool-free restrictions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-vision-test-'));
  const binary = join(dir, 'provider.sh');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\nprintf '%s\\n' '{"type":"system","subtype":"init"}'\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"VISUAL READ","usage":{"input_tokens":3,"output_tokens":2}}'\n`);
  chmodSync(binary, 0o700);
  try {
    const answer = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: binary }, () =>
      new ClaudeCliLanguageModel('claude-haiku-5-5').doGenerate({ prompt: makePrompt(new Uint8Array([1, 2, 3])) }));
    expect(answer.content).toEqual([{ type: 'text', text: 'VISUAL READ' }]);
    const args = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8')).message.content[1].source.data).toBe('AQID');
    expect(answer.usage.totalTokens).toBe(5);
  } finally {
    mkdirSync(join(homedir(), '.Trash'), { recursive: true });
    renameSync(dir, join(homedir(), '.Trash', 'claude-vision-test-' + randomUUID()));
  }
});
