import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { runAdminKnowledgeSearch } from '../src/commands/admin-knowledge-search';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-agent-runtime-'));
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const postgresUrl = process.env.PMBRAIN_AGENT_TEST_DATABASE_URL;
if (postgresUrl) assertSafeE2eDatabaseUrl(postgresUrl);
let engine: BrainEngine, runtime: ProductTaskRuntime, server: ReturnType<express.Express['listen']>, base: string, modelServer: ReturnType<typeof Bun.serve>;
let coordinator: NonNullable<ReturnType<typeof registerWorkbenchRoutes>['coordinator']>;
let slow = false, requested = false;
let agent: any;
const directory = join(root, 'materials'); const path = join(directory, 'week.md');
const work = '2026-10-14：完成需求评审。下周计划上线。';
const config = { engine: 'pglite', chat_model: 'service-agent-runtime:chat' } as any;
async function open() {
  runtime = new ProductTaskRuntime(engine); await runtime.start(); const app = express();
  const registration = registerWorkbenchRoutes(app, (req, res, next) => { if (req.get('x-owner') !== 'fixture') { res.status(401).end(); return; } next(); }, engine, config, { storageRoot: join(root, 'sessions'), productTasks: runtime, readConfig: () => config });
  coordinator = registration.coordinator!;
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
}
async function request(path: string, body?: unknown, method?: string) {
  const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'x-owner': 'fixture' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result: any = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
async function finished(id: string) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const run = await runtime.getRun(id); if (run && !['running', 'queued'].includes(run.status)) return run; await Bun.sleep(40); }
  throw new Error(JSON.stringify(await runtime.getRun(id)));
}
beforeAll(async () => {
  for (const key of keys) delete process.env[key]; process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain')); mkdirSync(directory); writeFileSync(path, work);
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite', model_usage: { generative_enabled: false, embedding_enabled: false } }));
  engine = postgresUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine; await engine.connect(postgresUrl ? { database_url: postgresUrl } : {}); await engine.initSchema();
  if (postgresUrl) await engine.executeRaw("DELETE FROM minion_jobs WHERE queue='pmbrain-product'");
  if (postgresUrl) config.engine = 'postgres';
  modelServer = Bun.serve({ port: 0, async fetch(req) {
    const input: any = await req.json(); requested = true;
    if (slow) { while (!req.signal.aborted && slow) await Bun.sleep(30); }
    const observations = input.messages.flatMap((message: any) => message.role === 'tool' ? [String(message.content)] : []);
    const create = input.messages.some((message: any) => message.role === 'user' && String(message.content).includes('创建周报助手'));
    const delegate = input.messages.some((message: any) => message.role === 'user' && String(message.content).includes('交给周报助手'));
    const last = observations.at(-1) ?? '';
    const tool = delegate ? !observations.length ? { name: 'task_submit', arguments: { assistantId: agent.id, prompt: '读取工作记录，写周报并保存 Word' } } : undefined : create && !observations.length ? { name: 'assistant_create', arguments: { name: '周报助手', systemPrompt: '只写有依据的工作', workflow: '读取工作记录，按完成和推进中写周报', readDirectories: [path.slice(0, path.lastIndexOf(process.platform === 'win32' ? '\\' : '/'))], skills: ['weekly-report'], sourceIds: ['default'] } } : !create && !observations.some((text: string) => text.includes(work)) ? { name: 'local_read', arguments: { path } } : !create && !observations.some((text: string) => text.includes('"saved":true')) ? { name: 'artifact_save', arguments: { title: '周报', content: '# 已完成\n完成需求评审 [1]\n# 下周计划\n计划上线 [1]' } } : undefined;
    const delta = tool ? { tool_calls: [{ index: 0, id: `tool-${observations.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: delegate ? '任务已提交，请到任务对话查看进展。' : create ? '周报助手已经创建。' : '周报文件已经保存。' };
    const payload = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'chat', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  configureGateway({ generative_enabled: true, chat_model: config.chat_model, env: {}, base_urls: { 'service-agent-runtime': modelServer.url.origin + '/v1' } });
  await open();
}, 60000);
afterAll(async () => { slow = false; if (server) await new Promise<void>(resolve => server.close(() => resolve())); await runtime?.close(); await engine?.disconnect(); modelServer?.stop(true); resetGateway(); for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }, 60000);

test('authenticated conversation creation configures rules, skill and file access, then survives reopening', async () => {
  const conversation = await request('/conversations', { knowledge: false });
  await request(`/conversations/${conversation.id}/messages`, { text: `创建周报助手，读取 ${directory}，只写有依据的工作`, knowledge: false });
  for (let count = 0; count < 200; count++) { const value = await request(`/conversations/${conversation.id}`); if (value.messages.at(-1)?.status !== 'running') break; await Bun.sleep(30); }
  agent = (await request('/agents')).agents.find((row: any) => row.name === '周报助手');
  expect(agent.skills).toEqual(['weekly-report']); expect(agent.readDirectories).toEqual([directory]);
  expect((await fetch(base + '/agents')).status).toBe(401);
  await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); await open();
  expect((await request('/agents')).agents.find((row: any) => row.id === agent.id).workflow).toContain('读取');
}, 60000);

test('persistent delegated task delivers a docx and preserves its source file', async () => {
  const submitted = await request(`/agents/${agent.id}/tasks`, { prompt: '读取工作记录，写周报并保存 Word', key: 'first-report' });
  const run = await finished(submitted.run.id); expect(run.status).toBe('completed'); expect((run.result as any)?.artifacts).toHaveLength(1);
  const artifactId = ((run.result as any).artifacts as any[])[0].id;
  const download = await request(`/artifacts/${artifactId}?download=1`); expect(Buffer.from(download.data, 'base64').subarray(0, 2).toString()).toBe('PK');
  expect(readFileSync(path, 'utf8')).toBe(work);
  const again = await request(`/agents/${agent.id}/tasks`, { prompt: '读取工作记录，写周报并保存 Word', key: 'first-report' });
  expect(again.run.id).toBe(run.id); expect(again.conversationId).toBe(submitted.conversationId); expect((await request('/artifacts')).artifacts).toHaveLength(1);
}, 60000);

test('weekly schedule persists across restart and one occurrence submits only one task', async () => {
  const fresh = (await request('/agents')).agents.find((row: any) => row.id === agent.id);
  const next = await request(`/agents/${agent.id}`, { ...fresh, schedule: { enabled: true, weekdays: [5], time: '17:00', timezone: 'Asia/Shanghai', prompt: '生成本周周报并保存 Word' } }, 'PUT');
  await coordinator.scan(new Date('2026-10-16T09:01:00Z')); await coordinator.scan(new Date('2026-10-16T09:02:00Z'));
  const runs = (await runtime.listRuns()).filter(run => run.kind === 'assistant_task' && run.trigger === 'scheduled'); expect(runs).toHaveLength(1);
  expect((await finished(runs[0]!.id)).status).toBe('completed');
  await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); await open();
  await coordinator.scan(new Date('2026-10-16T09:03:00Z'));
  expect((await runtime.listRuns()).filter(run => run.kind === 'assistant_task' && run.trigger === 'scheduled')).toHaveLength(1);
  expect((await request('/agents')).agents.find((row: any) => row.id === next.id).schedule.timezone).toBe('Asia/Shanghai');
}, 60000);

test('a main assistant conversation hands work to a specialist and links its real task conversation', async () => {
  const conversation = await request('/conversations', { knowledge: false });
  await request(`/conversations/${conversation.id}/messages`, { text: '把写周报的任务交给周报助手', knowledge: false });
  let reply: any;
  for (let count = 0; count < 200; count++) { reply = (await request(`/conversations/${conversation.id}`)).messages.at(-1); if (reply.status !== 'running') break; await Bun.sleep(30); }
  const submitted = JSON.parse(reply.toolCalls.find((call: any) => call.name === 'task_submit' && call.status === 'complete').output);
  expect(submitted.submitted).toBe(true); expect(submitted.conversationId).not.toBe(conversation.id);
  expect((await request(`/conversations/${submitted.conversationId}`)).assistantId).toBe(agent.id);
  expect((await finished(submitted.runId)).status).toBe('completed');
}, 60000);

test('stopping an assistant task preserves its conversation and retry resumes the same task', async () => {
  slow = true; requested = false;
  const submitted = await request(`/agents/${agent.id}/tasks`, { prompt: '读取工作记录，写周报并保存 Word', key: 'cancel-report' });
  const deadline = Date.now() + 15000; while (!requested && Date.now() < deadline) await Bun.sleep(20); expect(requested).toBe(true);
  const stopped = await runtime.cancel(submitted.run.id); expect(stopped?.status).toBe('cancelled'); slow = false;
  const conversation = await request(`/conversations/${submitted.conversationId}`); expect(conversation.messages[0].text).toContain('工作记录');
  const retried = await runtime.retry(submitted.run.id); expect(retried?.id).toBe(submitted.run.id);
  expect((await finished(submitted.run.id)).status).toBe('completed'); expect(readFileSync(path, 'utf8')).toBe(work);
}, 60000);

test('native knowledge searches apply Source scope before selecting duplicate titles', async () => {
  await engine.executeRaw("INSERT INTO sources (id,name,config) VALUES ('agent-other','agent-other','{}'::jsonb) ON CONFLICT (id) DO NOTHING");
  await engine.putPage('agent-review', { type: 'project', title: 'Agent weekly review', compiled_truth: 'Completed weekly review', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('agent-review', { type: 'project', title: 'Agent private review', compiled_truth: 'Other private weekly review', frontmatter: {} }, { sourceId: 'agent-other' });
  await engine.upsertChunks('agent-review', [{ chunk_index: 0, chunk_text: 'Agent completed weekly review', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  await engine.upsertChunks('agent-review', [{ chunk_index: 0, chunk_text: 'Agent other private weekly review', chunk_source: 'compiled_truth' }], { sourceId: 'agent-other' });
  const found = await runAdminKnowledgeSearch(engine, { query: 'Agent', mode: 'keyword', sourceIds: ['default'] });
  expect(found.results.length).toBeGreaterThan(0); expect(found.results.every(row => row.source_id === 'default')).toBe(true);
  expect((await engine.getPage('agent-review', { sourceId: 'agent-other' }))?.compiled_truth).toBe('Other private weekly review');
}, 60000);
