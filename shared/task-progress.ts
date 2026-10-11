export interface SyncFileDetails {
  rows: Array<{ id: number; sourceId: string; path: string; status: 'completed' | 'failed' | 'running' | 'pending'; error: string | null; activity?: SyncFileActivity }>;
  next: number | null;
  updatedAt?: string;
}

export interface SyncFileActivity {
  id: number;
  sourceId: string;
  path: string;
  bytes: number;
  stage: string;
  operation?: string;
  operationStartedAt?: string;
  updatedAt: string;
  chunksTotal?: number;
  bodyWritten?: number;
  bodyCommitted?: boolean;
  bodyBatchesCompleted?: number;
  bodyBatchesTotal?: number;
  generated?: number;
  embedded?: number;
  reused?: number;
  pending?: number;
  batchesCompleted?: number;
  noEmbed?: boolean;
}

export interface TaskProductProgress {
  relations?: { total: number; available: boolean };
  gitResults?: Array<{ sourceId: string; committed: boolean; commit: string | null; files: string[]; pending: Array<{path: string; reason: string}>; error?: string }>;
  syncScan?: { scanned: number; unchanged: number; total?:number; path?:string; bytes?:number; updatedAt?:string; active?:boolean };
  syncFiles?: { total: number; completed: number; failed: number; remaining: number };
  activeFiles?: SyncFileActivity[];
  name: string;
  stage: string;
  percent: number | null;
  phasePercent: number | null;
  completedSteps: number;
  steps: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'; phases: string[] }>;
  processed: number | null;
  total: number | null;
  file: string | null;
  metrics: Array<{ label: string; value: number }>;
  errorReason: string | null;
  detail?: string | null;
  material?: { name: string; sourceId: string; directory: boolean; page?: { slug: string; title: string; type: string } };
  scope?: { name: string; index: number; total: number };
}

export function taskName(kind: string): string {
  if (kind === 'import_path') return '导入资料';
  if (kind.includes('quick')) return '快速维护';
  if (kind.includes('meeting')) return '会议整理';
  if (kind === 'dream_propose_takes') return '观点提炼';
  if (['dream_full', 'dream_cycle'].includes(kind)) return 'AI 深度整理';
  if (kind.startsWith('dream_')) return '知识整理';
  if (kind === 'embed_stale') return '更新搜索索引';
  if (kind === 'sync_all') return '同步资料';
  return ({ doctor_check: '检查知识库', show_stats: '读取知识库状态', source_add: '添加知识源', export_markdown: '导出知识' } as Record<string, string>)[kind] ?? '后台任务';
}
export type TaskRelation = {
  id: number; fromId: number; toId: number; fromSourceId: string; toSourceId: string;
  fromSlug: string; toSlug: string; fromTitle: string; toTitle: string;
  type: string; producer: string | null; context: string; phase: string; present: boolean;
};
export type TaskRelations = { total: number; available: boolean; rows: TaskRelation[]; next: number | null };
