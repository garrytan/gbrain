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
    let entityCount = 0;
    try {
      const stats = await ctx.engine.getStats();
      pageCount = stats.page_count;
      entityCount = (stats.pages_by_type.person ?? 0) + (stats.pages_by_type.company ?? 0);
    } catch {
      return []; // no stats → empty brain or unreachable; nothing to advise
    }
    if (pageCount === 0) return [];

    try {
      const health = await ctx.engine.getHealth();
      if (health.embed_coverage < 0.7 && health.missing_embeddings > 0) {
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
      if (entityCount >= 10 && health.link_coverage < 0.5) {
        findings.push({
          id: 'low_entity_link_coverage',
          severity: 'warn',
          title: `Only ${Math.round(health.link_coverage * 100)}% of entity pages have an inbound link.`,
          detail: 'Preview stale link extraction before writing, then inspect graph health with doctor.',
          fix: { command_argv: ['gbrain', 'extract', '--stale', '--dry-run'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
      if (entityCount >= 10 && health.timeline_coverage < 0.5) {
        findings.push({
          id: 'low_entity_timeline_coverage',
          severity: 'info',
          title: `Only ${Math.round(health.timeline_coverage * 100)}% of entity pages have a structured timeline entry.`,
          detail: 'Review timeline extraction in dry-run mode; Chronicle events are measured separately.',
          fix: { command_argv: ['gbrain', 'extract', '--stale', '--dry-run'] },
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
