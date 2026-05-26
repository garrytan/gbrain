import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDream } from '../src/commands/dream.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('dream review cli', () => {
  it('requires --input for review mode', async () => {
    const result = await runDreamCliForTest(['review', '--json']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('dream review requires --input');
  });

  it('rejects --dry-run because review mode is already no-write', async () => {
    const inputFile = writeTranscript('Review transcript.');
    const result = await runDreamCliForTest(['review', '--input', inputFile, '--dry-run']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('review mode is already no-write');
  });

  it('accepts --model without persisting config', async () => {
    const calls: string[] = [];
    const inputFile = writeTranscript('Review transcript with one proposed idea.');
    __setChatTransportForTests(async (opts): Promise<ChatResult> => ({
      text: JSON.stringify({
        source_path: inputFile,
        source_date: '2026-05-26',
        proposals: [],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await runDreamCliForTest([
      'review',
      '--input',
      inputFile,
      '--model',
      'anthropic:claude-sonnet-4-6',
      '--json',
    ], makeReviewCliEngine(calls));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"model":"anthropic:claude-sonnet-4-6"');
    expect(calls).not.toContain('setConfig');
  });
});

async function runDreamCliForTest(
  args: string[],
  engine: BrainEngine = makeReviewCliEngine([]),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  const logSpy = spyOn(console, 'log').mockImplementation((msg: unknown) => {
    stdout.push(String(msg));
  });
  const errSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
    stderr.push(String(msg));
  });
  const exitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error('EXIT');
  });

  try {
    await runDream(engine, args);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
  } finally {
    await engine.disconnect?.();
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function writeTranscript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-review-cli-'));
  const filePath = join(dir, 'session.txt');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeReviewCliEngine(calls: string[]): BrainEngine {
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dream-review-brain-'));
  const config = new Map<string, string | null>([
    ['sync.repo_path', brainDir],
    ['dream.synthesize.min_chars', '1'],
  ]);

  return {
    kind: 'pglite',
    async getConfig(key: string) {
      return config.get(key) ?? null;
    },
    async setConfig() {
      calls.push('setConfig');
    },
    async disconnect() {
      rmSync(brainDir, { recursive: true, force: true });
    },
  } as unknown as BrainEngine;
}
