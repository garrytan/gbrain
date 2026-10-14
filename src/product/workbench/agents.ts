import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { atomicWriteFileSync } from '../../core/atomic-write';
import { defaultAssistant, normalizeAssistant } from '../../../shared/workbench';
import { isValidSourceId } from '../../core/source-id';
import type { WorkbenchAgent, WorkbenchArtifact, WorkbenchSchedule } from '../../../shared/workbench-agents';
import type { WorkbenchStore } from './store';

type AgentState = { agents: WorkbenchAgent[]; artifacts: WorkbenchArtifact[]; schedules: Record<string, { slot: string; conversationId: string; runId?: string }> };
const supportedTools = new Set(['search', 'query', 'get_page', 'knowledge_search', 'knowledge_read', 'memory_recall', 'local_files', 'local_read', 'artifact_save']);
export function compatibleSkill(detail: { frontmatter?: Record<string, unknown> }) {
  const tools = Array.isArray(detail.frontmatter?.tools) ? detail.frontmatter!.tools as string[] : [];
  const missingTools = tools.filter(tool => !supportedTools.has(tool));
  return { supported: !detail.frontmatter?.mutating && !detail.frontmatter?.writes_pages && !missingTools.length, missingTools };
}
function schedule(input: unknown): WorkbenchSchedule | undefined {
  if (input === undefined || input === null) return undefined;
  const value = input as WorkbenchSchedule;
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('请选择有效的执行日期');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('执行时间需为 HH:mm');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 8000) throw new Error('请填写定时任务要求');
  return { enabled: value.enabled !== false, weekdays: [...new Set(value.weekdays)], time: value.time, timezone: value.timezone, prompt: value.prompt.trim() };
}
function normalizeProfile(input: Record<string, unknown>, previous?: WorkbenchAgent): WorkbenchAgent {
  const sourceIds = input.sourceIds === undefined ? previous?.sourceIds ?? [String(input.memorySourceId ?? 'default')] : input.sourceIds;
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 30 || sourceIds.some(id => typeof id !== 'string' || !isValidSourceId(id))) throw new Error('请选择有效的知识来源');
  const base = normalizeAssistant({ ...defaultAssistant(), ...previous, ...input, memorySourceId: sourceIds[0] });
  const skills = input.skills ?? previous?.skills ?? [];
  if (!Array.isArray(skills) || skills.length > 12 || skills.some(name => typeof name !== 'string' || !name || name.replace(/^library__/, '').length > 128 || /[/\\]|\.\.|\0/.test(name))) throw new Error('技能名称无效');
  const workflow = String(input.workflow ?? previous?.workflow ?? '');
  if (workflow.length > 16000) throw new Error('工作步骤不超过 16000 个字符');
  const directories = input.readDirectories ?? previous?.readDirectories ?? [];
  if (!Array.isArray(directories) || directories.length > 20) throw new Error('资料目录无效');
  const readDirectories = directories.map(path => {
    if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new Error('资料目录需为存在的绝对目录');
    return realpathSync(path);
  });
  const deliveryFormat = input.deliveryFormat ?? previous?.deliveryFormat ?? 'docx';
  if (deliveryFormat !== 'docx' && deliveryFormat !== 'markdown') throw new Error('交付格式无效');
  const now = new Date().toISOString();
  return { ...base, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, sourceIds: [...new Set(sourceIds)], skills: [...new Set(skills)], workflow, readDirectories: [...new Set(readDirectories)], deliveryFormat, schedule: schedule(Object.hasOwn(input, 'schedule') ? input.schedule : previous?.schedule), createdAt: previous?.createdAt ?? now, updatedAt: now };
}
export class WorkbenchAgentStore {
  constructor(readonly workbench: WorkbenchStore) {}
  private read(): AgentState {
    const path = join(this.workbench.root, 'agents.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { agents: [], artifacts: [], schedules: {} };
  }
  private write(value: AgentState) {
    mkdirSync(this.workbench.root, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.workbench.root, 'agents.json'), JSON.stringify(value));
  }
  list(): WorkbenchAgent[] {
    const state = this.read();
    const main = state.agents.find(agent => agent.id === 'main');
    const legacy = this.workbench.assistant();
    return [{ ...(main ?? normalizeProfile({})), ...legacy, sourceIds: main?.sourceIds ?? [legacy.memorySourceId ?? 'default'], id: 'main', revision: main?.revision ?? 1, createdAt: main?.createdAt ?? new Date(0).toISOString() }, ...state.agents.filter(agent => agent.id !== 'main')];
  }
  get(id: string): WorkbenchAgent {
    const agent = this.list().find(item => item.id === id);
    if (!agent) throw new Error('助手不存在');
    return agent;
  }
  create(input: Record<string, unknown>): WorkbenchAgent {
    const state = this.read();
    if (state.agents.length >= 100) throw new Error('助手数量已达上限');
    const agent = normalizeProfile(input);
    if (this.list().some(row => row.name === agent.name)) throw new Error('已有同名助手，请修改现有助手或使用其他名称');
    state.agents.push(agent); this.write(state); return agent;
  }
  update(id: string, input: Record<string, unknown>): WorkbenchAgent {
    const state = this.read(); const previous = this.get(id);
    if (input.revision !== previous.revision) throw new Error('助手配置已改变，请重新读取后保存');
    const next = normalizeProfile(input, previous);
    if (this.list().some(row => row.id !== id && row.name === next.name)) throw new Error('已有同名助手');
    if (id === 'main') this.workbench.saveAssistant(next);
    state.agents = [...state.agents.filter(row => row.id !== id), next]; this.write(state); return next;
  }
  artifacts(): WorkbenchArtifact[] { return this.read().artifacts; }
  artifact(id: string): WorkbenchArtifact {
    const artifact = this.artifacts().find(row => row.id === id);
    if (!artifact) throw new Error('成果不存在'); return artifact;
  }
  recordArtifact(artifact: WorkbenchArtifact) {
    const state = this.read();
    if (!state.artifacts.some(row => row.id === artifact.id)) { state.artifacts.unshift(artifact); this.write(state); }
  }
  scheduled(id: string) { return this.read().schedules[id]; }
  recordSchedule(id: string, value: AgentState['schedules'][string]) { const state = this.read(); state.schedules[id] = value; this.write(state); }
}
function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
}
export function scheduleOccurrence(value: WorkbenchSchedule, now: Date, direction: 'previous' | 'next'): Date | undefined {
  const local = localParts(now, value.timezone); const [hour, minute] = value.time.split(':').map(Number);
  const base = Date.UTC(local.year!, local.month! - 1, local.day!);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(base + offset * 86400000 * (direction === 'previous' ? -1 : 1));
    if (!value.weekdays.includes(day.getUTCDay())) continue;
    const wall = day.getTime() + hour! * 3600000 + minute! * 60000;
    let candidate = wall;
    for (let pass = 0; pass < 3; pass++) { const parts = localParts(new Date(candidate), value.timezone); candidate += wall - Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!); }
    const actual = localParts(new Date(candidate), value.timezone);
    if (actual.hour !== hour || actual.minute !== minute) continue;
    if (direction === 'previous' ? candidate <= now.getTime() : candidate > now.getTime()) return new Date(candidate);
  }
}
