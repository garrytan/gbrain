import type { Migration } from './types.ts';
import { SHARED_SKILLS_SCHEMA_SQL } from '../shared-skills/schema-all.ts';

export const v164: Migration = {
  version: 164,
  name: 'shared_brain_skills_and_membership',
  idempotent: true,
  sql: SHARED_SKILLS_SCHEMA_SQL,
  verify: async (engine) => {
    const [row] = await engine.executeRaw<{ heads: string | null; members: string | null; protocol: boolean }>(
      `SELECT to_regclass('shared_skill_heads')::text AS heads,
          to_regclass('shared_skill_members')::text AS members,
          EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
            AND table_name='persistence_requests' AND column_name='target_kind') AS protocol`);
    return Boolean(row?.heads && row?.members && row?.protocol);
  },
};
