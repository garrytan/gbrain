/**
 * Migration-time seed/backfill using BrainEngine.executeRaw (no tagged sql).
 */

import type { BrainEngine } from './engine.ts';
import { DEFAULT_GROUP_IDS } from './memory-groups.ts';

const SEED_GROUPS: Array<{
  id: string;
  name: string;
  description: string;
  read: string[];
  write: string[];
  bypass: boolean;
}> = [
  {
    id: DEFAULT_GROUP_IDS.admin,
    name: 'Admin',
    description: 'Full access for portal and operators',
    read: ['*'],
    write: ['*'],
    bypass: true,
  },
  {
    id: DEFAULT_GROUP_IDS.coding,
    name: 'Coding',
    description: 'Coding agents and dev workspaces',
    read: ['coding', 'project:*', 'public', 'research'],
    write: ['coding', 'project:*', 'public', 'research'],
    bypass: false,
  },
  {
    id: DEFAULT_GROUP_IDS.management,
    name: 'Management',
    description: 'Manager agents with broad read/write',
    read: ['*'],
    write: ['personal', 'work', 'coding', 'research', 'public', 'project:*'],
    bypass: false,
  },
  {
    id: DEFAULT_GROUP_IDS.personal,
    name: 'Personal',
    description: 'Private personal context only',
    read: ['personal', 'public'],
    write: ['personal', 'public'],
    bypass: false,
  },
];

export async function seedAndBackfillMemoryGroups(engine: BrainEngine): Promise<void> {
  for (const g of SEED_GROUPS) {
    await engine.executeRaw(
      `INSERT INTO memory_groups (
        id, name, description, read_audiences, write_audiences,
        read_slug_prefixes, write_slug_prefixes, denied_audiences, bypass_policy
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $6)
      ON CONFLICT (id) DO NOTHING`,
      [
        g.id,
        g.name,
        g.description,
        JSON.stringify(g.read),
        JSON.stringify(g.write),
        g.bypass,
      ],
    );
  }

  const clients = await engine.executeRaw<{ client_id: string; client_name: string; scope: string }>(
    `SELECT client_id, client_name, scope FROM oauth_clients WHERE deleted_at IS NULL`,
  );

  for (const row of clients) {
    const existing = await engine.executeRaw(
      `SELECT 1 FROM oauth_client_memory_groups WHERE client_id = $1`,
      [row.client_id],
    );
    if (existing.length) continue;

    let groupId = DEFAULT_GROUP_IDS.coding;
    const scope = String(row.scope ?? '');
    const name = row.client_name ?? '';
    if (scope.includes('admin') || /memory-portal/i.test(name)) {
      groupId = DEFAULT_GROUP_IDS.admin;
    } else if (/personal/i.test(name) || name.includes('-cursor-personal')) {
      groupId = DEFAULT_GROUP_IDS.personal;
    } else if (/management|manager/i.test(name)) {
      groupId = DEFAULT_GROUP_IDS.management;
    }

    await engine.executeRaw(
      `INSERT INTO oauth_client_memory_groups (client_id, group_id) VALUES ($1, $2)`,
      [row.client_id, groupId],
    );
  }
}
