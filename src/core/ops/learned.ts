/**
 * Nightly learning PR 1: the `learned` read op ("what I learned since we last talked"). Lists the learning ledger's
 * items (src/core/learning/) rendered live at the caller's own scope, 15 by default; `stats` returns
 * the per-night scoreboard instead. Showing an item stamps its shown_at, so the default view is what the caller has
 * not seen yet. Never import from '../operations.ts' here (cycle).
 */

import { opError, type Operation, type OperationContext } from './contract.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { sourceScopeOpts } from './context.ts';
import { sqlEngineKind } from '../sql-engine-kind.ts';
import { learningTablePresent } from '../learning/kinds.ts';
import { LEARNED_DEFAULT_LIMIT, LEARNED_MAX_LIMIT, readLearned } from '../learning/read.ts';
import { learnedStats } from '../learning/stats.ts';
import { keepItems, parseItemIds, undoItems } from '../learning/decide.ts';

/** The ledger's sources this caller reads: every source for a local caller, the resolved scope for a remote one. */
async function ledgerScope(ctx: OperationContext, name: string): Promise<string[] | null> {
  sqlEngineKind(ctx.engine.kind, name);
  if (!await learningTablePresent(ctx.engine)) {
    throw opError('migrations_pending', "This brain has no learning ledger yet: its schema is older than the learned view.",
      'Run gbrain apply-migrations --yes on the brain host, then let a dream cycle run.');
  }
  const scope = sourceScopeOpts(ctx);
  if (ctx.remote !== false && !scope.sourceId && !scope.sourceIds) {
    throw opError('permission_denied', `${name}: remote callers need a resolved source scope`,
      'Pass a source this connection can read (fix lists them).',
      { fix: readFix('Lists the sources this connection can read.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } }) });
  }
  return scope.sourceIds?.length ? scope.sourceIds : scope.sourceId ? [scope.sourceId] : null;
}

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
    const sourceIds = await ledgerScope(ctx, 'learned');
    if (p.stats === true) return { stats: await learnedStats(ctx.engine, ctx, { sourceIds, since }) };
    return readLearned(ctx.engine, ctx, { sourceIds, since, limit: Math.min(rawLimit, LEARNED_MAX_LIMIT) });
  },
};

const IDS_EXAMPLE = '12,15';

const learned_keep: Operation = {
  name: 'learned_keep',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Keep items from the learned note: mark what the brain learned as right. Writes only the note\'s own record (no page or fact changes). ' +
    'Takes item ids from learned (comma separated), or all for every pending change you can read from the last 7 days (up to 100). ' +
    'Questions (facts that disagree, possible duplicate people) are answered, not kept.',
  params: {
    ids: { type: 'string', required: true, description: `Item ids from learned, comma separated (e.g. ${IDS_EXAMPLE}), or all.` },
  },
  scope: 'write',
  annotations: { idempotentHint: true },
  cliHints: { name: 'learned-keep', positional: ['ids'] },
  handler: async (ctx, p) => {
    const which = parseItemIds(p.ids);
    if (which === null) {
      throw invalidParam(ctx, 'learned_keep', 'ids', `learned_keep: ids must be item ids from learned or all, got ${JSON.stringify(p.ids)}`,
        { def: learned_keep.params.ids, example: IDS_EXAMPLE });
    }
    const sourceIds = await ledgerScope(ctx, 'learned_keep');
    return { action: 'keep', results: await keepItems(ctx.engine, ctx, sourceIds, which) };
  },
};

const learned_undo: Operation = {
  name: 'learned_undo',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Undo items from the learned note through the operation that owns each change: a new fact is forgotten (withdrawn; history kept), ' +
    'a promise is dropped, a filled-in page is reverted to the version before it was filled (refused when the page was edited since, ' +
    'with the commands to choose a version). For facts that disagree it rejects the newer fact on the brain host; for possible duplicate ' +
    'people it returns the gbrain dedupe reject command for the brain host. Each result says what happened.',
  params: {
    ids: { type: 'string', required: true, description: `Item ids from learned, comma separated (e.g. ${IDS_EXAMPLE}).` },
    reason: { type: 'string', description: 'Why it was wrong; recorded on the reversal (forget reason, loop note or revert reason).' },
  },
  scope: 'write',
  annotations: { destructiveHint: true, idempotentHint: true },
  cliHints: { name: 'learned-undo', positional: ['ids'] },
  handler: async (ctx, p) => {
    const ids = parseItemIds(p.ids);
    if (ids === null || ids === 'all') {
      throw invalidParam(ctx, 'learned_undo', 'ids', `learned_undo: ids must be item ids from learned (undo never takes all), got ${JSON.stringify(p.ids)}`,
        { def: learned_undo.params.ids, example: IDS_EXAMPLE });
    }
    const sourceIds = await ledgerScope(ctx, 'learned_undo');
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 200) : null;
    return { action: 'undo', results: await undoItems(ctx.engine, ctx, sourceIds, ids, reason) };
  },
};

export const learnedOperations: Operation[] = [learned, learned_keep, learned_undo];
