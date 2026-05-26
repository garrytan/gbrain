/**
 * Memory groups persistence and admin helpers (v0.35 memory ACL).
 */

import type { SqlQuery } from './sql-query.ts';
import type { MemoryGroupPolicy } from './memory-policy.ts';

export const DEFAULT_GROUP_IDS = {
  admin: 'mg_admin',
  coding: 'mg_coding',
  management: 'mg_management',
  personal: 'mg_personal',
} as const;

export interface MemoryGroupRow {
  id: string;
  name: string;
  description: string | null;
  read_audiences: string[];
  write_audiences: string[];
  read_slug_prefixes: string[];
  write_slug_prefixes: string[];
  denied_audiences: string[];
  bypass_policy: boolean;
  created_at: string;
  client_count?: number;
}

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function rowToPolicy(row: MemoryGroupRow): MemoryGroupPolicy {
  return {
    id: row.id,
    name: row.name,
    readAudiences: parseJsonArray(row.read_audiences),
    writeAudiences: parseJsonArray(row.write_audiences),
    readSlugPrefixes: parseJsonArray(row.read_slug_prefixes),
    writeSlugPrefixes: parseJsonArray(row.write_slug_prefixes),
    deniedAudiences: parseJsonArray(row.denied_audiences),
    bypassPolicy: Boolean(row.bypass_policy),
  };
}

export function isMemoryGroupsSchemaMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /memory_groups|oauth_client_memory_groups|relation.*does not exist/i.test(msg);
}

export async function loadMemoryGroupForClient(
  sql: SqlQuery,
  clientId: string,
): Promise<MemoryGroupPolicy | null | undefined> {
  try {
    const rows = await sql`
      SELECT g.id, g.name, g.description,
             g.read_audiences, g.write_audiences,
             g.read_slug_prefixes, g.write_slug_prefixes,
             g.denied_audiences, g.bypass_policy, g.created_at
      FROM oauth_client_memory_groups m
      JOIN memory_groups g ON g.id = m.group_id
      WHERE m.client_id = ${clientId}
      LIMIT 1
    `;
    if (!rows.length) return null;
    return rowToPolicy(rows[0] as MemoryGroupRow);
  } catch (err) {
    if (isMemoryGroupsSchemaMissing(err)) return undefined;
    throw err;
  }
}

export async function listMemoryGroups(sql: SqlQuery): Promise<MemoryGroupRow[]> {
  const rows = await sql`
    SELECT g.id, g.name, g.description,
           g.read_audiences, g.write_audiences,
           g.read_slug_prefixes, g.write_slug_prefixes,
           g.denied_audiences, g.bypass_policy, g.created_at,
           (SELECT count(*)::int FROM oauth_client_memory_groups m WHERE m.group_id = g.id) as client_count
    FROM memory_groups g
    ORDER BY g.name
  `;
  return rows as MemoryGroupRow[];
}

export async function getMemoryGroupById(sql: SqlQuery, id: string): Promise<MemoryGroupRow | null> {
  const rows = await sql`
    SELECT g.id, g.name, g.description,
           g.read_audiences, g.write_audiences,
           g.read_slug_prefixes, g.write_slug_prefixes,
           g.denied_audiences, g.bypass_policy, g.created_at
    FROM memory_groups g WHERE g.id = ${id}
  `;
  return rows.length ? (rows[0] as MemoryGroupRow) : null;
}

export async function getMemoryGroupByName(sql: SqlQuery, name: string): Promise<MemoryGroupRow | null> {
  const rows = await sql`
    SELECT g.id, g.name, g.description,
           g.read_audiences, g.write_audiences,
           g.read_slug_prefixes, g.write_slug_prefixes,
           g.denied_audiences, g.bypass_policy, g.created_at
    FROM memory_groups g WHERE g.name = ${name}
  `;
  return rows.length ? (rows[0] as MemoryGroupRow) : null;
}

export interface UpsertMemoryGroupInput {
  name: string;
  description?: string;
  readAudiences: string[];
  writeAudiences: string[];
  readSlugPrefixes?: string[];
  writeSlugPrefixes?: string[];
  deniedAudiences?: string[];
  bypassPolicy?: boolean;
}

export async function createMemoryGroup(
  sql: SqlQuery,
  id: string,
  input: UpsertMemoryGroupInput,
): Promise<MemoryGroupRow> {
  await sql`
    INSERT INTO memory_groups (
      id, name, description, read_audiences, write_audiences,
      read_slug_prefixes, write_slug_prefixes, denied_audiences, bypass_policy
    ) VALUES (
      ${id}, ${input.name}, ${input.description ?? null},
      ${JSON.stringify(input.readAudiences)},
      ${JSON.stringify(input.writeAudiences)},
      ${JSON.stringify(input.readSlugPrefixes ?? [])},
      ${JSON.stringify(input.writeSlugPrefixes ?? [])},
      ${JSON.stringify(input.deniedAudiences ?? [])},
      ${input.bypassPolicy === true}
    )
  `;
  const row = await getMemoryGroupById(sql, id);
  if (!row) throw new Error('Failed to create memory group');
  return row;
}

export async function updateMemoryGroup(
  sql: SqlQuery,
  id: string,
  input: UpsertMemoryGroupInput,
): Promise<MemoryGroupRow | null> {
  await sql`
    UPDATE memory_groups SET
      name = ${input.name},
      description = ${input.description ?? null},
      read_audiences = ${JSON.stringify(input.readAudiences)},
      write_audiences = ${JSON.stringify(input.writeAudiences)},
      read_slug_prefixes = ${JSON.stringify(input.readSlugPrefixes ?? [])},
      write_slug_prefixes = ${JSON.stringify(input.writeSlugPrefixes ?? [])},
      denied_audiences = ${JSON.stringify(input.deniedAudiences ?? [])},
      bypass_policy = ${input.bypassPolicy === true}
    WHERE id = ${id}
  `;
  return getMemoryGroupById(sql, id);
}

export async function deleteMemoryGroup(sql: SqlQuery, id: string): Promise<{ deleted: boolean; reason?: string }> {
  const [count] = await sql`
    SELECT count(*)::int as n FROM oauth_client_memory_groups WHERE group_id = ${id}
  `;
  if ((count as { n: number }).n > 0) {
    return { deleted: false, reason: 'clients_assigned' };
  }
  await sql`DELETE FROM memory_groups WHERE id = ${id}`;
  return { deleted: true };
}

export async function assignClientToMemoryGroup(
  sql: SqlQuery,
  clientId: string,
  groupId: string,
): Promise<void> {
  await sql`
    INSERT INTO oauth_client_memory_groups (client_id, group_id)
    VALUES (${clientId}, ${groupId})
    ON CONFLICT (client_id) DO UPDATE SET group_id = ${groupId}
  `;
}

export async function seedDefaultMemoryGroups(sql: SqlQuery): Promise<void> {
  const defaults: Array<{ id: string; input: UpsertMemoryGroupInput }> = [
    {
      id: DEFAULT_GROUP_IDS.admin,
      input: {
        name: 'Admin',
        description: 'Full access for portal and operators',
        readAudiences: ['*'],
        writeAudiences: ['*'],
        bypassPolicy: true,
      },
    },
    {
      id: DEFAULT_GROUP_IDS.coding,
      input: {
        name: 'Coding',
        description: 'Coding agents and dev workspaces',
        readAudiences: ['coding', 'project:*', 'public', 'research'],
        writeAudiences: ['coding', 'project:*', 'public', 'research'],
      },
    },
    {
      id: DEFAULT_GROUP_IDS.management,
      input: {
        name: 'Management',
        description: 'Manager agents with broad read/write',
        readAudiences: ['*'],
        writeAudiences: ['personal', 'work', 'coding', 'research', 'public', 'project:*'],
      },
    },
    {
      id: DEFAULT_GROUP_IDS.personal,
      input: {
        name: 'Personal',
        description: 'Private personal context only',
        readAudiences: ['personal', 'public'],
        writeAudiences: ['personal', 'public'],
      },
    },
  ];

  for (const { id, input } of defaults) {
    const existing = await getMemoryGroupById(sql, id);
    if (!existing) {
      await createMemoryGroup(sql, id, input);
    }
  }
}

export function inferGroupIdFromClientName(name: string): string | null {
  if (/memory-portal|admin/i.test(name)) return DEFAULT_GROUP_IDS.admin;
  if (/-cursor-personal|personal/i.test(name)) return DEFAULT_GROUP_IDS.personal;
  if (/management|manager/i.test(name)) return DEFAULT_GROUP_IDS.management;
  if (/-cursor-coding|coding/i.test(name)) return DEFAULT_GROUP_IDS.coding;
  if (/-forgetmenot-cursor/.test(name)) return DEFAULT_GROUP_IDS.coding;
  return null;
}

export async function tryAutoAssignClientGroup(
  sql: SqlQuery,
  clientId: string,
  clientName: string,
): Promise<void> {
  try {
    const groupId = inferGroupIdFromClientName(clientName);
    if (!groupId) return;
    const existing = await sql`
      SELECT 1 FROM oauth_client_memory_groups WHERE client_id = ${clientId}
    `;
    if (existing.length) return;
    await assignClientToMemoryGroup(sql, clientId, groupId);
  } catch (err) {
    if (isMemoryGroupsSchemaMissing(err)) return;
    throw err;
  }
}

export async function backfillClientMemoryGroups(sql: SqlQuery): Promise<number> {
  const clients = await sql`
    SELECT client_id, client_name, scope
    FROM oauth_clients
    WHERE deleted_at IS NULL
  `;
  let assigned = 0;
  for (const row of clients) {
    const clientId = row.client_id as string;
    const name = (row.client_name as string) ?? '';
    const scope = String(row.scope ?? '');
    const existing = await sql`
      SELECT 1 FROM oauth_client_memory_groups WHERE client_id = ${clientId}
    `;
    if (existing.length) continue;

    let groupId = DEFAULT_GROUP_IDS.coding;
    if (
      scope.includes('admin')
      || /memory-portal/i.test(name)
      || name.endsWith('-admin')
    ) {
      groupId = DEFAULT_GROUP_IDS.admin;
    } else if (/personal/i.test(name) || name.includes('-cursor-personal')) {
      groupId = DEFAULT_GROUP_IDS.personal;
    } else if (/management|manager/i.test(name)) {
      groupId = DEFAULT_GROUP_IDS.management;
    }

    await assignClientToMemoryGroup(sql, clientId, groupId);
    assigned++;
  }
  return assigned;
}
