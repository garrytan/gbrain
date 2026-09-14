// v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
// Brain-state (not workspace-dependent), so it runs over MCP too. Two signals:
//   - unresolved ontology conflicts (genuine disagreement, not supersession)
//   - recent meetings not yet swept into the timeline (coverage gap)
// Advisory display only (no dispatch_id) — the user runs the shown command.
import type { AdvisorCollector, AdvisorContext, AdvisorFinding } from './types.ts';
import { classifyCalendarEvent } from '../calendar-horizon.ts';

export const collectChronicle: AdvisorCollector = {
  id: 'chronicle',
  collect: async (ctx: AdvisorContext): Promise<AdvisorFinding[]> => {
    const findings: AdvisorFinding[] = [];

    // 1. Unresolved ontology conflicts.
    try {
      const conflicts = await ctx.engine.findOntologyConflicts({ minConfidence: 0.5 });
      if (conflicts.length > 0) {
        findings.push({
          id: 'ontology_conflicts',
          severity: 'warn',
          title: `${conflicts.length} entity dimension(s) have conflicting current values`,
          detail: conflicts.slice(0, 5).map((c) => `${c.entity_slug}.${c.dimension}`).join(', '),
          fix: { command_argv: ['gbrain', 'ontology-contradictions'] },
          collector: 'chronicle',
          ask_user: false,
        });
      }
    } catch {
      // Ontology columns may be absent on a brain that hasn't migrated; ignore.
    }

    // 2. Recent meetings not yet in the timeline (coverage gap).
    // Query by typed effective_date (actual event occurrence in past 30 days),
    // NEVER updated_at or raw SQL ::timestamptz frontmatter casts.
    try {
      const rows = await ctx.engine.executeRaw<{
        id: string;
        slug: string;
        type: string;
        frontmatter: unknown;
        effective_date: string | null;
      }>(
        `SELECT p.id, p.slug, p.type, p.frontmatter, p.effective_date FROM pages p
         WHERE p.type IN ('meeting','conversation','calendar-event') AND p.deleted_at IS NULL
           AND p.effective_date >= now() - interval '30 days'
           AND p.effective_date <= now()
           AND NOT EXISTS (
             SELECT 1 FROM timeline_entries te
             WHERE te.page_id = p.id AND te.event_page_id IS NOT NULL
           )`,
      );
      const eligibleRows = rows.filter((r) => {
        let fm: Record<string, unknown> = {};
        if (typeof r.frontmatter === 'string') {
          try {
            fm = JSON.parse(r.frontmatter);
          } catch {
            fm = {};
          }
        } else if (r.frontmatter && typeof r.frontmatter === 'object') {
          fm = r.frontmatter as Record<string, unknown>;
        }
        const cal = classifyCalendarEvent({
          slug: r.slug,
          type: r.type,
          frontmatter: fm,
        });
        if (cal.isCalendar && (cal.isFuture || !cal.valid)) {
          return false;
        }
        return true;
      });
      const gap = eligibleRows.length;
      if (gap > 0) {
        findings.push({
          id: 'chronicle_coverage_gap',
          severity: 'info',
          title: `${gap} recent meeting(s) aren't in the timeline yet`,
          detail: 'Sweep them into events with `gbrain chronicle-backfill`, or enable auto_chronicle.',
          fix: { command_argv: ['gbrain', 'chronicle-backfill'] },
          collector: 'chronicle',
          ask_user: true,
        });
      }
    } catch {
      // timeline_entries.event_page_id may be absent pre-migration; ignore.
    }

    return findings;
  },
};
