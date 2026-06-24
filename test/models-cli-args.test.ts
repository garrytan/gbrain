import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runModels } from '../src/commands/models.ts';

function makeEngineStub(configMap: Record<string, string> = {}) {
  return {
    async getConfig(key: string): Promise<string | null> {
      return configMap[key] ?? null;
    },
  } as any;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-models-cli-'));
  const outPath = join(dir, 'stdout.txt');
  const writer = Bun.file(outPath).writer();
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
    writer.write(typeof chunk === 'string' ? chunk : String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
    await writer.end();
    return await Bun.file(outPath).text();
  } finally {
    process.stdout.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('runModels CLI arg normalization', () => {
  test('help works when cli.ts passes only the subcommand tail', async () => {
    const out = await captureStdout(() => runModels(makeEngineStub(), ['help']));
    expect(out).toContain('Usage:');
    expect(out).toContain('gbrain models doctor [flags]');
  });

  test('doctor works when cli.ts passes only the subcommand tail', async () => {
    try {
      configureGateway({
        embedding_model: 'ollama:bge-m3',
        embedding_dimensions: 1024,
        expansion_model: 'anthropic:claude-haiku-4-5-20251001',
        chat_model: 'zai:glm-5.2',
        env: { ANTHROPIC_API_KEY: 'test', ZAI_API_KEY: 'test' },
      });

      const out = await captureStdout(() => runModels(makeEngineStub(), [
        'doctor',
        '--skip=anthropic',
        '--skip=ollama',
        '--skip=zai',
        '--skip=zeroentropyai',
        '--json',
      ]));
      const report = JSON.parse(out) as { probes: Array<{ touchpoint: string }>; summary: { failed: number } };
      expect(report.probes.some(p => p.touchpoint === 'chat')).toBe(false);
      expect(report.probes.some(p => p.touchpoint === 'expansion')).toBe(false);
      expect(report.probes.some(p => p.touchpoint === 'embedding_reachability')).toBe(false);
      expect(report.summary.failed).toBe(0);
    } finally {
      resetGateway();
    }
  });
});
