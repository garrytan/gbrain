import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runEvalNightlyQuality } from '../src/commands/eval-nightly-quality.ts';


test('nested probe reports stay off the final JSON channel and writers restore', async () => {
  const engine = new Proxy({}, { get: () => { throw new Error('injected probe opened a brain'); } }) as BrainEngine;
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalErrorWrite = process.stderr.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.stdout.write = ((chunk: string) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => { stdout.push(args.join(' ') + '\n'); };
  const write = process.stdout.write;
  const log = console.log;
  try {
    await runEvalNightlyQuality(engine, ['--json'], async () => {
      process.stdout.write('{"nested":"batch summary"}\n');
      console.log('nested progress');
      return { outcome: 'pass', exit_code: 0 };
    });
    expect(JSON.parse(stdout.join(''))).toEqual({ outcome: 'pass', exit_code: 0 });
    expect(stderr.join('')).toContain('batch summary');
    expect(process.stdout.write).toBe(write);
    expect(console.log).toBe(log);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
    console.log = originalLog;
  }
});

test('a thrown nested probe restores the stdout protocol without a success envelope', async () => {
  const engine = {} as BrainEngine;
  const write = process.stdout.write;
  const log = console.log;
  await expect(runEvalNightlyQuality(engine, ['--json'], async () => { throw new Error('B336 injected probe failure'); })).rejects.toThrow('B336 injected probe failure');
  expect(process.stdout.write).toBe(write);
  expect(console.log).toBe(log);
});

// Protocol fixtures come from the native CLI's input/output-mode contract.
import { chmodSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

for (const variant of ['malformed', 'missing-result', 'provider-error'] as const) {
  test(`stream-json ${variant} never becomes an image success`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b336-stream-'));
    const binary = join(dir, 'provider.sh');
    const events = [{ type: 'system', subtype: 'init' },
      ...(variant === 'missing-result' ? [{ type: 'assistant', message: { content: [] } }] :
        [{ type: 'result', is_error: variant === 'provider-error', result: 'refused', api_error_status: 429 }])];
    const wire = events.map(ev => JSON.stringify(ev));
    if (variant === 'malformed') wire.splice(1, 0, 'not JSON');
    const literal = wire.join('\n').replace(/'/g, "'\\''");
    writeFileSync(binary, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${literal}'\nexit ${variant === 'provider-error' ? 1 : 0}\n`);
    chmodSync(binary, 0o700);
    try {
      const result = withEnv({ GBRAIN_CLAUDE_CLI_BIN: binary }, () =>
        new ClaudeCliLanguageModel('claude-haiku-5-5').doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }] }],
        }));
      if (variant === 'provider-error') await expect(result).rejects.toMatchObject({ apiErrorStatus: 429, exitCode: 1 });
      else await expect(result).rejects.toThrow(variant === 'malformed' ? 'not JSON' : 'no "result" event');
    } finally {
      mkdirSync(join(homedir(), '.Trash'), { recursive: true });
      renameSync(dir, join(homedir(), '.Trash', 'b336-stream-' + randomUUID()));
    }
  });
}
