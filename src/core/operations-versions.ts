// Admin surface operations: stats, health, compile-debt report, anticipation
// pack, and page version history/revert.
import type { BrainEngine } from './engine.ts';
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { ANTICIPATION_PACK_CONFIG_KEY } from './services/anticipation-service.ts';
import type {
  Page,
} from './types.ts';

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
  },
  cliHints: { name: 'health' },
};

const list_compile_debt: Operation = {
  name: 'list_compile_debt',
  description: 'List pages whose timeline evidence is newer than compiled truth, ranked by entry count and age.',
  params: {
    limit: { type: 'number', description: 'Maximum debt rows to return (default: 20)' },
  },
  handler: async (ctx, p) => {
    const limit = typeof p.limit === 'number' && Number.isFinite(p.limit)
      ? Math.max(1, Math.min(100, Math.floor(p.limit)))
      : 20;
    const pages = await ctx.engine.listPages({ limit: 1000, offset: 0 });
    const debtRows = await Promise.all(pages.map((page) => compileDebtForPage(ctx.engine, page)));
    return debtRows
      .filter((entry) => entry.uncompiled_timeline_entries > 0)
      .sort((left, right) => right.debt_score - left.debt_score || left.slug.localeCompare(right.slug))
      .slice(0, limit);
  },
  cliHints: { name: 'compile-debt' },
};

const get_anticipation_pack: Operation = {
  name: 'get_anticipation_pack',
  description:
    'Read the latest sleep-time anticipation pack: deterministically precomputed likely next-session questions with their read-plan selector snapshots, persisted by the dream anticipation phase. Orientation-only; read_context remains the answer-evidence boundary. Returns { status: "empty" } when no pack has been persisted.',
  params: {},
  tier: 'admin',
  handler: async (ctx) => {
    const raw = await ctx.engine.getConfig(ANTICIPATION_PACK_CONFIG_KEY);
    if (!raw) return { status: 'empty' };
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new OperationError(
        'database_error',
        'Persisted anticipation pack is not valid JSON; rerun the dream anticipation phase to rebuild it.',
      );
    }
  },
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getVersions(p.slug as string);
  },
  cliHints: { name: 'history', positional: ['slug'] },
};

async function compileDebtForPage(engine: BrainEngine, page: Page) {
  const hasCompileDebt = page.timeline_changed_at.getTime() > page.compiled_truth_changed_at.getTime();
  const timelineEntries = hasCompileDebt
    ? timelineEntryDates(page.timeline).filter((date) => date.getTime() > page.compiled_truth_changed_at.getTime())
    : [];
  const structuredTimelineCount = hasCompileDebt && timelineEntries.length === 0
    ? await getStructuredTimelineCount(engine, page.slug)
    : 0;
  const uncompiledTimelineEntries = timelineEntries.length || structuredTimelineCount || (hasCompileDebt ? 1 : 0);
  const sortedUncompiled = timelineEntries
    .map((date) => date.getTime())
    .sort((left, right) => left - right);
  const oldestUncompiled = sortedUncompiled[0];
  const newestUncompiled = sortedUncompiled[sortedUncompiled.length - 1];
  const ageSource = newestUncompiled ?? (hasCompileDebt ? page.timeline_changed_at.getTime() : undefined);
  const ageDays = ageSource === undefined
    ? 0
    : Math.max(0, (Date.now() - ageSource) / (24 * 60 * 60 * 1000));
  return {
    slug: page.slug,
    title: page.title,
    compiled_truth_changed_at: page.compiled_truth_changed_at.toISOString(),
    timeline_changed_at: page.timeline_changed_at.toISOString(),
    uncompiled_timeline_entries: uncompiledTimelineEntries,
    oldest_uncompiled_timeline_at: oldestUncompiled === undefined ? null : new Date(oldestUncompiled).toISOString(),
    newest_uncompiled_timeline_at: newestUncompiled === undefined ? null : new Date(newestUncompiled).toISOString(),
    debt_score: Math.round((uncompiledTimelineEntries * (1 + ageDays)) * 100) / 100,
  };
}

async function getStructuredTimelineCount(engine: BrainEngine, slug: string): Promise<number> {
  try {
    return (await engine.getTimeline(slug, { limit: 1000, offset: 0 })).length;
  } catch {
    return 0;
  }
}

function timelineEntryDates(timeline: string): Date[] {
  const dates: Date[] = [];
  for (const line of timeline.split(/\r?\n/)) {
    const match = /^\s*-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(line);
    if (!match) continue;
    const date = new Date(`${match[1]}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) dates.push(date);
  }
  return dates;
}

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true },
    version_id: { type: 'number', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun)
      return {
        dry_run: true,
        action: 'revert_version',
        slug: p.slug,
        version_id: p.version_id,
      };
    await ctx.engine.createVersion(p.slug as string);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};

export function createVersionsOperations(): Operation[] {
  return [get_stats, get_health, list_compile_debt, get_anticipation_pack, get_versions, revert_version];
}
