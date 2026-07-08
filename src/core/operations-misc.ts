// Remaining registry operations: brain sync, raw data, maintenance job rerun,
// ingest log, file storage, and the skillpack reader.
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { MBrainConfig } from './config.ts';
import * as db from './db.ts';
import type { BrainEngine } from './engine.ts';
import { getUnsupportedCapabilityReason } from './offline-profile.ts';
import { OperationError, type OperationCapability } from './operation-params.ts';
import type { Operation, OperationContext } from './operations.ts';
import { putPageSourceRef } from './operations-put-page.ts';
import { assertJsonSerializable } from './operations-shared.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';

const runtimeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

export interface SyncBrainHandlerOptions {
  repoPath?: string;
  subbrain?: string;
  allSubbrains?: boolean;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
}

export type SyncBrainHandler = (engine: BrainEngine, opts: SyncBrainHandlerOptions) => Promise<unknown>;

let registeredSyncBrainHandler: SyncBrainHandler | null = null;

export function registerSyncBrainHandler(handler: SyncBrainHandler): void {
  registeredSyncBrainHandler = handler;
}

async function loadSyncBrainHandler(): Promise<SyncBrainHandler> {
  if (registeredSyncBrainHandler) return registeredSyncBrainHandler;

  // Keep sync local-only so the remote Edge bundle doesn't pull in CLI/import engine code.
  const { performSync } = await runtimeImport('../commands/sync.ts');
  return performSync;
}

function rawDataObject(value: unknown): object {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_params', 'data must be an object');
  }
  assertJsonSerializable(value, 'data', new WeakSet<object>());
  return value as object;
}

function rawDataRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: {
      type: 'string',
      description: 'Path to git repo (optional if configured)',
    },
    subbrain: {
      type: 'string',
      description: 'Registered sub-brain id to sync',
    },
    all_subbrains: {
      type: 'boolean',
      description: 'Sync every registered sub-brain',
    },
    dry_run: {
      type: 'boolean',
      description: 'Preview changes without applying',
    },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: {
      type: 'boolean',
      description: 'Compatibility no-op: sync already defers embeddings',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const performSync = await loadSyncBrainHandler();
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      subbrain: p.subbrain as string | undefined,
      allSubbrains: (p.all_subbrains as boolean) || false,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      full: (p.full as boolean) || false,
    });
  },
  cliHints: { name: 'sync' },
};

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: {
      type: 'string',
      required: true,
      description: 'Data source (e.g., crustdata, happenstance)',
    },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const slug = rawDataRequiredString(p.slug, 'slug');
    const source = rawDataRequiredString(p.source, 'source');
    const data = rawDataObject(p.data);
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug, source };
    await ctx.engine.putRawData(slug, source, data);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined);
  },
};

interface RerunMemoryJobInput {
  job_id: string;
  reason: string;
  requested_by: string;
  now: string;
}

interface MemoryJobRow {
  id: string;
  name: string;
  status: string;
  failure_class: string | null;
}

type MaintenanceJobQueryableEngine = BrainEngine & {
  database?: {
    query<T = Record<string, unknown>>(
      sql: string,
    ): {
      get(...params: unknown[]): T | null;
      run(...params: unknown[]): unknown;
    };
  };
  db?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  sql?: {
    unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  };
};

async function executeRerunMemoryJob(ctx: OperationContext, input: RerunMemoryJobInput): Promise<Record<string, unknown>> {
  const existing = await readMemoryJob(ctx.engine, input.job_id);
  assertRerunnableMemoryJob(existing, input.job_id);

  if (ctx.dryRun) {
    return {
      action: 'rerun_memory_job',
      job_id: input.job_id,
      status: 'dry_run',
      job_event: buildMemoryJobRerunEvent(existing, input),
      requires_mutation_ledger: true,
    };
  }

  const appliedResult = await ctx.engine.transaction(async (tx) => {
    const lockedExisting = await readMemoryJob(tx, input.job_id);
    assertRerunnableMemoryJob(lockedExisting, input.job_id);
    const jobEvent = buildMemoryJobRerunEvent(lockedExisting, input);
    const applied = await resetMemoryJobForRerun(tx, input);
    if (!applied) {
      assertRerunnableMemoryJob(await readMemoryJob(tx, input.job_id), input.job_id);
      throw new OperationError('invalid_params', `job_id could not be reset for rerun: ${input.job_id}`);
    }
    await insertMemoryJobEvent(tx, jobEvent);
    const mutationEvent = await recordMemoryMutationEvent(tx, {
      session_id: 'memory-review-report',
      realm_id: 'work',
      actor: input.requested_by,
      operation: 'rerun_memory_job',
      target_kind: 'procedure',
      target_id: input.job_id,
      scope_id: 'workspace:default',
      source_refs: [`Source: memory review report rerun action for ${input.job_id}`],
      result: 'applied',
      metadata: {
        reason: input.reason,
        job_event_id: jobEvent.id,
        previous_status: lockedExisting.status,
      },
      created_at: input.now,
      decided_at: input.now,
      applied_at: input.now,
    });
    return { jobEvent, mutationEvent };
  });

  return {
    action: 'rerun_memory_job',
    job_id: input.job_id,
    status: 'waiting',
    job_event: appliedResult.jobEvent,
    mutation_event: appliedResult.mutationEvent,
  };
}

function assertRerunnableMemoryJob(job: MemoryJobRow | null, jobId: string): asserts job is MemoryJobRow {
  if (!job) {
    throw new OperationError('invalid_params', `job_id not found: ${jobId}`);
  }
  if (job.status !== 'failed' && job.status !== 'dead') {
    throw new OperationError('invalid_params', `job_id must refer to a failed or dead job: ${jobId}`);
  }
}

function buildMemoryJobRerunEvent(
  existing: MemoryJobRow,
  input: RerunMemoryJobInput,
): {
  id: string;
  job_id: string;
  event_type: string;
  worker_id: string;
  failure_class: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
} {
  return {
    id: `job-event:${randomUUID()}`,
    job_id: input.job_id,
    event_type: 'rerun_requested',
    worker_id: input.requested_by,
    failure_class: existing.failure_class,
    metadata_json: {
      reason: input.reason,
      previous_status: existing.status,
      requested_by: input.requested_by,
    },
    created_at: input.now,
  };
}

async function readMemoryJob(engine: BrainEngine, jobId: string): Promise<MemoryJobRow | null> {
  const candidate = engine as MaintenanceJobQueryableEngine;
  if (candidate.database) {
    return candidate.database
      .query<MemoryJobRow>(`
      SELECT id, name, status, failure_class
      FROM memory_jobs
      WHERE id = ?
    `)
      .get(jobId);
  }
  if (candidate.sql?.unsafe) {
    const rows = await candidate.sql.unsafe(
      `
      SELECT id, name, status, failure_class
      FROM memory_jobs
      WHERE id = $1
    `,
      [jobId],
    );
    return (rows[0] as unknown as MemoryJobRow | undefined) ?? null;
  }
  if (candidate.db) {
    const result = await candidate.db.query(
      `
      SELECT id, name, status, failure_class
      FROM memory_jobs
      WHERE id = $1
    `,
      [jobId],
    );
    return (result.rows[0] as unknown as MemoryJobRow | undefined) ?? null;
  }
  throw new OperationError('invalid_params', 'rerun_memory_job requires a SQL-backed engine');
}

async function resetMemoryJobForRerun(engine: BrainEngine, input: RerunMemoryJobInput): Promise<boolean> {
  const candidate = engine as MaintenanceJobQueryableEngine;
  if (candidate.database) {
    const result = candidate.database
      .query(`
      UPDATE memory_jobs
      SET status = 'waiting',
          result_json = NULL,
          progress_json = '{}',
          attempts_started = 0,
          attempts_finished = 0,
          failure_class = NULL,
          last_error = NULL,
          lock_token = NULL,
          lock_owner = NULL,
          lock_expires_at = NULL,
          timeout_at = NULL,
          started_at = NULL,
          finished_at = NULL,
          next_run_at = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('failed', 'dead')
    `)
      .run(input.now, input.now, input.job_id);
    return changedRows(result) > 0;
  }
  if (candidate.sql?.unsafe) {
    const rows = await candidate.sql.unsafe(
      `
      UPDATE memory_jobs
      SET status = 'waiting',
          result_json = NULL,
          progress_json = '{}'::jsonb,
          attempts_started = 0,
          attempts_finished = 0,
          failure_class = NULL,
          last_error = NULL,
          lock_token = NULL,
          lock_owner = NULL,
          lock_expires_at = NULL,
          timeout_at = NULL,
          started_at = NULL,
          finished_at = NULL,
          next_run_at = $1,
          updated_at = $1
      WHERE id = $2 AND status IN ('failed', 'dead')
      RETURNING id
    `,
      [input.now, input.job_id],
    );
    return rows.length > 0;
  }
  if (candidate.db) {
    const result = await candidate.db.query(
      `
      UPDATE memory_jobs
      SET status = 'waiting',
          result_json = NULL,
          progress_json = '{}'::jsonb,
          attempts_started = 0,
          attempts_finished = 0,
          failure_class = NULL,
          last_error = NULL,
          lock_token = NULL,
          lock_owner = NULL,
          lock_expires_at = NULL,
          timeout_at = NULL,
          started_at = NULL,
          finished_at = NULL,
          next_run_at = $1,
          updated_at = $1
      WHERE id = $2 AND status IN ('failed', 'dead')
      RETURNING id
    `,
      [input.now, input.job_id],
    );
    return result.rows.length > 0;
  }
  throw new OperationError('invalid_params', 'rerun_memory_job requires a SQL-backed engine');
}

function changedRows(result: unknown): number {
  if (typeof result === 'object' && result !== null && 'changes' in result) {
    const changes = (result as { changes?: unknown }).changes;
    if (typeof changes === 'number') return changes;
  }
  return 0;
}

async function insertMemoryJobEvent(
  engine: BrainEngine,
  event: {
    id: string;
    job_id: string;
    event_type: string;
    worker_id: string;
    failure_class: string | null;
    metadata_json: Record<string, unknown>;
    created_at: string;
  },
): Promise<void> {
  const candidate = engine as MaintenanceJobQueryableEngine;
  if (candidate.database) {
    candidate.database
      .query(`
      INSERT INTO memory_job_events (
        id, job_id, event_type, worker_id, failure_class, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(event.id, event.job_id, event.event_type, event.worker_id, event.failure_class, JSON.stringify(event.metadata_json), event.created_at);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(
      `
      INSERT INTO memory_job_events (
        id, job_id, event_type, worker_id, failure_class, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
      [event.id, event.job_id, event.event_type, event.worker_id, event.failure_class, JSON.stringify(event.metadata_json), event.created_at],
    );
    return;
  }
  if (candidate.db) {
    await candidate.db.query(
      `
      INSERT INTO memory_job_events (
        id, job_id, event_type, worker_id, failure_class, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
      [event.id, event.job_id, event.event_type, event.worker_id, event.failure_class, JSON.stringify(event.metadata_json), event.created_at],
    );
    return;
  }
  throw new OperationError('invalid_params', 'rerun_memory_job requires a SQL-backed engine');
}

const rerun_memory_job: Operation = {
  name: 'rerun_memory_job',
  description: 'Reset a failed maintenance or runner job to waiting and record the auditable rerun request.',
  params: {
    job_id: {
      type: 'string',
      required: true,
      description: 'Failed memory job id to rerun.',
    },
    reason: {
      type: 'string',
      required: true,
      description: 'Reason for rerunning the job.',
    },
    requested_by: {
      type: 'string',
      description: 'Actor requesting the rerun.',
    },
    now: {
      type: 'string',
      description: 'Optional ISO timestamp for deterministic planning.',
    },
  },
  handler: async (ctx, p) =>
    executeRerunMemoryJob(ctx, {
      job_id: putPageSourceRef(p.job_id, 'job_id'),
      reason: putPageSourceRef(p.reason, 'reason'),
      requested_by: typeof p.requested_by === 'string' && p.requested_by.trim().length > 0 ? p.requested_by.trim() : 'mbrain:maintenance-runtime',
      now: typeof p.now === 'string' && p.now.trim().length > 0 ? p.now.trim() : new Date().toISOString(),
    }),
  mutating: true,
  cliHints: { name: 'memory-job-rerun' },
};

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true },
    source_ref: { type: 'string', required: true },
    pages_updated: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getIngestLog({ limit: (p.limit as number) ?? 20 });
  },
};

// --- File Operations ---

const FILE_LIST_LIMIT = 100;
const FILE_URL_TTL_SECONDS = 300;

const file_list: Operation = {
  name: 'file_list',
  description: 'List stored files',
  capabilityRequired: 'files',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    const sql = db.getConnection();
    const slug = p.slug as string | undefined;
    if (slug) {
      return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files WHERE page_slug = ${slug} ORDER BY filename LIMIT ${FILE_LIST_LIMIT}`;
    }
    return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files ORDER BY page_slug, filename LIMIT ${FILE_LIST_LIMIT}`;
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  description: 'Upload a file to storage',
  capabilityRequired: 'files',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { readFileSync, statSync } = await import('fs');
    const { basename } = await import('path');
    const { createHash } = await import('crypto');
    const { detectMimeType } = await import('./file-mime.ts');

    const filePath = p.path as string;
    const pageSlug = (p.page_slug as string) || null;
    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const filename = basename(filePath);
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const mimeType = detectMimeType(filePath, content);

    const sql = db.getConnection();
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      return { status: 'already_exists', storage_path: storagePath };
    }

    // Upload to storage backend if configured
    if (ctx.config.storage) {
      const { createStorage } = await import('./storage.ts');
      const storage = await createStorage(ctx.config.storage as any);
      try {
        await storage.upload(storagePath, content, mimeType || undefined);
      } catch (uploadErr) {
        throw new OperationError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
      }
    }

    try {
      await sql`
        INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
        VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
        ON CONFLICT (storage_path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          size_bytes = EXCLUDED.size_bytes,
          mime_type = EXCLUDED.mime_type
      `;
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      if (ctx.config.storage) {
        try {
          const { createStorage } = await import('./storage.ts');
          const storage = await createStorage(ctx.config.storage as any);
          await storage.delete(storagePath);
        } catch {
          /* best effort cleanup */
        }
      }
      throw dbErr;
    }

    return {
      status: 'uploaded',
      storage_path: storagePath,
      size_bytes: stat.size,
    };
  },
};

const file_url: Operation = {
  name: 'file_url',
  description: 'Get a URL for a stored file',
  capabilityRequired: 'files',
  params: {
    storage_path: { type: 'string', required: true },
    expires_in_seconds: {
      type: 'number',
      description: 'Signed URL TTL in seconds when cloud storage is configured.',
    },
  },
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    const sql = db.getConnection();
    const rows = await sql`SELECT storage_path, mime_type, size_bytes FROM files WHERE storage_path = ${p.storage_path as string}`;
    if (rows.length === 0) {
      throw new OperationError('storage_error', `File not found: ${p.storage_path}`);
    }
    const expiresInSeconds = typeof p.expires_in_seconds === 'number' ? Math.floor(p.expires_in_seconds) : FILE_URL_TTL_SECONDS;
    if (expiresInSeconds <= 0) {
      throw new OperationError('invalid_params', 'expires_in_seconds must be greater than zero');
    }
    if (ctx.config.storage) {
      const { createStorage } = await import('./storage.ts');
      const storage = await createStorage(ctx.config.storage as any);
      const url = await storage.getUrl(String(rows[0].storage_path), {
        expiresInSeconds,
      });
      return {
        storage_path: rows[0].storage_path,
        url,
        expires_in_seconds: expiresInSeconds,
      };
    }
    return {
      storage_path: rows[0].storage_path,
      url: `mbrain:files/${rows[0].storage_path}`,
    };
  },
};

// --- Skillpack ---

const get_skillpack: Operation = {
  name: 'get_skillpack',
  description:
    'Read the MBrain SKILLPACK reference architecture. Returns the full document or a specific section by number/name. Use this to learn detailed patterns for enrichment, meeting ingestion, cron schedules, and more.',
  discovery: {
    compactDescription: true,
    description:
      'Runtime self-orientation: call get_skillpack (no args) for the compact agent rules, or with a section for detailed retrieval/ingest/governance patterns. Start here when unsure how to use MBrain.',
  },
  params: {
    section: {
      type: 'string',
      description: 'Section number or keyword (e.g. "5", "enrichment", "meeting", "cron"). Omit to get the compact agent rules.',
    },
  },
  handler: async (_ctx, p) => {
    const section = p.section as string | undefined;

    // If no section requested, return the compact agent rules
    if (!section) {
      const rulesPath = resolveDocPath('MBRAIN_AGENT_RULES.md');
      if (!rulesPath) {
        return {
          error: 'not_found',
          message: 'MBRAIN_AGENT_RULES.md not found in the mbrain package.',
        };
      }
      return {
        document: 'MBRAIN_AGENT_RULES.md',
        content: readDocCached(rulesPath),
      };
    }

    // Load full SKILLPACK and extract section
    const skillpackPath = resolveDocPath('MBRAIN_SKILLPACK.md');
    if (!skillpackPath) {
      return {
        error: 'not_found',
        message: 'MBRAIN_SKILLPACK.md not found in the mbrain package.',
      };
    }

    const fullContent = readDocCached(skillpackPath);

    // Try to find section by number (e.g. "## 5." or "## 5 ")
    const sectionNum = parseInt(section, 10);
    if (!isNaN(sectionNum)) {
      const extracted = extractSection(fullContent, sectionNum);
      if (extracted) {
        return {
          document: 'MBRAIN_SKILLPACK.md',
          section: sectionNum,
          content: extracted,
        };
      }
      return {
        error: 'section_not_found',
        message: `Section ${sectionNum} not found.`,
        available: listSections(fullContent),
      };
    }

    // Try keyword search in section headers
    const keyword = section.toLowerCase();
    const lines = fullContent.split('\n');
    const matchingSections: Array<{ num: number; title: string }> = [];
    for (const line of lines) {
      const match = parseSkillpackSectionHeader(line);
      if (match && (match.title.toLowerCase().includes(keyword) || line.toLowerCase().includes(keyword))) {
        matchingSections.push(match);
      }
    }

    if (matchingSections.length === 1) {
      const extracted = extractSection(fullContent, matchingSections[0].num);
      return {
        document: 'MBRAIN_SKILLPACK.md',
        section: matchingSections[0].num,
        title: matchingSections[0].title,
        content: extracted,
      };
    }

    if (matchingSections.length > 1) {
      return {
        matches: matchingSections,
        hint: 'Multiple sections match. Specify a section number.',
      };
    }

    return {
      error: 'section_not_found',
      message: `No section matching "${section}".`,
      available: listSections(fullContent),
    };
  },
  cliHints: { hidden: true },
};

// Skillpack/agent-rules docs are static for the lifetime of an installed
// binary; cache file contents so repeated get_skillpack calls skip the disk.
const docContentCache = new Map<string, string>();

function readDocCached(path: string): string {
  let content = docContentCache.get(path);
  if (content === undefined) {
    content = readFileSync(path, 'utf-8');
    docContentCache.set(path, content);
  }
  return content;
}

function resolveDocPath(filename: string): string | null {
  const candidates = [join(process.cwd(), 'docs', filename), join(__dirname, '..', '..', 'docs', filename), join(__dirname, '..', 'docs', filename)];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function extractSection(content: string, sectionNum: number): string | null {
  const lines = content.split('\n');
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = parseSkillpackSectionHeader(lines[i]);
    if (match) {
      const num = match.num;
      if (num === sectionNum && start === -1) {
        start = i;
      } else if (start !== -1 && num > sectionNum) {
        end = i;
        break;
      }
    }
  }

  if (start === -1) return null;
  return lines.slice(start, end).join('\n').trim();
}

function listSections(content: string): Array<{ num: number; title: string }> {
  const sections: Array<{ num: number; title: string }> = [];
  for (const line of content.split('\n')) {
    const match = parseSkillpackSectionHeader(line);
    if (match) {
      sections.push({
        num: match.num,
        title: match.title.replace(/\s*--\s*/, ' - ').trim(),
      });
    }
  }
  return sections;
}

function parseSkillpackSectionHeader(line: string): { num: number; title: string } | null {
  const match = line.match(/^## (?:(?:Section )?(\d+)[a-z]?[:.\s]+)(.+)$/i);
  if (!match) return null;
  return { num: parseInt(match[1], 10), title: match[2].trim() };
}

function assertCapabilitySupported(config: MBrainConfig, capability: OperationCapability) {
  const reason = getUnsupportedCapabilityReason(config, capability);
  if (reason) {
    throw new OperationError('unsupported_capability', reason);
  }
}

export function createMiscOperations(): Operation[] {
  return [sync_brain, put_raw_data, get_raw_data, rerun_memory_job, log_ingest, get_ingest_log, file_list, file_upload, file_url, get_skillpack];
}
