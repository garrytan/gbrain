/**
 * Takes + think operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `takesOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { sourceScopeOpts, thinkSourceScopeOpts } from './context.ts';

// --- v0.28: Takes ---

const takes_list: Operation = {
  name: 'takes_list',
  description: 'List takes (typed/weighted/attributed claims) filtered by holder/kind/active/etc.',
  scope: 'read',
  params: {
    page_slug: { type: 'string', description: 'Filter to this page' },
    holder: { type: 'string', description: 'Filter to this holder (world|garry|brain|<slug>)' },
    kind: { type: 'string', description: 'Filter to this kind (fact|take|bet|hunch)' },
    active: { type: 'boolean', description: 'Active rows only (default true)' },
    resolved: { type: 'boolean', description: 'true → only resolved bets; false → only unresolved' },
    sort_by: { type: 'string', description: 'weight | since_date | created_at (default created_at)' },
    limit: { type: 'number', description: 'Max rows (default 100, cap 500)' },
    offset: { type: 'number', description: 'Skip first N rows' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listTakes({
      // #2200-class: honor federated/source scope (via the take's page.source_id).
      ...sourceScopeOpts(ctx),
      page_slug: p.page_slug as string | undefined,
      holder: p.holder as string | undefined,
      kind: p.kind as never,
      active: p.active as boolean | undefined,
      resolved: p.resolved as boolean | undefined,
      sortBy: p.sort_by as never,
      limit: p.limit as number | undefined,
      offset: p.offset as number | undefined,
      // Per-token allow-list — server-side filter for MCP-bound calls.
      // Local CLI callers leave takesHoldersAllowList unset and see all holders.
      takesHoldersAllowList: ctx.takesHoldersAllowList,
    });
  },
  cliHints: { name: 'takes-list' },
};

const takes_search: Operation = {
  name: 'takes_search',
  description: 'Keyword search across takes (pg_trgm similarity over claim text)',
  scope: 'read',
  params: {
    query: { type: 'string', required: true, description: "Search text matched against take claim text via trigram similarity, e.g. 'valuation cap'. This is the search text param — there is no `text` param." },
    limit: { type: 'number', description: 'Max results (default 30, cap 100)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.searchTakes(p.query as string, {
      ...sourceScopeOpts(ctx),
      limit: p.limit as number | undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
    });
  },
  cliHints: { name: 'takes-search', positional: ['query'] },
};

/**
 * v0.30.0 (Slice A1): aggregate calibration scorecard. Pure SQL aggregation.
 *
 * Privacy (D4 fail-closed): the engine method REQUIRES the takesHoldersAllowList
 * param. The handler threads it from the OperationContext so MCP-bound callers
 * see only their permitted holders' aggregate counts. Local CLI callers
 * (ctx.takesHoldersAllowList=undefined) get the full scorecard.
 */
const takes_scorecard: Operation = {
  name: 'takes_scorecard',
  description: 'Calibration scorecard for resolved bets: counts, accuracy, Brier (correct ∨ incorrect only), partial_rate.',
  scope: 'read',
  params: {
    holder: { type: 'string', description: 'Filter to this holder (world|garry|brain|<slug>)' },
    domain_prefix: { type: 'string', description: 'Slug prefix (e.g. companies/) to scope the scorecard' },
    since: { type: 'string', description: 'Window start (YYYY-MM-DD)' },
    until: { type: 'string', description: 'Window end (YYYY-MM-DD)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getScorecard(
      {
        ...sourceScopeOpts(ctx),
        holder: p.holder as string | undefined,
        domainPrefix: p.domain_prefix as string | undefined,
        since: p.since as string | undefined,
        until: p.until as string | undefined,
      },
      ctx.takesHoldersAllowList,
    );
  },
  cliHints: { name: 'takes-scorecard' },
};

/**
 * v0.30.0 (Slice A1): calibration curve binned by stated weight. Pure SQL.
 * Same allow-list contract as takes_scorecard.
 */
const takes_calibration: Operation = {
  name: 'takes_calibration',
  description: 'Calibration curve: resolved correct/incorrect bets binned by stated weight; observed vs predicted per bucket.',
  scope: 'read',
  params: {
    holder: { type: 'string', description: 'Filter to this holder' },
    bucket_size: { type: 'number', description: 'Bucket width in (0,1]; default 0.1' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getCalibrationCurve(
      {
        ...sourceScopeOpts(ctx),
        holder: p.holder as string | undefined,
        bucketSize: p.bucket_size as number | undefined,
      },
      ctx.takesHoldersAllowList,
    );
  },
  cliHints: { name: 'takes-calibration' },
};

const think: Operation = {
  name: 'think',
  description: 'Multi-hop synthesis across pages + takes + graph. Pulls relevant evidence and produces a cited answer with conflict + gap analysis.',
  scope: 'read',
  params: {
    question: { type: 'string', required: true, description: 'The question to think about' },
    anchor: { type: 'string', description: 'Pull the entity subgraph around this slug' },
    rounds: { type: 'number', description: 'Multi-pass: 1 (default). Round-loop scaffolding is in place; gap-driven retrieval ships in v0.29.' },
    save: { type: 'boolean', description: 'Persist a synthesis page (local-CLI only; ignored for MCP)' },
    take: { type: 'boolean', description: 'Append a take row to the anchor page (requires anchor)' },
    model: { type: 'string', description: 'Model override (alias or full id). Falls through models.think → models.default → GBRAIN_MODEL → opus.' },
    since: { type: 'string', description: 'Start of temporal window (YYYY-MM-DD or YYYY-MM)' },
    until: { type: 'string', description: 'End of temporal window' },
  },
  // Local CLI can persist with save/take; remote/MCP callers are forced
  // read-only below before runThink/persistSynthesis sees those flags.
  mutating: true,
  handler: async (ctx, p) => {
    const remote = ctx.remote ?? true;
    // Codex P1 #7 + privacy: remote callers cannot persist via MCP.
    const safeSave = remote ? false : Boolean(p.save);
    const safeTake = remote ? false : Boolean(p.take);
    // v0.40.2.0: thread source-scope scalars + remote flag for trajectory
    // injection. `sourceScopeOpts(ctx)` returns the federated array (when
    // present) OR the scalar; we pass both through to runThink which
    // forwards to findTrajectory. CLI callers don't go through this op
    // and get default scope + remote=false from runThink's CLI path.
    const thinkScope = thinkSourceScopeOpts(ctx);
    const { runThink, persistSynthesis } = await import('../think/index.ts');
    const result = await runThink(ctx.engine, {
      question: String(p.question),
      anchor: p.anchor ? String(p.anchor) : undefined,
      rounds: typeof p.rounds === 'number' ? (p.rounds as number) : undefined,
      save: safeSave,
      take: safeTake,
      model: p.model ? String(p.model) : undefined,
      // #1698 (C3): a remote caller that explicitly supplies a model gets the same
      // hard-error-on-unresolvable behavior as the CLI (loud op error envelope),
      // instead of silently degrading to a no-LLM stub answer. No model param →
      // false → configured/default model keeps its graceful path.
      modelExplicit: !!p.model,
      since: p.since ? String(p.since) : undefined,
      until: p.until ? String(p.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
      ...thinkScope,
      remote: ctx.remote !== false, // fail-closed: anything not strictly false is untrusted (CLAUDE.md invariant)
    });

    // Persist if --save was passed locally
    let savedSlug: string | undefined;
    let evidenceInserted = 0;
    if (safeSave) {
      const persisted = await persistSynthesis(ctx.engine, result);
      savedSlug = persisted.slug;
      evidenceInserted = persisted.evidenceInserted;
      for (const w of persisted.warnings) result.warnings.push(w);
    }

    return {
      ...result,
      // #1698 (#10): the persist-skip signal returns slug '' — map it (and any
      // falsy) to null so callers never see an empty-string "slug".
      saved_slug: savedSlug || null,
      evidence_inserted: evidenceInserted,
      remote_persisted_blocked: remote && (Boolean(p.save) || Boolean(p.take)),
    };
  },
  cliHints: { name: 'think', positional: ['question'] },
};


// Ops in EXACTLY the canonical `operations` array order: the v0.28 trio
// (takes_list, takes_search, think), then the v0.30 calibration aggregates.
export const takesOperations: Operation[] = [
  takes_list, takes_search, think,
  takes_scorecard, takes_calibration,
];
