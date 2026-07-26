/**
 * 老用户回归矩阵 · 桌面普通模型 / 高级模型 / 向量重建确认
 *
 * 分层说明（方案 A 后）：
 * A. 桌面「高级模型」任务层级 → models.tier.*
 * B. 桌面「高级模型」Dream 阶段 → models.propose_takes / grade_takes / calibration_profile
 * C. 普通模型保存不静默删除 A/B；仅 resetAdvanced=true 时整批清除
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readFileSync(resolve('src/main/index.ts'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const html = readFileSync(resolve('src/renderer/index.html'), 'utf8');
const advanced = readFileSync(resolve('src/main/advanced-model-config.ts'), 'utf8');
const configManager = readFileSync(resolve('src/main/config-manager.ts'), 'utf8');

function sliceSyncModelDefaults(): string {
  const start = main.indexOf('async function syncModelDefaultsToConfigFile');
  expect(start).toBeGreaterThan(-1);
  const end = main.indexOf('\nasync function ensureServiceReady', start);
  expect(end).toBeGreaterThan(start);
  return main.slice(start, end);
}

describe('老用户回归矩阵 · 桌面模型路由', () => {
  test('场景A · 普通模型保存默认不重置 models.tier.*（高级面板配置应保留）', () => {
    expect(renderer).toContain('resetAdvancedModelRouting: false');
    const body = sliceSyncModelDefaults();
    const resetBlock = body.match(/if \(opts\.resetAdvanced\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(resetBlock).toContain("['config', 'unset', '--pattern', 'models.tier.']");
    expect(resetBlock).toContain("['config', 'unset', '--pattern', 'models.dream.']");
    expect(advanced).toContain('models.tier.${tier}');
    expect(advanced).toContain('writeAdvancedModelConfig');
  });

  test('场景B · Dream 阶段覆盖属于高级模型：可配置且普通保存不静默删除', () => {
    const body = sliceSyncModelDefaults();
    const resetBlock = body.match(/if \(opts\.resetAdvanced\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(resetBlock).toContain('models.propose_takes');
    expect(resetBlock).toContain('models.grade_takes');
    expect(resetBlock).toContain('models.calibration_profile');
    const outside = body.replace(/if \(opts\.resetAdvanced\) \{[\s\S]*?\n  \}/, '');
    expect(outside).not.toContain("for (const key of ['models.propose_takes'");
    expect(html).toContain('Dream 阶段模型');
    expect(html).toContain('data-advanced-phase="propose_takes"');
    expect(renderer).toContain('advancedPhaseOverrides');
    expect(advanced).toContain("ADVANCED_MODEL_PHASES");
  });

  test('场景C · 只有显式 resetAdvanced 才清理 tier / dream / 阶段覆盖', () => {
    expect(main).toContain('resetAdvanced: payload.resetAdvancedModelRouting === true');
    const body = sliceSyncModelDefaults();
    expect(body).toMatch(/if \(opts\.resetAdvanced\) \{[\s\S]*models\.tier\.[\s\S]*models\.dream\./);
    expect(body).toMatch(/if \(opts\.resetAdvanced\) \{[\s\S]*models\.propose_takes/);
  });

  test('场景D · 向量模型真实变更必须二次确认，取消则主进程拒绝', () => {
    expect(renderer).toContain('confirmEmbeddingRebuild = true');
    expect(renderer).toContain('confirmEmbeddingRebuild,');
    expect(main).toContain('payload.confirmEmbeddingRebuild !== true');
    expect(main).toContain('必须在桌面端明确确认重新向量化后才能继续');
    expect(configManager).toContain('confirmEmbeddingRebuild?: boolean');
  });

  test('场景E · 普通启动/升级不得自动 align 或清空向量', () => {
    expect(main).not.toContain('reconcileConfiguredEmbeddingIndex');
    expect(main).toContain('Dream 不会自行触发模型迁移');
    expect(main).toMatch(/if \(saved\.embeddingModelChanged\) \{[\s\S]*'--force-reembed'/);
  });

  test('场景F · 读写同一份 config.json，不把 legacy CLI 配置另写到新路径', () => {
    expect(configManager).toContain('function desktopWriteConfigPath()');
    const writeFn = configManager.slice(
      configManager.indexOf('function desktopWriteConfigPath()'),
      configManager.indexOf('function stripJsonBom'),
    );
    expect(writeFn).toContain('return desktopConfigPath()');
    expect(writeFn).not.toContain('preferredConfigDirectory');
  });

  test('场景G · 高级模型配置有独立保存入口，阶段与层级一并读写', () => {
    expect(main).toContain('desktop:save-advanced-model-config');
    expect(main).toContain('desktop:get-advanced-model-config');
    expect(renderer).toContain('saveAdvancedModels');
    expect(renderer).toContain('values.phases');
    expect(advanced).toContain('phases?: Partial<Record<AdvancedModelPhase, string>>');
  });
});
