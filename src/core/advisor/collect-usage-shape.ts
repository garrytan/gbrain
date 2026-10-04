/**
 * advisor/collect-usage-shape.ts — brain health vs usage.
 *
 * Reads getStats + getHealth (both engine-parity-pinned). Surfaces the
 * highest-leverage health gaps: low embedding coverage (search is degraded),
 * orphan pages (knowledge not connected), and a low composite brain_score.
 *
 * Perf note (eng-review): getHealth runs the orphan/dead-link scan — heavier
 * than getStats. The advisor calls it on explicit `gbrain advisor` / weekly
 * cron; the sync-cadence path uses getStats only (commands/advisor.ts /
 * the sync hook decide which collectors to run).
 */

import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectUsageShape: AdvisorCollector = {
  id: 'usage-shape',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    let pageCount = 0;
    try {
      const stats = await ctx.engine.getStats();
      pageCount = stats.page_count;
    } catch {
      return []; // no stats → empty brain or unreachable; nothing to advise
    }
    if (pageCount === 0) return [];

    try {
      const health = await ctx.engine.getHealth();
      // A keyless-by-choice brain has no vectors by design; `embed --all` refuses there (setup-smells covers it).
      if (health.embed_coverage < 0.7 && health.missing_embeddings > 0 && ctx.config?.embedding_disabled !== true) {
        findings.push({
          id: 'low_embed_coverage',
          severity: 'warn',
          title: `Only ${Math.round(health.embed_coverage * 100)}% of content is embedded — semantic search is degraded.`,
          detail: `${health.missing_embeddings} pages are missing embeddings. Backfill to restore full recall.`,
          fix: { command_argv: ['gbrain', 'embed', '--all'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
      if (health.orphan_pages > 0) {
        findings.push({
          id: 'orphan_pages',
          severity: 'info',
          title: `${health.orphan_pages} page${health.orphan_pages === 1 ? ' has' : 's have'} no links in or out.`,
          detail: 'Orphaned pages do not surface through graph traversal — connect or review them.',
          fix: { command_argv: ['gbrain', 'orphans'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
      if (health.dead_links > 0) {
        findings.push({
          id: 'dead_links',
          severity: 'info',
          title: `${health.dead_links} link${health.dead_links === 1 ? '' : 's'} point to a page that no longer exists.`,
          fix: { command_argv: ['gbrain', 'doctor'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
    } catch {
      /* getHealth unavailable → skip the health-derived findings */
    }

    return findings;
  },
};
