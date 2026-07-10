import { randomUUID } from 'crypto';
import { lstatSync } from 'fs';
import type { ConsoleIntent, IntentPreview } from './types.ts';
import { INTENTS, INTENT_SLOT_KEYS } from './types.ts';

function inferPathType(path: string): 'file' | 'directory' | 'unknown' {
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
  } catch {
    // Fall through to extension-based inference for previewing paths that may
    // be unavailable from the server process.
  }
  return /\.mdx?$/i.test(path.trim()) ? 'file' : 'unknown';
}

export function normalizeIntentPreview(obj: Record<string, unknown>): IntentPreview {
  const originalIntent = String(obj.intent ?? obj.action ?? obj.type ?? '').trim();
  const rawIntent = originalIntent === 'capture_memo' ? 'capture_memory' : originalIntent;
  if (!INTENTS.has(rawIntent as ConsoleIntent)) throw new Error(`Unsupported intent: ${rawIntent}`);
  const intent = rawIntent as ConsoleIntent;
  const slots = obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots)
    ? { ...obj.slots as Record<string, unknown> }
    : {};
  for (const key of INTENT_SLOT_KEYS) {
    if (slots[key] === undefined && obj[key] !== undefined) slots[key] = obj[key];
  }
  if (intent === 'import_path' && typeof slots.path === 'string' && typeof slots.pathType !== 'string') {
    slots.pathType = inferPathType(slots.path);
  }
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0)));
  const riskLevel = intent === 'search_brain' || intent === 'show_sources' || intent === 'show_stats' || intent === 'show_config' || intent === 'doctor_check'
    ? 'read'
    : intent === 'embed_stale'
      ? 'maintenance'
      : 'write';
  const requiresConfirmation = riskLevel !== 'read';
  const preview: IntentPreview = {
    previewId: randomUUID(),
    intent,
    confidence,
    slots,
    proposedAction: describeAction(intent, slots),
    riskLevel,
    requiresConfirmation,
  };
  if (typeof obj.clarification === 'string' && obj.clarification.trim()) {
    preview.clarification = obj.clarification.trim();
  }
  validateSlots(preview);
  if (['sync_all', 'embed_stale', 'show_sources', 'show_stats', 'show_config', 'doctor_check'].includes(preview.intent)) {
    delete preview.clarification;
  }
  return preview;
}

export function validateSlots(preview: IntentPreview): void {
  const s = preview.slots;
  if (preview.intent === 'capture_memory' && typeof s.content !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要保存到知识库的内容。';
  }
  if (preview.intent === 'search_brain' && typeof s.query !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要搜索的问题或关键词。';
  }
  if (preview.intent === 'import_path' && typeof s.path !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要导入的本地文件或文件夹路径。';
  }
  if (preview.intent === 'sync_source' && typeof s.sourceId !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要同步的 source id。';
  }
}

export function describeAction(intent: ConsoleIntent, slots: Record<string, unknown>): string {
  switch (intent) {
    case 'capture_memory': {
      const content = String(slots.content ?? '');
      return `准备将完整文本保存到知识库（共 ${content.length.toLocaleString('zh-CN')} 字）。预览：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`;
    }
    case 'search_brain': return `搜索知识库：${String(slots.query ?? '').slice(0, 80)}`;
    case 'import_path': return `导入路径：${String(slots.path ?? '')}`;
    case 'sync_source': return `同步 source：${String(slots.sourceId ?? '')}`;
    case 'sync_all': return '同步所有 source';
    case 'embed_stale': return '补齐待向量化内容';
    case 'show_sources': return '查看当前数据源';
    case 'show_stats': return '查看知识库统计';
    case 'show_config': return '查看脱敏配置';
    case 'doctor_check': return '运行快速系统诊断';
  }
}
