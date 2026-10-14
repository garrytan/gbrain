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
  content: string;
  citations: WorkbenchCitation[];
  createdAt: string;
  hash: string;
}
export interface WorkbenchSkill {
  name: string;
  displayName?: string;
  description: string;
  supported: boolean;
  missingTools: string[];
}
