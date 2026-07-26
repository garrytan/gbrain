import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('src/main/index.ts'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const html = readFileSync(resolve('src/renderer/index.html'), 'utf8');
const advanced = readFileSync(resolve('src/main/advanced-model-config.ts'), 'utf8');

function sliceSyncModelDefaults(): string {
  const start = source.indexOf('async function syncModelDefaultsToConfigFile');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\nasync function ensureServiceReady', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('desktop simple-model config.json sync', () => {
  test('writes both legacy chat_model and canonical models.default', () => {
    expect(source).toContain("['config', 'set', 'chat_model', chatModel]");
    expect(source).toContain("['config', 'set', 'models.default', chatModel]");
  });

  test('basic desktop saves preserve advanced routing unless an explicit reset is requested', () => {
    expect(source).toContain("['config', 'unset', '--pattern', 'models.tier.']");
    expect(source).toContain("['config', 'unset', '--pattern', 'models.dream.']");
    expect(source).toContain('resetAdvanced: payload.resetAdvancedModelRouting === true');
    expect(renderer).toContain('resetAdvancedModelRouting: false');
    expect(source).toContain('await syncModelDefaultsToConfigFile();');
  });

  test('ordinary model save does not silently unset Dream phase overrides', () => {
    const body = sliceSyncModelDefaults();
    const resetBlock = body.match(/if \(opts\.resetAdvanced\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(resetBlock).toContain("'models.propose_takes'");
    expect(resetBlock).toContain("'models.grade_takes'");
    expect(resetBlock).toContain("'models.calibration_profile'");
    // 阶段键 unset 不得出现在 resetAdvanced 条件之外
    const afterReset = body.slice(body.indexOf('if (opts.resetAdvanced)'));
    const outside = afterReset.replace(/if \(opts\.resetAdvanced\) \{[\s\S]*?\n  \}/, '');
    expect(outside).not.toContain("for (const key of ['models.propose_takes'");
  });

  test('advanced model panel includes Dream phase overrides as first-class settings', () => {
    expect(advanced).toContain("ADVANCED_MODEL_PHASES");
    expect(advanced).toContain('models.propose_takes');
    expect(html).toContain('data-advanced-phase="propose_takes"');
    expect(html).toContain('data-advanced-phase="grade_takes"');
    expect(html).toContain('data-advanced-phase="calibration_profile"');
    expect(html).toContain('Dream 阶段模型');
    expect(renderer).toContain('ADVANCED_PHASES');
    expect(renderer).toContain('values.phases');
  });

  test('embedding replacement requires renderer and main-process confirmation', () => {
    expect(renderer).toContain('confirmEmbeddingRebuild = true');
    expect(renderer).toContain('confirmEmbeddingRebuild,');
    expect(source).toContain('payload.confirmEmbeddingRebuild !== true');
  });
});
