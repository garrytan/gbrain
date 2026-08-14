/**
 * advisor/collect-version.ts — gbrain version drift.
 *
 * Reads the update CACHE only — never the network (the advisor op must stay fast
 * and cron-safe). The cache is refreshed out-of-band by `gbrain check-update` /
 * the self-upgrade refresh path.
 */

import { pendingUpgradeVersion } from '../self-upgrade.ts';
import type { AdvisorCollector } from './types.ts';

export const collectVersion: AdvisorCollector = {
  id: 'version',
  collect: async (ctx) => {
    // Shared stale/foreign-cache guard: fresh cache only, and only an upgrade
    // strictly newer than the RUNNING version (pendingUpgradeVersion owns the
    // rule; never throws).
    const latest = pendingUpgradeVersion(ctx.version, Date.now());
    if (!latest) return [];
    return [
      {
        id: 'version_drift',
        severity: 'warn',
        title: `gbrain ${latest} is available — you're on ${ctx.version}.`,
        detail: 'A newer release shipped fixes and features. Upgrading keeps the brain current.',
        fix: { command_argv: ['gbrain', 'upgrade'] },
        collector: 'version',
        ask_user: true,
      },
    ];
  },
};
