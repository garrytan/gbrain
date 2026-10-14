import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createPgliteDatabase } from './pglite-open.ts';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { gbrainPath, loadConfig } from './config.ts';
import { PGLiteEngine } from './pglite-engine.ts';
import {
  parsePgliteToastError,
  isPgliteToastInconsistencyError,
  type PgliteToastErrorLocation,
} from './pglite-errors.ts';
import { attemptWalRepairAndRetry, clearRepairAttemptSidecar } from './pglite-repair.ts';
import { clearReapMarker } from './pglite-lock.ts';

const TOASTABLE_TYPES = /^(text|json|jsonb|bytea|xml|tsvector|vector|character varying|varchar|character|char|text\[\]|jsonb\[\]|bytea\[\])/i;
const EXTERNAL_STORAGE = new Set(['x', 'e', 'm']);

const DERIVED_COLUMNS: Record<string, Set<string>> = {
  pages: new Set(['search_vector', 'timeline', 'embedding_signature', 'corpus_generation']),
  content_chunks: new Set(['search_vector', 'embedding', 'embedded_text_hash', 'doc_comment']),
  facts: new Set(['embedding']),
  query_cache: new Set(['payload', 'result', 'results', 'answer']),
};

const CHUNK_TEXT_COLUMNS = new Set(['chunk_text']);
const PAGE_BODY_COLUMNS = new Set(['compiled_truth', 'title']);
const FACT_BODY_COLUMNS = new Set(['fact', 'context']);

export type ToastRepairability =
  | 'derived'
  | 'rebuildable-chunk'
  | 'canonical-page'
  | 'fact'
  | 'unknown';

export type ToastDiagnoseStatus =
  | 'located'
  | 'toast-table-located'
  | 'open-failed'
  | 'healthy';

export interface ToastRowIdentity {
  id: string | number | null;
  source_id?: string | null;
  slug?: string | null;
  entity_slug?: string | null;
  page_id?: string | number | null;
  ctid?: string | null;
}

export interface ToastDiagnoseReport {
  status: ToastDiagnoseStatus;
  stagingPath: string;
  productionPath: string | null;
  forensicWalResetUsed: boolean;
  toast?: PgliteToastErrorLocation;
  baseTable?: {
    schema: string;
    name: string;
    oid: number;
    toastRelation: string;
    toastOid: number | null;
  };
  toastChunks?: Array<{ chunk_id: number; chunk_seq: number; length: number }>;
  columns?: Array<{ attnum: number; attname: string; type: string; attstorage: string }>;
  row?: ToastRowIdentity;
  column?: string;
  repairability?: ToastRepairability;
  recommendedAction?: string;
  error?: string;
  logPath: string;
  steps: string[];
}

export function toastDiagnoseCanAutoRepair(report: Pick<ToastDiagnoseReport, 'status' | 'baseTable' | 'repairability'>): boolean {
  if (report.status === 'open-failed' || report.status === 'healthy') return false;
  if (report.repairability === 'canonical-page' || report.repairability === 'fact') return false;
  if (report.baseTable?.name === 'content_chunks') return true;
  return report.repairability === 'derived' || report.repairability === 'rebuildable-chunk';
}

export interface ToastApplyReport {
  status: 'applied' | 'dry-run' | 'refused';
  stagingPath: string;
  action?: string;
  sql?: string;
  deleted?: number;
  missingPageIds?: Array<string | number>;
  error?: string;
  logPath: string;
  steps: string[];
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function normalizedPath(value: string): string {
  const full = resolve(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function isSamePglitePath(a: string, b: string): boolean {
  return normalizedPath(a) === normalizedPath(b);
}

export function classifyToastColumn(table: string, column: string): ToastRepairability {
  const tableName = table.toLowerCase();
  const columnName = column.toLowerCase();
  if (DERIVED_COLUMNS[tableName]?.has(columnName)) return 'derived';
  if (tableName === 'content_chunks' && CHUNK_TEXT_COLUMNS.has(columnName)) return 'rebuildable-chunk';
  if (tableName === 'pages' && PAGE_BODY_COLUMNS.has(columnName)) return 'canonical-page';
  if (tableName === 'page_versions' && PAGE_BODY_COLUMNS.has(columnName)) return 'canonical-page';
  if (tableName === 'facts' && FACT_BODY_COLUMNS.has(columnName)) return 'fact';
  return 'unknown';
}

export function recommendedActionFor(repairability: ToastRepairability, table: string, column: string): string {
  switch (repairability) {
    case 'derived':
      return `在 staging 上将 ${table}.${column} 置空/空字符串，不删行；后续由正常流程重建。`;
    case 'rebuildable-chunk':
      return '确认对应 Page 正文可读后，只删除/重建该 Page 的 chunks，不碰其他页，不重建全库向量。';
    case 'canonical-page':
      return '禁止直接删除 Page。先从 page_versions、冷备或原始导入恢复这一条正文。';
    case 'fact':
      return '保存 Fact 身份字段，从更早备份恢复该条内容，禁止整表删除。';
    default:
      return '只读定位后等待用户确认最小修复方案。';
  }
}

function isPgliteRuntimePath(relativePath: string): boolean {
  const topLevel = relativePath.split(/[\\/]/)[0];
  return topLevel === '.gbrain-lock'
    || topLevel === '.pmbrain-resolve.sock'
    || topLevel === 'postmaster.pid'
    || topLevel === 'postmaster.opts';
}

export function copyPgliteDirectory(source: string, destination: string): void {
  if (existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing destination: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: sourcePath => {
      const rel = relative(source, sourcePath);
      return rel === '' || !isPgliteRuntimePath(rel);
    },
  });
}

export function defaultForensicRoot(): string {
  if (existsSync('D:\\backups')) return 'D:\\backups';
  return gbrainPath('toast-forensics');
}

export function resolveProductionPglitePath(explicit?: string | null): string {
  if (explicit) return resolve(explicit);
  const config = loadConfig();
  return resolve(config?.database_path || gbrainPath('brain.pglite'));
}

export function assertStagingNotProduction(stagingPath: string, productionPath: string): void {
  if (isSamePglitePath(stagingPath, productionPath)) {
    throw new Error(`Refusing to diagnose or repair the production PGLite path: ${productionPath}`);
  }
}

function writeReceipt(logPath: string, report: unknown): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify(report, null, 2) + '\n');
}

function toastErrorMatches(error: unknown, toastValue?: number): boolean {
  if (!isPgliteToastInconsistencyError(error)) return false;
  if (toastValue == null) return true;
  const parsed = parsePgliteToastError(error);
  return parsed?.toastValue === toastValue;
}

async function preservingProcessExitCode<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = previous;
  }
}

async function openStagingEngine(
  stagingPath: string,
  forensicWalReset: boolean,
  steps: string[],
): Promise<{ engine: PGLiteEngine; forensicWalResetUsed: boolean }> {
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: stagingPath });
    steps.push(`opened staging without WAL surgery: ${stagingPath}`);
    return { engine, forensicWalResetUsed: false };
  } catch (error) {
    if (!forensicWalReset || !isPgliteToastInconsistencyError(error)) throw error;
    steps.push('connect failed with toast-corrupt; attempting one forensic WAL reset on staging only');
    const open = () => preservingProcessExitCode(() => createPgliteDatabase({
      dataDir: stagingPath,
      extensions: { vector, pg_trgm },
    }));
    const attempt = await attemptWalRepairAndRetry(stagingPath, open);
    if (attempt.status !== 'repaired') {
      throw error;
    }
    try {
      await attempt.db.close();
    } catch { /* reopen via engine */ }
    const repaired = new PGLiteEngine();
    await repaired.connect({ engine: 'pglite', database_path: stagingPath });
    steps.push('forensic WAL reset allowed catalog access on staging');
    return { engine: repaired, forensicWalResetUsed: true };
  }
}

async function resolveBaseTable(
  engine: PGLiteEngine,
  heapOid: number,
  toastRelation: string,
): Promise<{ schema: string; name: string; oid: number; toastRelation: string; toastOid: number | null }> {
  const byToast = await engine.executeRaw<{
    table_oid: number;
    nspname: string;
    table_name: string;
    reltoastrelid: number | null;
    toast_table: string | null;
    toast_oid: number | null;
  }>(`
    SELECT
      c.oid AS table_oid,
      n.nspname,
      c.relname AS table_name,
      c.reltoastrelid,
      tc.relname AS toast_table,
      tc.oid AS toast_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class tc ON tc.oid = c.reltoastrelid
    WHERE tc.relname = $1
       OR c.oid = $2
    LIMIT 1
  `, [toastRelation, heapOid]);
  const row = byToast[0];
  if (row) {
    return {
      schema: row.nspname,
      name: row.table_name,
      oid: Number(row.table_oid),
      toastRelation: row.toast_table ?? toastRelation,
      toastOid: row.toast_oid == null ? null : Number(row.toast_oid),
    };
  }
  throw new Error(`Could not resolve base table for ${toastRelation} / oid ${heapOid}`);
}

async function listToastableColumns(
  engine: PGLiteEngine,
  tableOid: number,
): Promise<Array<{ attnum: number; attname: string; type: string; attstorage: string }>> {
  const rows = await engine.executeRaw<{
    attnum: number;
    attname: string;
    type: string;
    attstorage: string;
  }>(`
    SELECT
      a.attnum,
      a.attname,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      a.attstorage::text AS attstorage
    FROM pg_attribute a
    WHERE a.attrelid = $1
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [tableOid]);
  return rows.filter(row =>
    TOASTABLE_TYPES.test(row.type) || EXTERNAL_STORAGE.has(row.attstorage),
  );
}

async function readToastChunks(
  engine: PGLiteEngine,
  toastRelation: string,
  toastValue: number,
): Promise<Array<{ chunk_id: number; chunk_seq: number; length: number }>> {
  const table = quoteIdent(toastRelation);
  return engine.executeRaw<{ chunk_id: number; chunk_seq: number; length: number }>(
    `SELECT chunk_id, chunk_seq, length(chunk_data) AS length
     FROM pg_toast.${table}
     WHERE chunk_id = $1
     ORDER BY chunk_seq`,
    [toastValue],
  );
}

async function tableHasColumn(engine: PGLiteEngine, table: string, column: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return Boolean(rows[0]?.exists);
}

function columnProbeOrder(columns: Array<{ attname: string }>): Array<{ attname: string }> {
  const preferred = ['chunk_text', 'compiled_truth', 'search_vector', 'embedding', 'fact', 'doc_comment'];
  return [...columns].sort((a, b) => {
    const ai = preferred.indexOf(a.attname);
    const bi = preferred.indexOf(b.attname);
    return (ai === -1 ? 100 : ai) - (bi === -1 ? 100 : bi);
  });
}

async function locateCorruptRow(
  engine: PGLiteEngine,
  table: string,
  columns: Array<{ attname: string }>,
  toastValue: number | undefined,
  steps: string[],
): Promise<{ row: ToastRowIdentity; column: string; toast?: PgliteToastErrorLocation } | null> {
  const idRange = await engine.executeRaw<{ lo: string | number | null; hi: string | number | null }>(
    `SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${quoteIdent(table)}`,
  );
  const lo = idRange[0]?.lo;
  const hi = idRange[0]?.hi;
  if (lo == null || hi == null) {
    steps.push(`${table} has no rows`);
    return null;
  }
  const low = Number(lo);
  const high = Number(hi);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new Error(`${table}.id is not numeric; refusing unsafe scan`);
  }
  steps.push(`${table} id range ${low}-${high}`);

  for (const column of columnProbeOrder(columns)) {
    const probe = await rangeHitsToast(engine, table, column.attname, low, high);
    if (!probe.hit) continue;
    steps.push(`${table}.${column.attname} reproduced toast in id range ${low}-${high}: ${probe.toast?.toastValue ?? 'unknown'}`);
    const id = await binarySearchId(engine, table, column.attname, low, high, steps);
    const row = await readLightRow(engine, table, id);
    return { row, column: column.attname, toast: probe.toast };
  }
  return null;
}

async function rangeHitsToast(
  engine: PGLiteEngine,
  table: string,
  column: string,
  lo: number,
  hi: number,
): Promise<{ hit: boolean; toast?: PgliteToastErrorLocation }> {
  try {
    await engine.executeRaw(
      `SELECT length(${quoteIdent(column)}::text) AS n
       FROM ${quoteIdent(table)}
       WHERE id >= $1 AND id <= $2`,
      [lo, hi],
    );
    return { hit: false };
  } catch (error) {
    if (isPgliteToastInconsistencyError(error)) {
      return { hit: true, toast: parsePgliteToastError(error) ?? undefined };
    }
    throw error;
  }
}

async function binarySearchId(
  engine: PGLiteEngine,
  table: string,
  column: string,
  lo: number,
  hi: number,
  steps: string[],
): Promise<number> {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const left = await rangeHitsToast(engine, table, column, low, mid);
    if (left.hit) high = mid;
    else low = mid + 1;
  }
  steps.push(`narrowed ${table}.${column} to id=${low}`);
  return low;
}

async function readLightRow(engine: PGLiteEngine, table: string, id: number): Promise<ToastRowIdentity> {
  const candidates = ['id', 'source_id', 'slug', 'entity_slug', 'page_id', 'created_at', 'updated_at'];
  const present: string[] = [];
  for (const column of candidates) {
    if (column === 'id' || await tableHasColumn(engine, table, column)) present.push(column);
  }
  const sql = `SELECT ${present.map(quoteIdent).join(', ')}, ctid::text AS ctid
               FROM ${quoteIdent(table)} WHERE id = $1`;
  const rows = await engine.executeRaw<Record<string, unknown>>(sql, [id]);
  const row = rows[0] ?? {};
  return {
    id,
    source_id: typeof row.source_id === 'string' ? row.source_id : null,
    slug: typeof row.slug === 'string' ? row.slug : null,
    entity_slug: typeof row.entity_slug === 'string' ? row.entity_slug : null,
    page_id: row.page_id == null ? null : row.page_id as string | number,
    ctid: typeof row.ctid === 'string' ? row.ctid : null,
  };
}

export async function diagnosePgliteToast(opts: {
  stagingPath: string;
  productionPath: string;
  forensicWalReset?: boolean;
  toastHint?: Partial<PgliteToastErrorLocation>;
}): Promise<ToastDiagnoseReport> {
  const stagingPath = resolve(opts.stagingPath);
  const productionPath = resolve(opts.productionPath);
  assertStagingNotProduction(stagingPath, productionPath);
  const logPath = join(dirname(stagingPath), `${basename(stagingPath)}.toast-diagnose.json`);
  const steps: string[] = [`diagnose staging=${stagingPath}`, `production remains untouched=${productionPath}`];
  const report: ToastDiagnoseReport = {
    status: 'open-failed',
    stagingPath,
    productionPath,
    forensicWalResetUsed: false,
    logPath,
    steps,
  };

  let engine: PGLiteEngine | null = null;
  try {
    const opened = await openStagingEngine(stagingPath, opts.forensicWalReset === true, steps);
    engine = opened.engine;
    report.forensicWalResetUsed = opened.forensicWalResetUsed;

    const hint = opts.toastHint;
    const toastRelation = hint?.toastRelation ?? 'pg_toast_16852';
    const heapOid = hint?.heapOid ?? 16852;
    const toastValue = hint?.toastValue ?? 191139;
    report.toast = {
      actualChunk: hint?.actualChunk ?? 3,
      expectedChunk: hint?.expectedChunk ?? 0,
      toastValue,
      toastRelation,
      heapOid,
    };

    report.baseTable = await resolveBaseTable(engine, heapOid, toastRelation);
    steps.push(`base table ${report.baseTable.schema}.${report.baseTable.name} oid=${report.baseTable.oid}`);
    report.columns = await listToastableColumns(engine, report.baseTable.oid);
    steps.push(`toastable columns: ${report.columns.map(c => c.attname).join(', ') || '(none)'}`);

    try {
      report.toastChunks = await readToastChunks(engine, toastRelation, toastValue);
      steps.push(`toast chunks for ${toastValue}: ${report.toastChunks.map(c => c.chunk_seq).join(',') || '(none)'}`);
    } catch (error) {
      steps.push(`reading pg_toast.${toastRelation} failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const located = await locateCorruptRow(
      engine,
      report.baseTable.name,
      report.columns,
      toastValue,
      steps,
    );
    if (located) {
      report.status = 'located';
      report.row = located.row;
      report.column = located.column;
      if (located.toast) report.toast = located.toast;
      report.repairability = classifyToastColumn(report.baseTable.name, located.column);
      report.recommendedAction = recommendedActionFor(
        report.repairability,
        report.baseTable.name,
        located.column,
      );
    } else {
      report.status = 'toast-table-located';
      report.recommendedAction = '已定位 toast 表与业务表，但尚未命中具体行；需要扩大探测或检查 toast 堆本身。';
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.toast = parsePgliteToastError(error) ?? report.toast;
    steps.push(`diagnose failed: ${report.error}`);
    if (!report.baseTable) report.status = 'open-failed';
    else if (report.status !== 'located') report.status = 'toast-table-located';
  } finally {
    if (engine) {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
    writeReceipt(logPath, report);
  }
  return report;
}

function emptyValueSql(column: string, notNull: boolean): string {
  if (column === 'search_vector') return 'NULL';
  if (column === 'embedding') return 'NULL';
  return notNull ? `''` : 'NULL';
}

export async function applyPgliteToastRepair(opts: {
  stagingPath: string;
  productionPath: string;
  apply: boolean;
  table: string;
  column: string;
  id: string | number;
}): Promise<ToastApplyReport> {
  const stagingPath = resolve(opts.stagingPath);
  const productionPath = resolve(opts.productionPath);
  assertStagingNotProduction(stagingPath, productionPath);
  const logPath = join(dirname(stagingPath), `${basename(stagingPath)}.toast-apply.json`);
  const steps: string[] = [`apply=${opts.apply}`, `staging=${stagingPath}`];
  const repairability = classifyToastColumn(opts.table, opts.column);

  if (repairability === 'fact' || repairability === 'unknown') {
    const report: ToastApplyReport = {
      status: 'refused',
      stagingPath,
      error: `Refusing automatic apply for ${repairability} column ${opts.table}.${opts.column}. Restore that row from versions/backup instead.`,
      logPath,
      steps,
    };
    writeReceipt(logPath, report);
    return report;
  }

  const sql = repairability === 'rebuildable-chunk'
    ? `DELETE FROM ${quoteIdent(opts.table)} WHERE id = $1`
    : repairability === 'canonical-page'
      ? `UPDATE ${quoteIdent(opts.table)} SET ${quoteIdent(opts.column)} = $2 WHERE id = $1`
      : `UPDATE ${quoteIdent(opts.table)} SET ${quoteIdent(opts.column)} = ${emptyValueSql(opts.column, false)} WHERE id = $1`;
  if (!opts.apply) {
    const report: ToastApplyReport = {
      status: 'dry-run',
      stagingPath,
      action: recommendedActionFor(repairability, opts.table, opts.column),
      sql: sql.replace('$1', String(opts.id)),
      logPath,
      steps: [...steps, 'dry-run only'],
    };
    writeReceipt(logPath, report);
    return report;
  }

  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: stagingPath });
    if (repairability === 'rebuildable-chunk') {
      const chunk = await engine.executeRaw<{ page_id: number }>(
        `SELECT page_id FROM ${quoteIdent(opts.table)} WHERE id = $1`,
        [opts.id],
      );
      const pageId = chunk[0]?.page_id;
      if (pageId == null) throw new Error(`Chunk ${opts.id} has no page_id`);
      await engine.executeRaw(`SELECT length(compiled_truth) FROM pages WHERE id = $1`, [pageId]);
      await engine.executeRaw(`DELETE FROM ${quoteIdent(opts.table)} WHERE id = $1`, [opts.id]);
      steps.push(`page ${pageId} body readable; deleted corrupt chunk id=${opts.id}`);
    } else if (repairability === 'canonical-page' && opts.table === 'pages') {
      const versions = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM page_versions WHERE page_id = $1 ORDER BY snapshot_at DESC`,
        [opts.id],
      );
      let restored: string | null = null;
      for (const version of versions) {
        try {
          const body = await engine.executeRaw<{ compiled_truth: string }>(
            `SELECT compiled_truth FROM page_versions WHERE id = $1`,
            [version.id],
          );
          restored = body[0]?.compiled_truth ?? null;
          if (restored != null) {
            steps.push(`restored pages.${opts.column} from page_versions.id=${version.id}`);
            break;
          }
        } catch (error) {
          if (!toastErrorMatches(error)) throw error;
          steps.push(`page_versions.id=${version.id} also toasted; skipping`);
        }
      }
      if (restored == null) {
        throw new Error('No readable page_versions row; refusing to empty canonical page body');
      }
      await engine.executeRaw(
        `UPDATE pages SET ${quoteIdent(opts.column)} = $2 WHERE id = $1`,
        [opts.id, restored],
      );
    } else {
      await engine.executeRaw(sql, [opts.id]);
      steps.push(`cleared ${opts.table}.${opts.column} id=${opts.id}`);
    }
    const report: ToastApplyReport = {
      status: 'applied',
      stagingPath,
      action: recommendedActionFor(repairability, opts.table, opts.column),
      sql: sql.replace('$1', String(opts.id)),
      logPath,
      steps,
    };
    writeReceipt(logPath, report);
    return report;
  } catch (error) {
    const report: ToastApplyReport = {
      status: 'refused',
      stagingPath,
      error: error instanceof Error ? error.message : String(error),
      logPath,
      steps: [...steps, 'apply failed'],
    };
    writeReceipt(logPath, report);
    return report;
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
  }
}

export async function applyOrphanContentChunkRepair(opts: {
  stagingPath: string;
  productionPath: string;
  apply: boolean;
}): Promise<ToastApplyReport> {
  const stagingPath = resolve(opts.stagingPath);
  const productionPath = resolve(opts.productionPath);
  assertStagingNotProduction(stagingPath, productionPath);
  const logPath = join(dirname(stagingPath), `${basename(stagingPath)}.toast-orphan-apply.json`);
  const steps: string[] = [`apply=${opts.apply}`, `staging=${stagingPath}`];
  const sql = `DELETE FROM content_chunks
WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id)`;
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: stagingPath });
    await engine.executeRaw('SELECT length(compiled_truth) FROM pages');
    steps.push('all existing page bodies are readable');
    const missing = await engine.executeRaw<{ page_id: number; n: number }>(`
      SELECT c.page_id, COUNT(*)::int AS n
      FROM content_chunks c
      LEFT JOIN pages p ON p.id = c.page_id
      WHERE p.id IS NULL
      GROUP BY c.page_id
      ORDER BY c.page_id
    `);
    const deleted = missing.reduce((sum, row) => sum + Number(row.n), 0);
    steps.push(`orphan chunks=${deleted} missing page_ids=${missing.map(row => row.page_id).join(',') || '(none)'}`);
    if (!opts.apply) {
      const report: ToastApplyReport = {
        status: 'dry-run',
        stagingPath,
        action: '删除没有对应 Page 的 content_chunks（派生数据）。不删 Page / Wiki / Facts。',
        sql,
        deleted,
        missingPageIds: missing.map(row => row.page_id),
        logPath,
        steps,
      };
      writeReceipt(logPath, report);
      return report;
    }
    await engine.executeRaw(`
      CREATE TABLE IF NOT EXISTS content_chunks_keep AS
      SELECT * FROM content_chunks
      WHERE EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id)
    `);
    const edges = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM code_edges_chunk');
    if (Number(edges[0]?.n ?? 0) !== 0) {
      throw new Error('code_edges_chunk is not empty; refusing TRUNCATE CASCADE. Delete orphan chunks by id instead.');
    }
    await engine.executeRaw('TRUNCATE content_chunks CASCADE');
    await engine.executeRaw('INSERT INTO content_chunks SELECT * FROM content_chunks_keep');
    await engine.executeRaw('DROP TABLE content_chunks_keep');
    steps.push(`rewrote content_chunks from ${deleted ? 'live pages only' : 'readable rows'}; removed ${deleted} orphan chunks`);
    const report: ToastApplyReport = {
      status: 'applied',
      stagingPath,
      action: '用可读 Page 对应的 chunks 重写 content_chunks，去掉无主派生分块。不删 Page / Wiki / Facts。',
      sql: 'CREATE TABLE content_chunks_keep AS SELECT * FROM content_chunks WHERE EXISTS (pages); TRUNCATE content_chunks CASCADE; INSERT ...',
      deleted,
      missingPageIds: missing.map(row => row.page_id),
      logPath,
      steps,
    };
    writeReceipt(logPath, report);
    return report;
  } catch (error) {
    const report: ToastApplyReport = {
      status: 'refused',
      stagingPath,
      error: error instanceof Error ? error.message : String(error),
      logPath,
      steps: [...steps, 'orphan apply failed'],
    };
    writeReceipt(logPath, report);
    return report;
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
  }
}

export async function verifyStagingPgliteHealth(stagingPath: string, productionPath: string): Promise<{
  opens: number;
  schemaOk: boolean;
  pages: number;
  chunks: number;
  facts: number;
  chunkTextOk: boolean;
  pageBodyOk: boolean;
  toast191139Gone: boolean;
  error?: string;
}> {
  assertStagingNotProduction(stagingPath, productionPath);
  const result = {
    opens: 0,
    schemaOk: false,
    pages: 0,
    chunks: 0,
    facts: 0,
    chunkTextOk: false,
    pageBodyOk: false,
    toast191139Gone: false,
  };
  for (let i = 0; i < 3; i++) {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: stagingPath });
      if (i === 0) {
        await engine.initSchema();
        result.schemaOk = true;
      }
      const pages = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages');
      const chunks = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
      const facts = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM facts');
      result.pages = Number(pages[0]?.n ?? 0);
      result.chunks = Number(chunks[0]?.n ?? 0);
      result.facts = Number(facts[0]?.n ?? 0);
      await engine.executeRaw('SELECT length(compiled_truth) FROM pages');
      result.pageBodyOk = true;
      await engine.executeRaw('SELECT length(chunk_text) FROM content_chunks');
      result.chunkTextOk = true;
      result.toast191139Gone = true;
      result.opens += 1;
    } catch (error) {
      const parsed = parsePgliteToastError(error);
      return {
        ...result,
        toast191139Gone: parsed?.toastValue !== 191139,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
  }
  return result;
}

export interface ReplaceProductionReport {
  status: 'replaced';
  stagingPath: string;
  productionPath: string;
  preservedPath: string;
  pages: number;
  chunks: number;
  facts: number;
}

export async function replaceProductionWithStaging(opts: {
  stagingPath: string;
  productionPath: string;
  yes: boolean;
}): Promise<ReplaceProductionReport> {
  if (!opts.yes) {
    throw new Error('replace requires --yes because it replaces the active PGLite database.');
  }
  const stagingPath = resolve(opts.stagingPath);
  const productionPath = resolve(opts.productionPath);
  assertStagingNotProduction(stagingPath, productionPath);
  if (!existsSync(stagingPath)) throw new Error(`Staging PGLite directory does not exist: ${stagingPath}`);
  if (!existsSync(productionPath)) throw new Error(`Production PGLite directory does not exist: ${productionPath}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const preservedPath = `${productionPath}.pre-toast-repair-${stamp}`;
  if (existsSync(preservedPath)) throw new Error(`Preserve path already exists: ${preservedPath}`);
  renameSync(productionPath, preservedPath);
  try {
    copyPgliteDirectory(stagingPath, productionPath);
  } catch (error) {
    if (!existsSync(productionPath) && existsSync(preservedPath)) {
      renameSync(preservedPath, productionPath);
    }
    throw error;
  }
  clearReapMarker(productionPath);
  clearRepairAttemptSidecar(productionPath);
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: productionPath });
    const pages = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages');
    const chunks = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
    const facts = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM facts');
    await engine.executeRaw('SELECT length(compiled_truth) FROM pages');
    await engine.executeRaw('SELECT length(chunk_text) FROM content_chunks');
    return {
      status: 'replaced',
      stagingPath,
      productionPath,
      preservedPath,
      pages: Number(pages[0]?.n ?? 0),
      chunks: Number(chunks[0]?.n ?? 0),
      facts: Number(facts[0]?.n ?? 0),
    };
  } catch (error) {
    try { await engine.disconnect(); } catch { /* ignore */ }
    if (existsSync(productionPath)) rmSync(productionPath, { recursive: true, force: true });
    if (existsSync(preservedPath) && !existsSync(productionPath)) {
      renameSync(preservedPath, productionPath);
    }
    throw error;
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
  }
}
