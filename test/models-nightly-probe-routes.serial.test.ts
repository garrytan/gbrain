/**
 * #5872: `gbrain models` reported `models.eval.longmemeval` on the reasoning
 * tier while the nightly quality probe answered on the Anthropic fallback,
 * and no judge-slot route appeared at all. The report now carries the
 * probe's routes as the probe resolves them: the reader and extractor from
 * the probe's own route resolver, and each judge slot from its config key,
 * the panel default, or the #4636 substitute, under a note that keys are
 * judged from this process's environment, not the daemon's env file.
 *
 * Same StubConfigEngine + runModels pattern as
 * test/models-per-task-extract-atoms.serial.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runModels } from '../src/commands/models.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

class StubConfigEngine {
  constructor(private readonly config: Record<string, string>) {}

  async getConfig(key: string): Promise<string | null> {
    return this.config[key] ?? null;
  }

  async getPage(): Promise<{ source_id: string }> {
    return { source_id: 'default' };
  }
}

/** The reporter's DB plane: tiers on claude-cli, no per-task or default key. */
const REPORTED_TIERS: Record<string, string> = {
  'models.tier.utility': 'claude-cli:claude-sonnet-5',
  'models.tier.reasoning': 'claude-cli:claude-opus-5-5',
  'models.tier.deep': 'claude-cli:claude-opus-5-5',
};

/** The daemon's brain-resolved gateway on an install holding only an Anthropic key. */
function configureBrainGateway(): void {
  configureGateway({ chat_model: 'claude-cli:claude-opus-5-5', env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } });
}

/** The block's label: this process's keys, not the daemon's env file under `home`. */
function environmentNote(home: string): string {
  return "Slot availability, substitutes and key-aware defaults are judged from this process's environment; " +
    `a provider key set only in ${join(home, '.gbrain', 'env')} (sourced by the autopilot daemon's launcher) reads here as unavailable.`;
}

async function captureModels(engine: StubConfigEngine, args: string[], home?: string): Promise<string> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await withEnv({ GBRAIN_MODEL: undefined, ...(home ? { GBRAIN_HOME: home } : {}) }, () => runModels(engine as never, args));
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
}

afterEach(() => {
  resetGateway();
});

describe('gbrain models — nightly quality probe routes', () => {
  test('JSON: reader and extractor match their report rows, each slot names its origin', async () => {
    configureBrainGateway();
    const home = emptyHome();
    const report = JSON.parse(await captureModels(new StubConfigEngine({
      ...REPORTED_TIERS,
      'models.eval.cross_modal.slot_b': 'claude-cli:claude-fable-5',
    }), ['--json'], home));

    const lmeRow = report.per_task.find((r: { key: string }) => r.key === 'models.eval.longmemeval');
    expect(report.nightly_probe.reader).toEqual({ model: lmeRow.resolved, source: lmeRow.source });
    expect(report.nightly_probe.reader).toEqual({ model: 'claude-cli:claude-opus-5-5', source: 'config: models.tier.reasoning' });
    expect(report.nightly_probe.extractor).toEqual({ model: report.tiers.utility.resolved, source: report.tiers.utility.source });
    expect(report.nightly_probe.extractor).toEqual({ model: 'claude-cli:claude-sonnet-5', source: 'config: models.tier.utility' });
    expect(report.nightly_probe.slots).toEqual([
      { id: 'A', model: 'claude-cli:claude-opus-5-5', source: 'substitute for openai:gpt-5.2 (no usable provider)' },
      { id: 'B', model: 'claude-cli:claude-fable-5', source: 'config: models.eval.cross_modal.slot_b' },
      { id: 'C', model: 'claude-cli:claude-opus-5-5', source: 'substitute for deepseek:deepseek-v4-pro (no usable provider)' },
    ]);
    expect(report.nightly_probe.environment_note).toBe(environmentNote(home));
    expect(report.schema_version).toBe(1);
  });

  test('JSON: an unset slot whose default provider is usable keeps the panel default; the reader key wins', async () => {
    configureBrainGateway();
    const report = JSON.parse(await captureModels(new StubConfigEngine({
      ...REPORTED_TIERS,
      'models.eval.longmemeval': 'claude-cli:claude-fable-5',
    }), ['--json']));

    expect(report.nightly_probe.reader).toEqual({ model: 'claude-cli:claude-fable-5', source: 'config: models.eval.longmemeval' });
    expect(report.nightly_probe.slots[1]).toEqual({ id: 'B', model: 'anthropic:claude-opus-4-7', source: 'panel default' });
  });

  test('text: a nightly probe block after the per-task rows lists every route with its source', async () => {
    configureBrainGateway();
    const home = emptyHome();
    const text = await captureModels(new StubConfigEngine(REPORTED_TIERS), [], home);
    const block = text.slice(text.indexOf('Nightly quality probe'), text.indexOf('Aliases:'));
    expect(text.indexOf('Per-task overrides:')).toBeLessThan(text.indexOf('Nightly quality probe'));
    expect(block).toMatch(/reader \(LongMemEval answers\)\s+→ claude-cli:claude-opus-5-5\s+\[config: models\.tier\.reasoning\]/);
    expect(block).toMatch(/extractor \(trajectory claims\)\s+→ claude-cli:claude-sonnet-5\s+\[config: models\.tier\.utility\]/);
    expect(block).toMatch(/judge slot A\s+→ claude-cli:claude-opus-5-5\s+\[substitute for openai:gpt-5\.2 \(no usable provider\)\]/);
    expect(block).toMatch(/judge slot B\s+→ anthropic:claude-opus-4-7\s+\[panel default\]/);
    expect(block).toMatch(/judge slot C\s+→ claude-cli:claude-opus-5-5\s+\[substitute for deepseek:deepseek-v4-pro \(no usable provider\)\]/);
    expect(block).toContain(`\n  Note: ${environmentNote(home)}\n`);
  });
});
