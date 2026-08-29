/**
 * `gbrain models` per-task routing report omitted `models.dream.extract_atoms`
 * from PER_TASK_KEYS even though `runPhaseExtractAtoms()` (src/core/cycle/
 * extract-atoms.ts) reads that config key directly as a real, separately
 * priced routing decision. Operators had no way to see or verify extract_atoms
 * routing via the standard `gbrain models` diagnostic — the routing itself
 * worked, only the report was missing an entry.
 *
 * The report entry calls `resolveExtractAtomsModel()` — the SAME function
 * `runPhaseExtractAtoms` calls — rather than the generic `resolveModel()`
 * chain, because extract_atoms's actual runtime resolution is narrower (DB
 * config -> `resolveTierDefault('utility')` only; it does NOT honor
 * `models.tier.utility` / `models.default` / an env var the way the generic
 * chain does). Reporting via the generic chain would show a resolved value
 * that can diverge from what extraction actually uses whenever one of those
 * intermediate overrides is set without `models.dream.extract_atoms` itself
 * being set — this is pinned by the second test below.
 *
 * Follows the same StubConfigEngine + runModels(['--json']) pattern as
 * test/contextual-synopsis-model.serial.test.ts's "reports the ... route in
 * gbrain models JSON" case.
 */
import { describe, test, expect } from 'bun:test';
import { runModels } from '../src/commands/models.ts';
import { resolveExtractAtomsModel } from '../src/core/cycle/extract-atoms.ts';
import { resolveTierDefault } from '../src/core/model-config.ts';

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

  test('ignores models.tier.utility (extract_atoms does not honor it) — pins the narrow-resolver divergence this report exists to avoid hiding', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.utility', 'codex-proxy:should-be-ignored-by-extract-atoms');

    const report = await captureModelsJson(engine);

    const entry = report.per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    // The generic resolveModel() chain WOULD have picked up models.tier.utility
    // here; extract_atoms's actual runtime does not, so the report must not
    // claim it does.
    expect(entry!.resolved).toBe(resolveTierDefault('utility'));
    expect(entry!.resolved).not.toBe('codex-proxy:should-be-ignored-by-extract-atoms');
    expect(entry!.source).toBe('tier.utility (caller-specific)');
  });

  test('falls back to the same tier default when fully unconfigured, matching the runtime resolver directly', async () => {
    const engine = new StubConfigEngine();

    const report = await captureModelsJson(engine);
    const entry = report.per_task.find((r) => r.key === 'models.dream.extract_atoms');
    expect(entry).toBeDefined();
    expect(entry!.resolved).toBe(await resolveExtractAtomsModel(engine as never));
  });
});
