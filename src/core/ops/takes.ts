/**
 * Takes + think operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `takesOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import { OperationError, type Operation, type OperationContext } from './contract.ts';
import {
  sourceScopeOpts,
  thinkSourceScopeOpts,
  enforceClientSlugFence,
  validatePageSlug,
} from './context.ts';
import {
  addTakeToPage,
  updateTakeOnPage,
  supersedeTakeOnPage,
  resolveTakeOnPage,
  resolveTakesRepoDir,
  TakesWriteError,
} from '../takes-write.ts';

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
    const card = await ctx.engine.getScorecard(
      {
        ...sourceScopeOpts(ctx),
        holder: p.holder as string | undefined,
        domainPrefix: p.domain_prefix as string | undefined,
        since: p.since as string | undefined,
        until: p.until as string | undefined,
      },
      ctx.takesHoldersAllowList,
    );
    // [OV8/EV5] Resolver-provenance visibility: remote resolutions are
    // server-stamped resolved_by='mcp:<client>' (takes_resolve below), and
    // this coarse count keeps agent-resolved rows segregable from owner
    // ground truth. Op-layer SQL (plain executeRaw both engines share) —
    // no engine method added, parity untouched. Unfiltered by the window/
    // domain params (coarse by design; documented).
    return { ...card, mcp_resolved: await countMcpResolved(ctx) };
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
    // (The [OV8/EV5] mcp_resolved provenance count lives on takes_scorecard —
    // this op's wire shape is a bare bucket ARRAY, so decorating it would be
    // a breaking change; the scorecard is the segregation surface.)
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

/**
 * [OV8/EV5] Count of resolved take rows whose resolved_by carries the MCP
 * server-stamp prefix. Source-scoped + holder-allow-list-scoped like the
 * aggregates it decorates; unfiltered by window/domain (coarse segregation
 * signal, not a scorecard dimension).
 */
async function countMcpResolved(ctx: OperationContext): Promise<number> {
  const scope = sourceScopeOpts(ctx);
  const where: string[] = [`t.resolved_at IS NOT NULL`, `t.resolved_by LIKE 'mcp:%'`];
  const params: unknown[] = [];
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    where.push(`p.source_id = ANY($${params.length}::text[])`);
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    where.push(`p.source_id = $${params.length}`);
  }
  if (ctx.takesHoldersAllowList) {
    params.push(ctx.takesHoldersAllowList);
    where.push(`t.holder = ANY($${params.length}::text[])`);
  }
  try {
    const rows = await ctx.engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE ${where.join(' AND ')}`,
      params,
    );
    return parseInt(rows[0]?.n ?? '0', 10);
  } catch {
    // Decoration only — never fail the aggregate over the provenance count.
    return 0;
  }
}

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
  // hidden: 'think' is in CLI_ONLY (src/cli.ts) — the richer runThinkCli
  // handler owns the CLI surface; a non-hidden hint here is dead (CLI_ONLY
  // wins at dispatch) and lies to the catalog.
  cliHints: { name: 'think', positional: ['question'], hidden: true },
};


// ---------------------------------------------------------------------------
// CLI→MCP gap-closure wave — takes WRITE verbs. Before these, agents could
// read the predictions ledger (takes_list/search/scorecard) but never record,
// refine, resolve, or supersede a take. Backed by the same md-canonical
// write-through core as the CLI (src/core/takes-write.ts): fence-derived row
// numbers, markdown written first, the DB mirrored with the reconcile
// primitive — and the markdown write is REQUIRED (no sync.repo_path on the
// host → 'unavailable' with detail takes_mirror_unavailable), because a
// DB-only row would be clobbered by the next md→DB reconcile.
//
// Trust model (ungated by design — the put_page precedent: writes are
// consented via scope + the holder fence; publish gates cover owner-content
// READ surfaces):
//   - Holder WRITE fence reuses the read allow-list, fail-closed: remote
//     effective list = ctx.takesHoldersAllowList ?? ['world'] (the stdio
//     default — stdio agents write world-held takes only; OAuth tokens can
//     grant more), [] = deny-all. add/supersede check the param holder;
//     update/resolve/supersede check the TARGET row's holder — and a fenced
//     row presents as not_found (same shape as a missing row), hiding content
//     and holder. Existence-by-count is accepted: row numbers are dense per
//     page, so takes_add's returned row_num reveals how many rows (including
//     private ones) exist — returning it is functionally required for later
//     update/resolve, and takes_list's visible-sequence gaps leak the same
//     count anyway [OV10/EV3].
//   - resolved_by is SERVER-STAMPED for remote callers (mcp:<clientId>) so
//     agent-resolved rows stay segregable from owner-resolved ground truth;
//     scorecard/calibration surface the mcp_resolved count [OV8/EV5].
//   - A future permissions.takes_write_holders key could split the read/write
//     axes if field use demands it.
// ---------------------------------------------------------------------------

const TAKE_KINDS = ['fact', 'take', 'bet', 'hunch'] as const;
/** Ops hold the MCP request at most this long waiting for the page lock. */
const OP_LOCK_TIMEOUT_MS = 2000;

/** Remote callers get the read allow-list as the WRITE fence; local CLI is unfenced. */
function takesWriteAllowList(ctx: OperationContext): readonly string[] | null {
  return ctx.remote !== false ? (ctx.takesHoldersAllowList ?? ['world']) : null;
}

async function opBrainDir(ctx: OperationContext): Promise<string> {
  const dir = await resolveTakesRepoDir(ctx.engine);
  if (!dir) {
    const err = new OperationError(
      'unavailable',
      'Takes are markdown-canonical and this brain has no writable markdown repo configured.',
      'Configure sync.repo_path on the brain host, then retry.',
    );
    err.detail = 'takes_mirror_unavailable';
    throw err;
  }
  return dir;
}

function mapTakesWriteError(err: unknown): never {
  if (err instanceof TakesWriteError) {
    switch (err.code) {
      case 'page_not_found':
        throw new OperationError('page_not_found', err.message, 'Sync the brain first, or check the slug/source.');
      case 'row_not_found':
        // Fenced rows deliberately share this shape (no-existence-leak of
        // content/holder — see the trust-model comment above).
        throw new OperationError('not_found', err.message);
      case 'holder_denied': {
        const e = new OperationError('permission_denied', err.message,
          "Ask the brain owner to widen this caller's takes-holder allow-list.");
        e.detail = 'holder_not_in_allowlist';
        throw e;
      }
      case 'mirror_unavailable': {
        const e = new OperationError('unavailable', err.message,
          'Configure sync.repo_path on the brain host, then retry.');
        e.detail = 'takes_mirror_unavailable';
        throw e;
      }
      case 'page_locked': {
        const e = new OperationError('unavailable', err.message, 'Retry shortly.');
        e.detail = 'retryable';
        throw e;
      }
      case 'already_resolved':
        throw new OperationError('invalid_params', err.message, err.hint ?? 'Resolved takes are immutable; supersede instead.');
      case 'fence_unparsed':
      case 'row_inactive':
      case 'no_fields':
      case 'invalid_input':
        throw new OperationError('invalid_params', err.message, err.hint);
    }
  }
  throw err;
}

/**
 * P1-4/F4: the markdown write already succeeded; a non-empty `mirror_warning`
 * means only the DB mirror deferred to the next reconcile. Surface it so the
 * agent knows the durable row is on disk and MUST NOT retry.
 */
function mirrorWarnFields(mirror: { mirror_warning?: string }): Record<string, string> {
  return mirror.mirror_warning
    ? { mirror_warning: `row written to markdown; DB mirror deferred to reconcile: ${mirror.mirror_warning}` }
    : {};
}

const takes_add: Operation = {
  name: 'takes_add',
  description:
    'Record a take (typed claim) on a page: fact / take / bet / hunch, with a holder (who ' +
    'holds the belief: world, people/<slug>, companies/<slug>, or brain), weight 0..1, and ' +
    'optional source/since date. Writes the markdown takes fence first (markdown is ' +
    'canonical) and mirrors to the DB. Remote callers can only write holders in their ' +
    'allow-list (stdio default: world).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug to attach the take to (page must exist).' },
    claim: { type: 'string', required: true, description: 'The claim text (one line).' },
    kind: { type: 'string', required: true, enum: [...TAKE_KINDS], description: 'Claim type. Base kinds only; pack-extended kinds are a filed follow-up.' },
    holder: { type: 'string', required: true, description: "Who HOLDS this belief (said/clearly implied it): world | people/<slug> | companies/<slug> | brain. Remote callers: must be in the caller's takes-holder allow-list." },
    weight: { type: 'number', required: false, description: 'Confidence 0..1 (default 0.5; clamped server-side).' },
    source: { type: 'string', required: false, description: 'Where the claim came from (free text).' },
    since: { type: 'string', required: false, description: "When the belief started ('YYYY-MM' or 'YYYY-MM-DD')." },
  },
  scope: 'write',
  mutating: true,
  area: 'takes',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'takes_add');
    validatePageSlug(slug); // defense-in-depth, matching put_page
    if (ctx.dryRun) return { dry_run: true, action: 'takes_add', slug };
    const brainDir = await opBrainDir(ctx);
    try {
      const { rowNum, mirror } = await addTakeToPage(
        { engine: ctx.engine, slug, brainDir, sourceId: ctx.sourceId, allowList: takesWriteAllowList(ctx), lockTimeoutMs: OP_LOCK_TIMEOUT_MS },
        {
          claim: p.claim as string,
          kind: p.kind as string,
          holder: p.holder as string,
          weight: p.weight as number | undefined,
          source: p.source as string | undefined,
          sinceDate: p.since as string | undefined,
        },
      );
      return { slug, row_num: rowNum, holder: p.holder, mirror_written: true, ...mirrorWarnFields(mirror) };
    } catch (err) {
      mapTakesWriteError(err);
    }
  },
};

const takes_update: Operation = {
  name: 'takes_update',
  description:
    'Update a take\'s mutable fields (weight, source, since date). Claim/kind/holder are ' +
    'immutable — supersede instead. Markdown-canonical: the target row must exist in the ' +
    'page\'s takes fence. Remote callers can only touch rows whose holder is in their ' +
    'allow-list; other rows present as not_found.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug.' },
    row_num: { type: 'number', required: true, description: 'Take row number on the page (from takes_list).' },
    weight: { type: 'number', required: false, description: 'New confidence 0..1.' },
    source: { type: 'string', required: false, description: 'New source text.' },
    since: { type: 'string', required: false, description: "New since date ('YYYY-MM' or 'YYYY-MM-DD')." },
  },
  scope: 'write',
  mutating: true,
  area: 'takes',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'takes_update');
    validatePageSlug(slug); // defense-in-depth, matching put_page
    if (ctx.dryRun) return { dry_run: true, action: 'takes_update', slug, row_num: p.row_num };
    const brainDir = await opBrainDir(ctx);
    try {
      const { rowNum, mirror } = await updateTakeOnPage(
        { engine: ctx.engine, slug, brainDir, sourceId: ctx.sourceId, allowList: takesWriteAllowList(ctx), lockTimeoutMs: OP_LOCK_TIMEOUT_MS },
        p.row_num as number,
        {
          weight: p.weight as number | undefined,
          source: p.source as string | undefined,
          sinceDate: p.since as string | undefined,
        },
      );
      return { slug, row_num: rowNum, updated: true, ...mirrorWarnFields(mirror) };
    } catch (err) {
      mapTakesWriteError(err);
    }
  },
};

const takes_supersede: Operation = {
  name: 'takes_supersede',
  description:
    'Supersede a take with a replacement claim: the old row is struck through (kept for ' +
    'archaeology), the replacement appends at the next fence row number. Kind/holder inherit ' +
    'from the target row unless overridden; unset weight decays the target\'s by 0.1. ' +
    'Markdown-canonical; remote holder fencing as in takes_update.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug.' },
    row_num: { type: 'number', required: true, description: 'Row number of the take being superseded.' },
    claim: { type: 'string', required: true, description: 'The replacement claim text.' },
    kind: { type: 'string', required: false, enum: [...TAKE_KINDS], description: 'Override kind (default: inherit from the target row).' },
    holder: { type: 'string', required: false, description: 'Override holder (default: inherit). Remote callers: an override must be in the allow-list.' },
    weight: { type: 'number', required: false, description: "Replacement confidence 0..1 (default: target's weight - 0.1)." },
    source: { type: 'string', required: false, description: 'Source for the replacement.' },
    since: { type: 'string', required: false, description: 'Since date for the replacement.' },
  },
  scope: 'write',
  mutating: true,
  area: 'takes',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'takes_supersede');
    validatePageSlug(slug); // defense-in-depth, matching put_page
    if (ctx.dryRun) return { dry_run: true, action: 'takes_supersede', slug, row_num: p.row_num };
    const brainDir = await opBrainDir(ctx);
    try {
      const { oldRow, newRow, mirror } = await supersedeTakeOnPage(
        { engine: ctx.engine, slug, brainDir, sourceId: ctx.sourceId, allowList: takesWriteAllowList(ctx), lockTimeoutMs: OP_LOCK_TIMEOUT_MS },
        p.row_num as number,
        {
          claim: p.claim as string,
          kind: p.kind as string | undefined,
          holder: p.holder as string | undefined,
          weight: p.weight as number | undefined,
          source: p.source as string | undefined,
          sinceDate: p.since as string | undefined,
        },
      );
      return { slug, old_row: oldRow, new_row: newRow, ...mirrorWarnFields(mirror) };
    } catch (err) {
      mapTakesWriteError(err);
    }
  },
};

const takes_resolve: Operation = {
  name: 'takes_resolve',
  description:
    'Resolve a take: quality correct / incorrect / partial / unresolvable, with optional ' +
    'evidence text and measured value/unit. Resolutions feed the calibration scorecard. ' +
    'Remote callers: resolved_by is SERVER-STAMPED as mcp:<client> (any passed value is ' +
    'ignored) so agent resolutions stay segregable from owner ground truth; the target row ' +
    'must be in the caller\'s holder allow-list. Markdown-canonical.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug.' },
    row_num: { type: 'number', required: true, description: 'Take row number to resolve.' },
    quality: { type: 'string', required: true, enum: ['correct', 'incorrect', 'partial', 'unresolvable'], description: 'Resolution verdict.' },
    evidence: { type: 'string', required: false, description: 'What evidence resolved this (free text).' },
    value: { type: 'number', required: false, description: 'Measured value, when the claim was quantitative.' },
    unit: { type: 'string', required: false, description: 'Unit for value (usd | pct | count | ...).' },
    resolved_by: { type: 'string', required: false, description: 'Resolver identity. Remote callers: SERVER-STAMPED mcp:<client>, client value ignored. Local default: the configured owner holder.' },
  },
  scope: 'write',
  mutating: true,
  area: 'takes',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    enforceClientSlugFence(ctx, slug, 'takes_resolve');
    validatePageSlug(slug); // defense-in-depth, matching put_page
    if (ctx.dryRun) return { dry_run: true, action: 'takes_resolve', slug, row_num: p.row_num };
    const brainDir = await opBrainDir(ctx);
    // CV6 posture: remote resolutions are provenance-stamped server-side —
    // clamp + sanitize the client id: hostile DCR client names must not carry
    // newlines/pipes into the markdown fence, and must not bloat the column.
    let resolvedBy: string;
    if (ctx.remote !== false) {
      const id = (ctx.auth?.clientId ?? ctx.transport ?? 'remote').replace(/[^\w.:-]/g, '_').slice(0, 64);
      resolvedBy = `mcp:${id}`;
    } else if (typeof p.resolved_by === 'string' && p.resolved_by.length > 0) {
      resolvedBy = p.resolved_by;
    } else {
      const { resolveOwnerHolder } = await import('../owner-holder.ts');
      resolvedBy = resolveOwnerHolder({ configValue: await ctx.engine.getConfig('emotional_weight.user_holder') });
    }
    try {
      const { rowNum, quality, mirror } = await resolveTakeOnPage(
        { engine: ctx.engine, slug, brainDir, sourceId: ctx.sourceId, allowList: takesWriteAllowList(ctx), lockTimeoutMs: OP_LOCK_TIMEOUT_MS },
        p.row_num as number,
        {
          quality: p.quality as 'correct' | 'incorrect' | 'partial' | 'unresolvable',
          evidence: p.evidence as string | undefined,
          value: p.value as number | undefined,
          unit: p.unit as string | undefined,
          resolvedBy,
        },
      );
      return { slug, row_num: rowNum, quality, resolved_by: resolvedBy, ...mirrorWarnFields(mirror) };
    } catch (err) {
      mapTakesWriteError(err);
    }
  },
};

// Ops in EXACTLY the canonical `operations` array order: the v0.28 trio
// (takes_list, takes_search, think), the v0.30 calibration aggregates, then
// the gap-closure write verbs.
export const takesOperations: Operation[] = [
  takes_list, takes_search, think,
  takes_scorecard, takes_calibration,
  takes_add, takes_update, takes_resolve, takes_supersede,
];
