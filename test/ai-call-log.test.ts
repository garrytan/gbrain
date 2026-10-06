import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAICallLogFromEnv } from '../src/core/ai/call-log.ts';
import { invokeAI, sdkInvocationUsage, withAIAttribution } from '../src/core/ai/invocation-guard.ts';

const dirs: string[] = [];
afterEach(() => {
  installAICallLogFromEnv({});
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-call-log-'));
  dirs.push(dir);
  return join(dir, 'calls.jsonl');
}

describe('GBRAIN_AI_CALL_LOG', () => {
  test('one JSON line per call with kind, usage and attribution, never prompt text', async () => {
    const path = tempPath();
    installAICallLogFromEnv({ GBRAIN_AI_CALL_LOG: path });
    installAICallLogFromEnv({ GBRAIN_AI_CALL_LOG: path });
    await withAIAttribution({ request_id: 'req-1', effect: 'facts-absorb', job_id: 3 }, () =>
      invokeAI({ operation: 'gateway.chat', kind: 'chat', model: 'anthropic:claude-sonnet-4-6' },
        async () => ({ text: 'SECRET PROMPT ECHO', usage: { inputTokens: 100, outputTokens: 20 } }), sdkInvocationUsage));
    await invokeAI({ operation: 'gateway.multimodal', kind: 'multimodal', model: 'voyage:voyage-multimodal-3' }, async () => ({}), () => null);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('SECRET');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'chat', operation: 'gateway.chat', outcome: 'ok', input_tokens: 100, output_tokens: 20,
      request_id: 'req-1', effect: 'facts-absorb', job_id: 3 });
    expect(lines[1]).toMatchObject({ kind: 'embedding', raw_kind: 'multimodal', input_tokens: 'unknown' });
  });

  test('unset disposes the observer', async () => {
    const path = tempPath();
    installAICallLogFromEnv({ GBRAIN_AI_CALL_LOG: path });
    installAICallLogFromEnv({});
    await invokeAI({ operation: 'gateway.chat', kind: 'chat', model: 'm' }, async () => 1, () => null);
    expect(existsSync(path)).toBe(false);
  });

  test('an unwritable path warns once and never fails the call', async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => { writes.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      installAICallLogFromEnv({ GBRAIN_AI_CALL_LOG: join(tempPath(), 'missing-dir', 'x.jsonl') });
      await expect(invokeAI({ operation: 'gateway.chat', kind: 'chat', model: 'm' }, async () => 'ok', () => null)).resolves.toBe('ok');
      await invokeAI({ operation: 'gateway.chat', kind: 'chat', model: 'm' }, async () => 'ok', () => null);
    } finally { process.stderr.write = orig; }
    expect(writes.filter(w => w.includes('GBRAIN_AI_CALL_LOG')).length).toBeLessThanOrEqual(1);
  });
});
