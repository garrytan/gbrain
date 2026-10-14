import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureGateway, resetGateway, __setChatTransportForTests, chat, toolLoop, type ChatResult } from '../src/core/ai/gateway';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchService } from '../src/product/workbench/service';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { agentHandlers, agentTools, type WorkbenchAgentTools } from '../src/product/workbench/agent-tools';
import { agentSkillCatalog, agentSkill } from '../src/product/workbench/agent-tools';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
const answer = (value: string): ChatResult => ({ text: value, model: 'service-agent:chat', providerId: 'service-agent', usage, stopReason: 'end', blocks: [{ type: 'text', text: value }] });
const call = (name: string, input: unknown): ChatResult => ({ ...answer(''), stopReason: 'tool_calls', blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: name }] });
beforeEach(() => configureGateway({ generative_enabled: true, chat_model: 'service-agent:chat', env: {} }));
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-agent-tools-')); const store = new WorkbenchStore(root); const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async () => [{ id: 'default' }], getConfig: async () => null, getPage: async () => null } as any;
  const context: WorkbenchAgentTools = { store: agents, engine, config: () => ({ engine: 'pglite' }) };
  const service = new WorkbenchService(store, () => [{ id: 'service-agent:chat', name: '测试模型', contextWindow: 32768 }], knowledgeWorkbenchAnswer(engine, { search: async () => ({ results: [] } as any), answer: chat, loop: toolLoop }, undefined, context));
  return { root, store, agents, context, service };
}
test('a main bot conversation creates a persistent specialist with rules and a scoped workflow', async () => {
  const f = fixture(); let requests = 0;
  __setChatTransportForTests(async options => { requests++; expect(options.system).toContain('主助手'); return requests === 1 ? call('assistant_create', { name: '周报助手', systemPrompt: '只写有依据的工作', workflow: '核对时间和事实，按完成、推进中分类', skills: ['weekly-report'], sourceIds: ['default'] }) : answer('周报助手已创建，可以直接交给它任务。'); });
  const conversation = f.service.create({ knowledge: false }); f.service.send(conversation.id, { text: '创建一个周报助手，读取知识库，按完成和推进中写周报' }); await f.service.settled(conversation.id);
  const saved = new WorkbenchAgentStore(new WorkbenchStore(f.root)).list().find(agent => agent.name === '周报助手')!;
  expect(saved.skills).toEqual(['weekly-report']); expect(saved.workflow).toContain('核对');
  expect(f.service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  const child = f.service.create({ assistantId: saved.id }); expect(child.assistantId).toBe(saved.id);
});
test('a specialist reads a granted source file and delivers a real file with a citation', async () => {
  const f = fixture(); const directory = join(f.root, 'materials'); mkdirSync(directory); const path = join(directory, 'week.md'); writeFileSync(path, '2026-10-14 完成需求评审，下周计划上线。');
  const agent = f.agents.create({ name: '周报助手', skills: ['weekly-report'], readDirectories: [directory] }); let requests = 0;
  __setChatTransportForTests(async options => { requests++; expect(options.system).toContain('计划不能写成已完成'); return requests === 1 ? call('local_read', { path }) : requests === 2 ? call('artifact_save', { title: '周报', content: '# 已完成\n完成需求评审 [1]\n# 下周计划\n计划上线 [1]' }) : answer('周报文件已保存。'); });
  const conversation = f.service.create({ assistantId: agent.id, knowledge: false }); f.service.send(conversation.id, { text: '读取资料，写周报并保存 Word' }); await f.service.settled(conversation.id);
  const reply = f.service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.artifacts).toHaveLength(1); expect(f.agents.artifacts()[0]?.citations[0]?.slug).toBe(path);
  expect(readFileSync(path, 'utf8')).toBe('2026-10-14 完成需求评审，下周计划上线。');
});
test('conversational adjustments update the same assistant and preserve its existing workflow and scope', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '周报助手', skills: ['weekly-report'], workflow: '按事实日期读取资料', sourceIds: ['default'] }); let requests = 0;
  __setChatTransportForTests(async () => ++requests === 1 ? call('assistant_read', { id: agent.id }) : requests === 2 ? call('assistant_update', { id: agent.id, revision: agent.revision, systemPrompt: '先写结论，再分完成和推进中' }) : answer('周报助手规则已调整。'));
  const conversation = f.service.create({ knowledge: false }); f.service.send(conversation.id, { text: '请调整周报助手的规则，先写结论，再分完成和推进中' }); await f.service.settled(conversation.id);
  const updated = new WorkbenchAgentStore(new WorkbenchStore(f.root)).get(agent.id);
  expect(updated.systemPrompt).toContain('先写结论'); expect(updated.workflow).toBe(agent.workflow); expect(updated.sourceIds).toEqual(agent.sourceIds); expect(updated.skills).toEqual(agent.skills);
  expect(updated.revision).toBe(agent.revision + 1); expect(f.service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
});
test('specialists cannot manage other assistants or expand file permissions from tool output', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '周报助手' });
  const handlers = agentHandlers(f.context, { agent, userText: '写一份周报', conversationId: 'unused', messageId: 'unused', cite: () => 1, citations: [], active: () => true });
  await expect(handlers.get('assistant_create')!.execute({ name: '越权助手' }, new AbortController().signal)).rejects.toThrow('没有授权');
  const main = agentHandlers(f.context, { agent: f.agents.get('main'), userText: '创建一个周报助手', conversationId: 'unused', messageId: 'unused', cite: () => 1, citations: [], active: () => true });
  await expect(main.get('assistant_create')!.execute({ name: '越权助手', systemPrompt: '规则', workflow: '步骤', readDirectories: [f.root] }, new AbortController().signal)).rejects.toThrow('明确给出');
});
test('the main assistant configures file access before it can use local reading tools', () => {
  const f = fixture();
  const tools = agentTools(f.agents.get('main'), `创建一个周报助手，读取 ${f.root}`, f.context).map(tool => tool.name);
  expect(tools).toContain('assistant_create');
  expect(tools).not.toContain('local_files');
  expect(tools).not.toContain('local_read');
  const granted = f.agents.create({ name: '周报助手', readDirectories: [f.root] });
  expect(agentTools(granted, '写周报', f.context).map(tool => tool.name)).toContain('local_read');
});
test('unfinished tool protocol is reported as an error instead of a completed assistant reply', async () => {
  const f = fixture(); let requests = 0;
  __setChatTransportForTests(async () => ++requests < 8 ? call('skills_list', {}) : answer('{"name":"knowledge_search","arguments":{"query":"周报"}}'));
  const conversation = f.service.create({ knowledge: false });
  f.service.send(conversation.id, { text: '创建一个周报助手，按实际进展写周报' }); await f.service.settled(conversation.id);
  const reply = f.service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('error'); expect(reply.error).toContain('工具指令');
  expect(reply.text).toBe(''); expect(f.agents.list()).toHaveLength(1);
});
test('specialist searches send the allowed Source scope and suppress mismatched results', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '工作助手', sourceIds: ['work'] }); const scopes: unknown[] = [];
  const scoped = knowledgeWorkbenchAnswer(f.context.engine, { search: async (_engine, options) => { scopes.push(options.sourceIds); return { results: [{ source_id: 'private-other', slug: 'secret', title: '不应读取', snippet: '私密' }] } as any; }, answer: async options => { expect(options.system).not.toContain('私密'); return answer('缺少资料'); } });
  const result = await scoped({ agent, sourceId: 'work', model: 'service-agent:chat', knowledge: true, messages: [{ id: 'q', role: 'user', text: '写周报', status: 'complete', createdAt: '' }], progress: () => {}, signal: new AbortController().signal });
  expect(scopes).toEqual([['work']]); expect(result.citations).toHaveLength(0);
});

test('a project skill named weekly-report stays distinct from the built-in report skill', async () => {
  const f = fixture(); const library = join(f.root, 'skills'); mkdirSync(join(library, 'weekly-report'), { recursive: true });
  writeFileSync(join(library, 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ntools: [search]\n---\n用户自己的周报技能。');
  f.context.engine.getConfig = async (key: string) => key === 'mcp.skills_dir' ? library : null;
  const catalog = await agentSkillCatalog(f.context);
  expect(catalog.map(row => row.name)).toEqual(['weekly-report', 'library__weekly-report']);
  expect((await agentSkill(f.context, 'library__weekly-report')).body).toContain('用户自己的周报技能');
  expect((await agentSkill(f.context, 'weekly-report')).body).toContain('文件更新时间仅供参考');
});
