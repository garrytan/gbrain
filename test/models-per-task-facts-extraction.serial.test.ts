/**
 * `gbrain models` reports the facts extraction route through the same
 * resolver extraction uses (resolveFactsExtractionModel), so the measured
 * Haiku 5.5 default shows as `measured default` and every explicit setting
 * keeps its own label. Same StubConfigEngine + runModels(['--json']) pattern
 * as test/models-per-task-extract-atoms.serial.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { runModels } from '../src/commands/models.ts';
import { withEnv } from './helpers/with-env.ts';

class StubConfigEngine {
  private readonly config = new Map<string, string>();
  set(key: string, value: string): void { this.config.set(key, value); }
  async getConfig(key: string): Promise<string | null> { return this.config.get(key) ?? null; }
  async getPage(): Promise<{ source_id: string }> { return { source_id: 'default' }; }
}

async function factsRow(engine: StubConfigEngine) {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runModels(engine as never, ['--json']);
  } finally {
    process.stdout.write = originalWrite;
  }
  return (JSON.parse(stdout) as { per_task: Array<{ key: string; resolved: string; source: string }> }).per_task.find(r => r.key === 'facts.extraction_model')!;
}

const ENV = { GBRAIN_HOME: '/nonexistent-gbrain-home-for-models-facts-tests', GBRAIN_MODEL: undefined, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined };

describe('gbrain models: facts.extraction_model route', () => {
  test('unset on an Anthropic-keyed install: claude-haiku-5-5, measured default', async () => {
    await withEnv(ENV, async () => {
      expect(await factsRow(new StubConfigEngine())).toMatchObject({ resolved: 'anthropic:claude-haiku-5-5', source: 'measured default' });
    });
  });

  test('explicit settings keep their labels', async () => {
    await withEnv(ENV, async () => {
      const own = new StubConfigEngine();
      own.set('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
      expect(await factsRow(own)).toMatchObject({ resolved: 'anthropic:claude-sonnet-4-6', source: 'config: facts.extraction_model' });
      const tier = new StubConfigEngine();
      tier.set('models.tier.reasoning', 'anthropic:claude-sonnet-5-5');
      expect(await factsRow(tier)).toMatchObject({ resolved: 'anthropic:claude-sonnet-5-5', source: 'config: models.tier.reasoning' });
    });
  });
});
