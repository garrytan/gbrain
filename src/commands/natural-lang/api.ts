import { createHash, randomUUID } from 'crypto';
import { isAbsolute, join, relative, resolve } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import type { GBrainConfig } from '../../core/config.ts';
import { loadAllSources } from '../../core/sources-load.ts';
import { resolveMainSourceId } from '../../core/source-resolver.ts';
import type { ConsoleRun, IntentPreview } from './types.ts';
import { MAX_NATURAL_TASK_CHARACTERS } from './types.ts';
import { normalizeIntentPreview, describeAction } from './normalize.ts';
import { callIntentModel, getAdminLlmStatus } from './llm.ts';
import { commandForPreview, resolveCliEntry } from './commands.ts';
import { previews, runs, startRun, type RunHooks } from './executor.ts';
import { ALL_PHASES, type CyclePhase } from '../../core/cycle.ts';

export const ADMIN_IMPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Import-path helpers
// ---------------------------------------------------------------------------

function pathContains(basePath: string, candidatePath: string): boolean {
  const base = resolve(basePath);
  const candidate = resolve(candidatePath);
  const rel = relative(base, candidate);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

export function deriveSourceIdFromPath(inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) return '';
  const parts = trimmedPath.replace(/[\\/]+$/g, '').split(/[\\/]+/).filter(Boolean);
  const basename = parts[parts.length - 1] ?? trimmedPath;
  const ascii = basename
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
    .replace(/-+$/g, '');
  if (/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(ascii)) return ascii;
  return `source-${createHash('sha1').update(trimmedPath).digest('hex').slice(0, 8)}`;
}

export async function resolveImportSourceIdForPath(
  engine: BrainEngine,
  importPath: string,
  explicitSourceId?: unknown,
): Promise<string | undefined> {
  if (typeof explicitSourceId === 'string' && explicitSourceId.trim()) {
    return explicitSourceId.trim();
  }
  const trimmedPath = importPath.trim();
  if (!trimmedPath) return undefined;
  const sources = await loadAllSources(engine);
  let best: { id: string; pathLen: number } | null = null;
  for (const source of sources) {
    if (!source.local_path) continue;
    if (!pathContains(source.local_path, trimmedPath)) continue;
    const pathLen = resolve(source.local_path).length;
    if (!best || pathLen > best.pathLen) {
      best = { id: source.id, pathLen };
    }
  }
  return best?.id ?? await resolveMainSourceId(engine);
}

// ---------------------------------------------------------------------------
// High-level API: previewIntent / executePreview
// ---------------------------------------------------------------------------

export async function previewIntent(text: string, config: GBrainConfig | null): Promise<IntentPreview> {
  const trimmedText = text.trim();
  if (!trimmedText) throw new Error('请输入任务内容。');
  if (text.length > MAX_NATURAL_TASK_CHARACTERS) {
    throw new Error(`输入内容不能超过 ${MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字，当前为 ${text.length.toLocaleString('zh-CN')} 字。`);
  }
  const llm = getAdminLlmStatus(config);
  if (!llm.enabled) {
    throw new Error(`LLM is not configured: ${llm.missing.join(', ') || 'missing chat model or key'}`);
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = await callIntentModel(config!, text, attempt);
      const rawIntent = String(obj.intent ?? obj.action ?? obj.type ?? '').trim();
      if (rawIntent === 'capture_memory' || rawIntent === 'capture_memo') {
        const content = captureContentFromInput(trimmedText);
        obj.intent = 'capture_memory';
        obj.content = content;
        obj.slots = {
          ...(obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots) ? obj.slots as Record<string, unknown> : {}),
          content,
        };
      }
      const preview = normalizeIntentPreview(obj);
      previews.set(preview.previewId, preview);
      return preview;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error('Intent preview failed');
}

function captureContentFromInput(text: string): string {
  const withoutTrailingInstruction = text.replace(
    /\s*(?:请)?(?:把|将)?(?:以上|上述|这段|这些|全文|这篇)?(?:文本|文章|内容)?(?:保存|存入|写入|记入|收录)(?:到|至|进)?(?:我的)?知识库[。！!\s]*$/u,
    '',
  ).trim();
  return withoutTrailingInstruction || text;
}

export async function executePreview(engine: BrainEngine, previewId: string, confirmed: boolean, cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  const preview = previews.get(previewId);
  if (!preview) throw new Error('Preview not found or expired');
  if (preview.clarification) throw new Error(preview.clarification);
  if (preview.requiresConfirmation && !confirmed) throw new Error('Confirmation required');
  if (preview.intent === 'import_path' && typeof preview.slots.path === 'string') {
    preview.slots.sourceId = await resolveImportSourceIdForPath(engine, preview.slots.path, preview.slots.sourceId);
    const command = commandForPreview(preview);
    command.push('--fresh', '--report-files');
    return await startRun(preview.intent, command, cwd, hooks, ADMIN_IMPORT_TIMEOUT_MS);
  }
  return await startRun(preview.intent, commandForPreview(preview), cwd, hooks);
}

// ---------------------------------------------------------------------------
// Direct run starters (non-LLM entry points)
// ---------------------------------------------------------------------------

export async function startImportRun(engine: BrainEngine, input: {
  path: string;
  sourceId?: string;
  includeOffice?: boolean;
  includeImages?: boolean;
  noEmbed?: boolean;
  workers?: number;
  fresh?: boolean;
  reportFiles?: boolean;
  timeoutMs?: number;
}, cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  if (!input.path.trim()) throw new Error('Path is required');
  const prefix = resolveCliEntry();
  const cmd = [...prefix, 'import', input.path.trim()];
  if (input.includeOffice) cmd.push('--include-office');
  if (input.includeImages) cmd.push('--include-images');
  if (input.noEmbed) cmd.push('--no-embed');
  if (input.fresh) cmd.push('--fresh');
  if (input.reportFiles) cmd.push('--report-files');
  const sourceId = await resolveImportSourceIdForPath(engine, input.path, input.sourceId);
  if (sourceId) cmd.push('--source-id', sourceId);
  if (input.workers && input.workers > 1) cmd.push('--workers', String(Math.min(8, Math.floor(input.workers))));
  return await startRun('import_path', cmd, cwd, hooks, input.timeoutMs ?? ADMIN_IMPORT_TIMEOUT_MS);
}

export function buildCaptureCommand(content: string, sourceId?: string): string[] {
  if (!content.trim()) throw new Error('Content is required');
  if (content.length > MAX_NATURAL_TASK_CHARACTERS) {
    throw new Error(`内容不能超过 ${MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字。`);
  }
  const cmd = [...resolveCliEntry(), 'capture', content];
  if (sourceId?.trim()) cmd.push('--source', sourceId.trim());
  return cmd;
}

export async function startCaptureRun(
  content: string,
  sourceId: string | undefined,
  cwd: string,
  hooks?: RunHooks,
): Promise<ConsoleRun> {
  return await startRun('capture_memory', buildCaptureCommand(content, sourceId), cwd, hooks);
}

export async function startThinkRun(question: string, cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Question is required');
  if (trimmed.length > MAX_NATURAL_TASK_CHARACTERS) {
    throw new Error(`问题不能超过 ${MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字。`);
  }
  return await startRun('search_brain', [...resolveCliEntry(), 'think', trimmed, '--json'], cwd, hooks);
}

export async function startMarkdownExportRun(
  rootPath: string,
  cwd: string,
  hooks?: RunHooks,
): Promise<{ run: ConsoleRun; outputDir: string }> {
  const { command, outputDir } = buildMarkdownExportCommand(rootPath);
  const run = await startRun('export_markdown', command, cwd, hooks);
  return { run, outputDir };
}

export function buildMarkdownExportCommand(
  rootPath: string,
  now = new Date(),
  suffix = randomUUID().slice(0, 6),
): { command: string[]; outputDir: string } {
  const trimmed = rootPath.trim();
  if (!trimmed) throw new Error('Export directory is required');
  if (!isAbsolute(trimmed)) throw new Error('Export directory must be an absolute path');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const outputDir = join(resolve(trimmed), `PMBrain-Export-${stamp}-${suffix}`);
  return { command: [...resolveCliEntry(), 'export', '--dir', outputDir], outputDir };
}

export async function startSourceAddRun(input: {
  id?: string;
  path: string;
  name?: string;
  federated?: boolean;
}, cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  if (!input.path.trim()) throw new Error('Path is required');
  const sourceId = input.id?.trim() || deriveSourceIdFromPath(input.path);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) {
    throw new Error('Source ID must be lowercase alphanumeric with optional dashes');
  }
  const prefix = resolveCliEntry();
  const cmd = [...prefix, 'sources', 'add', sourceId, '--path', input.path.trim()];
  if (input.name?.trim()) cmd.push('--name', input.name.trim());
  cmd.push(input.federated === false ? '--no-federated' : '--federated');
  return await startRun('source_add', cmd, cwd, hooks);
}

export function buildDreamCommand(input: {
  phase?: CyclePhase | 'all' | string;
  preset?: 'full' | 'meeting' | 'quick';
  sourceId?: string;
  maxPages?: number;
  drainProposals?: boolean;
  windowSeconds?: number;
  dryRun?: boolean;
  input?: string;
  date?: string;
  from?: string;
  to?: string;
  json?: boolean;
}): string[] {
  const prefix = resolveCliEntry();
  const cmd = [...prefix, 'dream'];
  if (input.phase && input.preset) throw new Error('Dream phase and preset are mutually exclusive');
  if (input.preset) cmd.push('--preset', input.preset);
  const phase = input.phase === 'all' ? undefined : (input.phase || undefined);
  if (phase) {
    if (!(ALL_PHASES as readonly string[]).includes(phase)) throw new Error(`Unsupported dream phase: ${phase}`);
    cmd.push('--phase', phase);
  }
  if (input.sourceId?.trim()) cmd.push('--source', input.sourceId.trim());
  if (input.maxPages !== undefined) {
    const maxPages = Math.floor(Number(input.maxPages));
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new Error('Max pages must be a positive integer');
    }
    cmd.push('--max-pages', String(maxPages));
  }
  if (input.drainProposals) cmd.push('--drain-proposals');
  if (input.windowSeconds !== undefined) {
    const windowSeconds = Math.floor(Number(input.windowSeconds));
    if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
      throw new Error('Dream window must be a positive integer');
    }
    cmd.push('--window', String(windowSeconds));
  }
  if (input.input?.trim()) cmd.push('--input', input.input.trim());
  if (input.date?.trim()) cmd.push('--date', input.date.trim());
  if (input.from?.trim()) cmd.push('--from', input.from.trim());
  if (input.to?.trim()) cmd.push('--to', input.to.trim());
  if (input.dryRun) cmd.push('--dry-run');
  if (input.json) cmd.push('--json');
  return cmd;
}

export async function startDreamRun(input: {
  phase?: CyclePhase | 'all' | string;
  preset?: 'full' | 'meeting' | 'quick';
  sourceId?: string;
  maxPages?: number;
  drainProposals?: boolean;
  windowSeconds?: number;
  dryRun?: boolean;
  input?: string;
  date?: string;
  from?: string;
  to?: string;
  timeoutMs?: number;
}, cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  const mode = input.preset ?? (input.phase && input.phase !== 'all' ? input.phase : 'cycle');
  return await startRun(`dream_${mode}`, buildDreamCommand({ ...input, json: true }), cwd, hooks, input.timeoutMs);
}

export async function startActionRun(action: 'doctor_check' | 'show_sources' | 'show_stats' | 'embed_stale' | 'sync_all', cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  const preview: IntentPreview = {
    previewId: randomUUID(),
    intent: action,
    confidence: 1,
    slots: {},
    proposedAction: describeAction(action, {}),
    riskLevel: action === 'embed_stale' || action === 'sync_all' ? 'maintenance' : 'read',
    requiresConfirmation: false,
  };
  return await startRun(action, commandForPreview(preview), cwd, hooks);
}
