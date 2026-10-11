import type { ConsoleRun } from './shared';

const PHASE_LABELS: Record<string, string> = {
  lint: '页面检查',
  backlinks: '反向链接',
  sync: '内容同步',
  extract: '实体提取',
  extract_facts: '事实提取',
  extract_atoms: '原子知识提取',
  resolve_symbol_edges: '关系解析',
  synthesize: '知识综合',
  patterns: '模式识别',
  synthesize_concepts: '概念综合',
  recompute_emotional_weight: '权重计算',
  consolidate: '合并去重',
  propose_takes: '观点提炼',
  grade_takes: '观点评分',
  calibration_profile: '校准画像',
  conversation_facts_backfill: '事实回填',
  capture_entities: '识别实体',
  embed: '向量化',
  orphans: '孤立页检查',
  'schema-suggest': '结构建议',
  purge: '安全清理',
};

export interface DreamRunProgressView {
  phase: string;
  phaseLabel: string;
  done: number | null;
  total: number | null;
  pct: number | null;
  detail: string;
  heartbeat: string | null;
}

function rootPhase(raw: string): string | null {
  const withoutCycle = raw.startsWith('cycle.') ? raw.slice('cycle.'.length) : raw;
  const candidate = withoutCycle.split('.')[0] ?? '';
  const mapped = candidate === 'import' ? 'sync' : candidate;
  return mapped in PHASE_LABELS ? mapped : null;
}

function pageHeartbeat(note: string): string {
  const actual = note.match(/^(processing|done(?: \+\d+)?|failed|skipped fence|dry-run no-llm|budget exhausted)\s+(\d+)\/(\d+)\s+\(\d+%\)\s+(.+)$/i);
  if (actual) {
    const status = actual[1]!.startsWith('processing') ? '正在处理' : actual[1]!;
    return `第 ${actual[2]} / ${actual[3]} 页 · ${status} · ${actual[4]}`;
  }
  const compatible = note.match(/^page\s+(\d+)\/(\d+)\s+([^:]+):\s*(.+)$/i);
  if (compatible) {
    const status = compatible[3]!.startsWith('processing') ? '正在处理' : compatible[3]!;
    return `第 ${compatible[1]} / ${compatible[2]} 页 · ${status} · ${compatible[4]}`;
  }
  return note;
}

export function describeDreamRunProgress(run: ConsoleRun): DreamRunProgressView | null {
  if (!run.kind.startsWith('dream_') || (run.status !== 'running' && run.status !== 'queued')) return null;
  if (run.status === 'queued') {
    return {
      phase: 'queued',
      phaseLabel: '等待 PGLite 空闲',
      done: null,
      total: null,
      pct: null,
      detail: '尚未开始处理页面',
      heartbeat: null,
    };
  }

  let phase: string | null = null;
  let done: number | null = null;
  let total: number | null = null;
  let pct: number | null = null;
  let heartbeat: string | null = null;

  for (const rawLine of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {
        event?: unknown;
        phase?: unknown;
        done?: unknown;
        total?: unknown;
        pct?: unknown;
        note?: unknown;
      };
      if (typeof event.phase !== 'string') continue;
      const eventPhase = rootPhase(event.phase);
      if (eventPhase) phase = eventPhase;
      if (eventPhase === phase) {
        if (typeof event.done === 'number') done = event.done;
        if (typeof event.total === 'number') total = event.total;
        if (typeof event.pct === 'number') pct = event.pct;
        if (typeof event.note === 'string' && event.note.trim()) heartbeat = pageHeartbeat(event.note.trim());
      }
    } catch {
      // stderr may contain ordinary diagnostics next to progress JSON.
    }
  }

  if (!phase) {
    const phaseIndex = run.command.indexOf('--phase');
    phase = rootPhase(phaseIndex >= 0 ? run.command[phaseIndex + 1] ?? '' : 'lint') ?? 'lint';
  }
  if (done !== null && total && total > 0) pct = Math.min(100, Math.round((done / total) * 100));
  const detail = done !== null && total !== null
    ? `${done} / ${total} 页${pct !== null ? ` (${pct}%)` : ''}`
    : done !== null
      ? `已处理 ${done} 页`
      : heartbeat
        ? '正在处理页面'
        : '正在等待本阶段返回页数';

  return {
    phase,
    phaseLabel: PHASE_LABELS[phase] ?? phase,
    done,
    total,
    pct,
    detail,
    heartbeat,
  };
}
