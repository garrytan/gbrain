import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkbenchArtifact } from '../shared/workbench-agents';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { compileTaskBrief } from '../src/product/workbench/task-context';
import { listWorkbenchArtifacts, publishArtifactToSource, readWorkbenchArtifact, reviseWorkbenchArtifact, saveWorkbenchArtifact } from '../src/product/workbench/files';

const fixture = () => mkdtempSync(join(tmpdir(), 'pmbrain-artifact-revision-'));
const conversationId = '00000000-0000-4000-8000-000000000021';
const messageId = '00000000-0000-4000-8000-000000000022';
const original = '第一节 原样\n第二节 很长\n第三节 原样';
const shortened = '第一节 原样\n第二节 短\n第三节 原样';

function world() {
  const root = fixture();
  const sourceDir = join(root, 'knowledge');
  mkdirSync(sourceDir);
  const store = new WorkbenchAgentStore(new WorkbenchStore(join(root, 'store')));
  const agent = store.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: sourceDir }] : [{ id: 'default' }] } as never;
  return { root, sourceDir, store, agent, engine };
}

async function publish(engine: never, agent: ReturnType<WorkbenchAgentStore['create']>, store: WorkbenchAgentStore, artifact: WorkbenchArtifact) {
  const published = await publishArtifactToSource(engine, agent, artifact);
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error(published.reason);
  const saved = { ...artifact, publishedPath: published.path };
  store.recordArtifact(saved);
  return saved;
}

test('改第二节会另存新版本，旧版本和其他段落还在；外部改过的文件不会被覆盖', async () => {
  const { sourceDir, store, agent, engine } = world();
  const first = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: original, citations: [] });
  expect(first.familyId).toBe(first.id);
  expect(first.revision).toBe(1);
  const published = await publish(engine, agent, store, first);
  const oldBytes = readFileSync(published.path);
  const revised = await reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000023', baseArtifactId: first.id, baseHash: first.hash, title: '本周周报', content: shortened, citations: [] });
  const again = await reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000023', baseArtifactId: first.id, baseHash: first.hash, title: '本周周报', content: shortened, citations: [] });
  expect(again.id).toBe(revised.id);
  expect(store.artifacts().filter(item => item.parentId === first.id)).toHaveLength(1);
  expect(revised.familyId).toBe(first.id);
  expect(revised.revision).toBe(2);
  expect(revised.content).toBe(shortened);
  expect(store.artifact(first.id).content).toBe(original);
  expect(readFileSync(published.path).equals(oldBytes)).toBe(true);
  const second = await publish(engine, agent, store, revised);
  expect(second.publishedPath).toBe(join(sourceDir, '本周周报 (2).md'));
  expect(readFileSync(join(sourceDir, '本周周报.md'), 'utf8')).toContain('第二节 很长');
  expect(readFileSync(second.publishedPath!, 'utf8')).toContain('第二节 短');
  expect(readFileSync(second.publishedPath!, 'utf8')).toContain('第一节 原样');
  expect(readFileSync(second.publishedPath!, 'utf8')).toContain('第三节 原样');
  const privateBytes = readFileSync(revised.path);
  writeFileSync(second.publishedPath!, '外部改过的周报');
  await expect(reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000024', baseArtifactId: revised.id, baseHash: revised.hash, title: '本周周报', content: '第一节 原样\n第二节 更短\n第三节 原样', citations: [] })).rejects.toThrow('成果文件已被外部修改，未覆盖');
  expect(readFileSync(second.publishedPath!, 'utf8')).toBe('外部改过的周报');
  expect(readFileSync(revised.path).equals(privateBytes)).toBe(true);
  expect(store.artifacts().filter(item => item.familyId === first.id)).toHaveLength(2);
  const seen = readWorkbenchArtifact(store, { agentId: agent.id, conversationId, artifactId: revised.id });
  expect(seen.conflict).toBe(true);
  expect(seen.content).toContain('第二节 短');
});

test('旧成果没有版本字段时仍能读取；别的会话和其他旧版本不能拿来覆盖', async () => {
  const { store, agent } = world();
  const legacyPath = join(store.workbench.root, 'legacy.md');
  mkdirSync(store.workbench.root, { recursive: true });
  writeFileSync(legacyPath, '旧文件');
  const legacy: WorkbenchArtifact = { id: 'legacy-report', agentId: agent.id, conversationId, messageId, title: '旧周报', format: 'markdown', path: legacyPath, content: original, citations: [], createdAt: '2026-10-01T00:00:00.000Z', hash: 'ab'.repeat(32) };
  store.recordArtifact(legacy);
  const listed = listWorkbenchArtifacts(store, agent.id, conversationId);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.revision).toBe(1);
  expect(listed[0]?.familyId).toBe('legacy-report');
  expect(store.artifacts()[0]?.familyId).toBeUndefined();
  expect(readWorkbenchArtifact(store, { agentId: agent.id, conversationId, artifactId: 'legacy-report' }).content).toContain('第二节 很长');
  expect(() => readWorkbenchArtifact(store, { agentId: agent.id, conversationId: '00000000-0000-4000-8000-000000000099', artifactId: 'legacy-report' })).toThrow('成果不存在');
  const child = await reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000025', baseArtifactId: 'legacy-report', baseHash: legacy.hash, title: '旧周报', content: shortened, citations: [] });
  expect(child.revision).toBe(2);
  await expect(reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000026', baseArtifactId: 'legacy-report', baseHash: legacy.hash, title: '旧周报', content: '另一版', citations: [] })).rejects.toThrow('要改的不是最新一版');
  await expect(reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000027', baseArtifactId: child.id, baseHash: '不是这一版', title: '旧周报', content: '再改一版', citations: [] })).rejects.toThrow('内容已经变了');
  expect(store.artifact(child.id).content).toBe(shortened);
});

test('当前成果会跟着修改走；换任务后不再指向旧周报，另存新文件也不抢走它', async () => {
  const root = fixture();
  const sourceDir = join(root, 'knowledge');
  mkdirSync(sourceDir);
  const store = new WorkbenchStore(join(root, 'workbench'));
  const agents = new WorkbenchAgentStore(store);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'], systemPrompt: '你是周报助手' });
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: sourceDir }] : [{ id: 'default' }] } as never;
  let step = 0;
  let firstId = '';
  let revisedId = '';
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async input => {
    step += 1;
    if (step === 1) {
      const artifact = await publish(engine, agent, agents, await saveWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, title: '本周周报', content: original, citations: [] }));
      firstId = artifact.id;
    }
    if (step === 3) {
      const base = agents.artifact(input.task!.currentArtifactId!);
      const artifact = await publish(engine, agent, agents, await reviseWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, baseArtifactId: base.id, baseHash: base.hash, title: '本周周报', content: shortened, citations: [] }));
      revisedId = artifact.id;
    }
    if (step === 4) {
      await publish(engine, agent, agents, await saveWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, title: '附录', content: '这是另一份文件', citations: [] }));
    }
    return { text: '好', model: 'local', citations: [] };
  });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  const started = service.get(conversation.id);
  expect(started.task?.currentArtifactId).toBe(firstId);
  expect(started.messages.at(-1)?.artifacts?.[0]?.revision).toBeUndefined();
  service.send(conversation.id, { text: '这次不要写下周计划' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '第二节短一点，其他不动' });
  await service.settled(conversation.id);
  const edited = service.get(conversation.id);
  expect(edited.task?.id).toBe(started.task?.id);
  expect(edited.task?.constraints).toEqual(['这次不要写下周计划']);
  expect(edited.task?.currentArtifactId).toBe(revisedId);
  expect(edited.messages.at(-1)?.artifacts?.[0]?.revision).toBe(2);
  expect(agents.artifact(firstId).content).toBe(original);
  expect(agents.artifact(revisedId).content).toBe(shortened);
  service.send(conversation.id, { text: '再存一份附录' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).task?.currentArtifactId).toBe(revisedId);
  service.send(conversation.id, { text: '把输出换成 Markdown，接着写' });
  await service.settled(conversation.id);
  const formatted = service.get(conversation.id);
  expect(formatted.task?.id).toBe(started.task?.id);
  expect(formatted.task?.currentArtifactId).toBe(revisedId);
  expect(formatted.task?.constraints).toContain('这次不要写下周计划');
  expect(formatted.task?.constraints?.some(item => item.includes('换成 Markdown'))).toBe(true);
  service.send(conversation.id, { text: '不要继续了' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).task?.currentArtifactId).toBe(revisedId);
  service.send(conversation.id, { text: '这次改做报销，按费用类别整理' });
  await service.settled(conversation.id);
  const switched = service.get(conversation.id);
  expect(switched.task?.id).not.toBe(started.task?.id);
  expect(switched.task?.currentArtifactId).toBeUndefined();
  expect(switched.task?.goal).toContain('报销');
  expect(readWorkbenchArtifact(agents, { agentId: agent.id, conversationId: conversation.id, artifactId: firstId }).content).toBe(original);
  const fresh = service.create({ assistantId: agent.id, knowledge: false });
  service.send(fresh.id, { text: '可以' });
  await service.settled(fresh.id);
  expect(service.get(fresh.id).task).toBeUndefined();
});

test('任务简报会带上当前成果的编号和版本，模型请求里也能看到', async () => {
  const { store, agent } = world();
  const artifact = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: original, citations: [] });
  const task = { id: 'task-1', goal: '生成本周周报', constraints: ['这次不要写下周计划'], updatedAt: '2026-10-16T00:00:00.000Z', currentArtifactId: artifact.id };
  const brief = compileTaskBrief(task, false, { id: artifact.id, revision: 1, title: artifact.title, format: artifact.format, hash: artifact.hash });
  expect(brief).toContain(`当前成果：${artifact.id}`);
  expect(brief).toContain('第 1 版');
  expect(brief).toContain(artifact.hash);
  let system = '';
  const answer = knowledgeWorkbenchAnswer({} as never, { search: async () => { throw new Error('不应检索'); }, answer: async input => { system = input.system ?? ''; return { text: '好', model: 'm', stopReason: 'end' } as never; } }, undefined, { store, engine: {}, config: () => ({}) } as never);
  await answer({ agent, model: 'm', knowledge: false, conversationId, task, messages: [{ id: '1', role: 'user', text: '第二节短一点，其他不动', status: 'complete', createdAt: '' }], signal: new AbortController().signal, progress: () => {} });
  expect(system).toContain(`当前成果：${artifact.id}`);
  expect(system).toContain('第 1 版');
  expect(system).toContain('artifact_revise');
});
