import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { PMBRAIN_SCHEMA_VERSION_KEY } from '../core/pmbrain-adapters/migration-ledger.ts';
import { LEGACY_TABLE_RULES, inspectDuplicateFactsIds, isRegisteredHistoricalBackup, rewriteLegacyRow } from './full-engine-compatibility.ts';

const PAGE_SIZE = 100;
const OPERATIONAL_TABLES = new Set(['gbrain_cycle_locks', 'subagent_rate_leases', 'pmbrain_schema_migrations']);
const SCHEMA_CONFIG_KEYS = ['version', PMBRAIN_SCHEMA_VERSION_KEY];
const CRITICAL_TABLES = new Set(['pages', 'content_chunks', 'facts', 'takes', 'sources', 'files', 'links', 'page_links', 'raw_data']);

interface ColumnInfo {
  column_name: string;
  is_generated: string;
  is_identity: string;
  is_nullable: string;
  column_default: string | null;
  data_type: string;
}

interface VectorColumnInfo {
  table_name: string;
  column_name: string;
  type_name: string;
  formatted: string;
}

interface TablePlan {
  name: string;
  columns: string[];
  excludedSource: string[];
  excludedTarget: string[];
  overrideIdentity: boolean;
  count: number;
  timestampColumns: string[];
}

export interface FullTransferReceipt {
  status: 'verified';
  tables: Array<{ name: string; rows: number; sha256: string }>;
  skippedTables: Array<{ name: string; rows: number; reason: 'historical_backup' | 'unknown_approved' }>;
  converted: Array<{ rule: string; rows: number }>;
  excludedOperationalTables: string[];
}

export interface FullTransferPlan {
  schemaVersion: string | null;
  fingerprint: string;
  tables: Array<{ name: string; rows: number; action: 'direct' | 'convert' | 'skip' | 'unknown'; reason: string; skippable?: boolean }>;
  vectors: Array<{ table: string; column: string; source: string; target: string | null }>;
}

export interface FullTransferOptions {
  planFingerprint?: string;
  skipUnknownTables?: string[];
  onTableVerified?: (name: string, completed: number, total: number, rows: number) => void;
  onTableProgress?: (name: string, copied: number, total: number) => void;
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`不支持的数据库标识符：${value}`);
  return `"${value}"`;
}

function jsonProjection(excluded: string[]): string {
  if (excluded.length === 0) return 'to_jsonb(t)::text';
  return `(to_jsonb(t) - ARRAY[${excluded.map(column => `'${identifier(column).slice(1, -1)}'`).join(', ')}]::text[])::text`;
}

async function readPage(engine: BrainEngine, table: string, excluded: string[], cursor: string | null): Promise<Array<{ row: string; position: string }>> {
  return engine.executeRaw<{ row: string; position: string }>(
    `SELECT t.ctid::text AS position, ${jsonProjection(excluded)} AS row FROM ${identifier(table)} t ${cursor ? 'WHERE t.ctid > $2::tid' : ''} ORDER BY t.ctid LIMIT $1`,
    cursor ? [PAGE_SIZE, cursor] : [PAGE_SIZE],
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function canonicalRow(value: string, timestampColumns: string[]): unknown {
  const row = JSON.parse(value) as Record<string, unknown>;
  for (const column of timestampColumns) {
    const raw = row[column];
    if (typeof raw !== 'string') continue;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) continue;
    const fraction = raw.match(/\.([0-9]{1,6})(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/i)?.[1] ?? '';
    row[column] = `${new Date(parsed).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
  }
  return stable(row);
}

class TableDigest {
  private readonly sum = new Uint8Array(32);
  private count = 0;

  add(value: string, timestampColumns: string[]): void {
    const hash = createHash('sha256').update(JSON.stringify(canonicalRow(value, timestampColumns))).digest();
    let carry = 0;
    for (let index = this.sum.length - 1; index >= 0; index -= 1) {
      const total = this.sum[index]! + hash[index]! + carry;
      this.sum[index] = total & 255;
      carry = total >>> 8;
    }
    this.count += 1;
  }

  result(): { count: number; sha256: string } {
    const checksum = createHash('sha256').update(String(this.count)).update(':').update(this.sum).digest('hex');
    return { count: this.count, sha256: checksum };
  }
}

async function tableNames(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map(row => row.table_name);
}

async function columns(engine: BrainEngine, table: string): Promise<ColumnInfo[]> {
  return engine.executeRaw<ColumnInfo>(
    "SELECT column_name, is_generated, is_identity, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
}

async function vectorColumns(engine: BrainEngine): Promise<VectorColumnInfo[]> {
  return engine.executeRaw<VectorColumnInfo>(
    "SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type_name, format_type(a.atttypid, a.atttypmod) AS formatted FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid WHERE n.nspname = 'public' AND c.relkind = 'r' AND t.typname IN ('vector', 'halfvec') AND NOT a.attisdropped ORDER BY c.relname, a.attname",
  );
}

async function alignEmptyTargetVectorColumns(source: BrainEngine, target: BrainEngine): Promise<void> {
  const sourceColumns = await vectorColumns(source);
  const targetColumns = new Map((await vectorColumns(target)).map(column => [`${column.table_name}.${column.column_name}`, column]));
  for (const column of sourceColumns) {
    const counterpart = targetColumns.get(`${column.table_name}.${column.column_name}`);
    if (!counterpart || column.formatted === counterpart.formatted) continue;
    const match = column.formatted.match(/^(vector|halfvec)\(([1-9]\d*)\)$/);
    if (!match || counterpart.type_name !== match[1]) {
      throw new Error(`目标数据库的向量列 ${column.table_name}.${column.column_name} 类型不兼容：${counterpart.formatted} 与 ${column.formatted}`);
    }
    const dimensions = Number(match[2]);
    if (dimensions > (match[1] === 'halfvec' ? 4000 : 16000)) {
      throw new Error(`源数据库的向量列 ${column.table_name}.${column.column_name} 维度无效：${column.formatted}`);
    }
    await target.executeRaw(`ALTER TABLE ${identifier(column.table_name)} ALTER COLUMN ${identifier(column.column_name)} TYPE ${match[1]}(${dimensions})`);
  }
}

async function rowCount(engine: BrainEngine, table: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(`SELECT COUNT(*)::bigint AS count FROM ${identifier(table)}`);
  return Number(rows[0]?.count ?? 0);
}

async function sourceFingerprint(source: BrainEngine): Promise<{ fingerprint: string; schemaVersion: string | null }> {
  const names = await tableNames(source);
  const metadata = [];
  for (const name of names) metadata.push({ name, rows: await rowCount(source, name), columns: await columns(source, name) });
  const version = await source.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'version'");
  const schemaVersion = version[0]?.value ?? null;
  const vectors = await vectorColumns(source);
  return {
    fingerprint: createHash('sha256').update(JSON.stringify({ schemaVersion, metadata, vectors })).digest('hex'),
    schemaVersion,
  };
}

export async function inspectCompleteBrain(source: BrainEngine, target: BrainEngine): Promise<FullTransferPlan> {
  const sourceNames = await tableNames(source);
  const sourceSet = new Set(sourceNames);
  const targetSet = new Set(await tableNames(target));
  const duplicateFacts = await inspectDuplicateFactsIds(source, sourceSet);
  const sourceVectors = await vectorColumns(source);
  const targetVectors = new Map((await vectorColumns(target)).map(column => [`${column.table_name}.${column.column_name}`, column.formatted]));
  const vectors = sourceVectors.map(column => ({
    table: column.table_name, column: column.column_name, source: column.formatted,
    target: targetVectors.get(`${column.table_name}.${column.column_name}`) ?? null,
  }));
  const tables: FullTransferPlan['tables'] = [];
  for (const name of sourceNames) {
    if (name === 'config') continue;
    const rows = await rowCount(source, name);
    if (OPERATIONAL_TABLES.has(name)) {
      tables.push({ name, rows, action: 'skip', reason: '运行时锁和租约不迁移' });
      continue;
    }
    if (await isRegisteredHistoricalBackup(source, name, sourceSet)) {
      tables.push({ name, rows, action: 'skip', reason: LEGACY_TABLE_RULES[name]!.description });
      continue;
    }
    if (!targetSet.has(name)) {
      tables.push({ name, rows, action: rows === 0 ? 'skip' : 'unknown', reason: rows === 0 ? '空旧表' : '当前版本没有对应数据表', skippable: rows > 0 && !CRITICAL_TABLES.has(name) });
      continue;
    }
    if (name === 'facts' && duplicateFacts.ambiguous > 0) {
      tables.push({ name, rows, action: 'unknown', reason: `${duplicateFacts.ambiguous} 条重复主键事实存在引用歧义，不能自动处理`, skippable: false });
      continue;
    }
    const sourceColumns = await columns(source, name);
    const targetShape = await columns(target, name);
    const targetColumns = new Set(targetShape.filter(column => column.is_generated === 'NEVER').map(column => column.column_name));
    const missing = sourceColumns.filter(column => column.is_generated === 'NEVER' && !targetColumns.has(column.column_name));
    if (missing.length > 0 && rows > 0) {
      tables.push({ name, rows, action: 'unknown', reason: `当前版本缺少 ${missing.length} 个旧字段`, skippable: !CRITICAL_TABLES.has(name) });
      continue;
    }
    const sourceColumnNames = new Set(sourceColumns.map(column => column.column_name));
    const required = targetShape.filter(column => !sourceColumnNames.has(column.column_name)
      && column.is_generated === 'NEVER' && column.is_identity === 'NO'
      && column.is_nullable === 'NO' && column.column_default === null);
    if (required.length > 0 && rows > 0) {
      tables.push({ name, rows, action: 'unknown', reason: `当前版本新增 ${required.length} 个无默认值的必填字段`, skippable: !CRITICAL_TABLES.has(name) });
      continue;
    }
    const converted = vectors.some(column => column.table === name && column.target !== column.source);
    const repaired = name === 'facts' && duplicateFacts.replacements.size > 0;
    tables.push({ name, rows, action: converted || repaired ? 'convert' : 'direct', reason: repaired ? `${LEGACY_TABLE_RULES.facts_duplicate_id.description}（${duplicateFacts.replacements.size} 条）` : converted ? '自动对齐向量维度' : '按现有结构迁移' });
  }
  const { fingerprint, schemaVersion } = await sourceFingerprint(source);
  return { schemaVersion, fingerprint, tables, vectors };
}

async function planTables(source: BrainEngine, target: BrainEngine, skipUnknownTables: string[] = []): Promise<{ plans: TablePlan[]; excluded: string[]; skipped: FullTransferReceipt['skippedTables'] }> {
  const sourceTables = await tableNames(source);
  const sourceSet = new Set(sourceTables);
  const duplicateFacts = await inspectDuplicateFactsIds(source, sourceSet);
  if (duplicateFacts.ambiguous > 0) throw new Error(`Facts 有 ${duplicateFacts.ambiguous} 条重复主键且存在引用歧义；迁移已停止，不能跳过正式事实数据。`);
  const targetTables = new Set(await tableNames(target));
  const plans: TablePlan[] = [];
  const excluded: string[] = [];
  const skipped: FullTransferReceipt['skippedTables'] = [];
  for (const table of sourceTables) {
    if (table === 'config') continue;
    const count = await rowCount(source, table);
    if (OPERATIONAL_TABLES.has(table)) {
      excluded.push(table);
      continue;
    }
    if (await isRegisteredHistoricalBackup(source, table, sourceSet)) {
      skipped.push({ name: table, rows: count, reason: 'historical_backup' });
      continue;
    }
    if (!targetTables.has(table)) {
      if (count > 0 && skipUnknownTables.includes(table) && !CRITICAL_TABLES.has(table)) {
        skipped.push({ name: table, rows: count, reason: 'unknown_approved' });
        continue;
      }
      if (count > 0) throw new Error(`目标数据库缺少非空表 ${table}，不能无损迁移`);
      continue;
    }
    const sourceColumns = await columns(source, table);
    const targetColumns = await columns(target, table);
    const targetWritable = new Set(targetColumns.filter(column => column.is_generated === 'NEVER').map(column => column.column_name));
    const missing = sourceColumns.filter(column => column.is_generated === 'NEVER' && !targetWritable.has(column.column_name));
    if (missing.length > 0 && count > 0) {
      if (skipUnknownTables.includes(table) && !CRITICAL_TABLES.has(table)) {
        skipped.push({ name: table, rows: count, reason: 'unknown_approved' });
        continue;
      }
      throw new Error(`目标数据库的 ${table} 缺少列：${missing.map(column => column.column_name).join('、')}`);
    }
    const sourceColumnNames = new Set(sourceColumns.map(column => column.column_name));
    const required = targetColumns.filter(column => !sourceColumnNames.has(column.column_name)
      && column.is_generated === 'NEVER' && column.is_identity === 'NO'
      && column.is_nullable === 'NO' && column.column_default === null);
    if (required.length > 0 && count > 0) {
      if (skipUnknownTables.includes(table) && !CRITICAL_TABLES.has(table)) {
        skipped.push({ name: table, rows: count, reason: 'unknown_approved' });
        continue;
      }
      throw new Error(`目标数据库的 ${table} 新增无默认值的必填列：${required.map(column => column.column_name).join('、')}`);
    }
    const copyColumns = sourceColumns.filter(column => column.is_generated === 'NEVER' && targetWritable.has(column.column_name));
    const copied = new Set(copyColumns.map(column => column.column_name));
    plans.push({
      name: table,
      columns: copyColumns.map(column => column.column_name),
      excludedSource: sourceColumns.filter(column => !copied.has(column.column_name)).map(column => column.column_name),
      excludedTarget: targetColumns.filter(column => !copied.has(column.column_name)).map(column => column.column_name),
      overrideIdentity: copyColumns.some(column => targetColumns.some(targetColumn => targetColumn.column_name === column.column_name && targetColumn.is_identity === 'YES')),
      count,
      timestampColumns: copyColumns.filter(column => column.data_type === 'timestamp with time zone').map(column => column.column_name),
    });
  }
  return { plans, excluded, skipped };
}

async function orderTables(target: BrainEngine, plans: TablePlan[]): Promise<TablePlan[]> {
  const dependencies = await target.executeRaw<{ child: string; parent: string }>(
    "SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace",
  );
  const byName = new Map(plans.map(plan => [plan.name, plan]));
  const remaining = new Map(plans.map(plan => [plan.name, new Set<string>()]));
  for (const dependency of dependencies) {
    if (dependency.child !== dependency.parent && byName.has(dependency.child) && byName.has(dependency.parent)) {
      remaining.get(dependency.child)!.add(dependency.parent);
    }
  }
  const ordered: TablePlan[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, parents]) => parents.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) throw new Error(`数据库存在无法安全排序的外键依赖：${[...remaining.keys()].join('、')}`);
    for (const name of ready) {
      ordered.push(byName.get(name)!);
      remaining.delete(name);
      for (const parents of remaining.values()) parents.delete(name);
    }
  }
  return [...ordered.filter(plan => plan.name !== 'page_generation_clock'), ...ordered.filter(plan => plan.name === 'page_generation_clock')];
}

async function digestRows(engine: BrainEngine, plan: TablePlan, excluded: string[]): Promise<{ count: number; sha256: string }> {
  const digest = new TableDigest();
  const cursorName = 'pmbrain_transfer_digest';
  await engine.executeRaw(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT ${jsonProjection(excluded)} AS row FROM ${identifier(plan.name)} t`);
  try {
    for (;;) {
      const rows = await engine.executeRaw<{ row: string }>(`FETCH FORWARD ${PAGE_SIZE} FROM ${cursorName}`);
      for (const row of rows) digest.add(row.row, plan.timestampColumns);
      if (rows.length < PAGE_SIZE) break;
    }
  } finally {
    await engine.executeRaw(`CLOSE ${cursorName}`);
  }
  return digest.result();
}

async function firstRowDifference(source: BrainEngine, target: BrainEngine, plan: TablePlan, factsReplacements: Map<string, string>): Promise<string> {
  let sourceCursor: string | null = null;
  let targetCursor: string | null = null;
  let rowNumber = 0;
  for (;;) {
    const sourceRows = await readPage(source, plan.name, plan.excludedSource, sourceCursor);
    const targetRows = await readPage(target, plan.name, plan.excludedTarget, targetCursor);
    for (let index = 0; index < Math.min(sourceRows.length, targetRows.length); index += 1) {
      const sourceValue = rewriteLegacyRow(plan.name, sourceRows[index]!.position, JSON.parse(sourceRows[index]!.row) as Record<string, unknown>, factsReplacements);
      const left = canonicalRow(JSON.stringify(sourceValue), plan.timestampColumns) as Record<string, unknown>;
      const right = canonicalRow(targetRows[index]!.row, plan.timestampColumns) as Record<string, unknown>;
      const different = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
      if (different.length > 0) return `第 ${rowNumber + index + 1} 行，源 ID ${String(left.id ?? '无')}、目标 ID ${String(right.id ?? '无')}：${different.join('、')}`;
    }
    if (sourceRows.length !== targetRows.length) return `第 ${rowNumber + 1} 行起分页长度不同`;
    if (sourceRows.length < PAGE_SIZE) return '未定位到行差异';
    rowNumber += sourceRows.length;
    sourceCursor = sourceRows.at(-1)!.position;
    targetCursor = targetRows.at(-1)!.position;
  }
}

async function copyTable(source: BrainEngine, target: BrainEngine, plan: TablePlan, factsReplacements: Map<string, string>, onProgress?: (name: string, copied: number, total: number) => void): Promise<{ name: string; rows: number; sha256: string }> {
  if (plan.count === 0) return { name: plan.name, rows: 0, sha256: new TableDigest().result().sha256 };
  if (plan.columns.length === 0) throw new Error(`${plan.name} 没有可复制的列`);
  const columnSql = plan.columns.map(identifier).join(', ');
  const sourceDigest = new TableDigest();
  let offset = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await readPage(source, plan.name, plan.excludedSource, cursor);
    const transferRows = rows.map(row => {
      const value = rewriteLegacyRow(plan.name, row.position, JSON.parse(row.row) as Record<string, unknown>, factsReplacements);
      const serialized = JSON.stringify(value);
      sourceDigest.add(serialized, plan.timestampColumns);
      return value;
    });
    if (rows.length > 0) {
      const payload = JSON.stringify(transferRows);
      try {
        await target.executeRaw(
          `INSERT INTO ${identifier(plan.name)} (${columnSql}) ${plan.overrideIdentity ? 'OVERRIDING SYSTEM VALUE ' : ''}SELECT ${columnSql} FROM jsonb_populate_recordset(NULL::${identifier(plan.name)}, $1::text::jsonb)`,
          [payload],
        );
      } catch (error) {
        throw new Error(`复制 ${plan.name} 的 ${rows.length} 行失败（批次形态 ${payload[0]}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    offset += rows.length;
    if (offset % 1000 < rows.length || offset === plan.count) onProgress?.(plan.name, offset, plan.count);
    cursor = rows.at(-1)?.position ?? cursor;
    if (rows.length < PAGE_SIZE) break;
  }
  const expected = sourceDigest.result().sha256;
  const actual = await digestRows(target, plan, plan.excludedTarget);
  if (offset !== plan.count || actual.count !== plan.count || actual.sha256 !== expected) {
    const difference = offset === actual.count ? await firstRowDifference(source, target, plan, factsReplacements) : '';
    throw new Error(`${plan.name} 校验失败：源库 ${offset}/${plan.count} 行，目标库 ${actual.count} 行${difference ? `；差异 ${difference}` : ''}`);
  }
  return { name: plan.name, rows: actual.count, sha256: expected };
}

async function resetSequences(engine: BrainEngine, plan: TablePlan): Promise<void> {
  for (const column of plan.columns) {
    const rows = await engine.executeRaw<{ sequence: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS sequence',
      [`public.${plan.name}`, column],
    );
    const sequence = rows[0]?.sequence;
    if (!sequence) continue;
    await engine.executeRaw(
      `SELECT setval($1::regclass, COALESCE((SELECT MAX(${identifier(column)}) FROM ${identifier(plan.name)}), 1), EXISTS(SELECT 1 FROM ${identifier(plan.name)}))`,
      [sequence],
    );
  }
}

export async function transferCompleteBrain(source: BrainEngine, target: BrainEngine, options: FullTransferOptions = {}): Promise<FullTransferReceipt> {
  if (options.planFingerprint) {
    const actual = await sourceFingerprint(source);
    if (actual.fingerprint !== options.planFingerprint) throw new Error('源数据库在预检后发生变化，请重新扫描迁移方案。');
  }
  const preflight = await planTables(source, target, options.skipUnknownTables);
  const duplicateFacts = await inspectDuplicateFactsIds(source, new Set(await tableNames(source)));
  const targetTables = await tableNames(target);
  for (const table of targetTables) {
    if (table === 'config' || OPERATIONAL_TABLES.has(table)) continue;
    const count = await rowCount(target, table);
    if (table === 'sources') {
      const nonDefault = await target.executeRaw<{ id: string }>("SELECT id FROM sources WHERE id <> 'default' LIMIT 1");
      if (nonDefault.length === 0 && count <= 1) continue;
    }
    if (table === 'page_generation_clock') {
      const initial = await target.executeRaw<{ value: number | string }>('SELECT value FROM page_generation_clock WHERE id = 1');
      if (count === 1 && Number(initial[0]?.value) === 0) continue;
    }
    if (count > 0) throw new Error(`目标数据库非空：${table} 已有 ${count} 条记录`);
  }
  const tables = await target.transaction(async transaction => {
    await alignEmptyTargetVectorColumns(source, transaction);
    const ordered = await orderTables(transaction, preflight.plans);
    for (const plan of ordered) await transaction.executeRaw(`ALTER TABLE ${identifier(plan.name)} DISABLE TRIGGER USER`);
    await transaction.executeRaw("DELETE FROM sources WHERE id = 'default'");
    await transaction.executeRaw('DELETE FROM page_generation_clock WHERE id = 1');
    const copied: FullTransferReceipt['tables'] = [];
    for (const plan of ordered) {
      const verified = await copyTable(source, transaction, plan, duplicateFacts.replacements, options.onTableProgress);
      copied.push(verified);
      await resetSequences(transaction, plan);
      options.onTableVerified?.(plan.name, copied.length, ordered.length, verified.rows);
    }
    const sourceConfig = await source.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key <> ALL($1::text[]) ORDER BY key', [SCHEMA_CONFIG_KEYS]);
    await transaction.executeRaw('DELETE FROM config WHERE key <> ALL($1::text[])', [SCHEMA_CONFIG_KEYS]);
    for (const entry of sourceConfig) {
      await transaction.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [entry.key, entry.value]);
    }
    const targetConfig = await transaction.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key <> ALL($1::text[]) ORDER BY key', [SCHEMA_CONFIG_KEYS]);
    if (JSON.stringify(sourceConfig) !== JSON.stringify(targetConfig)) throw new Error('数据库配置校验失败');
    for (const plan of ordered) await transaction.executeRaw(`ALTER TABLE ${identifier(plan.name)} ENABLE TRIGGER USER`);
    return copied;
  });
  return {
    status: 'verified', tables, skippedTables: preflight.skipped,
    converted: duplicateFacts.replacements.size > 0 ? [{ rule: 'facts_duplicate_id', rows: duplicateFacts.replacements.size }] : [],
    excludedOperationalTables: preflight.excluded,
  };
}
