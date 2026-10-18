/**
 * `gbrain models` per-task routing report: the `models.dream.extract_atoms`
 * row, and the resolver it shares with `runPhaseExtractAtoms()`.
 *
 * The row calls `resolveExtractAtomsModelWithSource()`, the SAME function the
 * phase calls, so the report can never diverge from what extraction runs.
 * #6675 (decision D3, option B): the chain is `models.dream.extract_atoms` >
 * `models.tier.utility` > the key-aware utility default. `models.default` and
 * `GBRAIN_MODEL` alone do NOT move this phase: a frontier `models.default`
 * must not become the model of the highest-volume dream phase.
 *
 * Follows the StubConfigEngine + runModels(['--json']) pattern of
 * test/contextual-synopsis-model.serial.test.ts. Env is pinned keyless so the
 * built-in default resolves the same way on every machine.
 */
import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runModels } from '../src/commands/models.ts';
import { resolveExtractAtomsModel, resolveExtractAtomsModelWithSource } from '../src/core/cycle/extract-atoms.ts';
import { resolveTierDefault } from '../src/core/model-config.ts';

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_HOME', 'GBRAIN_MODEL'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = join(tmpdir(), `gbrain-extract-atoms-row-missing-${process.pid}`);
});
afterEach(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

class StubConfigEngine {
  private readonly config = new Map<string, string>();

  set(key: string, value: string): void {
    this.config.set(key, value);
  }

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }

  async getPage(): Promise<{ source_id: string }> {
    return { source_id: 'default' };
  }
}

async function captureModelsJson(engine: StubConfigEngine): Promise<{
  per_task: Array<{ key: string; tier: string; resolved: string; source: string; description: string; newer_available?: { command: string } }>;
}> {
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
  return JSON.parse(stdout);
}

describe('gbrain models per-task report — extract_atoms entry', () => {
  test('reports models.dream.extract_atoms with its configured routing', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.dream.extract_atoms', 'openai:gpt-5.6-luna');

    const report = await captureModelsJson(engine);

    expect(report.per_task).toContainEqual({
      key: 'models.dream.extract_atoms',
      tier: 'utility',
      resolved: 'openai:gpt-5.6-luna',
      source: 'config: models.dream.extract_atoms',
      description: 'Atom extraction from transcripts/pages (extract_atoms phase)',
    });
  });

  test('honors models.tier.utility when its own key is unset, and the runtime resolver agrees (#6675)', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'openai:gpt-6-luna');

    const entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    expect(entry!.resolved).toBe('openai:gpt-6-luna');
    expect(entry!.source).toBe('config: models.tier.utility');
    expect(await resolveExtractAtomsModel(engine as never)).toBe('openai:gpt-6-luna');
  });

  test('models.default alone does not change the model (D3)', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.default', 'openai:gpt-6-sol');
    const entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry!.resolved).toBe(resolveTierDefault('utility'));
    expect(entry!.source).toBe('tier.utility (caller-specific)');
    expect(await resolveExtractAtomsModel(engine as never)).toBe(resolveTierDefault('utility'));
  });

  test('GBRAIN_MODEL alone does not change the model (D3)', async () => {
    process.env.GBRAIN_MODEL = 'openai:gpt-6-sol';
    expect(await resolveExtractAtomsModel(new StubConfigEngine() as never)).toBe(resolveTierDefault('utility'));
  });

  test('models.dream.extract_atoms wins over the tier', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'claude-cli:claude-haiku-5-5');
    engine.set('models.dream.extract_atoms', 'openai:gpt-5.6-luna');
    const entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toMatchObject({ resolved: 'openai:gpt-5.6-luna', source: 'config: models.dream.extract_atoms' });
    expect(await resolveExtractAtomsModel(engine as never)).toBe('openai:gpt-5.6-luna');
  });

  test('an inherited tier route does not emit a row-key newer_available hint; the row key does', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'anthropic:claude-haiku-4-5');
    let entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry!.source).toBe('config: models.tier.utility');
    expect(entry!.newer_available).toBeUndefined();

    engine.set('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
    entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry!.newer_available?.command).toBe('gbrain config set models.dream.extract_atoms anthropic:claude-haiku-5-5');
  });

  test('resolver source is config only for its own key', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'claude-cli:claude-haiku-5-5');
    expect(await resolveExtractAtomsModelWithSource(engine as never)).toMatchObject({ source: 'tier_config', label: 'config: models.tier.utility' });
    engine.set('models.dream.extract_atoms', 'openai:gpt-5.6-luna');
    expect(await resolveExtractAtomsModelWithSource(engine as never)).toMatchObject({ source: 'config', label: 'config: models.dream.extract_atoms' });
  });

  test('falls back to the same tier default when fully unconfigured, matching the runtime resolver directly', async () => {
    const engine = new StubConfigEngine();

    const report = await captureModelsJson(engine);
    const entry = report.per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    expect(entry!.resolved).toBe(await resolveExtractAtomsModel(engine as never));
    expect(entry!.resolved).toBe(resolveTierDefault('utility'));
  });
});
