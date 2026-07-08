/**
 * Dialect-parameterized SQL for the personal-memory store
 * (profile_memory_entries + personal_episode_entries), shared by
 * SQLiteEngine and PgEngineBase (O1 first slice).
 *
 * Behavior contract (pinned by the personal-memory parity seeds in
 * test/parity.test.ts):
 * - Postgres dialect: single INSERT ... RETURNING round trip; created_at /
 *   updated_at come from table defaults and upsert refresh uses server now().
 * - SQLite dialect: write then read back; created_at / updated_at are bound
 *   client-side ISO strings and upsert refresh uses excluded.updated_at.
 *
 * Row mapping stays in the engines: this module returns raw rows so each
 * engine keeps its existing row-to-entry conversion unchanged.
 */

import type { DialectQueryable } from '../engine-dialect.ts';
import type {
  PersonalEpisodeEntryInput,
  PersonalEpisodeFilters,
  ProfileMemoryEntryInput,
  ProfileMemoryFilters,
} from '../types.ts';

const PROFILE_MEMORY_SELECT_COLUMNS =
  `id, scope_id, profile_type, subject, content, source_refs, sensitivity,
              export_status, last_confirmed_at, superseded_by, created_at, updated_at`;

const PERSONAL_EPISODE_SELECT_COLUMNS =
  `id, scope_id, title, start_time, end_time, source_kind, summary,
              source_refs, candidate_ids, created_at, updated_at`;

function toNullableIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function upsertProfileMemoryEntryRow(
  db: DialectQueryable,
  input: ProfileMemoryEntryInput,
): Promise<Record<string, unknown>> {
  const dialect = db.dialect;
  const columns = [
    'id', 'scope_id', 'profile_type', 'subject', 'content', 'source_refs', 'sensitivity',
    'export_status', 'last_confirmed_at', 'superseded_by',
  ];
  const params: unknown[] = [
    input.id,
    input.scope_id,
    input.profile_type,
    input.subject,
    input.content,
    JSON.stringify(input.source_refs ?? []),
    input.sensitivity,
    input.export_status,
    toNullableIso(input.last_confirmed_at),
    input.superseded_by ?? null,
  ];
  const values = columns.map((column, index) =>
    column === 'source_refs' ? dialect.jsonPlaceholder(index + 1) : dialect.placeholder(index + 1));
  const updateAssignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);

  if (dialect.serverNow === null) {
    const timestamp = new Date().toISOString();
    columns.push('created_at', 'updated_at');
    params.push(timestamp, timestamp);
    values.push(dialect.placeholder(params.length - 1), dialect.placeholder(params.length));
    updateAssignments.push('updated_at = excluded.updated_at');
  } else {
    updateAssignments.push(`updated_at = ${dialect.serverNow}`);
  }

  const insertSql =
    `INSERT INTO profile_memory_entries (${columns.join(', ')})
      VALUES (${values.join(', ')})
      ON CONFLICT (id) DO UPDATE SET
        ${updateAssignments.join(',\n        ')}`;

  if (dialect.supportsReturning) {
    const rows = await db.query(`${insertSql}\n      RETURNING ${PROFILE_MEMORY_SELECT_COLUMNS}`, params);
    return rows[0];
  }

  await db.run(insertSql, params);
  const rows = await db.query(
    `SELECT ${PROFILE_MEMORY_SELECT_COLUMNS}
       FROM profile_memory_entries
       WHERE id = ${dialect.placeholder(1)}`,
    [input.id],
  );
  if (rows.length === 0) throw new Error(`Profile memory entry not found after upsert: ${input.id}`);
  return rows[0];
}

export async function getProfileMemoryEntryRow(
  db: DialectQueryable,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.query(
    `SELECT ${PROFILE_MEMORY_SELECT_COLUMNS}
       FROM profile_memory_entries
       WHERE id = ${db.dialect.placeholder(1)}`,
    [id],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function listProfileMemoryEntryRows(
  db: DialectQueryable,
  filters?: ProfileMemoryFilters,
): Promise<Record<string, unknown>[]> {
  const dialect = db.dialect;
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (filters?.scope_id) {
    params.push(filters.scope_id);
    clauses.push(`scope_id = ${dialect.placeholder(params.length)}`);
  }
  if (filters?.subject) {
    params.push(filters.subject);
    clauses.push(`subject = ${dialect.placeholder(params.length)}`);
  }
  if (filters?.profile_type) {
    params.push(filters.profile_type);
    clauses.push(`profile_type = ${dialect.placeholder(params.length)}`);
  }

  params.push(limit);
  params.push(offset);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.query(
    `SELECT ${PROFILE_MEMORY_SELECT_COLUMNS}
       FROM profile_memory_entries
       ${whereClause}
       ORDER BY updated_at DESC, id ASC
       LIMIT ${dialect.placeholder(params.length - 1)}
       OFFSET ${dialect.placeholder(params.length)}`,
    params,
  );
}

export async function deleteProfileMemoryEntryRow(db: DialectQueryable, id: string): Promise<void> {
  await db.run(`DELETE FROM profile_memory_entries WHERE id = ${db.dialect.placeholder(1)}`, [id]);
}

export async function createPersonalEpisodeEntryRow(
  db: DialectQueryable,
  input: PersonalEpisodeEntryInput,
): Promise<Record<string, unknown>> {
  const dialect = db.dialect;
  const columns = [
    'id', 'scope_id', 'title', 'start_time', 'end_time', 'source_kind', 'summary',
    'source_refs', 'candidate_ids',
  ];
  const params: unknown[] = [
    input.id,
    input.scope_id,
    input.title,
    toNullableIso(input.start_time),
    toNullableIso(input.end_time),
    input.source_kind,
    input.summary,
    JSON.stringify(input.source_refs ?? []),
    JSON.stringify(input.candidate_ids ?? []),
  ];
  const jsonColumns = new Set(['source_refs', 'candidate_ids']);
  const values = columns.map((column, index) =>
    jsonColumns.has(column) ? dialect.jsonPlaceholder(index + 1) : dialect.placeholder(index + 1));

  if (dialect.serverNow === null) {
    const timestamp = new Date().toISOString();
    columns.push('created_at', 'updated_at');
    params.push(timestamp, timestamp);
    values.push(dialect.placeholder(params.length - 1), dialect.placeholder(params.length));
  }

  const insertSql =
    `INSERT INTO personal_episode_entries (${columns.join(', ')})
      VALUES (${values.join(', ')})`;

  if (dialect.supportsReturning) {
    const rows = await db.query(`${insertSql}\n      RETURNING ${PERSONAL_EPISODE_SELECT_COLUMNS}`, params);
    return rows[0];
  }

  await db.run(insertSql, params);
  const rows = await db.query(
    `SELECT ${PERSONAL_EPISODE_SELECT_COLUMNS}
       FROM personal_episode_entries
       WHERE id = ${dialect.placeholder(1)}`,
    [input.id],
  );
  if (rows.length === 0) throw new Error(`Personal episode entry not found after create: ${input.id}`);
  return rows[0];
}

export async function getPersonalEpisodeEntryRow(
  db: DialectQueryable,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.query(
    `SELECT ${PERSONAL_EPISODE_SELECT_COLUMNS}
       FROM personal_episode_entries
       WHERE id = ${db.dialect.placeholder(1)}`,
    [id],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function listPersonalEpisodeEntryRows(
  db: DialectQueryable,
  filters?: PersonalEpisodeFilters,
): Promise<Record<string, unknown>[]> {
  const dialect = db.dialect;
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (filters?.scope_id) {
    params.push(filters.scope_id);
    clauses.push(`scope_id = ${dialect.placeholder(params.length)}`);
  }
  if (filters?.title) {
    params.push(filters.title);
    clauses.push(`title = ${dialect.placeholder(params.length)}`);
  }
  if (filters?.source_kind) {
    params.push(filters.source_kind);
    clauses.push(`source_kind = ${dialect.placeholder(params.length)}`);
  }

  params.push(limit);
  params.push(offset);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.query(
    `SELECT ${PERSONAL_EPISODE_SELECT_COLUMNS}
       FROM personal_episode_entries
       ${whereClause}
       ORDER BY start_time DESC, id ASC
       LIMIT ${dialect.placeholder(params.length - 1)}
       OFFSET ${dialect.placeholder(params.length)}`,
    params,
  );
}

export async function deletePersonalEpisodeEntryRow(db: DialectQueryable, id: string): Promise<void> {
  await db.run(`DELETE FROM personal_episode_entries WHERE id = ${db.dialect.placeholder(1)}`, [id]);
}
