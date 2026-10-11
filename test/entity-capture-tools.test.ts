import { expect, test } from 'bun:test';
import { boundedEntityCaptureTools, captureDiscoveryInput, captureDiscoveryOutput } from '../src/core/cycle/entity-capture-tools.ts';
import type { ToolCtx, ToolDef } from '../src/core/minions/types.ts';

test('实体查重只取少量候选，保留 Source 和分页条件', () => {
  expect(captureDiscoveryInput('search', { query: '张三', source: 'vault', limit: 100, offset: 5 }))
    .toEqual({ query: '张三', source: 'vault', limit: 5, offset: 5 });
  expect(captureDiscoveryInput('list_pages', { offset: 20 })).toEqual({ offset: 20, limit: 20 });
});

test('搜索和目录不把整篇正文塞进每一轮上下文，仍保留身份和摘要', () => {
  const body = '长篇中文资料'.repeat(20000);
  const rows = [{ slug: 'people/zhang', source_id: 'vault', title: '张三', type: 'person', chunk_text: body }];
  const output = captureDiscoveryOutput('search', rows) as Array<Record<string, unknown>>;
  expect(output[0]).toMatchObject({ slug: 'people/zhang', source_id: 'vault', title: '张三', type: 'person' });
  expect(String(output[0]?.excerpt).length).toBeLessThanOrEqual(700);
  expect(JSON.stringify(output).length).toBeLessThan(1500);
  expect(rows[0]?.chunk_text).toBe(body);
});

test('读取或写入已有实体时保留完整正文，避免摘要覆盖原页', () => {
  const page = { slug: 'people/zhang', compiled_truth: '原始正文'.repeat(20000) };
  expect(captureDiscoveryOutput('get_page', page)).toBe(page);
  expect(captureDiscoveryInput('put_page', page)).toBe(page);
});

test('实体工具实际执行保留调用上下文和 Source，查重有界且完整读页不变', async () => {
  const calls: Array<{ input: unknown; context: ToolCtx }> = [];
  const context = { engine: {}, jobId: 10, remote: true } as ToolCtx;
  const search: ToolDef = {
    name: 'brain_search', description: '搜索', input_schema: {}, idempotent: true,
    async execute(input, ctx) {
      calls.push({ input, context: ctx });
      return [{ slug: 'people/zhang', source_id: 'vault', chunk_text: '中文资料'.repeat(1000) }];
    },
  };
  const page: ToolDef = { ...search, name: 'get_page' };
  const tools = boundedEntityCaptureTools([search, page]);
  const results = await tools[0]!.execute({ query: '张三', source: 'vault', limit: 100 }, context) as Array<Record<string, unknown>>;
  expect(calls[0]?.input).toEqual({ query: '张三', source: 'vault', limit: 5 });
  expect(calls[0]?.context).toBe(context);
  expect(results[0]?.source_id).toBe('vault');
  expect(String(results[0]?.excerpt).length).toBe(700);
  expect(tools[1]).toBe(page);
});
