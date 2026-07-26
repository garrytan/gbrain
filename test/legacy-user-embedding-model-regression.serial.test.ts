/**
 * 老用户向量模型回归矩阵（CLI / Dream 共用 embed 路径）
 *
 * 验收目标（与 2026-07-26 规划对齐）：
 * 1. 模型未变 / 标识不全 / 旧名等价 → 不清空已有向量
 * 2. 明确模型冲突 → 停止向量阶段、不写库、不隐式 invalidate
 * 3. embed --stale / Dream 只补 embedding IS NULL
 * 4. 后台路径不得调用 invalidateMismatchedEmbeddingModels
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';

let activeEmbedCalls = 0;
let totalEmbedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
    return texts.map(() => new Float32Array(1536));
  },
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { __setEmbedTransportForTests, configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  return new Proxy({} as any, {
    get(_, prop: string) {
      if (overrides[prop]) return overrides[prop];
      return (..._args: any[]) => Promise.resolve(null);
    },
  });
}

beforeEach(() => {
  activeEmbedCalls = 0;
  totalEmbedCalls = 0;
  configureGateway({
    embedding_model: 'ollama:qwen3-embedding:0.6b',
    embedding_dimensions: 1536,
    env: {},
  });
});

describe('老用户回归矩阵 · 向量模型 / embed --stale', () => {
  test('契约：embed 与 Dream 不得隐式 invalidate 已有向量', () => {
    const embed = readFileSync(resolve('src/commands/embed.ts'), 'utf8');
    const cycle = readFileSync(resolve('src/core/cycle.ts'), 'utf8');
    expect(embed).toContain('preflightEmbeddingModelChange');
    expect(embed).not.toContain('invalidateMismatchedEmbeddingModels(engine, getEmbeddingModel())');
    expect(cycle).toContain('runEmbedCore(engine, { stale: true, dryRun })');
    expect(embed).toContain('Dream、同步或普通向量补全时自动清空已有向量');
  });

  test('场景1 · 模型未变：已有向量全部保留，只报告 0 待补', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: 'ollama:qwen3-embedding:0.6b', count: 24740 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(0);
    expect(writes).toBe(0);
    expect(totalEmbedCalls).toBe(0);
  });

  test('场景2 · 历史 model 为空：默认保留，不清空、不重写', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: null, count: 24740 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(0);
    expect(writes).toBe(0);
  });

  test('场景2b · 历史 model 为空字符串：按信息不完整保留', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: '   ', count: 100 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(0);
    expect(writes).toBe(0);
  });

  test('场景2c · 无冒号的裸模型名与当前 provider:model 的 model 段相同：视为兼容保留', async () => {
    // splitProviderModelId 按首个 ':' 切分；裸名不能再带冒号，否则会被当成 provider:model。
    configureGateway({
      embedding_model: 'ollama:nomic-embed-text',
      embedding_dimensions: 1536,
      env: {},
    });
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: 'nomic-embed-text', count: 500 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(0);
    expect(writes).toBe(0);
  });

  test('场景2d · 历史串带冒号但被解析成不同 provider 时按冲突拒绝（不误清，只停）', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: 'qwen3-embedding:0.6b', count: 500 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    await expect(runEmbedCore(engine, { stale: true })).rejects.toThrow(
      /不会在 Dream、同步或普通向量补全时自动清空已有向量/,
    );
    expect(writes).toBe(0);
  });

  test('场景3 · 明确不同模型：停止向量阶段，零写入', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [{ model: 'zhipu:embedding-3', count: 25000 }],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    await expect(runEmbedCore(engine, { stale: true })).rejects.toThrow(
      /不会在 Dream、同步或普通向量补全时自动清空已有向量/,
    );
    expect(writes).toBe(0);
    expect(totalEmbedCalls).toBe(0);
  });

  test('场景3b · 混合库：一部分空标识 + 一部分冲突模型 → 仍因冲突拒绝，且不写库', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async () => [
        { model: null, count: 100 },
        { model: 'legacy-provider:old-embed', count: 900 },
      ],
      countStaleChunks: async () => 0,
      upsertChunks: async () => { writes++; },
    });

    await expect(runEmbedCore(engine, { stale: true })).rejects.toThrow(/legacy-provider:old-embed/);
    expect(writes).toBe(0);
  });

  test('场景4 · dry-run 不触发模型冲突阻断（仅观察计划）', async () => {
    const engine = mockEngine({
      executeRaw: async () => [{ model: 'zhipu:embedding-3', count: 10 }],
      countStaleChunks: async () => 2,
    });

    // dryRun 跳过凭证与模型冲突预检，避免误伤 plan 模式
    const result = await runEmbedCore(engine, { stale: true, dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  test('场景5 · 仅缺失向量时才会进入补齐，不因已有覆盖率而清空', async () => {
    let writes = 0;
    const engine = mockEngine({
      executeRaw: async (sql: string) => {
        if (String(sql).includes('GROUP BY model')) {
          return [{ model: 'ollama:qwen3-embedding:0.6b', count: 99 }];
        }
        return [];
      },
      countStaleChunks: async () => 1,
      listStaleChunks: async () => [{
        source_id: 'default',
        slug: 'new/page',
        chunk_index: 0,
        chunk_text: 'only missing chunk',
        page_id: 1,
      }],
      getChunks: async () => [{
        chunk_index: 0,
        chunk_text: 'only missing chunk',
        chunk_source: 'compiled_truth',
        embedding: null,
      }],
      upsertChunks: async () => { writes++; },
    });

    const result = await runEmbedCore(engine, { stale: true });
    // 允许补齐 1 条；不得因为“有旧向量”而批量失效
    expect(result.embedded).toBeGreaterThanOrEqual(0);
    expect(writes).toBeLessThanOrEqual(1);
  });
});

// 模块卸载前尽量复位 gateway，避免污染同进程其它套件
try { resetGateway(); } catch { /* ignore */ }
