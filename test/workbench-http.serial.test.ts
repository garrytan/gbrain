import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { chat, configureGateway, resetGateway } from '../src/core/ai/gateway';
import { knowledgeWorkbenchAnswer, registerWorkbenchRoutes } from '../src/product/workbench/routes';

test('流式备用模型切换清除失败片段，再开始第二份回答', async () => {
  const server = Bun.serve({ port: 0, async fetch(req) {
    const input = await req.json() as any;
    const first = input.model === 'first';
    const payload = { id: 'stream', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content: first ? '失败片段' : '有效回答' }, finish_reason: first ? 'content_filter' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    configureGateway({ generative_enabled: true, chat_model: 'service-review:first', chat_fallback_chain: ['service-review:second'], env: {}, base_urls: { 'service-review': `${server.url}v1` } });
    let visible = ''; const resets: string[] = [];
    const result = await chat({ messages: [{ role: 'user', content: '问题' }], onTextDelta: delta => { visible += delta; }, onTextReset: model => { visible = ''; resets.push(model); } });
    expect(visible).toBe('有效回答'); expect(result.text).toBe(visible); expect(resets).toEqual(['service-review:second']);
    let withoutReset = '';
    const stopped = await chat({ messages: [{ role: 'user', content: '问题' }], onTextDelta: delta => { withoutReset += delta; } });
    expect(withoutReset).toBe('失败片段'); expect(stopped.model).toBe('service-review:first');
  } finally { resetGateway(); server.stop(true); }
});

test('knowledge evidence reads the exact Source and preserves all conversation turns', async () => {
  const reads: unknown[] = []; let sent: any;
  const answer = knowledgeWorkbenchAnswer({ getPage: async (slug: string, opts: unknown) => { reads.push([slug, opts]); return { compiled_truth: '项目正式预算为十万元', timeline: '' }; } } as any, {
    search: async () => ({ results: [{ source_id: 'source-a', slug: 'project', title: '项目资料', snippet: '预算' }] } as any),
    answer: async input => { sent = input; return { text: '十万元 [1]', model: input.model } as any; },
  });
  const result = await answer({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '预算是多少', status: 'complete', createdAt: '' }] });
  expect(reads).toEqual([['project', { sourceId: 'source-a' }]]);
  expect(sent.system).toContain('十万元'); expect(sent.messages[0].content).toBe('预算是多少');
  expect(result.citations[0].sourceId).toBe('source-a');
});
test('HTTP workbench sends two real gateway requests with history and persists the answer', async () => {
  const requests: any[] = [];
  const modelServer = Bun.serve({ port: 0, async fetch(req) {
    const input = await req.json() as any; requests.push(input);
    const payload = { id: 'test', object: input.stream ? 'chat.completion.chunk' : 'chat.completion', created: 1, model: 'local', choices: [{ index: 0, ...(input.stream ? { delta: { role: 'assistant', content: '你喜欢蓝色' } } : { message: { role: 'assistant', content: '你喜欢蓝色' } }), finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } };
    if (input.stream) return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(payload);
  } });
  const app = express();
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), {} as any, { engine: 'pglite', chat_model: 'service-test:local' } as any, { storageRoot: mkdtempSync(join(tmpdir(), 'pmbrain-http-test-')) });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json() as Promise<any>;
  };
  try {
    configureGateway({ generative_enabled: true, chat_model: 'service-test:local', env: {}, base_urls: { 'service-test': `${modelServer.url}v1` } });
    const thread = await request('/conversations', { knowledge: false });
    let result: any;
    for (const text of ['我喜欢蓝色', '我喜欢什么颜色？']) {
      await request(`/conversations/${thread.id}/messages`, { text, knowledge: false });
      for (let i = 0; i < 100; i++) { result = await request(`/conversations/${thread.id}`); if (result.messages.at(-1).status !== 'running') break; await Bun.sleep(10); }
      expect(result.messages.at(-1).status).toBe('complete');
    }
    expect(requests).toHaveLength(2);
    expect(requests.every((item: any) => item.stream === true)).toBe(true);
    expect(requests[1].messages.filter((m: any) => m.role !== 'system').map((m: any) => m.content)).toEqual(['我喜欢蓝色', '你喜欢蓝色', '我喜欢什么颜色？']);
    expect(result.messages.at(-1).text).toBe('你喜欢蓝色');
    expect(result.messages.at(-1).modelName).toBe('service-test:local · 当前普通模型');
    expect(result.messages.at(-1).knowledge).toBe('off');
    expect((await fetch(`${base}/conversations/${thread.id}?emptyOnly=true`, { method: 'DELETE' })).status).toBe(400);
    expect((await request(`/conversations/${thread.id}`)).messages).toHaveLength(4);
    const empty = await request('/conversations', { knowledge: false });
    expect((await fetch(`${base}/conversations/${empty.id}?emptyOnly=true`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/conversations/${empty.id}`)).status).toBe(400);
  } finally { resetGateway(); modelServer.stop(true); server.close(); }
});
