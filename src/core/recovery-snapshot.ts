import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { GBrainConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { LATEST_VERSION } from './migrate.ts';
import { canonicalJson } from './remediation-step.ts';
import { loadActivePack } from './schema-pack/load-active.ts';
import { VERSION } from '../version.ts';

export const RECOVERY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RECOVERY_SNAPSHOT_CONTRACT = 'gbrain.recovery-snapshot/v1' as const;

type JsonRecord = Record<string, unknown>;

export class RecoverySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverySnapshotError';
  }
}

export interface RecoverySnapshotOptions {
  brainId: string;
  sourceId: string;
  config: GBrainConfig;
  now?: () => Date;
}

export interface RecoverySnapshotPage {
  source_id: string;
  slug: string;
  state: 'active' | 'soft_deleted';
  source_anchor: { kind: 'path' | 'slug'; value: string };
  content_hash: string | null;
  normalized_sha256: string;
  chunk_count: number;
  chunk_content_sha256: string;
  chunker_version: number | null;
  embedding_signature: string | null;
  embedding_spaces: Array<{
    model: string;
    modality: string;
    dimensions: number | null;
    chunks: number;
    embedded: number;
  }>;
}

export interface RecoverySnapshot {
  schema_version: typeof RECOVERY_SNAPSHOT_SCHEMA_VERSION;
  contract: typeof RECOVERY_SNAPSHOT_CONTRACT;
  ok: true;
  generated_at: string;
  brain: {
    id: string;
    engine: 'postgres' | 'pglite';
    target_fingerprint: string;
  };
  database: {
    schema_version: number;
    latest_schema_version: number;
    gbrain_version: string;
  };
  schema_pack: {
    identity: string;
    manifest_sha8: string;
    alias_closure_hash: string;
  };
  source: {
    id: string;
    name: string;
    archived: boolean;
    last_commit: string | null;
    last_sync_at: string | null;
    newest_content_at: string | null;
    chunker_version: string | null;
    local_path_sha256: string | null;
  };
  counts: {
    pages: { active: number; soft_deleted: number; total: number };
    facts: { active: number; total: number };
    takes: { active: number; total: number };
    links: { total: number };
    timeline: { total: number };
    tags: { total: number };
    synthesis_evidence: { total: number };
    chunks: { total: number; embedded: number; missing: number };
  };
  pages: RecoverySnapshotPage[];
  fs_canonical: Record<string, { count: number; sha256: string }>;
  retrieval: {
    chunk_count: number;
    embedded_count: number;
    missing_count: number;
    sha256: string;
  };
  database_only: {
    parity_required: false;
    scope: 'selected_source_and_brain_runtime';
    counts: Record<string, number>;
  };
  content_digest: { algorithm: 'sha256'; canonicalization: 'recursive-key-sort/utf8/v1'; value: string };
  snapshot_digest: { algorithm: 'sha256'; canonicalization: 'recursive-key-sort/utf8/v1'; value: string };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value as JsonRecord)) out[key] = normalize(child);
    return out;
  }
  return value;
}

function normalizedRecord(value: unknown, label: string): JsonRecord {
  const normalized = normalize(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new RecoverySnapshotError(`${label} was not a JSON object`);
  }
  return normalized as JsonRecord;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRows(rows: unknown[]): JsonRecord[] {
  return rows
    .map((row, index) => normalizedRecord(row, `row ${index}`))
    .sort((a, b) => compareStable(canonicalJson(a), canonicalJson(b)));
}

function digestRows(rows: unknown[]): { count: number; sha256: string } {
  const stable = stableRows(rows);
  return { count: stable.length, sha256: sha256(canonicalJson(stable)) };
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RecoverySnapshotError(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') throw new RecoverySnapshotError(`${label} must be a string or null`);
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new RecoverySnapshotError(`${label} must be a boolean`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RecoverySnapshotError(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function targetFingerprint(brainId: string, config: GBrainConfig): string {
  let target: JsonRecord;
  if (config.engine === 'postgres') {
    if (!config.database_url) throw new RecoverySnapshotError('Postgres recovery snapshot requires database_url');
    let parsed: URL;
    try {
      parsed = new URL(config.database_url);
    } catch {
      throw new RecoverySnapshotError('Postgres database_url is malformed');
    }
    target = {
      brain_id: brainId,
      engine: 'postgres',
      protocol: parsed.protocol.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, ''),
    };
  } else {
    if (!config.database_path) throw new RecoverySnapshotError('PGLite recovery snapshot requires database_path');
    target = {
      brain_id: brainId,
      engine: 'pglite',
      database_path_sha256: sha256(resolve(config.database_path).replace(/\\/g, '/')),
    };
  }
  return sha256(canonicalJson(target));
}

function stripKeys(input: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  const blocked = new Set(keys);
  for (const [key, value] of Object.entries(input)) {
    if (!blocked.has(key)) out[key] = value;
  }
  return out;
}

async function readDataRows(engine: BrainEngine, sql: string, params: unknown[], label: string): Promise<JsonRecord[]> {
  const rows = await engine.executeRaw<{ data: unknown }>(sql, params);
  return rows.map((row, index) => normalizedRecord(row.data, `${label}[${index}]`));
}

export async function buildRecoverySnapshot(
  engine: BrainEngine,
  opts: RecoverySnapshotOptions,
): Promise<RecoverySnapshot> {
  if (!opts.brainId.trim()) throw new RecoverySnapshotError('brainId is required');
  if (!opts.sourceId.trim()) throw new RecoverySnapshotError('sourceId is required');
  if (engine.kind !== opts.config.engine) throw new RecoverySnapshotError('Connected engine kind contradicts recovery config');

  const generatedAt = (opts.now ?? (() => new Date()))().toISOString();
  const fingerprint = targetFingerprint(opts.brainId, opts.config);

  return await engine.transaction(async (tx) => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const versionRaw = await tx.getConfig('version');
    const schemaVersion = Number.parseInt(versionRaw ?? '', 10);
    if (!Number.isInteger(schemaVersion) || schemaVersion !== LATEST_VERSION) {
      throw new RecoverySnapshotError(`Schema version ${versionRaw ?? 'missing'} does not exactly match required ${LATEST_VERSION}`);
    }
    const pack = await loadActivePack({
      cfg: opts.config,
      remote: false,
      sourceId: opts.sourceId,
      dbConfig: await tx.getConfig('schema_pack') ?? undefined,
    });

    const sourceRows = await tx.executeRaw<JsonRecord>(
      `SELECT id, name, local_path, last_commit, last_sync_at, chunker_version,
              archived, newest_content_at
         FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    if (sourceRows.length !== 1) throw new RecoverySnapshotError(`Source ${opts.sourceId} does not resolve to exactly one row`);
    const sourceRow = normalizedRecord(sourceRows[0], 'source');

    const pagesRaw = await readDataRows(tx,
      `SELECT to_jsonb(p) AS data FROM pages p WHERE p.source_id = $1 ORDER BY p.slug`,
      [opts.sourceId], 'pages');
    const chunksRaw = await readDataRows(tx,
      `SELECT (to_jsonb(c) - ARRAY['id','page_id','embedding','embedding_image','embedding_multimodal','embedded_at','created_at','search_vector']) ||
              jsonb_build_object(
                'source_id', p.source_id,
                'page_slug', p.slug,
                'embedding_dimensions', CASE WHEN c.embedding IS NULL THEN NULL ELSE vector_dims(c.embedding) END,
                'embedding_image_dimensions', CASE WHEN c.embedding_image IS NULL THEN NULL ELSE vector_dims(c.embedding_image) END,
                'embedding_multimodal_dimensions', CASE WHEN c.embedding_multimodal IS NULL THEN NULL ELSE vector_dims(c.embedding_multimodal) END,
                'embedding_present', c.embedding IS NOT NULL,
                'embedding_image_present', c.embedding_image IS NOT NULL,
                'embedding_multimodal_present', c.embedding_multimodal IS NOT NULL
              ) AS data
         FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.source_id = $1
        ORDER BY p.slug, c.chunk_index`,
      [opts.sourceId], 'chunks');
    const factsRaw = await readDataRows(tx,
      `SELECT (to_jsonb(f) - ARRAY['id','embedding','embedded_at','created_at','superseded_by','consolidated_at','consolidated_into','expired_at']) ||
              jsonb_build_object('active', f.expired_at IS NULL) AS data
         FROM facts f WHERE f.source_id = $1
        ORDER BY f.source_markdown_slug NULLS LAST, f.row_num NULLS LAST, f.entity_slug NULLS LAST, f.fact`,
      [opts.sourceId], 'facts');
    const takesRaw = await readDataRows(tx,
      `SELECT (to_jsonb(t) - ARRAY['id','page_id','embedding','embedded_at','created_at','updated_at']) ||
              jsonb_build_object('source_id', p.source_id, 'page_slug', p.slug) AS data
         FROM takes t JOIN pages p ON p.id = t.page_id
        WHERE p.source_id = $1 ORDER BY p.slug, t.row_num`,
      [opts.sourceId], 'takes');
    const linksRaw = await readDataRows(tx,
      `SELECT (to_jsonb(l) - ARRAY['id','from_page_id','to_page_id','origin_page_id','created_at']) ||
              jsonb_build_object(
                'from_source_id', pf.source_id, 'from_slug', pf.slug,
                'to_source_id', pt.source_id, 'to_slug', pt.slug,
                'origin_source_id', po.source_id, 'origin_slug', po.slug
              ) AS data
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
         LEFT JOIN pages po ON po.id = l.origin_page_id
        WHERE pf.source_id = $1
        ORDER BY pf.slug, pt.source_id, pt.slug, l.link_type, l.link_source NULLS FIRST`,
      [opts.sourceId], 'links');
    const timelineRaw = await readDataRows(tx,
      `SELECT (to_jsonb(te) - ARRAY['id','page_id','event_page_id','created_at']) ||
              jsonb_build_object(
                'source_id', p.source_id, 'page_slug', p.slug,
                'event_source_id', ep.source_id, 'event_slug', ep.slug
              ) AS data
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
         LEFT JOIN pages ep ON ep.id = te.event_page_id
        WHERE p.source_id = $1
        ORDER BY p.slug, te.date, te.summary, te.source`,
      [opts.sourceId], 'timeline');
    const tagsRaw = await readDataRows(tx,
      `SELECT jsonb_build_object('source_id', p.source_id, 'page_slug', p.slug, 'tag', t.tag) AS data
         FROM tags t JOIN pages p ON p.id = t.page_id
        WHERE p.source_id = $1 ORDER BY p.slug, t.tag`,
      [opts.sourceId], 'tags');
    const synthesisRaw = await readDataRows(tx,
      `SELECT jsonb_build_object(
                'source_id', sp.source_id, 'synthesis_slug', sp.slug,
                'take_source_id', tp.source_id, 'take_slug', tp.slug,
                'take_row_num', se.take_row_num, 'citation_index', se.citation_index
              ) AS data
         FROM synthesis_evidence se
         JOIN pages sp ON sp.id = se.synthesis_page_id
         JOIN pages tp ON tp.id = se.take_page_id
        WHERE sp.source_id = $1
        ORDER BY sp.slug, se.citation_index, tp.source_id, tp.slug, se.take_row_num`,
      [opts.sourceId], 'synthesis_evidence');

    const dbOnlyRows = await tx.executeRaw<Record<string, unknown>>(
      `SELECT
        (SELECT count(*) FROM raw_data r JOIN pages p ON p.id = r.page_id WHERE p.source_id = $1) AS raw_data,
        (SELECT count(*) FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1) AS page_versions,
        (SELECT count(*) FROM ingest_log WHERE source_id = $1) AS ingest_log,
        (SELECT count(*) FROM minion_jobs) AS minion_jobs,
        (SELECT count(*) FROM mcp_request_log) AS mcp_request_log,
        (SELECT count(*) FROM config) AS config_rows`,
      [opts.sourceId],
    );
    if (dbOnlyRows.length !== 1) throw new RecoverySnapshotError('Database-only category counts were unavailable');

    const pageSemantics: JsonRecord[] = pagesRaw.map((row): JsonRecord => ({
      ...stripKeys(row, [
        'id', 'created_at', 'updated_at', 'deleted_at', 'salience_touched_at',
        'last_retrieved_at', 'links_extracted_at', 'ingested_at', 'generation',
      ]),
      state: row.deleted_at === null || row.deleted_at === undefined ? 'active' as const : 'soft_deleted' as const,
    }));
    const stableChunks = stableRows(chunksRaw);
    const chunksByPage = new Map<string, JsonRecord[]>();
    for (const chunk of stableChunks) {
      const key = `${asString(chunk.source_id, 'chunk.source_id')}\0${asString(chunk.page_slug, 'chunk.page_slug')}`;
      const bucket = chunksByPage.get(key) ?? [];
      bucket.push(chunk);
      chunksByPage.set(key, bucket);
    }

    const pages: RecoverySnapshotPage[] = pageSemantics.map((row): RecoverySnapshotPage => {
      const sourceId = asString(row.source_id, 'page.source_id');
      const slug = asString(row.slug, 'page.slug');
      const pageChunks = chunksByPage.get(`${sourceId}\0${slug}`) ?? [];
      const spaces = new Map<string, RecoverySnapshotPage['embedding_spaces'][number]>();
      for (const chunk of pageChunks) {
        const model = typeof chunk.model === 'string' ? chunk.model : 'unknown';
        const modalities: Array<[string, unknown, unknown]> = [
          [typeof chunk.modality === 'string' ? chunk.modality : 'text', chunk.embedding_dimensions, chunk.embedding_present],
          ['image', chunk.embedding_image_dimensions, chunk.embedding_image_present],
          ['multimodal', chunk.embedding_multimodal_dimensions, chunk.embedding_multimodal_present],
        ];
        for (const [modality, dimsRaw, presentRaw] of modalities) {
          const present = presentRaw === true;
          if (!present && dimsRaw === null) continue;
          const dimensions = dimsRaw === null ? null : asNumber(dimsRaw, 'embedding dimensions');
          const key = `${model}\0${modality}\0${dimensions ?? 'null'}`;
          const prior = spaces.get(key) ?? { model, modality, dimensions, chunks: 0, embedded: 0 };
          prior.chunks += 1;
          if (present) prior.embedded += 1;
          spaces.set(key, prior);
        }
      }
      const sourcePath = nullableString(row.source_path, 'page.source_path');
      return {
        source_id: sourceId,
        slug,
        state: row.state === 'active' ? 'active' : 'soft_deleted',
        source_anchor: sourcePath ? { kind: 'path', value: sourcePath } : { kind: 'slug', value: slug },
        content_hash: nullableString(row.content_hash, 'page.content_hash'),
        normalized_sha256: sha256(canonicalJson(normalize(row))),
        chunk_count: pageChunks.length,
        chunk_content_sha256: sha256(canonicalJson(pageChunks)),
        chunker_version: row.chunker_version === null || row.chunker_version === undefined
          ? null : asNumber(row.chunker_version, 'page.chunker_version'),
        embedding_signature: nullableString(row.embedding_signature, 'page.embedding_signature'),
        embedding_spaces: Array.from(spaces.values()).sort((a, b) => compareStable(canonicalJson(a), canonicalJson(b))),
      };
    }).sort((a, b) => compareStable(a.source_id, b.source_id) || compareStable(a.slug, b.slug));

    const pageActive = pages.filter((page) => page.state === 'active').length;
    const factActive = factsRaw.filter((row) => row.active === true).length;
    const takeActive = takesRaw.filter((row) => row.active === true).length;
    const embeddedCount = stableChunks.filter((row) => row.embedding_present === true || row.embedding_image_present === true || row.embedding_multimodal_present === true).length;

    const fsCanonical = {
      facts: digestRows(factsRaw),
      takes: digestRows(takesRaw),
      links: digestRows(linksRaw),
      timeline: digestRows(timelineRaw),
      tags: digestRows(tagsRaw),
      synthesis_evidence: digestRows(synthesisRaw),
    };
    const counts = {
      pages: { active: pageActive, soft_deleted: pages.length - pageActive, total: pages.length },
      facts: { active: factActive, total: factsRaw.length },
      takes: { active: takeActive, total: takesRaw.length },
      links: { total: linksRaw.length },
      timeline: { total: timelineRaw.length },
      tags: { total: tagsRaw.length },
      synthesis_evidence: { total: synthesisRaw.length },
      chunks: { total: stableChunks.length, embedded: embeddedCount, missing: stableChunks.length - embeddedCount },
    };
    const retrieval = {
      chunk_count: stableChunks.length,
      embedded_count: embeddedCount,
      missing_count: stableChunks.length - embeddedCount,
      sha256: sha256(canonicalJson(stableChunks)),
    };
    const dbOnly = normalizedRecord(dbOnlyRows[0], 'database_only counts');
    const databaseOnlyCounts = Object.fromEntries(
      Object.entries(dbOnly).map(([key, value]) => [key, asNumber(value, `database_only.${key}`)]),
    );

    const source = {
      id: asString(sourceRow.id, 'source.id'),
      name: asString(sourceRow.name, 'source.name'),
      archived: asBoolean(sourceRow.archived, 'source.archived'),
      last_commit: nullableString(sourceRow.last_commit, 'source.last_commit'),
      last_sync_at: nullableString(sourceRow.last_sync_at, 'source.last_sync_at'),
      newest_content_at: nullableString(sourceRow.newest_content_at, 'source.newest_content_at'),
      chunker_version: nullableString(sourceRow.chunker_version, 'source.chunker_version'),
      local_path_sha256: sourceRow.local_path === null || sourceRow.local_path === undefined
        ? null : sha256(resolve(asString(sourceRow.local_path, 'source.local_path')).replace(/\\/g, '/')),
    };
    const schemaPack = {
      identity: pack.identity,
      manifest_sha8: pack.manifest_sha8,
      alias_closure_hash: pack.alias_closure_hash,
    };
    const contentIdentity = {
      source: { id: source.id, archived: source.archived, last_commit: source.last_commit, chunker_version: source.chunker_version },
      counts,
      pages,
      fs_canonical: fsCanonical,
      retrieval,
    };
    const contentDigest = sha256(canonicalJson(contentIdentity));
    const contentDigestEnvelope = {
      contract: RECOVERY_SNAPSHOT_CONTRACT,
      brain: { id: opts.brainId, engine: engine.kind, target_fingerprint: fingerprint },
      database: { schema_version: schemaVersion, latest_schema_version: LATEST_VERSION, gbrain_version: VERSION },
      schema_pack: schemaPack,
      source,
      counts,
      pages,
      fs_canonical: fsCanonical,
      retrieval,
      database_only: { parity_required: false as const, scope: 'selected_source_and_brain_runtime' as const, counts: databaseOnlyCounts },
    };

    const contentDigestIdentity = {
      algorithm: 'sha256' as const,
      canonicalization: 'recursive-key-sort/utf8/v1' as const,
      value: contentDigest,
    };
    const stableEnvelope = {
      ...contentDigestEnvelope,
      content_digest: contentDigestIdentity,
    };

    return {
      schema_version: RECOVERY_SNAPSHOT_SCHEMA_VERSION,
      ok: true,
      generated_at: generatedAt,
      ...stableEnvelope,
      content_digest: contentDigestIdentity,
      snapshot_digest: {
        algorithm: 'sha256',
        canonicalization: 'recursive-key-sort/utf8/v1',
        value: sha256(canonicalJson(stableEnvelope)),
      },
    };
  });
}
