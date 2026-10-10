import { searchAnswerFeedback } from '../feedback/record.ts';
import { parseRelationalPlan } from '../search/relational-plan.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../search/mode.ts';
import { WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import { deliverEvidence, effectivePlan, resolveEvidencePlan, type DeliveryMeta, type EvidencePlan } from '../search/evidence-delivery.ts';
import { randomUUID } from 'node:crypto';
import { readHolders } from './context.ts';
/**
 * Hot-memory (facts) operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): extract_facts, the extended `recall` verb, the
 * v0.45.x boundary verbs context_pack/delta, and forget_fact, plus the
 * cluster-local parsers (parseEntityList, parseSinceParam, parseTtlParam).
 * The other four frozen memory verbs (remember/entity/synthesize/forget)
 * live in ../verbs.ts and are NOT part of this module. Op consts stay
 * module-private; `factsOperations` below lists them in EXACTLY the order
 * they appear in the canonical `operations` array in ../operations.ts.
 * parseTtlParam stays exported — the `remember` verb (../verbs.ts) loads it
 * from operations.ts at runtime, which re-exports it from here. Never import
 * from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import type { Notice } from '../agent-output.ts';
import { OperationError, opError, verbError } from './contract.ts';
import { invalidParam, paramUse } from './op-fix.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, sourceScopeOpts, stampEvidenceSafe } from './context.ts';
import { markKeywordHits } from '../search/evidence.ts';
import { hybridSearchCached, stampContentFlags } from '../search/hybrid.ts';
import { dedupResults } from '../search/dedup.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { packToBudget, estimateTokens, resultTokens } from '../search/token-budget.ts';
import { redactRetrievalOutput } from '../search/output-redaction.ts';
import { isAvailable } from '../ai/gateway.ts';
// #4209: the named entity-hints cap — surfaced in the extract_facts param
// description and the entity_hints_used/_dropped response fields.
import { ENTITY_HINTS_CAP } from '../facts/extract.ts';
import { parseTtlShorthand } from '../facts/ttl-parse.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';
import type { SearchResult } from '../types.ts';
import type { BrainEngine, FactRow } from '../engine.ts';
import { MIN_TRUST_PARAM, resolveReadEligibility } from '../eligibility/policy.ts';
import { hasScope } from '../scope.ts';
import { renderTrustedText } from '../eligibility/labels.ts';
import { MEMORY_CONFIRM_SCOPE } from '../trust/confirm.ts';
import { proactiveEligibility } from '../eligibility/registry.ts';
import { activationSuppressionNotice, suppressionSummary } from '../eligibility/activation.ts';
import { stampPageTrust, stampRowTrust } from '../eligibility/stamp.ts';
import type { TrustTier } from '../trust/tier.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';

// ============================================================
// v0.31 — Hot memory ops: extract_facts / recall / forget_fact
// ============================================================

const extract_facts: Operation = {
  name: 'extract_facts',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Extract personal-knowledge facts (events, preferences, commitments, beliefs, ideas, and plain facts) from a conversation turn into the per-source hot memory. Sanitizes turn_text via INJECTION_PATTERNS, calls the configured extraction model (key-aware: any servable provider — OpenAI or Anthropic key both work), runs the cosine fast-path + classifier dedup pipeline, INSERTs into facts. Returns counts by status. With NO servable chat model, returns skipped: extraction_unavailable + an agent_action telling YOU to extract and write via `remember` (visibility: "private"). Skips extraction when the turn is dream-generated content (anti-loop). For agent memory writes of a SINGLE already-formed fact, prefer the `remember` verb (zero LLM, mandatory provenance).',
  params: {
    request_id: { ...WRITE_REQUEST_PARAM, description: `${WRITE_REQUEST_PARAM.description} Managed extraction returns durable receipts; when omitted, each call gets a new UUID. Unmanaged extraction retains its legacy non-journaled behavior.` },
    turn_text: { type: 'string', required: true, description: 'The user message or page body to extract facts from. Sanitized via INJECTION_PATTERNS before the LLM call.' },
    session_id: { type: 'string', description: 'Opaque session id (e.g. topic-id from MCP _meta.session_id, or CLI --session). Stored on each fact for the recall --session filter. Not an auth surface. NOTE (#4206): the session survives on the DB row at insert time, but the `## Facts` fence has no session column — a fence rebuild/reconcile re-derives rows session-less. Treat fence-backed facts as session-less across rebuilds.' },
    entity_hints: { type: 'array', items: { type: 'string' }, description: `Existing canonical entity slugs the agent has already resolved. Helps the extractor pick the right slug. Only the first ${ENTITY_HINTS_CAP} are forwarded to the extractor (#4209) — the response reports entity_hints_used / entity_hints_dropped; pass the most load-bearing slugs first.` },
    is_dream_generated: { type: 'boolean', description: 'When true, extraction is skipped (anti-loop). Caller flips this on for pages with dream_generated:true frontmatter.' },
    valid_from: { type: 'string', description: '#4206: ISO 8601 event time for the extracted facts — use when the turn is historical (importing an old transcript) so facts do not get stamped with import time. Fallback only: a date the extractor derives from the turn itself wins. Default: now().' },
    source_slug: { type: 'string', description: "#4206: slug of the page/transcript this turn came from (e.g. 'meetings/2026-04-03'). Written to facts.context so recall/context_pack/delta consumers see the provenance." },
    visibility: { type: 'string', description: 'Default visibility for extracted facts. private (default) | world.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'extract_facts' };
    const { isFactsExtractionEnabled } = await import('../facts/extract.ts');
    const { runFactsPipeline } = await import('../facts/backstop.ts');

    // #4209: named-cap accounting. The extractor prompt forwards only the
    // first ENTITY_HINTS_CAP hints; report used/dropped on EVERY envelope so
    // over-cap hints are visible in the contract instead of silently eaten.
    const entityHints = Array.isArray(p.entity_hints) ? (p.entity_hints as string[]) : undefined;
    const hintAccounting = {
      entity_hints_used: Math.min(entityHints?.length ?? 0, ENTITY_HINTS_CAP),
      entity_hints_dropped: Math.max(0, (entityHints?.length ?? 0) - ENTITY_HINTS_CAP),
    };

    // D15: kill switch. Operator can disable facts extraction across the
    // brain without binary downgrade by setting `facts.extraction_enabled`
    // to false. Returns zero-counts envelope so callers see a clean
    // success rather than a 'permission_denied' false alarm.
    if (!(await isFactsExtractionEnabled(ctx.engine))) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_disabled', ...hintAccounting };
    }

    // v0.31.2: routed through the shared pipeline (PR1 commit 9). Anti-loop
    // dream-generated check stays at the op layer because extract_facts is
    // an explicit user op without a parsedPage — the eligibility predicate
    // doesn't apply, but the dream-generated guard still does.
    if (p.is_dream_generated === true) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'dream_generated', ...hintAccounting };
    }

    const sourceId = ctx.sourceId ?? 'default';
    // [ENG-8] Explicit caller value wins; UNSET resolves through the shared
    // facts.default_visibility helper (the old ternary coerced unset →
    // 'private' before any config default could run). Garbage stays 'private'.
    const { resolveVisibilityParam } = await import('../facts/visibility.ts');
    const visibility: 'private' | 'world' = await resolveVisibilityParam(ctx.engine, p.visibility);

    // #4206: optional event-time + provenance threading. An unparseable
    // valid_from fails LOUD — silently defaulting to now() is exactly the
    // wrong-timestamp bug the param exists to fix.
    let validFrom: Date | undefined;
    if (p.valid_from !== undefined && p.valid_from !== null) {
      const d = new Date(p.valid_from as string);
      if (!Number.isFinite(d.getTime())) {
        throw invalidParam(ctx, 'extract_facts', 'valid_from',
          `invalid valid_from: "${String(p.valid_from)}" — expected a parseable ISO 8601 datetime`,
          { def: extract_facts.params.valid_from, example: '2026-08-11T00:00:00Z' });
      }
      validFrom = d;
    }
    const sourceSlug =
      typeof p.source_slug === 'string' && p.source_slug.trim().length > 0
        ? p.source_slug.trim()
        : undefined;

    const r = await runFactsPipeline(p.turn_text as string, {
      engine: ctx.engine,
      operationContext: ctx,
      requestId: typeof p.request_id === 'string' ? p.request_id : randomUUID(),
      requestIntent: { ...p, request_id: undefined },
      sourceId,
      sessionId: typeof p.session_id === 'string' ? p.session_id : null,
      entityHints,
      source: 'mcp:extract_facts',
      visibility,
      validFrom,
      sourceSlug,
      mode: 'inline',  // declarative; runFactsPipeline always inline
    });

    // Reason-specific envelopes — never collapse distinct failures into one
    // message. `chat_unavailable` means no servable chat model: the calling
    // agent IS an LLM, so hand it the keyless self-extract path (the
    // `remember` verb + `## Facts` fences work with zero keys). The
    // visibility pin in the instruction is mandatory copy: `remember`
    // defaults to 'world' while extract_facts facts default 'private' —
    // omitting it would silently widen private data to every connected agent.
    // The visibility instruction names the RESOLVED visibility for THIS call
    // (caller param > facts.default_visibility config > private): a caller who
    // asked for world must not be steered to private, and an unpinned
    // instruction would silently widen private-default extractions because
    // `remember` hard-defaults to 'world'.
    const visibilityPin = `visibility: "${visibility}"` +
      (visibility === 'private' ? ' (remember defaults to world — omitting it would widen these facts)' : '');
    if (r.skipped_reason === 'chat_unavailable') {
      return {
        inserted: 0, duplicate: 0, superseded: 0, fact_ids: [],
        ...hintAccounting,
        skipped: 'extraction_unavailable',
        agent_action:
          'No server-side chat model is available. You are an LLM: extract the facts ' +
          'yourself (up to ~10 per turn) and write each one with the `remember` verb: ' +
          'one claim per call, provenance required, set `kind` (event | preference | ' +
          'commitment | belief — it defaults to plain "fact" otherwise), set `entity` ' +
          `when the fact is about a person/company/project, and ${visibilityPin}. ` +
          'Or author a `## Facts` fence on the entity page. To enable automatic ' +
          'extraction, add an OpenAI or Anthropic API key.',
      };
    }
    if (r.skipped_reason) {
      return {
        inserted: 0, duplicate: 0, superseded: 0, fact_ids: [],
        ...hintAccounting,
        skipped: 'extraction_failed',
        reason: r.skipped_reason,
        agent_action:
          `The extractor failed on this turn (${r.skipped_reason}). You may extract the ` +
          'facts manually via the `remember` verb (one claim per call, provenance ' +
          `required, ${visibilityPin}).`,
      };
    }

    return {
      inserted: r.inserted,
      duplicate: r.duplicate,
      superseded: r.superseded,
      fact_ids: r.fact_ids,
      ...(r.write_requests ? { write_requests: r.write_requests } : {}),
      ...hintAccounting,
    };
  },
};

/** One arm of recall's budget_packing accounting. */
function packingArm<T>(candidates: T[], kept: T[], cost: (item: T) => number) {
  return { candidates: candidates.length, kept: kept.length, dropped: candidates.length - kept.length, used: kept.reduce((sum, r) => sum + cost(r), 0) };
}

/**
 * recall's evidence plan: budget_tokens budgets the delivered blocks before
 * recall's own packing. Without return_unit, budget_tokens or budget_policy
 * keeps legacy chunk packing (facts pack first, so a whole session would
 * otherwise lose to them).
 */
function recallEvidencePlan(ctx: OperationContext, p: Record<string, unknown>): Promise<EvidencePlan | null> {
  return resolveEvidencePlan(ctx.engine, {
    legacyBudget: p.budget_policy !== undefined || (typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0),
    remote: ctx.remote, viaSubagent: ctx.viaSubagent, returnUnit: p.return_unit, returnWindow: p.return_window,
    budget: p.budget_tokens, snippetChars: undefined, snippetCap: 0, op: 'recall',
  });
}

const recall: Operation = {
  name: 'recall',
  mutating: false,
  idempotent: true,
  outputRedaction: { retrieval: { localVerbatim: ['facts'] } },
  description: 'MEMORY VERB (v1): read saved facts by entity, since or session_id; `query` also searches pages. Remote callers see world facts only. One card: entity; reasoning: synthesize.',
  params: {
    entity: { type: 'string', description: 'Entity slug; facts about it, newest first.' },
    query: { type: 'string', description: 'Also search pages (results[] arm).' },
    budget_tokens: { type: 'number', description: 'Token budget; facts pack first.' },
    budget_policy: { type: 'string', enum: ['facts_first', 'query_first'], description: 'facts_first (default) or query_first.' },
    source_id: { type: 'string', description: 'Narrow to one source you may read.' },
    since: { type: 'string', description: 'Facts since (ISO 8601 or "8 hours ago").' },
    session_id: { type: 'string', description: 'Facts captured in this session.' },
    include_expired: { type: 'boolean', description: 'Include expired facts.' },
    supersessions: { type: 'boolean', description: 'Only the supersession audit log.' },
    limit: { type: 'number', description: 'Per-arm max (default 50, cap 100).' },
    grep: { type: 'string', description: 'Substring of the fact text.' },
    include_pending: { type: 'boolean', description: 'Add pending count.' },
    return_unit: { type: 'string', enum: ['chunk', 'window', 'section', 'page', 'auto'], description: 'Evidence unit for results[] (see search).' },
    return_window: { type: 'number', description: 'Window size 1-3.' },
    min_trust: MIN_TRUST_PARAM,
  },
  scope: 'read',
  verb: true,
  annotations: { title: 'recall (memory read)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const sourceId = ctx.sourceId ?? 'default';
    const limit = clampRecallLimit(p.limit);
    const includeExpired = p.include_expired === true;
    const grep = typeof p.grep === 'string' ? p.grep.toLowerCase() : null;

    // Federated grants (cathedral-6): the fact arms honor the SAME scope
    // ladder as every other read-side op — federated array > scalar >
    // default — via federatedSearchScope, never a hand-rolled filter. The engine
    // fact APIs are scalar-source, so a federated grant fans out per granted
    // source and merges newest-first; a single-source caller takes exactly
    // the pre-v1 single-query path. A trusted-local `__all__` ({}) has no
    // enumerable grant and keeps the resolved-scalar behavior.
    let sourceIdParam: string | undefined;
    let scope: ReturnType<typeof sourceScopeOpts>;
    try {
      sourceIdParam = parseSourceIdParam(p.source_id, 'recall');
      // The facts arms widen an unqualified no-grant caller across the transport-computed
      // federated set, exactly like the page-search arm below and every sibling read op.
      scope = federatedSearchScope(ctx, sourceIdParam);
      await assertExplicitSourceLive(ctx, sourceIdParam);
    } catch (error) {
      if (!(error instanceof OperationError) || p.source_id === undefined || p.source_id === null) throw error;
      const code = error.code === 'permission_denied' ? 'scope_denied'
        : error.code === 'unknown_source' ? 'not_found'
          : error.code === 'invalid_params' ? 'invalid_params' : null;
      if (code === null) throw error;
      throw Object.assign(verbError(code, error.message,
        error.suggestion ?? 'Choose a permitted active source, or omit source_id to use your existing scope.',
        error.detail ?? error.code), error.fix ? { fix: error.fix } : {});
    }
    // Set-dedupe: a grant carrying a repeated id (or the scalar source again)
    // must not fan out the same source twice into the merge.
    const factSources: string[] = [...new Set(
      scope.sourceIds && scope.sourceIds.length > 0 ? scope.sourceIds
        : scope.sourceId ? [scope.sourceId]
          : [sourceId],
    )];

    // Visibility filter: remote callers see world-only unless their token
    // grants elevated visibility (future-proofing; v0.31 ships world-only
    // for remote, all for local CLI).
    const visibility =
      ctx.remote === false
        ? undefined
        : ['world'] as ('private' | 'world')[];
    const eligibility = await resolveReadEligibility(ctx, { minTrust: p.min_trust }); // #5575 floor + quarantine/rederive hiding

    type FactRows = Awaited<ReturnType<typeof ctx.engine.listFactsByEntity>>;
    type FactRowItem = FactRows[number];
    // Per-arm merge key: each arm's engine query ORDERs by a different column
    // (supersessions by COALESCE(expired_at, valid_until) — #3014, entity by
    // valid_from, the rest by
    // created_at) — the cross-source merge must sort by the SAME key or the
    // truncation at `limit` silently drops the wrong rows. Decorate-sort-
    // undecorate: the key is computed once per row.
    const mergeNewest = (lists: FactRows[], keyOf: (rec: Record<string, unknown>) => unknown): FactRows => {
      if (lists.length === 1) return lists[0];
      const toTime = (v: unknown): number => {
        const t = v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
      };
      const decorated = lists.flat().map((r: FactRowItem) => ({
        r,
        k: toTime(keyOf(r as unknown as Record<string, unknown>)),
      }));
      decorated.sort((a, b) => b.k - a.k);
      return decorated.slice(0, limit).map(d => d.r);
    };
    const byCreated = (rec: Record<string, unknown>) => rec.created_at ?? rec.since_date;
    // The since-arms below pass eventTime:true (COALESCE(valid_from,
    // created_at) — see FactListOpts.eventTime), so their per-source ORDER BY
    // is event time, not creation time. The federated merge key has to match
    // or truncation at `limit` drops the wrong rows across sources.
    const byEventTime = (rec: Record<string, unknown>) => rec.valid_from ?? rec.created_at;

    let rows: FactRows = [];
    let ambiguousEntity: EntityCandidate[] | null = null;

    // `since` is parsed once, up front, and a value that does not parse is
    // rejected instead of silently widening the window: a caller that asked
    // for "facts since T" must never receive every fact (or none) because
    // T was malformed.
    const since = p.since !== undefined ? parseSinceParam(p.since) : null;
    if (p.since !== undefined && !since) {
      throw verbError(
        'invalid_params',
        `since is not a parseable timestamp or duration: "${String(p.since).slice(0, 60)}"`,
        'Pass an ISO 8601 datetime (e.g. "2026-08-11T00:00:00Z"), Unix epoch millis, or a duration such as "8 hours ago" / "2d".',
      );
    }
    const entityParam = typeof p.entity === 'string' && p.entity.length > 0 ? (p.entity as string) : null;
    const sessionParam = typeof p.session_id === 'string' && p.session_id.length > 0 ? (p.session_id as string) : null;
    // Shared per-source opts for the fact-list arms (visibility, grep and the
    // audit exclusion all filter at the ENGINE level, before each source's
    // LIMIT, so a hidden newest row never consumes a slot).
    const listOpts = {
      activeOnly: !includeExpired,
      limit,
      visibility,
      grep: grep ?? undefined,
      excludeAuditRows: true, eligibility,
    };

    if (p.supersessions === true) {
      // Visibility filters at the ENGINE level (before each source's LIMIT),
      // same as the sibling fact-list arms — a post-merge filter would let a
      // private newest row consume a limit slot and hide an older world row.
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listSupersessions(src, { since: since ?? undefined, limit, visibility, eligibility }),
        )),
        // v0.46 (#3014): matches the engine's ORDER BY COALESCE(expired_at,
        // valid_until) — ontology supersessions carry valid_until only.
        (rec) => rec.expired_at ?? rec.valid_until ?? rec.created_at,
      );
    } else if (since) {
      // Composed window: `since` ANDs onto `entity` and/or `session_id` in
      // ONE engine query, so the time cutoff lands before the SQL LIMIT. The
      // window is measured on EVENT time, COALESCE(valid_from, created_at),
      // exactly like the since-only arm: "what happened to this entity (or
      // in this session) since T" is a question about when the underlying
      // events occurred, not about when a batch extraction wrote the rows.
      const { resolveEntitySlug } = await import('../entities/resolve.ts');
      const lists = await Promise.all(factSources.map(async (src) => {
        const entitySlug = entityParam
          ? ((await resolveEntitySlug(ctx.engine, src, entityParam)) ?? entityParam)
          : undefined;
        return ctx.engine.listFactsSince(src, since, { ...listOpts, eventTime: true, entitySlug, sessionId: sessionParam ?? undefined });
      }));
      ambiguousEntity = entityParam ? await unlinkedNamesakes(ctx.engine, lists) : null;
      rows = ambiguousEntity ? [] : mergeNewest(lists, byEventTime);
    } else if (entityParam) {
      const { resolveEntitySlug } = await import('../entities/resolve.ts');
      const lists = await Promise.all(factSources.map(async (src) => {
        const slug = (await resolveEntitySlug(ctx.engine, src, entityParam)) ?? entityParam;
        return ctx.engine.listFactsByEntity(src, slug, listOpts);
      }));
      ambiguousEntity = await unlinkedNamesakes(ctx.engine, lists);
      rows = ambiguousEntity ? [] : mergeNewest(lists, (rec) => rec.valid_from ?? rec.created_at);
    } else if (sessionParam) {
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listFactsBySession(src, sessionParam, listOpts),
        )),
        byCreated,
      );
    } else {
      // No filter: return recent across the granted source(s).
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listFactsSince(src, new Date(0), { ...listOpts, eventTime: true }),
        )),
        byEventTime,
      );
    }

    // extract-conversation-facts writes durable audit checkpoint rows
    // (source = TERMINAL_AUDIT_SOURCE / NON_EXTRACTABLE_AUDIT_SOURCE) into
    // the facts table. They are checkpoints, not user facts. Every arm
    // above already passes excludeAuditRows: true (SQL-level, both
    // engines, keyed on `source` not `fact` text) — this client-side
    // filter is belt-and-braces defense in depth, not the primary guard.
    rows = rows.filter((r) => !(AUDIT_ROW_SOURCES as readonly string[]).includes(r.source));

    // Engines apply grep in SQL (pre-limit). This client-side pass stays only
    // as the filter for the supersessions branch, which bypasses FactListOpts.
    if (grep && p.supersessions === true) {
      rows = rows.filter(r => r.fact.toLowerCase().includes(grep));
    }

    // v0.32: optional pending-consolidation count piggy-backed on the recall
    // response. Single round trip on thin-client; omitted when not requested
    // so existing callers see no shape change. Sums over the SAME factSources
    // set the fact arms fan out across — a federated caller's pending count
    // must cover every granted source, not just the scalar sourceId.
    let pending_consolidation_count: number | undefined;
    if (p.include_pending === true) {
      try {
        const counts = await Promise.all(
          factSources.map(src => ctx.engine.countUnconsolidatedFacts(src)),
        );
        pending_consolidation_count = counts.reduce((a, b) => a + b, 0);
      } catch (e) {
        // Best-effort: if the count query fails we still return facts. Field
        // stays undefined so callers can tell the difference between "0
        // pending" and "we couldn't ask."
        process.stderr.write(
          `[recall] countUnconsolidatedFacts failed: ${(e as Error).message}\n`,
        );
      }
    }

    // ── MEMORY_VERBS v1 — query arm (G1B superset). Hybrid search over pages
    // when `query` is present; degrades to keyword-only with a note (never an
    // error) when no embedding provider is configured [F-B].
    const queryText = typeof p.query === 'string' && p.query.trim().length > 0 ? p.query.trim() : null;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;

    let searchResults: SearchResult[] = [];
    let searchDegraded: string | undefined;
    let delivery: DeliveryMeta | undefined;
    const evidencePlan = queryText ? await recallEvidencePlan(ctx, p) : null;
    if (queryText) {
      // #3242 parity (#4707): the page-search arm widens an unqualified
      // no-grant caller across the transport-computed federated set, exactly
      // like search/query/get_page/list_pages/resolve_slugs. sourceScopeOpts
      // alone pinned this arm to the scalar source, so a `federated: true`
      // source was invisible to recall while visible to every sibling read op.
      const searchScope = { ...federatedSearchScope(ctx, sourceIdParam), ...(eligibility.floor ? { minTrust: eligibility.floor } : {}) };
      // #4352 — recall's page-search arm enforces `visibility: private` for
      // untrusted callers (matches the facts arms' world-only filter above).
      const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
      const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
      const keywordOnly = await recallKeywordOnlyReason(ctx);
      if (keywordOnly) {
        searchResults = await keylessRecallRows(ctx, queryText, limit, excludePrivate, searchScope);
        searchDegraded = keywordOnly;
      } else {
        searchResults = await hybridSearchCached(ctx.engine, queryText, {
          limit,
          expansion: false,
          excludePrivate,
          requireSafeChunks: ctx.remote !== false,
          takesHoldersAllowList: readHolders(ctx),
          ...searchScope,
        });
      }
      bumpLastRetrievedAt(ctx.engine, searchResults.map(r => r.page_id));
      const applied = effectivePlan(evidencePlan, searchResults);
      if (applied) ({ results: searchResults, delivery } = await deliverEvidence(ctx.engine, searchResults, applied, { ...searchScope, excludePrivate, requireSafeChunks: ctx.remote !== false }));
      searchResults = await stampPageTrust(ctx.engine, searchResults, eligibility.floor);
    }

    // Pack what is delivered: results redacted for all; facts for remote only (localVerbatim).
    const view = redactRetrievalOutput([{ facts: rows.map(r => ({ fact: r.fact, context: r.context, source: r.source })), results: searchResults }], {}).results[0];
    searchResults = view.results;
    if (ctx.remote !== false) rows = rows.map((r, i) => ({ ...r, ...view.facts[i] }));

    let packedFacts = rows;
    let packedResults = searchResults;
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    const queryFirst = p.budget_policy === 'query_first' && queryText !== null && budgetTokens !== null;
    if (queryFirst) {
      const resultsPack = budgetTokens > 0
        ? packToBudget(searchResults, resultTokens, budgetTokens)
        : { items: [] as SearchResult[], meta: { used: 0, dropped: searchResults.length } };
      packedResults = resultsPack.items;
      const remaining = budgetTokens - resultsPack.meta.used;
      const factsPack = remaining > 0
        ? packToBudget(rows, r => estimateTokens(r.fact), remaining)
        : { items: [] as FactRows, meta: { used: 0, dropped: rows.length } };
      packedFacts = factsPack.items;
      budgetUsed = resultsPack.meta.used + factsPack.meta.used;
      droppedCount = resultsPack.meta.dropped + factsPack.meta.dropped;
    } else if (budgetTokens !== null) {
      const factsPack = packToBudget(rows, r => estimateTokens(r.fact), budgetTokens);
      packedFacts = factsPack.items;
      const remaining = budgetTokens - factsPack.meta.used;
      const resultsPack =
        remaining > 0
          ? packToBudget(searchResults, resultTokens, remaining)
          : { items: [] as SearchResult[], meta: { budget: 0, used: 0, dropped: searchResults.length, kept: 0 } };
      packedResults = resultsPack.items;
      budgetUsed = factsPack.meta.used + resultsPack.meta.used;
      droppedCount = factsPack.meta.dropped + resultsPack.meta.dropped;
    }

    const budgetPacking = p.budget_policy === 'facts_first' || p.budget_policy === 'query_first'
      ? {
          policy: queryFirst ? 'query_first' : 'facts_first',
          applied: budgetTokens !== null && (queryFirst || (p.budget_policy === 'facts_first' && budgetTokens > 0)),
          reason: p.budget_policy === 'query_first' && !queryText ? 'no_query'
            : budgetTokens === null ? 'no_positive_finite_budget'
              : budgetTokens === 0 ? 'budget_below_one'
                : rows.length + searchResults.length === 0 ? 'no_candidates'
                  : packedFacts.length + packedResults.length === 0 ? 'first_items_exceed_budget'
                    : 'packed',
          facts: packingArm(rows, packedFacts, r => estimateTokens(r.fact)),
          results: packingArm(searchResults, packedResults, resultTokens),
        }
      : undefined;

    return {
      facts: await stampRowTrust(ctx.engine, 'facts', packedFacts.map(r => ({ // #5575 A6: + trust_tier, origin, unconfirmed
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
        source_id: r.source_id,
        visibility: r.visibility,
        // v0.31.2: notability surfaced to recall consumers (CLI, MCP, admin).
        // Pre-v46 brains return 'medium' via the row mapper's fallback so the
        // contract stays total.
        notability: r.notability,
        valid_from: r.valid_from.toISOString(),
        valid_until: r.valid_until?.toISOString() ?? null,
        expired_at: r.expired_at?.toISOString() ?? null,
        superseded_by: r.superseded_by,
        consolidated_at: r.consolidated_at?.toISOString() ?? null,
        consolidated_into: r.consolidated_into,
        source: r.source,
        source_session: r.source_session,
        // #4206: provenance context (e.g. extract_facts' source_slug) rides
        // the recall projection like every other provenance field.
        context: r.context,
        confidence: r.confidence,
        created_at: r.created_at.toISOString(),
        // MEMORY_VERBS v1 additive fields (G1B). `fact_id` is the opaque
        // STRING id the `forget` verb accepts (legacy numeric `id` stays for
        // pre-v1 consumers — legacy fields are frozen byte-equal). `provenance`
        // is the protocol name for the stored source attribution.
        fact_id: String(r.id),
        provenance: r.source, ...(r.attributed_to ? { attributed_to: r.attributed_to } : {}),
      })), f => f.id),
      total: packedFacts.length,
      ...(ambiguousEntity ? { ambiguous_entity: { candidates: ambiguousEntity, suggestion: AMBIGUOUS_ENTITY_SUGGESTION } } : {}),
      ...(pending_consolidation_count !== undefined ? { pending_consolidation_count } : {}),
      // MEMORY_VERBS v1 envelope (G1B superset — additive on every response).
      protocol_version: MEMORY_VERBS_VERSION,
      ...(queryText
        ? {
            results: packedResults.map(r => ({
              slug: r.slug,
              title: r.title,
              chunk: r.chunk_text,
              evidence: r.evidence,
              create_safety: r.create_safety,
              provenance: r.slug,
              ...(r.delivered ? { delivered: r.delivered } : {}),
              ...(r.relational ? { relational: r.relational } : {}),
              ...(r.trust_tier ? { trust_tier: r.trust_tier, origin: r.origin, ...(r.unconfirmed ? { unconfirmed: true } : {}) } : {}),
            })),
            ...(searchDegraded ? { search_degraded: searchDegraded } : {}),
            ...(searchDegraded ? {} : await searchAnswerFeedback(ctx, 'recall', packedResults)),
          }
        : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
      ...(budgetPacking ? { budget_packing: budgetPacking } : {}),
      ...(delivery ? { delivery } : {}),
    };
  },
};

type EntityCandidate = { source_id: string; entity_slug: string };
const AMBIGUOUS_ENTITY_SUGGESTION = 'These are different entities in different sources. Pass source_id to read one, or link them with entity_identity_link if they are the same.';

/**
 * The identity key is (source_id, slug): an entity name resolved in several
 * granted sources names different entities unless an entity-identity group
 * links their pages. Merging them would hand the caller a stranger's facts,
 * so federated recall refuses unlinked namesakes and names the candidates.
 * Returns null when the per-source fact lists are one entity.
 */
async function unlinkedNamesakes(engine: BrainEngine, lists: FactRow[][]): Promise<EntityCandidate[] | null> {
  const candidates = [...new Map(lists.flat().map((r): [string, EntityCandidate] =>
    [`${r.source_id}:${r.entity_slug}`, { source_id: r.source_id, entity_slug: r.entity_slug as string }])).values()];
  if (candidates.length < 2) return null;
  const { identityIdsForPages } = await import('../entity-identity.ts');
  const ids = await identityIdsForPages(engine, candidates.map(c => ({ sourceId: c.source_id, slug: c.entity_slug })));
  const groups = new Set(candidates.map(c => ids.get(`${c.source_id}:${c.entity_slug}`) ?? null));
  return groups.size === 1 && !groups.has(null) ? null : candidates;
}

/** Parse an `entities` param (comma-string or array) to a trimmed name list. */
function parseEntityList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim());
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// #4761: the budget packers price the RENDERED line (+ its newline), never the
// raw fields — see renderCardLine & co. in context/turn-context.ts. packToBudget
// treats budget <= 0 as NO CAP, so a sub-floor budget must drop explicitly.
const lineCost = (line: string) => estimateTokens(line + '\n');
const dropAll = <T>(items: T[]) => ({ items: [] as T[], meta: { budget: 0, used: 0, dropped: items.length, kept: 0 } });

/**
 * #6146: the stored provenance (`facts.source`, what `remember --provenance`
 * wrote) of the facts a pack or delta delivers, in one batched read keyed by
 * the facts' own ids, so hot memory (and every MCP `_meta`) stays unchanged.
 * Fail-soft like the rest of the pack: a failed read leaves `provenance` null.
 */
async function withProvenance<T extends { id: number }>(engine: BrainEngine, sourceId: string, facts: T[]): Promise<Array<T & { provenance: string | null }>> {
  if (facts.length === 0) return [];
  const rows = await engine.executeRaw<{ id: number | string; source: string | null }>(
    'SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[])', [sourceId, facts.map((f) => f.id)],
  ).catch(() => []);
  const byId = new Map(rows.map((r) => [Number(r.id), r.source]));
  return facts.map((f) => ({ ...f, provenance: byId.get(f.id) ?? null }));
}

const context_pack: Operation = {
  name: 'context_pack',
  mutating: false,
  idempotent: true,
  outputRedaction: { retrieval: { localVerbatim: ['facts'] } },
  description: 'MEMORY VERB (v1): core memory, budget-packed cards, open threads and hot facts for up to 8 entities, zero LLM. Call at session start and after compaction.',
  params: {
    entities: { type: 'string', description: 'Comma-separated names or slugs (max 8).' },
    budget_tokens: { type: 'number', description: 'Token budget; cards pack first.' },
    since: { type: 'string', description: 'Only open-thread events after this ISO time.' },
    session_id: { type: 'string', description: 'Opaque session id.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only.' },
    min_trust: MIN_TRUST_PARAM,
    include_quarantined: { type: 'boolean', description: 'Admin or memory_confirm: quarantined cards.', fullSurfaceOnly: true },
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'context-pack' },
  annotations: { title: 'context_pack (boundary bundle)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleContextPack, renderPack, isAfter, PACK_DEFAULT_MAX_ENTITIES, renderCardLine, renderThreadLine, renderFactLine, packHeaderCost,
      renderNewerMentionLines } = await import('../context/turn-context.ts');
    const { NEWER_MENTIONS_HEADER } = await import('../mentions/newer-mentions.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : undefined;
    if (rawSince !== undefined && !Number.isFinite(Date.parse(rawSince))) {
      throw verbError(
        'invalid_params',
        `context_pack: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`,
        `Pass an ISO 8601 datetime, e.g. ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')}.`,
      );
    }
    // Normalize to ISO (red-team F4): the filter + rendered text use it.
    const since = rawSince !== undefined ? new Date(Date.parse(rawSince)).toISOString() : undefined;
    // Echo the CAPPED list (pre-landing review): the assembler bundles at most
    // PACK_DEFAULT_MAX_ENTITIES, so echoing more would claim entities were
    // bundled that produced no cards.
    const entities = parseEntityList(p.entities).slice(0, PACK_DEFAULT_MAX_ENTITIES);
    // Fail-closed: private only when EXPLICITLY requested AND the caller is
    // trusted-local (ctx.remote === false). A remote caller never widens.
    const includePrivate = p.include_private === true && ctx.remote === false;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;
    // #5575 (CEO-20, CEO-18): a proactive surface under the connection's floor.
    const eligibility = await proactiveEligibility(ctx, 'context_pack', { minTrust: p.min_trust });
    const res = entities.length === 0
      ? { cards: [], facts: [], text: '', pointers: [], factsCount: 0 } as unknown as Awaited<ReturnType<typeof assembleContextPack>>
      : await assembleContextPack(ctx.engine, {
        sourceId,
        entities,
        since,
        sessionId: typeof p.session_id === 'string' ? p.session_id : undefined,
        includePrivate,
        maxEntities: PACK_DEFAULT_MAX_ENTITIES,
        eligibility,
        // #5575 ENG-15: same rule as get_page: quarantined cards only on an authorized explicit ask.
        includeQuarantined: p.include_quarantined === true && (ctx.remote === false || hasScope(ctx.auth?.scopes ?? [], 'admin') || hasScope(ctx.auth?.scopes ?? [], MEMORY_CONFIRM_SCOPE)),
      });
    // Always-loaded core tier (core-memory.ts): owner-designated pages of
    // `default` plus this source, inside the caller's grant; it packs first.
    const { loadCoreBlock } = await import('../core-memory.ts');
    const allowed = ctx.auth?.allowedSources?.length ? ctx.auth.allowedSources : null;
    const core = await loadCoreBlock(ctx.engine, { sessionSourceId: sourceId, allowedSources: allowed, excludePrivate: !includePrivate, eligibility })
      .catch(() => null);
    const coreText = core?.text ?? '';
    const coreTokens = estimateTokens(coreText);
    const withheld = (res.suppressed?.withheld ?? 0) + (core?.activation_withheld ?? 0);
    const suppressionNotice = activationSuppressionNotice(withheld, 'this context pack');
    if (suppressionNotice) ctx.emitNotice?.(suppressionNotice);

    // Pack, price and render the redacted presentation sets (one echo
    // dictionary); local callers get the delivered facts back raw below.
    const rawFacts = await withProvenance(ctx.engine, sourceId, res.facts ?? []);
    const view = redactRetrievalOutput([{ cards: res.cards ?? [], facts: rawFacts }], {}).results[0];
    let cards = view.cards;
    let facts = view.facts;
    // The SAME since filter the assembler applied (pre-landing review: the raw
    // flatMap silently dropped the documented `since` contract from the
    // structured array whenever budget packing ran) — shared with the card
    // cost below, since a card's rendered threads ride its budget.
    const threadsOf = (c: (typeof cards)[number]) =>
      (c.open_threads ?? []).filter((t) => !since || (t.date !== null && isAfter(t.date, since)));
    let droppedCount: number | undefined;
    if (budgetTokens !== null) {
      // #4761: reserve the envelope + headers, then price each card as its
      // rendered line plus its rendered (since-filtered) thread lines.
      const itemBudget = budgetTokens - packHeaderCost() - coreTokens;
      const cardCost = (c: (typeof cards)[number]) =>
        lineCost(renderCardLine(c)) + threadsOf(c).reduce((n, t) => n + lineCost(renderThreadLine(t)), 0);
      const cardPack = itemBudget > 0 ? packToBudget(cards, cardCost, itemBudget) : dropAll(cards);
      cards = cardPack.items;
      const remaining = itemBudget - cardPack.meta.used;
      const factPack = remaining > 0 ? packToBudget(facts, (f) => lineCost(renderFactLine(f)), remaining) : dropAll(facts);
      facts = factPack.items;
      // Newer mentions pack last, into what cards and facts left; a card whose block does not fit keeps its card line.
      const mentionBudget = remaining - factPack.meta.used - lineCost('') - lineCost(NEWER_MENTIONS_HEADER);
      const withMentions = cards.filter((c) => c.newer_mentions);
      const mentionPack = mentionBudget > 0
        ? packToBudget(withMentions, (c) => renderNewerMentionLines(c).reduce((n, l) => n + lineCost(l), 0), mentionBudget)
        : dropAll(withMentions);
      const keptMentions = new Set(mentionPack.items);
      cards = cards.map((c) => (c.newer_mentions && !keptMentions.has(c) ? { ...c, newer_mentions: undefined } : c));
      droppedCount = cardPack.meta.dropped + factPack.meta.dropped;
    }
    const open_threads = cards.flatMap(threadsOf);
    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` is what harnesses inject, so it must honor the same budget the
    // structured arrays report — the assembler's pre-budget rendering would
    // overrun the declared budget_tokens. budget_used reports that text.
    const packText = entities.length === 0 ? '' : budgetTokens !== null ? renderPack(cards, open_threads, facts) : res.text;
    const text = [coreText, packText].filter(Boolean).join('\n\n');
    const budgetUsed = budgetTokens !== null ? estimateTokens(text) : undefined;

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      entities,
      cards: cards.map((c) => ({
        slug: c.entity.slug,
        title: c.entity.title,
        type: c.entity.type,
        summary: c.quarantined && c.summary ? renderTrustedText(c.summary, { trust_tier: 'external_untrusted', origin: 'quarantined' }) : c.summary,
        open_threads: c.open_threads,
        edges: c.edges,
        backlink_count: c.backlink_count,
        ...(c.relationship_note ? { relationship_note: c.relationship_note } : {}),
        ...(c.trust_tier ? { trust_tier: c.trust_tier, origin: c.origin } : {}),
        ...(c.quarantined ? { quarantined: true } : {}),
        ...(c.unconfirmed ? { unconfirmed: true } : {}),
        ...(c.newer_mentions ? { newer_mentions: c.newer_mentions } : {}),
      })),
      open_threads,
      facts: (ctx.remote === false ? rawFacts.slice(0, facts.length) : facts).map((f) => ({
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        // #4206: provenance context (parity with the recall projection).
        context: f.context ?? null,
        confidence: f.confidence,
        // #6146: recall's v1 names, so a packed fact traces back to its record.
        fact_id: String(f.id),
        provenance: f.provenance,
        ...(f.trust_tier ? { trust_tier: f.trust_tier, origin: f.origin } : {}),
      })),
      text,
      ...(withheld ? { suppressed: suppressionSummary(withheld) } : {}),
      ...(core && core.enabled ? { core: { text: core.text, chars_used: core.chars_used, chars_limit: core.chars_limit, pages: core.pages,
        truncated: core.truncated, revision: core.revision } } : {}),
      ...(res.degradedReason ? { degraded_reason: res.degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

const delta: Operation = {
  name: 'delta',
  mutating: false,
  idempotent: true,
  outputRedaction: { retrieval: { localVerbatim: ['facts'] } },
  description: 'MEMORY VERB (v1): pages, facts, thread events changed since a cursor, zero LLM. Pass session_id, cursor or since.',
  params: {
    since: { type: 'string', description: 'ISO 8601 start time.' },
    since_slug: { type: 'string', description: 'Legacy: next_cursor.slug.' },
    cursor: { type: 'string', description: 'next_cursor.cursor (exact).' },
    entities: { type: 'string', description: 'Entities for thread events (max 8).' },
    budget_tokens: { type: 'number', description: 'Token budget; pages pack first.' },
    session_id: { type: 'string', description: 'Session id; keeps a cursor.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only.' },
    min_trust: MIN_TRUST_PARAM,
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'delta' },
  annotations: { title: 'delta (what changed since)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleDeltaContext, renderDelta, PACK_DEFAULT_MAX_ENTITIES, renderPageLine, renderFactLine, renderThreadLine, deltaHeaderCost } =
      await import('../context/turn-context.ts');
    const { readDeltaSessionState, upsertSessionContextState, gcSessionContextState } = await import('../context/session-state.ts');
    const cur = await import('../context/delta-cursor.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : null;
    // NORMALIZE to ISO immediately (red-team F4): the raw string is echoed
    // into the injectable `text` block, so an attacker-shaped-but-parseable
    // `since` must never reach rendering verbatim. A value already in the
    // canonical microsecond shape `listPages` projects (`next_cursor.since`
    // passed back) is kept verbatim. Date.parse normalizes Feb 31 into March
    // and accepts years 0 and 10000+ that Postgres timestamptz refuses, so the
    // calendar date and the 0001-9999 range are checked on the parsed value.
    let explicitSince: string | null = null;
    if (rawSince !== null) {
      const checked = cur.checkDeltaTimestamp(rawSince);
      if (!checked.ok) {
        throw verbError(
          'invalid_params',
          checked.why === 'unparseable'
            ? `delta: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`
            : checked.why === 'calendar'
              ? `delta: since is not a valid ISO 8601 calendar timestamp: "${rawSince.slice(0, 60)}"`
              : `delta: since is outside the accepted range ${cur.DELTA_TIMESTAMP_RANGE}: "${rawSince.slice(0, 60)}"`,
          checked.why === 'unparseable'
            ? `Pass an ISO 8601 datetime, e.g. ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')}.`
            : `Pass a real calendar datetime between years 0001 and 9999, e.g. ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')}.`,
        );
      }
      explicitSince = checked.value;
    }
    const rawCursor = typeof p.cursor === 'string' && p.cursor.trim() ? p.cursor.trim() : null;
    let cursorPos: import('../context/delta-cursor.ts').DeltaPosition | null = null;
    if (rawCursor !== null) {
      const decoded = cur.decodeDeltaCursor(rawCursor);
      if (!decoded.ok) {
        throw verbError(
          'invalid_params',
          `delta: cursor is invalid: ${decoded.why}`,
          `Pass next_cursor.cursor from a previous delta response unchanged, or omit cursor and pass ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')}.`,
        );
      }
      cursorPos = decoded.pos;
    }
    const sessionId = typeof p.session_id === 'string' && p.session_id.trim() ? p.session_id : null;
    // Cursor namespace (pre-landing review, fail-closed): 'local' is RESERVED
    // for the trusted CLI/hook lane, gated on STRICT ctx.remote === false —
    // anything else (true, undefined via cast bypass) is remote. Remote callers
    // use their auth client id; an auth-LESS or blank-id remote (stdio MCP)
    // gets the shared 'remote' sentinel — never collapsed into 'local'.
    const clientId = ctx.remote === false ? null : ctx.auth?.clientId?.trim() || 'remote';
    const includePrivate = p.include_private === true && ctx.remote === false;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;
    const explicitSlug = typeof p.since_slug === 'string' ? p.since_slug : undefined;
    const read = sessionId ? await readDeltaSessionState(ctx.engine, sourceId, clientId, sessionId) : null;

    // Start position. Explicit overrides replace WHOLE tuples: `cursor` sets
    // both arms; `since` sets both arms to "strictly after since" with only the
    // slug the caller supplied (never the session's slug for another time).
    type Pos = import('../context/delta-cursor.ts').DeltaPosition;
    const start: Pos | null = cur.resolveDeltaStart({ cursorPos, explicitSince, explicitSlug, session: read?.status === 'loaded' ? read.state : null });
    const stateful = sessionId !== null;
    const retryArgs: Record<string, unknown> = {
      ...(stateful ? { session_id: sessionId } : { cursor: start ? cur.encodeDeltaCursor(start) : undefined }),
      ...(typeof p.entities === 'string' ? { entities: p.entities } : {}),
      ...(budgetTokens !== null ? { budget_tokens: budgetTokens } : {}),
      ...(includePrivate ? { include_private: true } : {}),
    };
    const emitIncomplete = (reason: string, consecutive: number) =>
      ctx.emitNotice?.(incompleteNotice(reason, stateful && consecutive >= DELTA_ESCALATE_AFTER, consecutive, retryArgs));

    if (!start) {
      if (!sessionId) {
        throw verbError(
          'invalid_params',
          'delta requires `since` (ISO 8601), a `cursor`, or a `session_id` with an established cursor.',
          `Pass ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')} for a stateless delta, or a stable ${paramUse(ctx, 'session_id', 'agent-main')} — the first call establishes the cursor and later calls return only newer changes.`,
        );
      }
      if (read?.status === 'unavailable') {
        // A failed state read is NOT a first wake: initializing at now would
        // drop everything since the session's checkpoint. With no position
        // there is nothing to deliver, so refuse retryably and move nothing.
        throw sessionUnavailableError(ctx, bumpLocalDegraded(sourceId, clientId, sessionId, true) >= DELTA_ESCALATE_AFTER, retryArgs);
      }
      // First wake (no row, including a GC-expired session): establish the
      // cursor at now and report an empty delta. Opportunistic GC on row
      // creation bounds session-row accumulation. AWAITED (v0.45.7): a
      // floating engine promise races the CLI lane's engine teardown.
      const now = new Date().toISOString();
      const first: Pos = { pages: { since: now }, facts: { at: now, id: null } };
      const wrote = await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
        lastWakeAt: now, factsCursor: { at: now, id: null }, degradedWakes: 'reset',
      });
      await gcSessionContextState(ctx.engine);
      ctx.emitNotice?.({
        code: 'empty_retrieval',
        kind: 'info',
        why: `delta started this session's cursor now (${now}); this call and later calls return only changes after it. To read earlier changes, replay statelessly with since (no session_id), which leaves this cursor alone.`,
        fix: { argv: ['gbrain', 'delta', '--since', '<since>'], mcp: { tool: 'delta', arguments: { since: '<since>' } },
          inputs: [{ name: 'since', how: 'the ISO 8601 time to read changes from, e.g. 24 hours ago' }],
          consent: [], actor: 'agent', requires_exclusive: false, why: 'Reads the changes before this session started without moving its cursor.', docs: DELTA_REPLAY_DOCS },
      });
      if (!wrote.ok) emitIncomplete('session_state', bumpLocalDegraded(sourceId, clientId, sessionId, true));
      return {
        protocol_version: MEMORY_VERBS_VERSION,
        since: now, pages: [], facts: [], threads: [], text: '', has_more: false,
        next_cursor: { since: now, slug: '', cursor: cur.encodeDeltaCursor(first) },
        ...(wrote.ok ? {} : { degraded_reason: 'session_state' }),
        ...(budgetTokens !== null ? { budget_tokens: budgetTokens, budget_used: 0, dropped_count: 0 } : {}),
      };
    }

    const effectiveSince = start.pages.since;
    const res = await assembleDeltaContext(ctx.engine, {
      sourceId,
      since: effectiveSince,
      ...(start.pages.slug !== undefined ? { sinceSlug: start.pages.slug } : {}),
      factsAfter: start.facts,
      entities: parseEntityList(p.entities),
      sessionId: sessionId ?? undefined,
      includePrivate,
      maxEntities: PACK_DEFAULT_MAX_ENTITIES,
      eligibility: await resolveReadEligibility(ctx, { minTrust: p.min_trust }),
    });

    // Pages arrive OLDEST first by (updated_at, slug), facts OLDEST first by
    // (created_at, id). Pack, price and render the redacted presentation sets
    // (one echo dictionary). The cursors read the raw rows at the delivered
    // index and local callers get the delivered facts back raw below.
    const rawPages = res.deltaPages ?? [];
    const rawFacts = await withProvenance(ctx.engine, sourceId, res.facts ?? []);
    const view = redactRetrievalOutput([{ pages: rawPages, facts: rawFacts, threads: res.openThreads ?? [] }], {}).results[0];
    let pages = view.pages;
    let facts = view.facts;
    // Threads are NEVER budget-dropped: they are the commitments a heartbeat
    // must not miss, and they have no keyset of their own to resume from.
    const threads = view.threads;
    let droppedCount: number | undefined;
    let factsDropped = 0;
    let itemBudget = 0;
    const fetchedPages = pages.length;
    const fetchedFacts = facts.length;
    if (budgetTokens !== null) {
      // packToBudget keeps a contiguous PREFIX (order-preserving, stops at the
      // first overflow), which both arms' delivered-prefix cursors depend on.
      // #4761: reserve the envelope + headers and every thread line, then cost
      // each page/fact as its rendered line.
      itemBudget =
        budgetTokens - deltaHeaderCost(effectiveSince) - threads.reduce((n, t) => n + lineCost(renderThreadLine(t)), 0);
      const pagePack = itemBudget > 0 ? packToBudget(pages, (pg) => lineCost(renderPageLine(pg)), itemBudget) : dropAll(pages);
      pages = pagePack.items;
      const remaining = itemBudget - pagePack.meta.used;
      const factPack = remaining > 0 ? packToBudget(facts, (f) => lineCost(renderFactLine(f)), remaining) : dropAll(facts);
      facts = factPack.items;
      droppedCount = pagePack.meta.dropped + factPack.meta.dropped;
      factsDropped = factPack.meta.dropped;
    }
    const pagesDropped = fetchedPages - pages.length;
    const factsOverflowRow = res.deltaFactsOverflowRow ?? null;
    // has_more: more content is waiting (fetch-limit overflow on either arm or
    // a budget drop). Failure is signalled by degraded_reason + the notice.
    const hasMore = res.deltaOverflow === true || factsOverflowRow !== null || pagesDropped > 0 || factsDropped > 0;

    // Per-arm advance (at-least-once): each arm moves through the prefix it
    // DELIVERED and never past now() - lag; an arm whose read failed or never
    // finished holds. Thread events follow the pages' time cursor, so an
    // incomplete threads arm holds the pages arm too.
    const arms = res.deltaArms ?? { pages: 'unknown', facts: 'unknown', threads: 'unknown' };
    const horizon = cur.horizonIso();
    const pagesNext = cur.nextPagesPos({
      start: start.pages,
      complete: arms.pages === 'ok' && arms.threads === 'ok',
      delivered: rawPages.slice(0, pages.length),
      undelivered: res.deltaOverflow === true || pagesDropped > 0,
      horizon,
      advanceOnEmpty: stateful,
    });
    const deliveredRepIds = new Set(rawFacts.slice(0, facts.length).map((f) => f.id));
    const { next: factsNext, oldestUndelivered } = cur.nextFactsPos({
      start: start.facts,
      complete: arms.facts === 'ok',
      raw: res.deltaFactsRaw ?? [],
      overflowRow: factsOverflowRow,
      deliveredRepIds,
      horizon,
      advanceOnEmpty: stateful,
    });
    const next: Pos = { pages: pagesNext, facts: factsNext };

    // Conservative legacy `since`/`slug` for clients that do not send `cursor`.
    const incomplete = res.degradedReason !== undefined;
    const { legacy, clamped } = cur.legacyDeltaCursor({
      start, pagesNext, factsNext, oldestUndelivered, incomplete,
      pagesDelivered: pages.length, factsDelivered: facts.length,
      pagesQuiet: res.deltaOverflow !== true && pagesDropped === 0,
    });
    if (clamped && !stateful && cursorPos === null && cur.comparePages(legacy, start.pages) <= 0) {
      // A legacy stateless caller at a boundary it cannot page (more undelivered
      // facts at one timestamp than the fetch limit): advancing would skip
      // them and holding would loop forever. Only the opaque cursor can page it.
      const exact = cur.encodeDeltaCursor(next);
      const e = opError(
        'delta_cursor_upgrade_required',
        'delta: more undelivered facts share one timestamp than a since/since_slug cursor can page.',
        `Repeat the call with ${paramUse(ctx, 'cursor', exact)} instead of since/since_slug.`,
        {
          why: 'The legacy cursor is a single timestamp; facts that share it can only be paged by fact id, which the opaque cursor carries. Nothing was skipped and no cursor moved.',
          fix: { argv: deltaArgv({ cursor: exact }), mcp: { tool: 'delta', arguments: { cursor: exact } }, consent: [], actor: 'agent', requires_exclusive: false,
            why: 'Resumes both arms exactly; keep passing next_cursor.cursor on later calls.', docs: DELTA_REPLAY_DOCS },
        },
      );
      e.protocolVersion = MEMORY_VERBS_VERSION;
      throw e;
    }

    let degradedReason = res.degradedReason;
    if (sessionId) {
      const wrote = await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
        lastWakeAt: pagesNext.since,
        cursorSlug: pagesNext.slug ?? '',
        factsCursor: { at: factsNext.at, id: factsNext.id },
        degradedWakes: incomplete ? 'increment' : 'reset',
      });
      if (!wrote.ok) degradedReason = degradedReason ? `${degradedReason},session_state` : 'session_state';
      const consecutive = wrote.ok ? (bumpLocalDegraded(sourceId, clientId, sessionId, false), wrote.degradedWakes) : bumpLocalDegraded(sourceId, clientId, sessionId, true);
      if (degradedReason) emitIncomplete(degradedReason, consecutive);
    } else if (degradedReason) {
      emitIncomplete(degradedReason, 1);
    }

    // A budget too small for even ONE waiting item would return has_more
    // forever; say so with the budget that fits the next item.
    if (budgetTokens !== null && pages.length === 0 && facts.length === 0 && (pagesDropped > 0 || factsDropped > 0)) {
      const nextItem = fetchedPages > 0 ? lineCost(renderPageLine(view.pages[0])) : fetchedFacts > 0 ? lineCost(renderFactLine(view.facts[0])) : 0;
      const needed = budgetTokens - itemBudget + nextItem;
      const bigger = { ...retryArgs, budget_tokens: needed };
      ctx.emitNotice?.({
        code: 'delta_incomplete',
        kind: 'degraded',
        why: `budget_tokens ${budgetTokens} cannot fit even one waiting item (the next one needs ${needed}); repeating the call with the same budget returns has_more forever.`,
        fix: { argv: deltaArgv(bigger), mcp: { tool: 'delta', arguments: bigger }, consent: [], actor: 'agent', requires_exclusive: false,
          why: `Repeat with budget_tokens ${needed} or more; nothing was skipped and no cursor moved.` },
      });
    }

    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` must honor the budget AND the boundary-tie exclusion the
    // structured arrays reflect — the assembler's render predates both.
    const text = renderDelta(pages, facts, threads, effectiveSince);
    const budgetUsed = budgetTokens !== null ? estimateTokens(text) : undefined;

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      since: effectiveSince,
      pages,
      facts: (ctx.remote === false ? rawFacts.slice(0, facts.length) : facts).map((f) => ({
        id: f.id,
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        // #4206: provenance context (parity with the recall projection).
        context: f.context ?? null,
        confidence: f.confidence,
        // #6146: recall's v1 names, so a packed fact traces back to its record.
        fact_id: String(f.id),
        provenance: f.provenance,
        ...(f.trust_tier ? { trust_tier: f.trust_tier, origin: f.origin } : {}),
      })),
      threads,
      text,
      has_more: hasMore,
      // Stateless resume: pass `cursor` back (exact, both arms). Older clients
      // pass `since` + `since_slug` (conservative: may re-see, never skips).
      next_cursor: { since: legacy.since, slug: legacy.slug ?? '', cursor: cur.encodeDeltaCursor(next) },
      // Replay audit trail: where each arm started and where it resumes.
      cursor_arms: {
        pages: { start: { since: start.pages.since, slug: start.pages.slug ?? null }, next: { since: pagesNext.since, slug: pagesNext.slug ?? null } },
        facts: { start: { since: start.facts.at, id: start.facts.id }, next: { since: factsNext.at, id: factsNext.id } },
      },
      ...(degradedReason ? { degraded_reason: degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

/** delta: consecutive incomplete wakes before the notice escalates from `wait` to `report`. */
const DELTA_ESCALATE_AFTER = 3;
const DELTA_RETRY_SECONDS = 30;
const DELTA_REPLAY_DOCS = 'docs/guides/ambient-recall.md#replay-after-a-degraded-wake';

/** The delta_incomplete notice: retry the same call after a short wait, or report once it keeps failing. */
function incompleteNotice(reason: string, escalate: boolean, consecutive: number, retryArgs: Record<string, unknown>): Notice {
  return {
    code: 'delta_incomplete',
    kind: 'degraded',
    why: escalate
      ? `delta has been incomplete on ${consecutive} consecutive wakes (${reason}); no cursor moved past content it did not deliver, but the store is not recovering on its own.`
      : `delta could not complete this read (${reason}); no cursor moved past content it did not deliver. Retry the same call in about ${DELTA_RETRY_SECONDS} seconds and the held cursor re-reads the same window.`,
    fix: escalate
      ? { consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Tell the user delta keeps failing, then run gbrain doctor --json to find the failing store.',
          verify: { argv: ['gbrain', 'doctor', '--json'] }, docs: DELTA_REPLAY_DOCS }
      : { argv: deltaArgv(retryArgs), mcp: { tool: 'delta', arguments: retryArgs }, consent: [], actor: 'provider', requires_exclusive: false,
          why: `Retry the same read after about ${DELTA_RETRY_SECONDS} seconds; nothing was skipped.`, docs: DELTA_REPLAY_DOCS },
  };
}

/** A failed session-state read is NOT a first wake: refuse retryably, move nothing. */
function sessionUnavailableError(ctx: OperationContext, escalate: boolean, retryArgs: Record<string, unknown>): OperationError {
  const e = opError(
    'unavailable',
    'delta: the session cursor could not be read, so this wake delivered nothing and moved nothing.',
    escalate
      ? 'The session store has failed on several consecutive wakes: tell the user and run `gbrain doctor --json`.'
      : `Retry the same call in about ${DELTA_RETRY_SECONDS} seconds, or replay statelessly with ${paramUse(ctx, 'since', '2026-08-11T00:00:00Z')}.`,
    {
      reason: 'session_state',
      why: 'Treating a failed read as a new session would restart the cursor at now and silently skip everything since its checkpoint.',
      fix: escalate
        ? { consent: [], actor: 'agent', requires_exclusive: false, why: 'Tell the user the session store keeps failing, then run gbrain doctor --json.', verify: { argv: ['gbrain', 'doctor', '--json'] }, docs: DELTA_REPLAY_DOCS }
        : { argv: deltaArgv(retryArgs), mcp: { tool: 'delta', arguments: retryArgs }, consent: [], actor: 'provider', requires_exclusive: false,
            why: `Retry the same read after about ${DELTA_RETRY_SECONDS} seconds; the checkpoint is intact.`, docs: DELTA_REPLAY_DOCS },
    },
  );
  e.protocolVersion = MEMORY_VERBS_VERSION;
  return e;
}

/** CLI form of a delta call (flags mirror the params). */
function deltaArgv(args: Record<string, unknown>): string[] {
  const argv = ['gbrain', 'delta'];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const flag = `--${k.replace(/_/g, '-')}`;
    if (v === true) argv.push(flag);
    else argv.push(flag, String(v));
  }
  return argv;
}

/**
 * In-process consecutive-incomplete counter: the fallback when the session
 * store itself is down (the durable counter lives in session_context_state).
 * Bounded; returns the count after the update.
 */
const localDegraded = new Map<string, number>();
function bumpLocalDegraded(sourceId: string, clientId: string | null, sessionId: string, incomplete: boolean): number {
  const key = `${sourceId}|${clientId ?? 'local'}|${sessionId}`;
  if (!incomplete) {
    localDegraded.delete(key);
    return 0;
  }
  const n = (localDegraded.get(key) ?? 0) + 1;
  localDegraded.delete(key);
  localDegraded.set(key, n);
  if (localDegraded.size > 1_000) localDegraded.delete(localDegraded.keys().next().value!);
  return n;
}

const forget_fact: Operation = {
  name: 'forget_fact',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Forget a fact by recording a durable withdrawal in its source and visibility. Strikes the Markdown facts fence when writable; otherwise keeps the withdrawal in the database. Stale imports cannot reactivate the same normalized claim. This retracts memory; original prose, files and backups may retain the text. Idempotent on already-expired or unknown ids.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    id: { type: 'number', required: true, description: 'Fact id to forget.' },
    reason: { type: 'string', required: false, description: 'Optional reason; written to the fence row\'s context cell as "forgotten: <reason>". Default: "forgotten".' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'forget_fact', id: p.id };
    const { submitForgetMutation } = await import('../persistence/memory-mutations.ts');
    return submitForgetMutation(ctx, 'forget_fact', p);
  },
};

/**
 * recall's per-arm limit clamp — applied ONCE, before the per-source fan-out.
 * The doc contract is "Default 50, cap 100": each engine clamps its own query,
 * but the cross-source merge slices with THIS value, so an unclamped limit
 * (e.g. 150 across two granted sources) would return up to 200 rows.
 * Invalid input (undefined / NaN / non-positive / non-integer) → default 50;
 * valid positive integers clamp to [1, 100]. Exported for the unit suite.
 */
export function clampRecallLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return 50;
  return Math.min(raw, 100);
}

/**
 * Parse a `since` parameter into a Date. Accepts ISO 8601, plain duration
 * shorthand ("8 hours ago", "3 days ago", "30m", "1h", "2d", "7d"), or
 * Unix epoch millis. Returns null on unparseable input.
 */
function parseSinceParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Try ISO first.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  // "N (minutes|hours|days) ago" or compact forms.
  const ago = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return null;
}

/**
 * MEMORY_VERBS v1 — parse the `remember` verb's `ttl` param into a
 * `valid_until` Date. Sibling of parseSinceParam, pointed FORWARD.
 *
 * Accepted forms (frozen in docs/protocol/MEMORY_VERBS_v1.md):
 *   - relative duration shorthand: '30d', '12h', '45m', '90s' (also
 *     spelled-out: '30 days', '12 hours') → now + duration
 *   - absolute ISO 8601 date or datetime: '2026-07-12', '2026-07-12T00:00:00Z'
 *
 * Explicitly REJECTED with a self-correcting suggestion: ISO-8601 duration
 * syntax ('P30D', 'PT12H') — agents that read "ISO 8601" as durations get a
 * fix, not a mystery. Returns null for null/undefined/empty (= never expires).
 * Throws verbError('invalid_params') on anything unparseable.
 */
export function parseTtlParam(raw: unknown): Date | null {
  // Grammar lives in the dependency-free leaf (core/facts/ttl-parse.ts — E1,
  // ambient-writeback wave) so the engine-free hook lane shares it without
  // importing this module's gateway-reaching graph. This wrapper owns the
  // wire contract: the verbError copy below is byte-identical to the
  // pre-extraction messages.
  const parsed = parseTtlShorthand(raw);
  if (parsed.ok) return parsed.validUntil;
  if (parsed.code === 'not_string') {
    throw verbError(
      'invalid_params',
      `ttl must be a string, got ${typeof raw}.`,
      'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z".',
    );
  }
  if (parsed.code === 'iso_duration') {
    const s = parsed.input;
    throw verbError(
      'invalid_params',
      `ttl "${s}" looks like an ISO-8601 duration, which is not accepted.`,
      `Use the shorthand form instead (e.g. "${s.replace(/^PT?/i, '').toLowerCase()}" style: "30d", "12h"), or an absolute ISO 8601 expiry timestamp.`,
    );
  }
  throw verbError(
    'invalid_params',
    `Cannot parse ttl "${parsed.input}".`,
    'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z". Omit ttl for a fact that never expires.',
  );
}

export const factsOperations: Operation[] = [
  extract_facts, recall, context_pack, delta, forget_fact,
];

/** Why recall's page-search arm runs keyword-only, or null: the brain opted out (no query text sent), or no provider. */
async function recallKeywordOnlyReason(ctx: OperationContext): Promise<string | null> {
  const { factEmbeddingDisabled } = await import('../embedding-disabled.ts');
  if (await factEmbeddingDisabled(ctx.engine, ctx.config)) return (await import('../interop-notices.ts')).RECALL_KEYWORD_ONLY_OPTED_OUT;
  return isAvailable('embedding') ? null : 'keyword_only_no_embedding_provider';
}

/**
 * Keyless recall's page arm: direct keyword FTS, except that a planned
 * multi-relation question (planner on) goes through hybridSearch's keyless
 * path, which runs keyword + title + the relational chain (zero LLM).
 */
async function keylessRecallRows(
  ctx: OperationContext, queryText: string, limit: number, excludePrivate: boolean,
  searchScope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier },
): Promise<SearchResult[]> {
  if (await keylessChainQuestion(ctx, queryText)) {
    return hybridSearchCached(ctx.engine, queryText, {
      limit, expansion: false, excludePrivate, requireSafeChunks: ctx.remote !== false,
      takesHoldersAllowList: readHolders(ctx), ...searchScope,
    });
  }
  const rows = dedupResults(await ctx.engine.searchKeyword(queryText, { limit, excludePrivate, requireSafeChunks: ctx.remote !== false, ...searchScope }));
  // #3783 — direct FTS path: every row is a keyword hit by construction.
  markKeywordHits(rows);
  stampEvidenceSafe(rows);
  await stampContentFlags(ctx.engine, rows, { ...searchScope, excludePrivate });
  return rows;
}

/** Keyless recall routes a planned multi-relation question through the relational chain when the planner is on. */
async function keylessChainQuestion(ctx: OperationContext, queryText: string): Promise<boolean> {
  if (parseRelationalPlan(queryText).kind !== 'plan') return false;
  const modeInput = await loadSearchModeConfig(ctx.engine);
  return resolveSearchMode({ mode: modeInput.mode, overrides: modeInput.overrides }).relational_planner;
}
