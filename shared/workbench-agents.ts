import type { KnowledgeAssistantSettings, WorkbenchCitation } from './workbench';

export interface WorkbenchSchedule {
  enabled: boolean;
  weekdays: number[];
  time: string;
  timezone: string;
  prompt: string;
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
}
export function agentRoleLabel(id: string) {
  return id === 'main' ? '主助手' : '专用助手';
}
export function agentAvatar(input: { id: string; name: string; emoji: string }) {
  if (input.id !== 'main' && input.emoji === '知') return [...input.name][0] || input.emoji;
  return input.emoji;
}
export interface WorkbenchSkill {
  name: string;
  displayName?: string;
  description: string;
  supported: boolean;
  missingTools: string[];
}
