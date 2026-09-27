import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readdirSync(resolve('src/main'), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts'))
  .sort()
  .map(path => readFileSync(resolve('src/main', path), 'utf8'))
  .join('\n');
const modelSync = readFileSync(resolve('src/main/models/model-config-sync.ts'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const html = readFileSync(resolve('src/renderer/settings-content.html'), 'utf8');
const advanced = readFileSync(resolve('src/main/advanced-model-config.ts'), 'utf8');

function sliceSyncModelDefaults(): string {
  return modelSync;
}

describe('desktop simple-model config.json sync', () => {
  test('writes both legacy chat_model and canonical models.default', () => {
    expect(modelSync).toContain('syncChatModelDefaultsInConfig(chatModel)');
    expect(modelSync).not.toContain("['config', 'set', 'chat_model', chatModel]");
    expect(modelSync).not.toContain("['config', 'set', 'models.default', chatModel]");
  });

  test('automatic upgrade sync never starts the full CLI or touches embedding storage', () => {
    const body = sliceSyncModelDefaults();
    const resetBlock = body.match(/if \(options\.resetAdvanced\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const outsideReset = body.replace(resetBlock, '');
    expect(outsideReset).not.toContain('runCliChecked(runtime');
    expect(outsideReset).not.toContain('runCli(runtime');
  });

  test('basic desktop saves preserve advanced routing unless an explicit reset is requested', () => {
    expect(source).toContain("['config', 'unset', '--pattern', 'models.tier.']");
    expect(source).toContain("['config', 'unset', '--pattern', 'models.dream.']");
    expect(source).toContain('resetAdvanced: payload.resetAdvancedModelRouting === true');
    expect(renderer).toContain('resetAdvancedModelRouting: false');
    expect(source).toContain('syncModelDefaults: options => syncModelDefaultsToConfigFile(runtime(), options)');
  });

  test('ordinary model save does not silently unset Dream phase overrides', () => {
    const body = sliceSyncModelDefaults();
    const resetBlock = body.match(/if \(options\.resetAdvanced\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(resetBlock).toContain("'models.propose_takes'");
    expect(resetBlock).toContain("'models.grade_takes'");
    expect(resetBlock).toContain("'models.calibration_profile'");
    // 阶段键 unset 不得出现在 resetAdvanced 条件之外
    const afterReset = body.slice(body.indexOf('if (options.resetAdvanced)'));
    const outside = afterReset.replace(/if \(options\.resetAdvanced\) \{[\s\S]*?\n  \}/, '');
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
    expect(html).toContain('setup-wait-defer');
    expect(renderer).toContain("chooseEmbeddingRebuild('defer')");
    expect(source).toContain('waitEmbeddingRebuildChoice');
  });

  test('historical ZeroEntropy misconfiguration uses a verified zero-rebuild recovery path', () => {
    expect(renderer).toContain('legacyEmbeddingRecoveryCandidate');
    expect(renderer).toContain('confirmLegacyEmbeddingRecovery = true');
    expect(renderer).toContain('不会清空或重新生成已有向量');
    expect(source).toContain('payload.confirmLegacyEmbeddingRecovery === true');
    expect(source).toContain("'models', 'restore-legacy-embedding-config', '--json'");
    expect(source).toContain('saved.embeddingModelChanged && !legacyEmbeddingRecoveryConfirmed');
  });
});
