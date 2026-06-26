// src/core/office/config.ts
//
// Resolves office-ingest configuration from the brain's config store (dotted
// keys via engine.getConfig). Spec: docs/proposals/office-ingest.md §10.
// Defaults are applied here; missing keys never throw.

import type { BrainEngine } from '../engine.ts';

export interface OfficeConfig {
  /** ingest.docling.enabled — master switch (default false / opt-in). */
  enabled: boolean;
  /** ingest.docling.url — sidecar base URL. */
  url: string;
  /** ingest.docling.python — venv python path; null → derived from the sidecar dir. */
  python: string | null;
  /** ingest.docling.max_concurrency — gbrain-side cap on in-flight /parse. */
  maxConcurrency: number;
  /** ingest.office.chunk_tokens — target chunk size (tokens). */
  chunkTokens: number;
  /** ingest.office.table_summary.model — chat model for table summaries. */
  tableSummaryModel: string | null;
  /** ingest.office.table_summary.enabled — false → always template summary. */
  tableSummaryEnabled: boolean;
  /** ingest.office.multimodal — visual embedding policy. */
  multimodal: 'selective' | 'all' | 'off';
  /** ingest.office.max_file_mb — per-file size cap. */
  maxFileMb: number;
}

const DEFAULTS = {
  url: 'http://127.0.0.1:8765',
  maxConcurrency: 2,
  chunkTokens: 512,
  multimodal: 'selective' as const,
  maxFileMb: 50,
};

async function getBool(engine: BrainEngine, key: string, def: boolean): Promise<boolean> {
  const v = await engine.getConfig(key);
  if (v == null) return def;
  return v === 'true' || v === '1';
}

async function getInt(engine: BrainEngine, key: string, def: number): Promise<number> {
  const v = await engine.getConfig(key);
  const n = v != null ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

export async function resolveOfficeConfig(engine: BrainEngine): Promise<OfficeConfig> {
  const [
    enabled,
    url,
    python,
    maxConcurrency,
    chunkTokens,
    tableSummaryModel,
    tableSummaryEnabled,
    multimodalRaw,
    maxFileMb,
  ] = await Promise.all([
    getBool(engine, 'ingest.docling.enabled', false),
    engine.getConfig('ingest.docling.url'),
    engine.getConfig('ingest.docling.python'),
    getInt(engine, 'ingest.docling.max_concurrency', DEFAULTS.maxConcurrency),
    getInt(engine, 'ingest.office.chunk_tokens', DEFAULTS.chunkTokens),
    engine.getConfig('ingest.office.table_summary.model'),
    getBool(engine, 'ingest.office.table_summary.enabled', true),
    engine.getConfig('ingest.office.multimodal'),
    getInt(engine, 'ingest.office.max_file_mb', DEFAULTS.maxFileMb),
  ]);

  const multimodal: OfficeConfig['multimodal'] =
    multimodalRaw === 'all' || multimodalRaw === 'off' || multimodalRaw === 'selective'
      ? multimodalRaw
      : DEFAULTS.multimodal;

  return {
    enabled,
    url: (url && url.trim()) || DEFAULTS.url,
    python: python && python.trim() ? python : null,
    maxConcurrency,
    chunkTokens,
    tableSummaryModel,
    tableSummaryEnabled,
    multimodal,
    maxFileMb,
  };
}
