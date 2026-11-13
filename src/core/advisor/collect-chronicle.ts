// v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
// Brain-state (not workspace-dependent), so it runs over MCP too. Two signals:
//   - unresolved ontology conflicts (genuine disagreement, not supersession)
//   - recent meetings not yet swept into the timeline (coverage gap)
//   - automatic extraction (#5876): the unconfirmed default-on change, an invalid setting,
//     pending pages with no chat provider, failures, and 7-day spend with the largest writer's share
// Advisory display only (no dispatch_id) — the user runs the shown command.
import type { AdvisorCollector, AdvisorContext, AdvisorFinding } from './types.ts';
import {
  AUTO_CHRONICLE_KEEP_ARGV, AUTO_CHRONICLE_OPT_OUT_ARGV, autoChronicleNeedsAcknowledgement, autoChronicleSetting, chronicleSettings,
} from '../chronicle/config.ts';
import { describeChronicleActivity, readChronicleLedgerStats } from '../chronicle/ledger-stats.ts';
import { CHRONICLE_REASONS, chronicleBackfillArgv } from '../chronicle/reasons.ts';
import { chroniclePageDate } from '../chronicle/eligibility.ts';
import type { Action } from '../agent-output.ts';

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

async function chatAvailable(): Promise<boolean> {
  try {
    const { isAvailable } = await import('../ai/gateway.ts');
    return isAvailable('chat');
  } catch {
    return false;
  }
}

async function collectAutoChronicle(ctx: AdvisorContext): Promise<AdvisorFinding[]> {
  const raw = await ctx.engine.getConfig('auto_chronicle');
  const setting = autoChronicleSetting(raw);
  if (setting === 'invalid') {
    return [{
      id: 'auto_chronicle_invalid',
      severity: 'warn',
      title: `auto_chronicle is '${raw}', which reads as off`,
      detail: 'Ask the user whether automatic event extraction should be on (one paid chat call per eligible page) or off, ' +
        `then run \`${AUTO_CHRONICLE_KEEP_ARGV.join(' ')}\` or \`${AUTO_CHRONICLE_OPT_OUT_ARGV.join(' ')}\`.`,
      fix: { command_argv: [...AUTO_CHRONICLE_KEEP_ARGV] },
      collector: 'chronicle',
      ask_user: true,
    }];
  }
  if (setting === 'off') return [];
  const findings: AdvisorFinding[] = [];
  const settings = await chronicleSettings(ctx.engine);
  const stats = await readChronicleLedgerStats(ctx.engine);
  const activity = stats.available ? describeChronicleActivity(stats, settings.dailyLimit, { nameWriters: ctx.remote === false }) : '';
  if (await autoChronicleNeedsAcknowledgement(ctx.engine)) {
    findings.push({
      id: 'auto_chronicle_default_on',
      severity: 'info',
      title: 'Automatic event extraction is on by default; confirm it with the user',
      detail: `Each eligible new or changed meeting, conversation or calendar page gets one paid chat call (cap $${settings.jobBudgetUsd.toFixed(2)} per page, ` +
        `at most ${settings.dailyLimit} calls per day: $${(settings.dailyLimit * settings.jobBudgetUsd).toFixed(2)} per day at most for a priced model; ` +
        'an unpriced model has no cap). Page text goes to the configured chat provider. ' +
        `Keep it: \`${AUTO_CHRONICLE_KEEP_ARGV.join(' ')}\`. Opt out: \`${AUTO_CHRONICLE_OPT_OUT_ARGV.join(' ')}\`.` +
        (activity ? ` ${activity}` : ''),
      fix: { command_argv: [...AUTO_CHRONICLE_KEEP_ARGV] },
      collector: 'chronicle',
      ask_user: true,
    });
  }
  if (stats.pending > 0 && !(await chatAvailable())) {
    findings.push({
      id: 'chronicle_chat_unavailable',
      severity: 'warn',
      title: `${stats.pending} page(s) wait for event extraction, but no chat provider is configured`,
      detail: CHRONICLE_REASONS.judge_llm_unavailable.fix().why,
      fix: { command_argv: null },
      collector: 'chronicle',
      ask_user: true,
    });
  }
  const failed = Object.entries(stats.last7d.failedReasons).find(([reason]) => reason in CHRONICLE_REASONS);
  if (stats.last7d.failed > 0 && failed) {
    const reasonCtx = { since: daysAgo(ctx.now ?? new Date(), 7), dailyLimit: settings.dailyLimit, recentDays: settings.recentDays };
    const entry = CHRONICLE_REASONS[failed[0] as keyof typeof CHRONICLE_REASONS];
    const fix: Action | undefined = 'fix' in entry ? entry.fix(reasonCtx) : undefined;
    findings.push({
      id: 'chronicle_extraction_failing',
      severity: 'warn',
      title: `${stats.last7d.failed} automatic event extraction(s) failed in 7 days (most often ${failed[0]})`,
      detail: `${entry.meaning(reasonCtx)}${fix ? ` ${fix.why}` : ''} ${activity}`,
      fix: { command_argv: fix?.argv ?? null },
      collector: 'chronicle',
      ask_user: fix ? fix.consent.length > 0 || fix.actor !== 'agent' : false,
    });
  }
  if (stats.pending > 0 && stats.autoCalls24h >= settings.dailyLimit) {
    const fix = CHRONICLE_REASONS.daily_limit.fix({ dailyLimit: settings.dailyLimit, since: daysAgo(ctx.now ?? new Date(), 7) });
    findings.push({
      id: 'chronicle_daily_limit',
      severity: 'info',
      title: `The automatic daily limit (${settings.dailyLimit} calls) is used up; ${stats.pending} page(s) wait for a free slot`,
      detail: `${fix.why} ${activity}`,
      fix: { command_argv: fix.argv ?? null },
      collector: 'chronicle',
      ask_user: true,
    });
  }
  return findings;
}

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

    // 2. Recent meetings, conversations and calendar events not yet in the timeline (coverage gap).
    // #7282: "recent" is the page's own date within chronicle.auto_recent_days, the cutoff automatic
    // extraction applies (older pages skip as `history`); only an undated page falls back to updated_at.
    try {
      const { recentDays } = await chronicleSettings(ctx.engine);
      const now = ctx.now ?? new Date();
      const rows = await ctx.engine.executeRaw<{ type: string; effective_date: Date | string | null; effective_date_source: string | null; fm_date: string | null; fm_start: string | null }>(
        `SELECT p.type, p.effective_date, p.effective_date_source, p.frontmatter->>'date' AS fm_date, p.frontmatter->>'start' AS fm_start
           FROM pages p
          WHERE p.type IN ('meeting','conversation','calendar-event') AND p.deleted_at IS NULL
            AND p.updated_at > now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM timeline_entries te
              WHERE te.page_id = p.id AND te.event_page_id IS NOT NULL
            )`,
      );
      const byType = new Map<string, number>();
      for (const r of rows) {
        const dated = chroniclePageDate({ effectiveDate: r.effective_date, effectiveDateSource: r.effective_date_source, frontmatter: { date: r.fm_date, start: r.fm_start } });
        if (dated && dated.getTime() < now.getTime() - recentDays * 86_400_000) continue;
        byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
      }
      const gap = [...byType.values()].reduce((a, b) => a + b, 0);
      if (gap > 0) {
        findings.push({
          id: 'chronicle_coverage_gap',
          severity: 'info',
          title: `${gap} recent meeting, conversation or calendar page(s) aren't in the timeline yet (${[...byType].map(([t, n]) => `${n} ${t}`).join(', ')})`,
          detail: 'Preview them, then sweep them into events if the user agrees to one paid chat call per page.',
          fix: { command_argv: chronicleBackfillArgv({ since: daysAgo(ctx.now ?? new Date(), 30), dryRun: true }) },
          collector: 'chronicle',
          ask_user: true,
        });
      }
    } catch {
      // timeline_entries.event_page_id may be absent pre-migration; ignore.
    }

    // 3. #5876: automatic extraction (on by default). Brain state only; no provider calls.
    try {
      findings.push(...await collectAutoChronicle(ctx));
    } catch {
      // Config/ledger read failures leave the other findings intact.
    }

    return findings;
  },
};
