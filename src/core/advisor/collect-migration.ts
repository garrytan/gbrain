/**
 * advisor/collect-migration.ts — pending schema migrations.
 *
 * The single critical signal: an un-migrated brain can be missing columns/
 * indexes newer code expects. Fix is idempotent + safe to run via --apply.
 */

import { hasPendingMigrations } from '../migrate.ts';
import type { AdvisorCollector } from './types.ts';

export const collectMigration: AdvisorCollector = {
  id: 'migration',
  collect: async (ctx) => {
    let pending = false;
    try {
      pending = await hasPendingMigrations(ctx.engine);
    } catch {
      return []; // can't determine (e.g. no config table yet) → say nothing
    }
    if (!pending) return [];
    return [
      {
        id: 'pending_migration',
        severity: 'critical',
        title: 'Schema migrations are pending — run them before relying on newer features.',
        detail: 'Newer gbrain code assumes the latest schema; an un-migrated brain can fail or under-perform.',
        fix: { command_argv: ['gbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' },
        collector: 'migration',
        ask_user: true,
      },
    ];
  },
};
