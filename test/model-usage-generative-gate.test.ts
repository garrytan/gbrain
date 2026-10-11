/**
 * 产品经理可读的测试说明：
 * 1. 普通模型配置完成后即可使用；旧版 generative_enabled=false 不再阻断调用。
 * 2. full / meeting 和生成式阶段不再受已移除的界面开关影响。
 * 4. 阶段能力表覆盖全部 ALL_PHASES，并声明 requiresGenerativeModel。
 * 5. Admin / 服务层路由包含生成式开关 API。
 * 6. 知识整理页把模式命名为快速维护 / AI 深度整理 / AI 会议整理。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PHASES } from '../src/core/cycle.ts';
import {
  assertDreamPresetAllowGenerative,
  assertPhasesAllowGenerative,
  getPhaseCapabilities,
  isGenerativeModelEnabled,
  phaseRequiresGenerativeModel,
} from '../src/core/model-usage.ts';

const ROOT = join(import.meta.dir, '..');

describe('普通模型默认可用', () => {
  test('缺少配置字段或保留旧版关闭字段时都默认开启', () => {
    expect(isGenerativeModelEnabled(null)).toBe(true);
    expect(isGenerativeModelEnabled({ engine: 'pglite', chat_model: 'deepseek:deepseek-chat' } as any)).toBe(true);
    expect(isGenerativeModelEnabled({
      engine: 'pglite',
      chat_model: 'deepseek:deepseek-chat',
      model_usage: { generative_enabled: false },
    } as any)).toBe(true);
    expect(isGenerativeModelEnabled({
      engine: 'pglite',
      chat_model: 'deepseek:deepseek-chat',
      model_usage: { generative_enabled: true },
    } as any)).toBe(true);
  });

  test('旧版关闭字段不再阻断 full/meeting/quick', () => {
    const closed = { engine: 'pglite' as const, model_usage: { generative_enabled: false } };
    expect(() => assertDreamPresetAllowGenerative('quick', closed)).not.toThrow();
    expect(() => assertDreamPresetAllowGenerative('full', closed)).not.toThrow();
    expect(() => assertDreamPresetAllowGenerative('meeting', closed)).not.toThrow();
  });

  test('旧版关闭字段不再阻断生成式或本地阶段', () => {
    const closed = { engine: 'pglite' as const, model_usage: { generative_enabled: false } };
    expect(() => assertPhasesAllowGenerative(['lint', 'embed', 'sync'], closed)).not.toThrow();
    expect(() => assertPhasesAllowGenerative(['synthesize'], closed)).not.toThrow();
    expect(() => assertPhasesAllowGenerative(['propose_takes', 'embed'], closed)).not.toThrow();
  });

  test('阶段能力表覆盖全部 Dream 阶段', () => {
    const caps = getPhaseCapabilities();
    expect(caps.map(c => c.id).sort()).toEqual([...ALL_PHASES].sort());
    expect(phaseRequiresGenerativeModel('lint')).toBe(false);
    expect(phaseRequiresGenerativeModel('embed')).toBe(false);
    expect(phaseRequiresGenerativeModel('extract')).toBe(false);
    expect(phaseRequiresGenerativeModel('extract_facts')).toBe(false);
    expect(phaseRequiresGenerativeModel('synthesize')).toBe(true);
    expect(phaseRequiresGenerativeModel('patterns')).toBe(true);
    expect(phaseRequiresGenerativeModel('propose_takes')).toBe(true);
    expect(phaseRequiresGenerativeModel('grade_takes')).toBe(true);
    expect(phaseRequiresGenerativeModel('extract_atoms')).toBe(true);
    expect(phaseRequiresGenerativeModel('drift')).toBe(true);
    expect(phaseRequiresGenerativeModel('capture_entities')).toBe(true);
    expect(phaseRequiresGenerativeModel('enrich_thin')).toBe(true);
    expect(phaseRequiresGenerativeModel('schema-suggest')).toBe(false);
    expect(phaseRequiresGenerativeModel('consolidate')).toBe(false);
  });

  test('服务端保留兼容 API，设置页移除普通模型开关', () => {
    const serve = readFileSync(join(ROOT, 'src/commands/pmbrain-admin-routes.ts'), 'utf8');
    const dreamUi = readFileSync(join(ROOT, 'admin/src/pages/Dream.tsx'), 'utf8');
    const settingsUi = readFileSync(join(ROOT, 'admin/src/pages/Settings.tsx'), 'utf8');
    const gateway = readFileSync(join(ROOT, 'src/core/ai/gateway.ts'), 'utf8');
    const dreamCli = readFileSync(join(ROOT, 'src/commands/dream.ts'), 'utf8');
    expect(serve).toContain("app.get('/admin/api/model-usage/generative'");
    expect(serve).toContain("app.post('/admin/api/model-usage/generative'");
    expect(serve).toContain('getAdminDreamOverview(engine, loadConfig() ?? config, VERSION)');
    expect(serve).toContain('cancelRun');
    expect(gateway).toContain('assertGenerativeModelEnabled');
    expect(dreamCli).toContain('assertDreamPresetAllowGenerative');
    expect(settingsUi).not.toContain('普通模型调用');
    expect(settingsUi).not.toContain('允许 PMBrain 调用普通模型');
    expect(settingsUi).not.toContain('新用户默认关闭');
    expect(settingsUi).not.toContain('即使已配置普通模型，也需主动打开');
    expect(settingsUi).not.toContain('「发送」的 AI 意图识别与综合回答需要普通模型');
    expect(dreamUi).toContain('AI 深度整理');
    expect(dreamUi).toContain('AI 会议整理');
    expect(dreamUi).toContain('快速维护');
    expect(dreamUi).toContain('不使用普通模型');
    expect(dreamUi).toContain('按 Phase 精细控制');
    expect(dreamUi).toContain('GENERATIVE_DISABLED_HINT');
  });

  test('深度整理默认同步 Office/PDF/Excel', () => {
    const dreamCli = readFileSync(join(ROOT, 'src/commands/dream.ts'), 'utf8');
    expect(dreamCli).toContain('includeOffice: true');
  });

  test('定时任务仍只使用 quick 预设', () => {
    const serve = readFileSync(join(ROOT, 'src/commands/pmbrain-admin-routes.ts'), 'utf8');
    expect(serve).toContain("preset: 'quick'");
    expect(serve).not.toMatch(/checkScheduledDream[\s\S]{0,800}preset:\s*'full'/);
  });
});
