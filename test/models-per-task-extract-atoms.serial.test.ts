/**
 * `gbrain models` per-task routing report — the `models.dream.extract_atoms`
 * row, and the resolver it shares with `runPhaseExtractAtoms()`.
 *
 * The row calls `resolveExtractAtomsModelWithSource()` — the SAME function the
 * phase calls — so the report can never diverge from what extraction runs.
 * That resolver walks the full chain: `models.dream.extract_atoms` >
 * `models.tier.utility` > `models.default` > `GBRAIN_MODEL` > the key-aware
 * utility default. Before the precedence fix it read only its own key and
 * then jumped to `resolveTierDefault('utility')`, so a brain that routed its
 * utility tier elsewhere still extracted atoms on the built-in Anthropic
 * default; the second and third tests pin the chain now in effect (they fail
 * against the old resolver, where `models.tier.utility` was ignored and the
 * row read `tier.utility (caller-specific)`). The second test's earlier form
 * pinned that old behavior on purpose ("ignores models.tier.utility"); it is
 * flipped here because the divergence it guarded is the bug.
 *
 * Follows the same StubConfigEngine + runModels(['--json']) pattern as
 * test/contextual-synopsis-model.serial.test.ts's "reports the ... route in
 * gbrain models JSON" case. Env is pinned keyless so the built-in default
 * resolves the same way on every machine.
 */
import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runModels } from '../src/commands/models.ts';
import { resolveExtractAtomsModel } from '../src/core/cycle/extract-atoms.ts';
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
  per_task: Array<{ key: string; tier: string; resolved: string; source: string; description: string }>;
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

  test('honors models.tier.utility when its own key is unset, and the runtime resolver agrees', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'deepseek:deepseek-v4-flash');

    const report = await captureModelsJson(engine);

    const entry = report.per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    expect(entry!.resolved).toBe('deepseek:deepseek-v4-flash');
    expect(entry!.source).toBe('config: models.tier.utility');
    expect(await resolveExtractAtomsModel(engine as never)).toBe('deepseek:deepseek-v4-flash');
  });

  test('models.dream.extract_atoms still wins over the tier, and models.default fills in below it', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.default', 'claude-cli:claude-sonnet-5-5');
    let entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toMatchObject({ resolved: 'claude-cli:claude-sonnet-5-5', source: 'config: models.default' });

    engine.set('models.tier.utility', 'claude-cli:claude-haiku-5-5');
    entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toMatchObject({ resolved: 'claude-cli:claude-haiku-5-5', source: 'config: models.tier.utility' });

    engine.set('models.dream.extract_atoms', 'openai:gpt-5.6-luna');
    entry = (await captureModelsJson(engine)).per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toMatchObject({ resolved: 'openai:gpt-5.6-luna', source: 'config: models.dream.extract_atoms' });
    expect(await resolveExtractAtomsModel(engine as never)).toBe('openai:gpt-5.6-luna');
  });

  test('falls back to the same tier default when fully unconfigured, matching the runtime resolver directly', async () => {
    const engine = new StubConfigEngine();

    const report = await captureModelsJson(engine);
    const entry = report.per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    expect(entry!.resolved).toBe(await resolveExtractAtomsModel(engine as never));
    expect(entry!.resolved).toBe(resolveTierDefault('utility'));
    expect(entry!.source).toBe('tier.utility');
  });
});
