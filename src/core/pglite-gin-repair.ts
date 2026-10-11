export const GIN_REPAIR_PROGRESS_MESSAGE = '搜索索引异常，正在重建。知识内容不会受影响。';
export const GIN_REPAIR_SUCCESS_MESSAGE = '搜索索引修复完成';
export const GIN_REPAIR_FAILED_MESSAGE = '搜索索引修复失败，无法确认搜索已恢复。';
export const GIN_REPAIR_DB_UNUSABLE_MESSAGE = '数据库本身异常，需要先修复数据库或恢复备份。';
export const GIN_REPAIR_STOP_WRITES_MESSAGE = '搜索索引异常，已停止后续数据库写入。';
export const GIN_REPAIR_ACTION_LABEL = '重建搜索索引';
export const GIN_REPAIR_ACTION_HINT = '只修复搜索索引，知识内容不会被删除。修好后再继续快速维护。';

export const LIST_GIN_INDEXES_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS index_name,
  pg_get_indexdef(c.oid) AS index_def
FROM pg_class c
JOIN pg_am am ON am.oid = c.relam
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index i ON i.indexrelid = c.oid
WHERE am.amname = 'gin'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relkind = 'i'
ORDER BY n.nspname, c.relname
`;

export type GinRepairStatus = 'ok' | 'repaired' | 'failed' | 'database_unusable';

export interface GinIndexInfo {
  schema: string;
  name: string;
  indexDef: string;
}

export const SEARCH_GIN_FALLBACK_INDEXES: GinIndexInfo[] = [
  { schema: 'public', name: 'idx_pages_search', indexDef: 'CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN (search_vector)' },
  { schema: 'public', name: 'idx_pages_trgm', indexDef: 'CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN (title gin_trgm_ops)' },
  { schema: 'public', name: 'idx_pages_slug_trgm', indexDef: 'CREATE INDEX IF NOT EXISTS idx_pages_slug_trgm ON pages USING GIN (slug gin_trgm_ops)' },
  { schema: 'public', name: 'idx_pages_frontmatter', indexDef: 'CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN (frontmatter)' },
  { schema: 'public', name: 'idx_chunks_text_trgm', indexDef: 'CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON content_chunks USING GIN (chunk_text gin_trgm_ops)' },
  { schema: 'public', name: 'idx_chunks_search_vector', indexDef: 'CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON content_chunks USING GIN (search_vector)' },
];

export function textHasGinRepairFailure(text: unknown): boolean {
  const msg = text instanceof Error ? text.message : String(text ?? '');
  return (
    msg.includes(GIN_REPAIR_FAILED_MESSAGE)
    || msg.includes(GIN_REPAIR_STOP_WRITES_MESSAGE)
    || msg.includes(GIN_REPAIR_DB_UNUSABLE_MESSAGE)
    || isGinCorruptionError(msg)
  );
}

export interface GinRepairResult {
  status: GinRepairStatus;
  rebuilt: string[];
  message: string;
}

export interface GinRepairEngine {
  kind?: string;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  searchKeyword(query: string, opts?: { limit?: number }): Promise<Array<{ slug: string }>>;
}

export class GinIndexUnusableError extends Error {
  readonly name = 'GinIndexUnusableError';
  readonly status: GinRepairStatus;

  constructor(message: string, opts?: { status?: GinRepairStatus; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.status = opts?.status ?? 'failed';
  }
}

export function isGinCorruptionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /right sibling of GIN page is of different type|GIN page is of different type/i.test(msg);
}

export function isDatabaseUnusableError(error: unknown): boolean {
  if (isGinCorruptionError(error)) return false;
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'PgliteOpenError') {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /Aborted\(\)|database recovery failed|\bWAL\b|PGlite\.create failed|PGLite failed to initialize|could not initialize its WASM|unexpected chunk number|missing chunk number|for toast value \d+ in pg_toast_/i.test(msg);
}

export function isGinRepairAbortText(error: unknown): boolean {
  if (error instanceof GinIndexUnusableError) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes(GIN_REPAIR_FAILED_MESSAGE)
    || msg.includes(GIN_REPAIR_DB_UNUSABLE_MESSAGE)
    || msg.includes(GIN_REPAIR_STOP_WRITES_MESSAGE)
    || /GinIndexUnusableError/.test(msg)
    || isGinCorruptionError(error)
  );
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function writeRepairLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function rowText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

export async function listGinIndexes(engine: GinRepairEngine): Promise<GinIndexInfo[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(LIST_GIN_INDEXES_SQL);
  return rows.map((row) => ({
    schema: rowText(row, ['schema_name', 'schemaname']) || 'public',
    name: rowText(row, ['index_name', 'indexname']),
    indexDef: rowText(row, ['index_def', 'indexdef']),
  })).filter((index) => index.name.length > 0 && index.indexDef.length > 0);
}

export async function probeGinSearch(engine: GinRepairEngine): Promise<void> {
  await engine.searchKeyword('健康检查', { limit: 1 });
  await engine.searchKeyword('healthcheck', { limit: 1 });
}

function pickSearchToken(row: { title: string; slug: string }): string | null {
  const blobs = [row.title, row.slug];
  for (const text of blobs) {
    const cjk = text.match(/[\u3400-\u9fff]{2,8}/);
    if (cjk) return cjk[0];
  }
  for (const text of blobs) {
    const word = text
      .split(/[\s/._-]+/)
      .find((part) => part.length >= 3 && !/^(the|and|for|with|from|this|that)$/i.test(part));
    if (word) return word;
  }
  return row.slug || null;
}

export async function verifyGinSearch(engine: GinRepairEngine): Promise<void> {
  await probeGinSearch(engine);
  const pages = await engine.executeRaw<{ title: string; slug: string }>(
    `SELECT title, slug
       FROM pages
      WHERE deleted_at IS NULL
        AND title IS NOT NULL
        AND length(btrim(title)) >= 2
      ORDER BY length(title) DESC, id
      LIMIT 8`,
  );
  if (pages.length === 0) return;
  const ranked = [...pages].sort((a, b) => {
    const ac = /[\u3400-\u9fff]/.test(a.title) ? 1 : 0;
    const bc = /[\u3400-\u9fff]/.test(b.title) ? 1 : 0;
    return bc - ac;
  });
  const misses: string[] = [];
  for (const page of ranked) {
    const query = pickSearchToken(page) ?? page.title.trim();
    const hits = await engine.searchKeyword(query, { limit: 50 });
    if (hits.some((hit) => hit.slug === page.slug)) return;
    misses.push(`${JSON.stringify(query)} 未命中 ${page.slug}`);
  }
  throw new Error(`真实搜索未找回已有知识页：${misses[0]}`);
}

async function rebuildGinIndex(engine: GinRepairEngine, index: GinIndexInfo): Promise<void> {
  const qualified = `${quoteIdent(index.schema)}.${quoteIdent(index.name)}`;
  await engine.executeRaw(`DROP INDEX IF EXISTS ${qualified}`);
  const createSql = index.indexDef.replace(/\s+CONCURRENTLY\s+/i, ' ');
  await engine.executeRaw(createSql);
}

function failedResult(rebuilt: string[], cause?: unknown): GinRepairResult {
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const message = detail && !detail.includes(GIN_REPAIR_FAILED_MESSAGE)
    ? `${GIN_REPAIR_FAILED_MESSAGE} ${detail}`
    : (detail || GIN_REPAIR_FAILED_MESSAGE);
  writeRepairLine(message);
  return { status: 'failed', rebuilt, message };
}

function unusableResult(): GinRepairResult {
  writeRepairLine(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
  return { status: 'database_unusable', rebuilt: [], message: GIN_REPAIR_DB_UNUSABLE_MESSAGE };
}

export async function repairPgliteGinIndexes(engine: GinRepairEngine): Promise<GinRepairResult> {
  let indexes: GinIndexInfo[];
  try {
    indexes = await listGinIndexes(engine);
  } catch (error) {
    if (isDatabaseUnusableError(error)) return unusableResult();
    return failedResult([], error);
  }
  const liveNames = new Set(indexes.map((index) => index.name));
  const missing = SEARCH_GIN_FALLBACK_INDEXES.filter((index) => !liveNames.has(index.name));
  if (indexes.length === 0 && missing.length === 0) {
    return failedResult([], '当前库里没有可重建的搜索索引');
  }
  writeRepairLine(GIN_REPAIR_PROGRESS_MESSAGE);

  const rebuilt: string[] = [];
  for (const index of indexes) {
    try {
      await rebuildGinIndex(engine, index);
      rebuilt.push(index.name);
    } catch (error) {
      if (isDatabaseUnusableError(error)) return unusableResult();
      try {
        const createSql = index.indexDef.replace(/\s+CONCURRENTLY\s+/i, ' ');
        await engine.executeRaw(createSql);
      } catch {
        /* keep the original rebuild error */
      }
      return failedResult(rebuilt, error);
    }
  }
  for (const index of missing) {
    try {
      await engine.executeRaw(index.indexDef);
      rebuilt.push(index.name);
    } catch (error) {
      if (isDatabaseUnusableError(error)) return unusableResult();
      return failedResult(rebuilt, error);
    }
  }

  try {
    await verifyGinSearch(engine);
  } catch (error) {
    if (isDatabaseUnusableError(error)) return unusableResult();
    return failedResult(rebuilt, error);
  }

  writeRepairLine(GIN_REPAIR_SUCCESS_MESSAGE);
  return {
    status: 'repaired',
    rebuilt,
    message: GIN_REPAIR_SUCCESS_MESSAGE,
  };
}

export async function ensurePgliteGinHealthy(engine: GinRepairEngine): Promise<GinRepairResult> {
  try {
    await probeGinSearch(engine);
    return { status: 'ok', rebuilt: [], message: '' };
  } catch (error) {
    if (isDatabaseUnusableError(error)) return unusableResult();
    if (!isGinCorruptionError(error)) throw error;
    return repairPgliteGinIndexes(engine);
  }
}

export function assertGinRepairSucceeded(result: GinRepairResult): void {
  if (result.status === 'repaired' || result.status === 'ok') return;
  throw new GinIndexUnusableError(result.message, { status: result.status });
}
