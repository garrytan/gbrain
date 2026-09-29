/**
 * `gbrain models` — advisory newer-available hint and source attribution
 * derived from resolveModelDetailed (models.tier.* attributed before
 * models.default). Serial: captures process.stdout and clears GBRAIN_MODEL.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { runModels } from '../src/commands/models.ts';

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

interface Newer { family: string; model: string; command: string }
interface Report {
  tiers: Record<string, { resolved: string; source: string; newer_available?: Newer }>;
  per_task: Array<{ key: string; resolved: string; source: string; newer_available?: Newer }>;
}

async function capture(engine: StubConfigEngine, args: string[]): Promise<string> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runModels(engine as never, args);
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
}

const reportOf = async (engine: StubConfigEngine): Promise<Report> => JSON.parse(await capture(engine, ['--json']));

let savedModelEnv: string | undefined;
beforeEach(() => {
  savedModelEnv = process.env.GBRAIN_MODEL;
  delete process.env.GBRAIN_MODEL;
});
afterEach(() => {
  if (savedModelEnv === undefined) delete process.env.GBRAIN_MODEL;
  else process.env.GBRAIN_MODEL = savedModelEnv;
});

describe('gbrain models — newer-available hint', () => {
  test('an older configured sonnet prints the hint and the config command', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.reasoning', 'anthropic:claude-sonnet-4-6');

    const report = await reportOf(engine);
    expect(report.tiers.reasoning.newer_available).toEqual({
      family: 'sonnet',
      model: 'claude-sonnet-5-5',
      command: 'gbrain config set models.tier.reasoning anthropic:claude-sonnet-5-5',
    });

    const text = await capture(engine, []);
    const row = text.split('\n').find((l) => l.includes('tier.reasoning'))!;
    expect(row).toContain('[newer sonnet available: claude-sonnet-5-5]');
    expect(row).toContain('gbrain config set models.tier.reasoning anthropic:claude-sonnet-5-5');
  });

  test('current, newer-than-recipe, dated/undated-equal and non-Anthropic models get no hint', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.reasoning', 'anthropic:claude-sonnet-5-5');
    engine.set('models.tier.deep', 'anthropic:claude-opus-6');
    engine.set('models.tier.utility', 'claude-haiku-4-5');
    engine.set('models.tier.subagent', 'openai:gpt-5.6');

    const report = await reportOf(engine);
    for (const t of ['utility', 'reasoning', 'deep', 'subagent']) {
      expect(report.tiers[t].newer_available).toBeUndefined();
    }
    expect(await capture(engine, [])).not.toContain('[newer ');
  });

  test('per-task rows hint only when their own key supplied the model', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.tier.deep', 'anthropic:claude-opus-4-7');
    engine.set('models.drift', 'anthropic:claude-sonnet-4-6');

    const report = await reportOf(engine);
    const drift = report.per_task.find((r) => r.key === 'models.drift')!;
    expect(drift.newer_available?.command).toBe('gbrain config set models.drift anthropic:claude-sonnet-5-5');
    const think = report.per_task.find((r) => r.key === 'models.think')!;
    expect(think.resolved).toBe('anthropic:claude-opus-4-7');
    expect(think.newer_available).toBeUndefined();
    expect(report.tiers.deep.newer_available?.model).toBe('claude-opus-5-5');
  });
});

describe('gbrain models — source attribution', () => {
  test('models.tier.* is attributed before models.default on tier and per-task rows', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.default', 'anthropic:claude-sonnet-5');
    engine.set('models.tier.utility', 'anthropic:claude-haiku-4-5-20251001');

    const report = await reportOf(engine);
    expect(report.tiers.utility).toMatchObject({
      resolved: 'anthropic:claude-haiku-4-5-20251001',
      source: 'config: models.tier.utility',
    });
    expect(report.tiers.reasoning).toMatchObject({
      resolved: 'anthropic:claude-sonnet-5',
      source: 'config: models.default',
    });
    const expansion = report.per_task.find((r) => r.key === 'models.expansion')!;
    expect(expansion).toMatchObject({
      resolved: 'anthropic:claude-haiku-4-5-20251001',
      source: 'config: models.tier.utility',
    });
    const chat = report.per_task.find((r) => r.key === 'models.chat')!;
    expect(chat.source).toBe('config: models.default');
  });

  test('unconfigured rows report the built-in default', async () => {
    const report = await reportOf(new StubConfigEngine());
    expect(report.tiers.deep.source).toBe('default');
    expect(report.per_task.find((r) => r.key === 'models.think')!.source).toBe('tier.deep');
  });
});
