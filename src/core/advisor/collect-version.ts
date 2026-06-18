/**
 * advisor/collect-version.ts — gbrain version drift.
 *
 * Reads the update CACHE only — never the network (the advisor op must stay fast
 * and cron-safe). The cache is refreshed out-of-band by `gbrain check-update` /
 * the self-upgrade refresh path.
 */

import { readUpdateCache } from '../self-upgrade.ts';
import type { AdvisorCollector } from './types.ts';

export const collectVersion: AdvisorCollector = {
  id: 'version',
  collect: async (ctx) => {
    let latest: string | undefined;
    try {
      const entry = readUpdateCache();
      if (entry && entry.marker.kind === 'upgrade_available' && entry.marker.latest) {
        latest = entry.marker.latest;
      }
    } catch {
      return [];
    }
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
