/**
 * Install-time search-mode picker.
 *
 * The recommendation over every input combination (chat key yes/no, ready
 * reranker yes/no, Haiku / Opus / unknown model), the inputs resolved from
 * the environment and from a key saved only in ~/.gbrain/config.json, the
 * shared cost matrix and banners, `--search-mode` (operator choice,
 * refuse-or-force), `search.mode_source`, and the `--json` event. The TTY
 * menu branch needs a terminal and is not exercised here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  MODE_PICKER_MENU,
  parseModeInput,
  recommendModeFor,
  resolveModePickerInputs,
  runModePicker,
  searchModeChoiceFromArgs,
} from '../src/commands/init-mode-picker.ts';
import {
  COST_MATRIX_MODELS,
  MODE_REASONS,
  agentBannerLines,
  costMatrixLines,
  costMatrixSentence,
  monthlyPayloadCost,
  upgradeBannerLines,
} from '../src/core/search/mode-advice.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';
import { withEnv } from './helpers/with-env.ts';

const NO_KEYS = {
  ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  GEMINI_API_KEY: undefined, VOYAGE_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
};

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-mode-picker-'));
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%' OR key LIKE 'models.%'`);
});

/** Runs `fn` with no provider keys and a fresh GBRAIN_HOME, plus `env`. */
function inHome<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  return withEnv({ ...NO_KEYS, GBRAIN_HOME: home, ...env }, fn);
}

function writeConfigFile(fields: Record<string, string>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...fields }));
}

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

describe('recommendModeFor: every input combination', () => {
  const models = [
    { name: 'Haiku', subagentModel: 'anthropic:claude-haiku-5-5' },
    { name: 'Opus', defaultModel: 'anthropic:claude-opus-5-5' },
    { name: 'unknown', subagentModel: undefined },
  ] as const;
  const expected = (model: string, chat: boolean, rerank: boolean): string => {
    if (model === 'Haiku') return 'conservative';
    if (!chat && !rerank) return 'conservative';
    return chat ? 'tokenmax' : 'balanced';
  };
  for (const m of models) {
    for (const chat of [true, false]) {
      for (const rerank of [true, false]) {
        test(`${m.name} model, chat key ${chat ? 'yes' : 'no'}, reranker ${rerank ? 'ready' : 'not ready'} → ${expected(m.name, chat, rerank)}`, () => {
          const { name: _name, ...model } = m;
          const r = recommendModeFor({ ...model, hasChatKey: chat, hasRerankKey: rerank });
          expect(r.mode).toBe(expected(m.name, chat, rerank) as never);
          expect(r.reason.length).toBeGreaterThan(0);
        });
      }
    }
  }

  test('each branch names its reason', () => {
    expect(recommendModeFor({ subagentModel: 'anthropic:claude-haiku-5-5', hasChatKey: true }).reason).toBe(MODE_REASONS.haiku);
    expect(recommendModeFor({ hasChatKey: false, hasRerankKey: false }).reason).toBe(MODE_REASONS.noKeys);
    expect(recommendModeFor({ hasChatKey: false, hasRerankKey: true }).reason).toBe(MODE_REASONS.rerankOnly);
    expect(recommendModeFor({ defaultModel: 'anthropic:claude-opus-5-5', hasChatKey: true }).reason).toBe(MODE_REASONS.opus);
    expect(recommendModeFor({ hasChatKey: true, hasRerankKey: true }).reason).toBe(MODE_REASONS.default);
  });

  test('unknown key state is not "no keys": empty inputs get the default', () => {
    expect(recommendModeFor({}).mode).toBe('tokenmax');
  });

  test('a Haiku subagent wins over an Opus default model', () => {
    const r = recommendModeFor({ defaultModel: 'anthropic:claude-opus-5-5', subagentModel: 'anthropic:claude-haiku-5-5', hasChatKey: true, hasRerankKey: true });
    expect(r.mode).toBe('conservative');
  });
});

describe('resolveModePickerInputs: keys through mergedProviderEnv and reranker readiness', () => {
  test('no keys anywhere → no chat key, reranker not ready → conservative', async () => {
    await inHome({}, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs.hasChatKey).toBe(false);
      expect(inputs.hasRerankKey).toBe(false);
      expect(recommendModeFor(inputs).mode).toBe('conservative');
    });
  });

  test('a Voyage key in the environment without a chat key → balanced', async () => {
    await inHome({ VOYAGE_API_KEY: 'pa-test-stub' }, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs).toMatchObject({ hasChatKey: false, hasRerankKey: true });
      expect(recommendModeFor(inputs)).toEqual({ mode: 'balanced', reason: MODE_REASONS.rerankOnly });
    });
  });

  test('a Voyage key saved only in ~/.gbrain/config.json counts', async () => {
    writeConfigFile({ voyage_api_key: 'pa-test-stub' });
    await inHome({}, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs).toMatchObject({ hasChatKey: false, hasRerankKey: true });
      expect(recommendModeFor(inputs).mode).toBe('balanced');
    });
  });

  test('a chat key saved only in ~/.gbrain/config.json counts', async () => {
    writeConfigFile({ anthropic_api_key: 'sk-ant-test-stub' });
    await inHome({}, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs.hasChatKey).toBe(true);
      expect(inputs.hasRerankKey).toBe(false);
      expect(recommendModeFor(inputs)).toEqual({ mode: 'tokenmax', reason: MODE_REASONS.default });
    });
  });

  test('GEMINI_API_KEY counts as a chat key', async () => {
    await inHome({ GEMINI_API_KEY: 'gm-test-stub' }, async () => {
      expect((await resolveModePickerInputs(engine)).hasChatKey).toBe(true);
    });
  });

  test('a configured reranker that cannot run is not counted ready because a Voyage key exists', async () => {
    await engine.setConfig('search.reranker.model', 'nonexistent-provider:model');
    await inHome({ VOYAGE_API_KEY: 'pa-test-stub' }, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs.hasRerankKey).toBe(false);
      expect(recommendModeFor(inputs).mode).toBe('conservative');
    });
  });

  test('model tiers are read from the brain config', async () => {
    await engine.setConfig('models.tier.subagent', 'anthropic:claude-haiku-5-5');
    await inHome({ ANTHROPIC_API_KEY: 'sk-ant-test-stub' }, async () => {
      const inputs = await resolveModePickerInputs(engine);
      expect(inputs.subagentModel).toBe('anthropic:claude-haiku-5-5');
      expect(recommendModeFor(inputs).mode).toBe('conservative');
    });
  });
});

describe('cost matrix: newest models, priced from model-pricing', () => {
  test('prices every cell from the canonical pricing table', () => {
    for (const { id } of COST_MATRIX_MODELS) {
      const input = canonicalLookup(id)!.input;
      expect(monthlyPayloadCost('conservative', id)).toBeCloseTo(4_000 * 10_000 / 1e6 * input, 6);
      expect(monthlyPayloadCost('balanced', id)).toBeCloseTo(10_000 * 10_000 / 1e6 * input, 6);
      expect(monthlyPayloadCost('tokenmax', id)).toBeCloseTo(20_000 * 10_000 / 1e6 * input, 6);
    }
  });

  test('names the newest Anthropic models, not retired ones', () => {
    const text = costMatrixLines().join('\n');
    for (const label of ['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5']) expect(text).toContain(label);
    for (const old of ['Haiku 4.5', 'Sonnet 4.6', 'Opus 4.7', '25x']) expect(text).not.toContain(old);
    expect(text).toContain('10K queries/mo');
    expect(text).toContain('Scales linearly');
  });

  test('the menu, the [AGENT] banner and the upgrade banner print the same matrix', () => {
    const matrix = costMatrixLines('  ').slice(2, 7).map(l => l.trim());
    const surfaces = [MODE_PICKER_MENU, agentBannerLines('balanced', 'r').join('\n'), upgradeBannerLines().join('\n')];
    for (const surface of surfaces) for (const row of matrix) expect(surface).toContain(row);
  });

  test('INSTALL_FOR_AGENTS.md Step 3.5 carries the generated matrix verbatim', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'INSTALL_FOR_AGENTS.md'), 'utf8');
    expect(doc).toContain(costMatrixLines('  ').join('\n'));
  });

  test('the first-run sentence carries the same cells', () => {
    const sentence = costMatrixSentence();
    expect(sentence).toContain('Haiku 5.5 / Sonnet 5.5 / Opus 5.5');
    expect(sentence).toContain(`balanced $10 / $200 / $400`);
  });

  test('the menu states the query expansion rule and no cache refill', () => {
    const flat = MODE_PICKER_MENU.replace(/\s+/g, ' ');
    expect(flat).toContain('`gbrain query` does not expand by default in any mode');
    expect(flat).toContain('`gbrain search` never expands');
    expect(flat).toContain('`gbrain config set search.expansion true` turns the default on for the brain');
    expect(flat).not.toMatch(/in every mode/);
    expect(MODE_PICKER_MENU).toContain('semantic result caching is temporarily disabled');
    expect(MODE_PICKER_MENU).toContain('gbrain search tune');
  });
});

describe('parseModeInput', () => {
  test('numeric 1/2/3 and names (case-insensitive)', () => {
    expect(parseModeInput('1')).toBe('conservative');
    expect(parseModeInput('2')).toBe('balanced');
    expect(parseModeInput('3')).toBe('tokenmax');
    expect(parseModeInput(' TokenMax ')).toBe('tokenmax');
  });

  test('empty / unrecognized → null', () => {
    for (const raw of ['', '   ', 'foo', '4', '0']) expect(parseModeInput(raw)).toBeNull();
  });
});

describe('runModePicker: non-TTY and --json', () => {
  test('non-TTY applies tokenmax for a keyed brain, records auto, prints the [AGENT] banner', async () => {
    await inHome({ ANTHROPIC_API_KEY: 'sk-ant-test-stub' }, async () => {
      let decision: { mode: string; reason: string } | undefined;
      const out = (await captureLog(() => runModePicker(engine, { onDecision: d => { decision = d; } }))).join('\n');
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.mode_source')).toBe('auto');
      expect(decision).toEqual({ mode: 'tokenmax', reason: MODE_REASONS.default });
      expect(out).toContain('[gbrain] search mode tentatively set to: tokenmax');
      expect(out.toLowerCase()).toContain('show this matrix');
      expect(out).toContain('INSTALL_FOR_AGENTS.md');
      expect(out).toContain('gbrain init --search-mode <mode>');
      expect(out).toContain('Opus 5.5');
    });
  });

  test('non-TTY on a keyless brain applies conservative', async () => {
    await inHome({}, async () => {
      await captureLog(() => runModePicker(engine));
      expect(await engine.getConfig('search.mode')).toBe('conservative');
      expect(await engine.getConfig('search.mode_source')).toBe('auto');
    });
  });

  test('--json emits one structured event with auto: true and source auto', async () => {
    await inHome({ VOYAGE_API_KEY: 'pa-test-stub' }, async () => {
      const lines = await captureLog(() => runModePicker(engine, { jsonOutput: true }));
      const event = JSON.parse(lines.find(l => l.startsWith('{'))!);
      expect(event).toEqual({ phase: 'search_mode_picker', mode: 'balanced', reason: MODE_REASONS.rerankOnly, auto: true, source: 'auto' });
      expect(await engine.getConfig('search.mode')).toBe('balanced');
    });
  });

  test('idempotent: an existing mode is kept and nothing is recorded', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await inHome({ ANTHROPIC_API_KEY: 'sk-ant-test-stub' }, async () => {
      let decided = false;
      expect(await runModePicker(engine, { onDecision: () => { decided = true; } })).toBe('tokenmax');
      expect(decided).toBe(false);
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.mode_source')).toBeNull();
    });
  });

  test('--force re-runs the recommendation over an existing mode', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await inHome({ ANTHROPIC_API_KEY: 'sk-ant-test-stub' }, async () => {
      await engine.setConfig('search.mode', 'conservative');
      await captureLog(() => runModePicker(engine, { force: true }));
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.mode_source')).toBe('auto');
    });
  });
});

describe('init --search-mode: the operator\'s choice', () => {
  const fail = (message: string): never => { throw new Error(`refused: ${message}`); };

  test('parses the flag; an invalid value is refused', () => {
    expect(searchModeChoiceFromArgs(['--pglite'], fail)).toEqual({});
    expect(searchModeChoiceFromArgs(['--search-mode', 'Balanced'], fail)).toMatchObject({ explicit: 'balanced', force: false });
    expect(searchModeChoiceFromArgs(['--search-mode', 'tokenmax', '--force'], fail)).toMatchObject({ explicit: 'tokenmax', force: true });
    expect(() => searchModeChoiceFromArgs(['--search-mode', 'max'], fail)).toThrow(/--search-mode must be one of conservative, balanced, tokenmax/);
    expect(() => searchModeChoiceFromArgs(['--search-mode'], fail)).toThrow(/--search-mode must be one of/);
  });

  test('a fresh brain records the choice as operator and asks nothing', async () => {
    await inHome({}, async () => {
      let decided = false;
      const lines = await captureLog(() => runModePicker(engine, { explicit: 'tokenmax', jsonOutput: true, onDecision: () => { decided = true; } }));
      expect(decided).toBe(false);
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.mode_source')).toBe('operator');
      expect(JSON.parse(lines.find(l => l.startsWith('{'))!)).toMatchObject({ phase: 'search_mode_picker', mode: 'tokenmax', auto: false, source: 'operator' });
      expect(lines.join('\n')).not.toContain('[AGENT]');
    });
  });

  test('an existing brain with another mode refuses without --force and changes nothing', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await inHome({}, async () => {
      await expect(runModePicker(engine, { explicit: 'tokenmax', refuse: fail })).rejects.toThrow(
        /refused: This brain already has search.mode balanced.*gbrain config set search.mode tokenmax.*--force/,
      );
      expect(await engine.getConfig('search.mode')).toBe('balanced');
      expect(await engine.getConfig('search.mode_source')).toBeNull();
    });
  });

  test('--force replaces an existing brain\'s mode and records operator', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await inHome({}, async () => {
      await captureLog(() => runModePicker(engine, { explicit: 'tokenmax', force: true }));
      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.mode_source')).toBe('operator');
    });
  });

  test('the same mode on an existing brain is accepted and marks it the operator\'s', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await inHome({}, async () => {
      await captureLog(() => runModePicker(engine, { explicit: 'tokenmax', refuse: fail }));
      expect(await engine.getConfig('search.mode_source')).toBe('operator');
    });
  });
});

describe('upgrade banner', () => {
  test('states the default a mode-less brain runs and the recommendation from the shared source', () => {
    const text = upgradeBannerLines().join('\n');
    expect(text).toContain('runs balanced');
    expect(text).toContain('Recommended for a brain with a chat key: tokenmax');
    expect(text).not.toMatch(/expand=true|preserves current retrieval shape|v0\.31/);
  });
});
