import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { defaultAssistant } from '../shared/workbench';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchAgentStore, compatibleSkill, scheduleOccurrence } from '../src/product/workbench/agents';
import { agentAvatar, agentRoleLabel } from '../shared/workbench-agents';
import { readLocalFile, listLocalFiles, saveWorkbenchArtifact, publishArtifactToSource, artifactFilename } from '../src/product/workbench/files';

const fixture = () => mkdtempSync(join(tmpdir(), 'pmbrain-agent-test-'));
test('legacy assistant and conversations remain available while specialist settings persist separately', () => {
  const root = fixture(); const legacy = new WorkbenchStore(root);
  legacy.saveAssistant({ ...defaultAssistant(), name: '我的知识助手', systemPrompt: '先说结论' });
  const store = new WorkbenchAgentStore(legacy);
  expect(store.get('main').name).toBe('我的知识助手');
  const agent = store.create({ name: '周报助手', systemPrompt: '只写有依据的工作', workflow: '查本周工作，分清完成与计划', skills: ['weekly-report'], sourceIds: ['work'] });
  expect(agent.emoji).toBe('周');
  expect(agentAvatar({ id: agent.id, name: agent.name, emoji: '知' })).toBe('周');
  expect(agentRoleLabel(agent.id)).toBe('专用助手');
  expect(agentRoleLabel('main')).toBe('主助手');
  expect(agentAvatar({ id: 'main', name: '知识库助手', emoji: '知' })).toBe('知');
  const reopened = new WorkbenchAgentStore(new WorkbenchStore(root));
  expect(reopened.get(agent.id).workflow).toContain('分清');
  expect(reopened.get(agent.id).skills).toEqual(['weekly-report']);
  expect(reopened.get(agent.id).memorySourceId).toBe('work');
  expect(legacy.assistant().systemPrompt).toBe('先说结论');
  expect(() => reopened.update(agent.id, { ...agent, revision: 0 })).toThrow('已改变');
});

test('skill compatibility exposes missing tools and rejects automatic brain writes', () => {
  expect(compatibleSkill({ frontmatter: { tools: ['search', 'get_page'], mutating: false } }).supported).toBe(true);
  expect(compatibleSkill({ frontmatter: { tools: ['shell'] } }).supported).toBe(false);
  expect(compatibleSkill({ frontmatter: { tools: ['put_page'], mutating: true } }).supported).toBe(false);
});

test('native Chinese skill names persist while path-shaped names are rejected', () => {
  const store = new WorkbenchAgentStore(new WorkbenchStore(fixture()));
  const agent = store.create({ name: '方案助手', skills: ['library__方案写作'] });
  expect(store.get(agent.id).skills).toEqual(['library__方案写作']);
  expect(() => store.create({ name: '越界助手', skills: ['library__../private'] })).toThrow('技能名称');
});

test('weekly schedules use the selected timezone and recover only the latest occurrence', () => {
  const schedule = { weekdays: [5], time: '17:00', timezone: 'Asia/Shanghai', prompt: '写本周周报', enabled: true };
  expect(scheduleOccurrence(schedule, new Date('2026-10-16T09:00:00Z'), 'previous')?.toISOString()).toBe('2026-10-16T09:00:00.000Z');
  expect(scheduleOccurrence(schedule, new Date('2026-10-16T08:59:00Z'), 'next')?.toISOString()).toBe('2026-10-16T09:00:00.000Z');
  expect(scheduleOccurrence(schedule, new Date('2026-10-18T10:00:00Z'), 'previous')?.toISOString()).toBe('2026-10-16T09:00:00.000Z');
});

test('local reads remain inside granted directories and do not modify source materials', async () => {
  const root = fixture(); const allowed = join(root, 'materials'); mkdirSync(allowed);
  const path = join(allowed, 'work.md'); writeFileSync(path, '2026-10-14：完成需求评审。');
  const secret = join(root, 'outside.md'); writeFileSync(secret, '未授权');
  const agent = new WorkbenchAgentStore(new WorkbenchStore(join(root, 'store'))).create({ name: '周报助手', readDirectories: [allowed] });
  expect((await listLocalFiles(agent)).files.map(row => row.path)).toContain(path);
  expect((await readLocalFile(agent, path, 0)).content).toContain('完成需求评审');
  await expect(readLocalFile(agent, secret, 0)).rejects.toThrow('授权');
  await expect(readLocalFile(agent, join(allowed, '..', 'outside.md'), 0)).rejects.toThrow('授权');
  if (process.platform !== 'win32') {
    symlinkSync(secret, join(allowed, 'escape.md'));
    await expect(readLocalFile(agent, join(allowed, 'escape.md'), 0)).rejects.toThrow('授权');
  }
  expect(readFileSync(path, 'utf8')).toBe('2026-10-14：完成需求评审。');
});

test('deliverables are real docx files, preserve citation provenance and are idempotent', async () => {
  const root = fixture(); const store = new WorkbenchAgentStore(new WorkbenchStore(root));
  const agent = store.create({ name: '周报助手', deliveryFormat: 'docx' });
  const citation = { sourceId: 'work', slug: 'projects/review', title: '评审记录', snippet: '完成需求评审' };
  const input = { agent, conversationId: '00000000-0000-4000-8000-000000000000', messageId: '00000000-0000-4000-8000-000000000001', title: '本周周报', content: '# 已完成\n完成需求评审 [1]', citations: [citation] };
  const first = await saveWorkbenchArtifact(store, input);
  const second = await saveWorkbenchArtifact(store, input);
  expect(first.id).toBe(second.id);
  expect(store.artifacts()).toHaveLength(1);
  const zip = await JSZip.loadAsync(readFileSync(first.path));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('完成需求评审'); expect(xml).toContain('work/projects/review');
  await expect(saveWorkbenchArtifact(store, { ...input, content: '错误引用 [9]' })).rejects.toThrow('引用');
});

test('周报成果写入主数据源本地目录，不覆盖已有不同文件，也不改原始资料', async () => {
  const root = fixture();
  const sourceDir = join(root, 'knowledge');
  mkdirSync(sourceDir);
  const original = join(sourceDir, '项目笔记.md');
  writeFileSync(original, '原始资料保持不动');
  const store = new WorkbenchAgentStore(new WorkbenchStore(join(root, 'store')));
  const agent = store.create({ name: '周报助手', deliveryFormat: 'markdown', sourceIds: ['default'] });
  const engine = {
    getConfig: async () => null,
    executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: sourceDir }] : [{ id: 'default' }],
  } as any;
  expect(artifactFilename('本周周报 (2026-10-12 至 2026-10-15)', 'docx')).toBe('本周周报 (2026-10-12 至 2026-10-15).docx');
  const artifact = await saveWorkbenchArtifact(store, {
    agent,
    conversationId: '00000000-0000-4000-8000-000000000010',
    messageId: '00000000-0000-4000-8000-000000000011',
    title: '本周周报',
    content: '已完成需求评审',
    citations: [],
  });
  const published = await publishArtifactToSource(engine, agent, artifact);
  expect(published).toEqual({ ok: true, path: join(sourceDir, '本周周报.md'), sourceId: 'default' });
  expect(readFileSync(join(sourceDir, '本周周报.md'), 'utf8')).toContain('已完成需求评审');
  expect(readFileSync(original, 'utf8')).toBe('原始资料保持不动');
  const again = await publishArtifactToSource(engine, agent, artifact);
  expect(again.ok && again.path).toBe(join(sourceDir, '本周周报.md'));
  writeFileSync(join(sourceDir, '冲突.md'), '人工改过的文件');
  const conflict = await saveWorkbenchArtifact(store, {
    agent,
    conversationId: '00000000-0000-4000-8000-000000000012',
    messageId: '00000000-0000-4000-8000-000000000013',
    title: '冲突',
    content: '新的周报正文',
    citations: [],
  });
  const renamed = await publishArtifactToSource(engine, agent, conflict);
  expect(renamed).toEqual({ ok: true, path: join(sourceDir, '冲突 (2).md'), sourceId: 'default' });
  expect(readFileSync(join(sourceDir, '冲突.md'), 'utf8')).toBe('人工改过的文件');
  const missing = {
    getConfig: async () => null,
    executeRaw: async () => [{ id: 'default' }],
  } as any;
  const skipped = await publishArtifactToSource(missing, agent, artifact);
  expect(skipped).toEqual({ ok: false, reason: '知识来源没有绑定可用的本地目录' });
});

test('local spreadsheet reads reuse the native parser and keep budget rows intact', async () => {
  const root = fixture(); const path = join(root, 'budget.xlsx');
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['工作', '预算'], ['需求评审', 1200]]), '本周'); XLSX.writeFile(book, path);
  const bytes = readFileSync(path); const agent = new WorkbenchAgentStore(new WorkbenchStore(join(root, 'store'))).create({ name: '方案助手', readDirectories: [root] });
  const result = await readLocalFile(agent, path); expect(result.content).toContain('需求评审'); expect(result.content).toContain('1200'); expect(readFileSync(path).equals(bytes)).toBe(true);
});
