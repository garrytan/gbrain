import type { CyclePhase } from '../../core/cycle.ts';
import type { PhaseResult } from '../../core/cycle.ts';
import type { SyncFileOptions } from '../../core/sync-file-runtime.ts';

export interface SyncFileInput {
  path: string;
  relativePath: string;
  originalPath?: string;
  originalSize?: number;
  originalMtime?: number;
  hash: string;
  fingerprint: string;
  modelFingerprint: string;
  modelMayRun?: boolean;
  sourceRoot: string;
  options: SyncFileOptions;
  timeoutMs?: number;
}

export interface MaintenanceCheckpoint {
  captureRequests?: Record<string, string[]>;
  phases: Record<string, PhaseResult[]>;
  reports: Record<string, Record<string, unknown>>;
}

export interface ImportTaskInput {
  path: string;
  sourceId?: string;
  noEmbed?: boolean;
  includeOffice?: boolean;
  includeImages?: boolean;
  structuredDocuments?: boolean;
  documentOcr?: boolean;
  workers?: number;
  timeoutMs?: number;
  stagingDir?: string;
  resumeCheckpointId?: number;
  directory?: boolean;
}

export interface DreamTaskInput {
  slugs?: string[];
  checkpoint?: MaintenanceCheckpoint;
  preset?: 'quick' | 'full' | 'meeting';
  phase?: CyclePhase | 'all' | string;
  sourceId?: string;
  allSources?: boolean;
  maxPages?: number;
  drainProposals?: boolean;
  windowSeconds?: number;
  dryRun?: boolean;
  input?: string;
  date?: string;
  from?: string;
  to?: string;
  timeoutMs?: number;
}

export type ProductTask =
  | { type: 'sync-file'; input: SyncFileInput }
  | { type: 'sync'; input: { timeoutMs?: number } }
  | { type: 'import'; input: ImportTaskInput }
  | { type: 'dream'; input: DreamTaskInput }
  | { type: 'embed'; input: { catchUp?: boolean; forceReembed?: boolean; timeoutMs?: number } };

export type TaskWorkerMessage =
  | { type: 'deferred' }
  | { type: 'progress'; largeDocument?: import('../../core/document/trusted-large-document.ts').LargeDocumentProgress; syncScan?: import('../../../shared/task-progress.ts').TaskProductProgress['syncScan']; page?: { slug: string; title: string; type: string }; event?: { phase: string; file?: string; event?: string; done?: number; total?: number }; phases?: string[]; scope?: { name: string; index: number; total: number } }
  | { type: 'rpc'; id: number; method: string; args: unknown[]; scope?: number }
  | { type: 'log'; text: string }
  | { type: 'result'; result: Record<string, unknown> }
  | { type: 'error'; error: string; result?: Record<string, unknown> };
