import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import type { StorageBackend } from './storage.ts';

export type BrainSourceType = 'youtube' | 'quant_x' | 'news' | 'person' | 'manual';
export type BrainIngestionMode = 'pilot' | 'staged';
export type BrainItemType = 'youtube_video' | 'youtube_comment' | 'x_post' | 'news_article' | 'person_profile' | 'manual_note' | 'manual_doc';

export const BRAIN_ARCHIVE_BUCKET = 'brain-archive';
export const BRAIN_QUANT_PILOT_SOURCE_KEYS = [
  'quant_x:afirebrand',
  'quant_x:MoneyPrinter0x',
  'quant_x:TaikiMadea',
] as const;

const PILOT_SOURCE_ALIASES: Record<string, typeof BRAIN_QUANT_PILOT_SOURCE_KEYS[number]> = {
  afirebrand: 'quant_x:afirebrand',
  'quant_x:afirebrand': 'quant_x:afirebrand',
  moneyprinter0x: 'quant_x:MoneyPrinter0x',
  MoneyPrinter0x: 'quant_x:MoneyPrinter0x',
  'quant_x:MoneyPrinter0x': 'quant_x:MoneyPrinter0x',
  taikimadea: 'quant_x:TaikiMadea',
  TaikiMadea: 'quant_x:TaikiMadea',
  'Taiki Madea': 'quant_x:TaikiMadea',
  'Humble Farmer Army': 'quant_x:TaikiMadea',
  'Taiki Madea / Humble Farmer Army': 'quant_x:TaikiMadea',
  'quant_x:TaikiMadea': 'quant_x:TaikiMadea',
};

export interface BrainIngestionOptions {
  bucket: string;
  mode: BrainIngestionMode;
  sources: string[];
  dryRun: boolean;
  allowWrites?: boolean;
  limit?: number;
  prefix?: string;
}

export interface BrainIngestionSourcePlan {
  sourceKey: typeof BRAIN_QUANT_PILOT_SOURCE_KEYS[number];
  sourceType: BrainSourceType;
  storagePrefix: string;
  storagePrefixes: string[];
}

export interface BrainIngestionPlan {
  bucket: string;
  mode: BrainIngestionMode;
  dryRun: boolean;
  limit: number;
  sources: BrainIngestionSourcePlan[];
}

export interface ParsedBrainSourceItem {
  sourceKey: string;
  itemType: BrainItemType;
  externalId: string;
  idempotencyKey: string;
  title: string | null;
  bodyText: string;
  summary: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  rawPayload: Record<string, unknown>;
  storageBucket: string;
  storagePath: string;
  contentSha256: string;
}

export interface BrainQualityGateResult {
  passed: boolean;
  detail: string;
  value?: number;
  threshold?: number;
}

export interface BrainIngestionResult {
  dryRun: boolean;
  bucket: string;
  mode: BrainIngestionMode;
  sources: string[];
  counters: {
    listed: number;
    parsed: number;
    skipped: number;
    failed: number;
    written: number;
    duplicates: number;
  };
  samples: Array<{
    sourceKey: string;
    storagePath: string;
    title: string | null;
    authorHandle: string | null;
    bodyPreview: string;
    qualityStatus: 'new';
  }>;
  qualityGates: {
    parseSuccess: BrainQualityGateResult;
    idempotency: BrainQualityGateResult;
    storageDatabaseConsistency: BrainQualityGateResult;
  };
  failures: Array<{ storagePath: string; error: string }>;
}

const REAL_ARCHIVE_LAYOUT_PREFIXES: Record<typeof BRAIN_QUANT_PILOT_SOURCE_KEYS[number], string[]> = {
  'quant_x:afirebrand': ['13f'],
  'quant_x:MoneyPrinter0x': ['poi/all-in-podcast'],
  'quant_x:TaikiMadea': ['poi/dylan-patel', 'poi/jensen-huang', 'poi/moonshots-podcast'],
};

export function normalizeBrainPilotSource(input: string): typeof BRAIN_QUANT_PILOT_SOURCE_KEYS[number] {
  const direct = PILOT_SOURCE_ALIASES[input] ?? PILOT_SOURCE_ALIASES[input.trim()];
  if (direct) return direct;
  const compact = input.trim().replace(/^@/, '').replace(/[\s_-]/g, '').toLowerCase();
  const normalized = PILOT_SOURCE_ALIASES[compact];
  if (normalized) return normalized;
  throw new Error(`Source ${input} is not in the Quant pilot allowlist`);
}

export function buildBrainIngestionPlan(opts: BrainIngestionOptions): BrainIngestionPlan {
  if (opts.bucket !== BRAIN_ARCHIVE_BUCKET) {
    throw new Error(`Brain ingestion pilot expects Supabase Storage bucket ${BRAIN_ARCHIVE_BUCKET}`);
  }
  if (opts.mode !== 'pilot') {
    throw new Error('Only pilot mode is enabled for Brain ingestion until quality gates pass');
  }

  const uniqueSources = Array.from(new Set(opts.sources.map(normalizeBrainPilotSource)));
  const prefixRoot = (opts.prefix ?? 'pilot').replace(/^\/+|\/+$/g, '');
  return {
    bucket: opts.bucket,
    mode: opts.mode,
    dryRun: opts.dryRun,
    limit: opts.limit ?? 500,
    sources: uniqueSources.map(sourceKey => {
      const storagePrefix = `${prefixRoot}/quant_x/${sourceKey.slice('quant_x:'.length)}`;
      return {
        sourceKey,
        sourceType: 'quant_x',
        storagePrefix,
        storagePrefixes: prefixRoot === 'pilot'
          ? [storagePrefix, ...REAL_ARCHIVE_LAYOUT_PREFIXES[sourceKey]]
          : [storagePrefix],
      };
    }),
  };
}

export function createBrainIngestionIdempotencyKey(sourceKey: string, externalId: string, contentSha256: string): string {
  return createHash('sha256')
    .update(`${sourceKey}\0${externalId}\0${contentSha256}`)
    .digest('hex');
}

export function parseBrainArchiveObject(
  sourceKey: string,
  storagePath: string,
  payload: unknown,
  bucket = BRAIN_ARCHIVE_BUCKET,
): ParsedBrainSourceItem {
  if (!sourceKey.startsWith('quant_x:')) {
    throw new Error(`No Brain ingestion adapter registered for ${sourceKey}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Archive object ${storagePath} must be a JSON object`);
  }
  const rawPayload = payload as Record<string, unknown>;
  const text = stringValue(rawPayload.text) ?? stringValue(rawPayload.body_text) ?? stringValue(rawPayload.body) ?? '';
  if (!text.trim()) throw new Error(`Archive object ${storagePath} has no text/body_text`);

  const externalId = stringValue(rawPayload.id)
    ?? stringValue(rawPayload.external_id)
    ?? stringValue(rawPayload.post_id)
    ?? createHash('sha256').update(storagePath).digest('hex');
  const serialized = stableJson(rawPayload);
  const contentSha256 = createHash('sha256').update(serialized).digest('hex');

  return {
    sourceKey,
    itemType: 'x_post',
    externalId,
    idempotencyKey: createBrainIngestionIdempotencyKey(sourceKey, externalId, contentSha256),
    title: stringValue(rawPayload.title),
    bodyText: text,
    summary: stringValue(rawPayload.summary),
    authorHandle: stringValue(rawPayload.author) ?? stringValue(rawPayload.author_handle) ?? sourceKey.slice('quant_x:'.length),
    authorDisplayName: stringValue(rawPayload.author_name) ?? stringValue(rawPayload.author_display_name),
    canonicalUrl: stringValue(rawPayload.url) ?? stringValue(rawPayload.canonical_url),
    sourceUrl: stringValue(rawPayload.source_url) ?? stringValue(rawPayload.url),
    publishedAt: stringValue(rawPayload.created_at) ?? stringValue(rawPayload.published_at),
    rawPayload,
    storageBucket: bucket,
    storagePath,
    contentSha256,
  };
}

export function parseBrainArchiveBytes(
  sourceKey: string,
  storagePath: string,
  buf: Buffer,
  bucket = BRAIN_ARCHIVE_BUCKET,
): ParsedBrainSourceItem {
  const text = buf.toString('utf8');
  const trimmed = text.trimStart();
  if (storagePath.endsWith('.json') || trimmed.startsWith('{')) {
    return parseBrainArchiveObject(sourceKey, storagePath, JSON.parse(text), bucket);
  }
  return parseBrainArchiveObject(sourceKey, storagePath, parseTextArchivePayload(storagePath, text), bucket);
}

export async function runBrainIngestion(
  engine: BrainEngine,
  storage: StorageBackend,
  opts: BrainIngestionOptions,
): Promise<BrainIngestionResult> {
  const plan = buildBrainIngestionPlan(opts);
  if (!plan.dryRun && !opts.allowWrites) {
    throw new Error('Brain ingestion write mode requires --write plus GBRAIN_BRAIN_INGESTION_ALLOW_WRITES=1');
  }

  const failures: Array<{ storagePath: string; error: string }> = [];
  const seenKeys = new Set<string>();
  let listed = 0;
  let parsed = 0;
  let skipped = 0;
  let written = 0;
  let duplicates = 0;
  const samples: BrainIngestionResult['samples'] = [];

  for (const source of plan.sources) {
    const paths = await listSourcePaths(storage, source, plan.limit);
    listed += paths.length;
    for (const storagePath of paths) {
      try {
        const buf = await storage.download(storagePath);
        const item = parseBrainArchiveBytes(source.sourceKey, storagePath, buf, plan.bucket);
        parsed++;
        if (samples.length < 5) {
          samples.push({
            sourceKey: item.sourceKey,
            storagePath: item.storagePath,
            title: item.title,
            authorHandle: item.authorHandle,
            bodyPreview: item.bodyText.slice(0, 160),
            qualityStatus: 'new',
          });
        }
        if (seenKeys.has(item.idempotencyKey)) {
          duplicates++;
          skipped++;
          continue;
        }
        seenKeys.add(item.idempotencyKey);
        if (!plan.dryRun) {
          await writeBrainSourceItem(engine, source, item);
          written++;
        }
      } catch (err) {
        failures.push({ storagePath, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const failed = failures.length;
  const parseRate = listed === 0 ? 1 : parsed / listed;
  return {
    dryRun: plan.dryRun,
    bucket: plan.bucket,
    mode: plan.mode,
    sources: plan.sources.map(s => s.sourceKey),
    counters: { listed, parsed, skipped, failed, written, duplicates },
    samples,
    qualityGates: {
      parseSuccess: {
        passed: parseRate >= 0.95,
        value: parseRate,
        threshold: 0.95,
        detail: `${parsed}/${listed} archive objects parsed`,
      },
      idempotency: {
        passed: duplicates === 0,
        value: duplicates,
        threshold: 0,
        detail: `${duplicates} duplicate idempotency keys seen in this run`,
      },
      storageDatabaseConsistency: {
        passed: plan.dryRun ? true : written === parsed - duplicates,
        value: plan.dryRun ? parsed : written,
        detail: plan.dryRun ? 'dry-run: database consistency check deferred' : `${written} rows written for ${parsed - duplicates} parsed unique items`,
      },
    },
    failures,
  };
}

async function writeBrainSourceItem(
  engine: BrainEngine,
  source: BrainIngestionSourcePlan,
  item: ParsedBrainSourceItem,
): Promise<void> {
  const sourceRows = await engine.executeRaw<{ id: string; enabled: boolean }>(
    `SELECT id, enabled FROM brain_sources WHERE source_key = $1 LIMIT 1`,
    [source.sourceKey],
  );
  const sourceRow = sourceRows[0];
  if (!sourceRow) throw new Error(`Missing brain_sources row for ${source.sourceKey}`);
  if (!sourceRow.enabled) throw new Error(`Brain source ${source.sourceKey} is disabled`);

  const runRows = await engine.executeRaw<{ id: string }>(
    `INSERT INTO brain_ingestion_runs (
       source_id, run_type, status, idempotency_key,
       started_at, items_seen, items_inserted, items_updated, items_skipped, error_count
     ) VALUES (
       $1, 'backfill', 'running', $2,
       now(), 0, 0, 0, 0, 0
     )
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [sourceRow.id, `pilot:${item.idempotencyKey}`],
  );
  const runId = runRows[0]?.id;

  await engine.executeRaw(
    `INSERT INTO brain_source_items (
       source_id, ingestion_run_id, item_type, external_id, canonical_url, source_url,
       title, body_text, summary, author_handle, author_name, published_at,
       raw_payload, storage_bucket, storage_path, content_sha256, idempotency_key,
       quality_status, visibility
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13::jsonb, $14, $15, $16, $17,
       'new', 'private'
     )
     ON CONFLICT (idempotency_key) DO UPDATE SET
       ingestion_run_id = EXCLUDED.ingestion_run_id,
       body_text = EXCLUDED.body_text,
       raw_payload = EXCLUDED.raw_payload,
       storage_bucket = EXCLUDED.storage_bucket,
       storage_path = EXCLUDED.storage_path,
       content_sha256 = EXCLUDED.content_sha256,
       updated_at = now()`,
    [
      sourceRow.id,
      runId,
      item.itemType,
      item.externalId,
      item.canonicalUrl,
      item.sourceUrl,
      item.title,
      item.bodyText,
      item.summary,
      item.authorHandle,
      item.authorDisplayName,
      item.publishedAt,
      stableJson(item.rawPayload),
      item.storageBucket,
      item.storagePath,
      item.contentSha256,
      item.idempotencyKey,
    ],
  );

  if (runId) {
    await engine.executeRaw(
      `UPDATE brain_ingestion_runs
       SET status = 'succeeded',
           items_seen = 1,
           items_inserted = 1,
           items_updated = 0,
           items_skipped = 0,
           error_count = 0,
           finished_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [runId],
    );
  }
}

async function listSourcePaths(storage: StorageBackend, source: BrainIngestionSourcePlan, limit: number): Promise<string[]> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const prefix of source.storagePrefixes ?? [source.storagePrefix]) {
    for (const path of await storage.list(prefix)) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= limit) return paths;
    }
  }
  return paths;
}

function parseTextArchivePayload(storagePath: string, text: string): Record<string, unknown> {
  const title = storagePath.endsWith('.md')
    ? text.match(/^#\s+(.+)$/m)?.[1]
    : storagePath.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  return {
    id: storagePath,
    title,
    text: storagePath.endsWith('.xml') ? xmlToText(text) : text,
    raw_format: storagePath.endsWith('.xml') ? 'xml' : 'markdown',
  };
}

function xmlToText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(obj).sort().map(k => [k, sortJson(obj[k])]));
}
