export type ConsoleIntent =
  | 'capture_memory'
  | 'search_brain'
  | 'import_path'
  | 'sync_source'
  | 'sync_all'
  | 'embed_stale'
  | 'show_sources'
  | 'show_stats'
  | 'show_config'
  | 'doctor_check';

export interface IntentPreview {
  previewId: string;
  intent: ConsoleIntent;
  confidence: number;
  slots: Record<string, unknown>;
  proposedAction: string;
  riskLevel: 'read' | 'write' | 'maintenance';
  requiresConfirmation: boolean;
  clarification?: string;
}

export interface ConsoleRun {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /** Bounded structured command result, kept separately from truncated logs. */
  result?: unknown;
}

export const INTENTS = new Set<ConsoleIntent>([
  'capture_memory',
  'search_brain',
  'import_path',
  'sync_source',
  'sync_all',
  'embed_stale',
  'show_sources',
  'show_stats',
  'show_config',
  'doctor_check',
]);

export const INTENT_SLOT_KEYS = new Set([
  'content',
  'query',
  'path',
  'pathType',
  'includeOffice',
  'includeImages',
  'sourceId',
]);

// Keep this aligned with the character counter in admin/src/pages/Console.tsx.
// Natural-language capture is ultimately forwarded as a Windows process argument,
// so leave sufficient room below the CreateProcess command-line limit.
export const MAX_NATURAL_TASK_CHARACTERS = 10_000;
