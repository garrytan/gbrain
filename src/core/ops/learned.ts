/**
 * Nightly learning PR 1: the `learned` read op ("what I learned since we last talked"). Lists the learning ledger's
 * items (src/core/learning/) rendered live at the caller's own scope, 15 by default; `stats` returns
 * the per-night scoreboard instead. Showing an item stamps its shown_at, so the default view is what the caller has
 * not seen yet. Never import from '../operations.ts' here (cycle).
 */

import { opError, type Operation } from './contract.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { sourceScopeOpts } from './context.ts';
import { sqlEngineKind } from '../sql-engine-kind.ts';
import { learningTablePresent } from '../learning/kinds.ts';
import { LEARNED_DEFAULT_LIMIT, LEARNED_MAX_LIMIT, readLearned } from '../learning/read.ts';
import { learnedStats } from '../learning/stats.ts';

const learned: Operation = {
  name: 'learned',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'What the brain learned since you last looked: new facts its extractors saved, facts that disagree (which one is right?), ' +
    'promises people made to you, people who may be the same person (with the gbrain dedupe confirm and reject commands, run on the brain host), thin pages it filled in, and rows you typed into Facts fences (shown, never counted). ' +
    'Default: the items you have not been shown yet from the last 7 days; with since, every item since that date. ' +
    'Grouped by kind, questions first, 15 by default; each item carries a stable id and evidence links ' +
    '(the page or loop it came from). Reading stamps the items as shown. With stats: per-night counts (a night ends ' +
    'at 06:00 in brain.timezone) of items shown, kept, undone and expired, and the share of nights with at least 5 counted items.',
  params: {
    since: { type: 'string', description: 'ISO date or timestamp (e.g. 2026-11-20). Lists every item recorded since then, shown or not. Default: unseen items of the last 7 days (stats: the last 30 days).' },
    limit: { type: 'number', description: `Most items to return (default ${LEARNED_DEFAULT_LIMIT}, at most ${LEARNED_MAX_LIMIT}). Every item returned is shown and stamped.` },
    stats: { type: 'boolean', description: 'Return the per-night stats instead of the items. Shows nothing, so it stamps nothing.' },
  },
  scope: 'read',
  annotations: { readOnlyHint: true },
  cliHints: { name: 'learned' },
  handler: async (ctx, p) => {
    sqlEngineKind(ctx.engine.kind, 'learned');
    let since: Date | undefined;
    if (p.since !== undefined && p.since !== null) {
      since = new Date(String(p.since));
      if (Number.isNaN(since.getTime())) {
        throw invalidParam(ctx, 'learned', 'since', `learned: since must be an ISO date or timestamp, got ${JSON.stringify(p.since)}`,
          { def: learned.params.since, example: '2026-11-20' });
      }
    }
    const rawLimit = p.limit === undefined || p.limit === null ? LEARNED_DEFAULT_LIMIT : Number(p.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      throw invalidParam(ctx, 'learned', 'limit', `learned: limit must be a whole number from 1 to ${LEARNED_MAX_LIMIT}, got ${JSON.stringify(p.limit)}`,
        { def: learned.params.limit, example: LEARNED_DEFAULT_LIMIT });
    }
    if (!await learningTablePresent(ctx.engine)) {
      throw opError('migrations_pending', "This brain has no learning ledger yet: its schema is older than the learned view.",
        'Run gbrain apply-migrations --yes on the brain host, then let a dream cycle run.');
    }
    const scope = sourceScopeOpts(ctx);
    if (ctx.remote !== false && !scope.sourceId && !scope.sourceIds) {
      throw opError('permission_denied', 'learned: remote callers need a resolved source scope',
        'Pass a source this connection can read (fix lists them).',
        { fix: readFix('Lists the sources this connection can read.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } }) });
    }
    const sourceIds = scope.sourceIds?.length ? scope.sourceIds : scope.sourceId ? [scope.sourceId] : null;
    if (p.stats === true) return { stats: await learnedStats(ctx.engine, ctx, { sourceIds, since }) };
    return readLearned(ctx.engine, ctx, { sourceIds, since, limit: Math.min(rawLimit, LEARNED_MAX_LIMIT) });
  },
};

export const learnedOperations: Operation[] = [learned];
