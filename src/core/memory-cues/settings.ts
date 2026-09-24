import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn } from '../types.ts';
import { resolveEmbeddingColumn } from '../search/embedding-column.ts';
import { loadConfigWithEngine } from '../config.ts';
import { digest } from '../persistence/digest.ts';
import { MEMORY_CUE_FAMILIES, MEMORY_CUE_PROMPT_VERSION, type MemoryCueSettings, type MemoryCueFamily } from './types.ts';

export async function loadMemoryCueSettings(engine: BrainEngine): Promise<MemoryCueSettings> {
  const rows = await engine.executeRaw<{ key: string; value: string }>("SELECT key,value FROM config WHERE key LIKE 'memory.cues.%'");
  const cfg = Object.fromEntries(rows.map(row => [row.key.slice('memory.cues.'.length), row.value]));
  let sources: unknown;
  try { sources = JSON.parse(cfg.sources ?? '[]'); } catch { sources = []; }
  let families: unknown;
  try { families = JSON.parse(cfg.families ?? '["scene","horizon"]'); } catch { families = []; }
  const threshold = (value?: string) => value !== undefined && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= -1 && Number(value) <= 1 ? Number(value) : null;
  const readMode = cfg.read === 'on' || cfg.read === 'shadow' ? cfg.read : 'off';
  const pushEnabled = cfg.push === 'true';
  const needsReadCalibration = readMode !== 'off' && cfg.min_similarity !== undefined;
  const needsPushCalibration = pushEnabled && cfg.push_min_similarity !== undefined;
  const signature = needsReadCalibration || needsPushCalibration ? cueSignature(await memoryCueColumn(engine)) : null;
  return {
    generationEnabled: cfg.generation_enabled === 'true',
    sourceIds: Array.isArray(sources) && sources.every(v => typeof v === 'string' && v.length > 0) ? [...new Set(sources)] : [],
    readMode,
    pushEnabled,
    weight: Number(cfg.weight) > 0 && Number(cfg.weight) <= 0.5 ? Number(cfg.weight) : 0.25,
    minSimilarity: needsReadCalibration && cfg.read_calibration_signature === signature ? threshold(cfg.min_similarity) : null,
    pushMinSimilarity: needsPushCalibration && cfg.push_calibration_signature === signature ? threshold(cfg.push_min_similarity) : null,
    families: Array.isArray(families) && families.length <= 3 && families.every(f => MEMORY_CUE_FAMILIES.includes(f))
      ? [...new Set(families)] as MemoryCueFamily[] : [],
  };
}

export async function memoryCueColumn(engine: BrainEngine): Promise<ResolvedColumn> {
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config');
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const merged = await loadConfigWithEngine({ getAllConfig: async () => cfg, getConfig: async key => cfg[key] ?? null });
  return resolveEmbeddingColumn(undefined, merged ?? { engine: engine.kind });
}

export function cueSignature(column: ResolvedColumn): string {
  return digest([MEMORY_CUE_PROMPT_VERSION, column.name, column.type, column.dimensions, column.embeddingModel]);
}

export function unsupportedCueColumn(column: ResolvedColumn): string | undefined {
  if (!['vector', 'halfvec'].includes(column.type) || !Number.isInteger(column.dimensions) || column.dimensions < 1
    || column.dimensions > (column.type === 'halfvec' ? 4000 : 2000) || !/^[\w-]+:.+/.test(column.embeddingModel)) return 'unsupported_embedding_signature';
}

export function missingCueSchema(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e.code === '42P01' && /memory_cue/.test(e.message ?? '')
    || e.code === '42703' && /(?:c|memory_cues)\.grounding/.test(e.message ?? '');
}
