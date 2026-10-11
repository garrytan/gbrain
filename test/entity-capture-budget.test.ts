/**
 * 产品经理能看懂的测试说明：
 * 实体回填先算费用和候选，再决定要不要把下一份资料交给模型。
 * 这里不连数据库。它确认金额公式、Ollama、缺用量、缺价格、候选数量和任务详情上的数字。
 */
import { expect, test } from 'bun:test';
import { TaskProgressAdapter, finishTaskProgress } from '../src/product/tasks/progress-adapter.ts';
import {
  captureBudgetStop,
  captureChunkCostCny,
  captureReportLine,
  captureServiceReady,
  deltaCaptureNeedles,
  parseEntityCaptureCostCapInput,
  rankCaptureCandidates,
  readEntityCaptureCostCap,
  readModelCnyPrices,
  selectReadyCaptureModel,
  usageFromJobResult,
} from '../src/core/cycle/entity-capture-budget.ts';

test('费用按真实用量和人民币单价计算，缺一项就不编造金额', () => {
  expect(captureChunkCostCny({
    usage: { present: true, input: 1_000_000, output: 500_000 },
    inputPriceCnyPerMillion: 2,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBe(6);
  expect(captureChunkCostCny({
    usage: { present: false, input: 0, output: 0 },
    inputPriceCnyPerMillion: 2,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBeNull();
  expect(captureChunkCostCny({
    usage: { present: true, input: 100, output: 100 },
    inputPriceCnyPerMillion: null,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBeNull();
  expect(captureChunkCostCny({
    usage: { present: true, input: 100, output: 100 },
    inputPriceCnyPerMillion: 99,
    outputPriceCnyPerMillion: 99,
    ollama: true,
  })).toBe(0);
  expect(readModelCnyPrices([
    { provider: 'deepseek', models: [{ id: 'deepseek-chat', inputPrice: 1, outputPrice: 2, inputPriceCny: 3, outputPriceCny: 4 }] },
  ], 'deepseek:deepseek-chat', 'deepseek')).toEqual({ input: 3, output: 4 });
});

test('未配置费用上限时默认 5 元，不限制和自定义金额可以识别', () => {
  expect(readEntityCaptureCostCap(null)).toBe(5);
  expect(readEntityCaptureCostCap('unlimited')).toBeNull();
  expect(readEntityCaptureCostCap('12.5')).toBe(12.5);
  expect(parseEntityCaptureCostCapInput('unlimited')).toBeNull();
  expect(parseEntityCaptureCostCapInput(20)).toBe(20);
  expect(parseEntityCaptureCostCapInput('0')).toBeUndefined();
  expect(usageFromJobResult({ tokens: { missing: true } }).present).toBe(false);
  expect(usageFromJobResult({ tokens: { in: 0, out: 0 } })).toEqual({ present: true, input: 0, output: 0 });
});

test('页数不是停止条件，费用和 Token 可以在长文中间停住', () => {
  expect(captureBudgetStop({
    inputTokens: 1, outputTokens: 1,
    maxInputTokens: 100, maxOutputTokens: 100, usageKnown: true, costCny: 0, costCapCny: 5,
  })).toBeNull();
  expect(captureBudgetStop({
    inputTokens: 10, outputTokens: 1,
    maxInputTokens: 10, maxOutputTokens: 100, usageKnown: false, costCny: null, costCapCny: 5,
  })).toBeNull();
  expect(captureBudgetStop({
    inputTokens: 10, outputTokens: 1,
    maxInputTokens: 10, maxOutputTokens: 100, usageKnown: true, costCny: null, costCapCny: 5,
  })).toBe('tokens');
  expect(captureBudgetStop({
    inputTokens: 1, outputTokens: 1,
    maxInputTokens: 100, maxOutputTokens: 100, usageKnown: true, costCny: 5, costCapCny: 5,
  })).toBe('cost');
});

test('识别实体单独选可用模型，显式不可用时不改去别的模型', () => {
  const services = [
    { provider: 'anthropic', enabled: false, apiKey: '', baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'mimo', enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.xiaomimimo.com/v1' },
  ];
  expect(captureServiceReady([], 'anthropic:claude-sonnet-4-6')).toEqual({ ready: true });
  expect(captureServiceReady(undefined, 'anthropic:claude-sonnet-4-6')).toEqual({ ready: true });
  expect(captureServiceReady(services, 'anthropic:claude-sonnet-4-6')).toEqual({ ready: false, reason: 'provider_disabled' });
  expect(captureServiceReady([
    { provider: 'anthropic', enabled: true, apiKey: '', baseUrl: 'https://api.anthropic.com/v1' },
  ], 'anthropic:claude-sonnet-4-6')).toEqual({ ready: false, reason: 'missing_key' });
  expect(captureServiceReady([
    { provider: 'ollama', enabled: true, apiKey: '', baseUrl: 'http://localhost:11434/v1' },
  ], 'ollama:qwen')).toEqual({ ready: true });
  expect(selectReadyCaptureModel({
    explicit: null,
    candidates: [
      { model: 'mimo:mimo-v2.6-flash', source: 'config: models.default' },
      { model: 'anthropic:claude-sonnet-4-6', source: 'config: models.dream.synthesize' },
    ],
    services,
  })).toEqual({ ok: true, model: 'mimo:mimo-v2.6-flash', source: 'config: models.default' });
  expect(selectReadyCaptureModel({
    explicit: { model: 'anthropic:claude-sonnet-4-6', source: 'config: models.dream.capture_entities' },
    candidates: [{ model: 'mimo:mimo-v2.6-flash', source: 'config: models.default' }],
    services: [
      { provider: 'anthropic', enabled: true, apiKey: ' ', baseUrl: 'https://api.anthropic.com/v1' },
      { provider: 'mimo', enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.xiaomimimo.com/v1' },
    ],
  })).toMatchObject({ ok: false, model: 'anthropic:claude-sonnet-4-6', reason: 'missing_key' });
  expect(deltaCaptureNeedles(
    [],
    [{ slug: 'people/liu', sourceId: 'vault', type: 'person', title: '刘慈欣', aliases: ['大刘'] }],
  ).map(item => item.needle)).toEqual(['刘慈欣', 'people/liu', '大刘']);
});

test('候选只取正文里相关的实体，不把全库塞进去', () => {
  const entities = [
    { slug: 'people/zhang-san', sourceId: 'vault', type: 'person', title: '张三', aliases: ['张老师'] },
    { slug: 'companies/xinghe', sourceId: 'vault', type: 'company', title: '星河公司', aliases: [] },
    { slug: 'concepts/system', sourceId: 'vault', type: 'concept', title: '系统', aliases: [] },
    { slug: 'people/other', sourceId: 'other', type: 'person', title: '李四', aliases: [] },
  ];
  const ranked = rankCaptureCandidates('张老师参加了评审。系统只是普通用词。', entities, { sourceId: 'vault' });
  expect(ranked.map(item => item.slug)).toEqual(['people/zhang-san', 'concepts/system']);
  expect(ranked[0]).toMatchObject({ type: 'person', title: '张三', aliases: ['张老师'] });
});

test('任务详情能看到页面、分块、Token、费用和剩余资料', () => {
  const view = new TaskProgressAdapter('dream_full').view;
  const next = finishTaskProgress(view, 'completed', {
    phases: [{
      phase: 'capture_entities',
      status: 'ok',
      details: {
        pages_processed: 2,
        chunks_processed: 3,
        input_tokens: 11,
        output_tokens: 4,
        cost_cny: 1.25,
        cost_cap_cny: 5,
        pages_remaining: 8,
        entities_written: 3,
        relations_created: 4,
        report_line: '使用模型 mimo:mimo-v2.6-flash。已处理 2 页，剩余 8 页。创建实体 3。新增关系 4。费用 1.25 元 / 5 元。停止原因：费用到上限。',
      },
    }],
  }, null);
  const metrics = next.metrics.map(metric => [metric.label, metric.value]);
  expect(metrics).toContainEqual(['已处理页面', 2]);
  expect(metrics).toContainEqual(['已处理分块', 3]);
  expect(metrics).toContainEqual(['输入 Token', 11]);
  expect(metrics).toContainEqual(['输出 Token', 4]);
  expect(metrics).toContainEqual(['当前费用', 1.25]);
  expect(metrics).toContainEqual(['费用上限', 5]);
  expect(metrics).toContainEqual(['剩余页面', 8]);
  expect(metrics).toContainEqual(['创建实体', 3]);
  expect(metrics).toContainEqual(['新增关系', 4]);
  expect(next.detail).toContain('停止原因：费用到上限');

  const failedAdapter = new TaskProgressAdapter('dream_full');
  failedAdapter.plan(['capture_entities']);
  const failed = finishTaskProgress(failedAdapter.view, 'completed', {
    phases: [{
      phase: 'capture_entities',
      status: 'fail',
      error: { message: '实体识别模型不可用' },
      details: {
        stop_reason: 'model_unavailable',
        report_line: captureReportLine({
          model: 'anthropic:claude-sonnet-4-6',
          pagesProcessed: 0,
          pagesRemaining: 4,
          entitiesCreated: 0,
          relationsCreated: 0,
          costCny: null,
          costCapCny: 5,
          ollama: false,
          stopReason: 'model_unavailable',
        }),
        pages_processed: 0,
        entities_written: 0,
        relations_created: 0,
        pages_remaining: 4,
      },
    }],
  }, null);
  expect(failed.errorReason).toBe('实体识别模型不可用');
  expect(failed.detail).toContain('使用模型 anthropic:claude-sonnet-4-6');
  expect(failed.steps.find(step => step.phases.includes('capture_entities'))?.status).toBe('failed');
  expect(failed.stage.startsWith('部分完成')).toBe(true);
});
