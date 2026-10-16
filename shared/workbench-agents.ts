import type { KnowledgeAssistantSettings, WorkbenchCitation } from './workbench';

export interface WorkbenchSchedule {
  enabled: boolean;
  weekdays: number[];
  time: string;
  timezone: string;
  prompt: string;
}
export interface WorkbenchPlaybook {
  name: string;
  when: string;
  inputs: string;
  steps: string[];
  checks: string;
  output: string;
  approval: string;
  updatedAt: string;
}
export interface WorkbenchAgent extends KnowledgeAssistantSettings {
  id: string;
  revision: number;
  skills: string[];
  workflow: string;
  sourceIds: string[];
  readDirectories: string[];
  deliveryFormat: 'markdown' | 'docx';
  schedule?: WorkbenchSchedule;
  standingRules?: string[];
  retiredRules?: Array<{ text: string; replacedBy: string }>;
  playbook?: WorkbenchPlaybook | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkbenchArtifact {
  id: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  title: string;
  format: 'markdown' | 'docx';
  path: string;
  publishedPath?: string;
  content: string;
  citations: WorkbenchCitation[];
  createdAt: string;
  hash: string;
  familyId?: string;
  parentId?: string;
  revision?: number;
  baseHash?: string;
}
export function agentRoleLabel(id: string) {
  return id === 'main' ? '主助手' : '专用助手';
}
export function agentAvatar(input: { id: string; name: string; emoji: string }) {
  if (input.id !== 'main' && input.emoji === '知') return [...input.name][0] || input.emoji;
  return input.emoji;
}
export function rosterStatus(agentId: string, rows: Array<{ assistantId?: string; running?: boolean; activity?: string; updatedAt: string }>): string {
  const mine = rows.filter(row => (row.assistantId ?? 'main') === agentId);
  const active = mine.find(row => row.running && row.activity);
  if (active?.activity) return active.activity;
  return [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.activity ?? '';
}
export interface WorkbenchSkill {
  name: string;
  displayName?: string;
  description: string;
  supported: boolean;
  missingTools: string[];
}
