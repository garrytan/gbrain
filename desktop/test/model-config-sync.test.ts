import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('src/main/index.ts'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');

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

  test('desktop ordinary model removes hidden legacy Dream phase overrides', () => {
    expect(source).toContain("'models.propose_takes'");
    expect(source).toContain("'models.grade_takes'");
    expect(source).toContain("'models.calibration_profile'");
    expect(source).toContain("['config', 'unset', key]");
  });

  test('embedding replacement requires renderer and main-process confirmation', () => {
    expect(renderer).toContain('confirmEmbeddingRebuild = true');
    expect(renderer).toContain('confirmEmbeddingRebuild,');
    expect(source).toContain('payload.confirmEmbeddingRebuild !== true');
  });
});
