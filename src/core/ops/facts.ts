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

import type { Operation } from './contract.ts';
import { OperationError, verbError } from './contract.ts';
import { sourceScopeOpts, stampEvidenceSafe } from './context.ts';
import { markKeywordHits } from '../search/evidence.ts';
import { hybridSearchCached, stampContentFlags } from '../search/hybrid.ts';
import { dedupResults } from '../search/dedup.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { packToBudget, estimateTokens, resultTokens } from '../search/token-budget.ts';
import { isAvailable } from '../ai/gateway.ts';
// #4209: the named entity-hints cap — surfaced in the extract_facts param
// description and the entity_hints_used/_dropped response fields.
import { ENTITY_HINTS_CAP } from '../facts/extract.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';
import type { SearchResult } from '../types.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';

// ============================================================
// v0.31 — Hot memory ops: extract_facts / recall / forget_fact
// ============================================================

const extract_facts: Operation = {
  name: 'extract_facts',
  description:
    'v0.31: extract personal-knowledge facts (events, preferences, commitments, beliefs) from a conversation turn into the per-source hot memory. Sanitizes turn_text via INJECTION_PATTERNS, calls the configured extraction model (key-aware: any servable provider — OpenAI or Anthropic key both work), runs the cosine fast-path + classifier dedup pipeline, INSERTs into facts. Returns counts by status. With NO servable chat model, returns skipped: extraction_unavailable + an agent_action telling YOU to extract and write via `remember` (visibility: "private"). Skips extraction when the turn is dream-generated content (anti-loop). For agent memory writes of a SINGLE already-formed fact, prefer the `remember` verb (zero LLM, mandatory provenance).',
  params: {
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
        throw new OperationError(
          'invalid_params',
          `invalid valid_from: "${String(p.valid_from)}" — expected a parseable ISO 8601 datetime`,
        );
      }
      validFrom = d;
    }
    const sourceSlug =
      typeof p.source_slug === 'string' && p.source_slug.trim().length > 0
        ? p.source_slug.trim()
        : undefined;

    const r = await runFactsPipeline(p.turn_text as string, {
      engine: ctx.engine,
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
      ...hintAccounting,
    };
  },
};

const recall: Operation = {
  name: 'recall',
  description:
    'MEMORY VERB (v1): retrieve saved facts/snippets — the protocol read verb. Filters hot-memory facts by entity / since / session_id; pass `query` to ALSO run hybrid search over pages (results[] arm); pass `budget_tokens` for server-side packing (response reports budget_used + dropped_count — never trims client-side). Remote callers see visibility=world facts only. Routing: for ONE known person/company/project card use `entity` (zero LLM); for broad questions needing reasoning use `synthesize` (expensive). Branch on structured fields (status/kind/evidence), never on prose. Every response carries protocol_version.',
  params: {
    entity: { type: 'string', description: 'Entity slug (canonical). Returns facts about this entity newest first.' },
    query: { type: 'string', description: 'MEMORY_VERBS v1: free-text retrieval over pages (hybrid search arm). Response adds results[] (slug, title, chunk, evidence, create_safety, provenance). Combinable with entity (both arms run). Degrades to keyword-only search when no embedding provider is configured (search_degraded notes it; never an error).' },
    budget_tokens: { type: 'number', description: 'MEMORY_VERBS v1: server-side token budget (char/4 estimate). Facts pack first, then results. Response adds budget_tokens, budget_used, dropped_count.' },
    since: { type: 'string', description: 'ISO 8601 datetime or duration shorthand (e.g. "8 hours ago"). Filters the FACTS arm only.' },
    session_id: { type: 'string', description: 'Source session id (e.g. topic-A). Returns facts captured in that session.' },
    include_expired: { type: 'boolean', description: 'When true, include expired_at IS NOT NULL rows. Default false.' },
    supersessions: { type: 'boolean', description: 'When true, return only the supersession audit log (facts with superseded_by set), newest first by COALESCE(expired_at, valid_until).' },
    limit: { type: 'number', description: 'Per-arm cap: max fact rows AND max search results. Default 50, cap 100.' },
    grep: { type: 'string', description: 'Substring filter on fact text (case-insensitive). Applied client-side after recall.' },
    include_pending: { type: 'boolean', description: 'v0.32: when true, response includes pending_consolidation_count (facts not yet promoted to takes by the dream-cycle consolidate phase). One round trip; backward-compatible (field omitted when false).' },
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
    // default — via sourceScopeOpts, never a hand-rolled filter. The engine
    // fact APIs are scalar-source, so a federated grant fans out per granted
    // source and merges newest-first; a single-source caller takes exactly
    // the pre-v1 single-query path. A trusted-local `__all__` ({}) has no
    // enumerable grant and keeps the resolved-scalar behavior.
    const scope = sourceScopeOpts(ctx);
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

    if (p.supersessions === true) {
      const since = parseSinceParam(p.since);
      // Visibility filters at the ENGINE level (before each source's LIMIT),
      // same as the sibling fact-list arms — a post-merge filter would let a
      // private newest row consume a limit slot and hide an older world row.
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listSupersessions(src, { since: since ?? undefined, limit, visibility }),
        )),
        // v0.46 (#3014): matches the engine's ORDER BY COALESCE(expired_at,
        // valid_until) — ontology supersessions carry valid_until only.
        (rec) => rec.expired_at ?? rec.valid_until ?? rec.created_at,
      );
    } else if (typeof p.entity === 'string' && p.entity.length > 0) {
      const { resolveEntitySlug } = await import('../entities/resolve.ts');
      rows = mergeNewest(
        await Promise.all(factSources.map(async (src) => {
          const slug = (await resolveEntitySlug(ctx.engine, src, p.entity as string)) ?? (p.entity as string);
          return ctx.engine.listFactsByEntity(src, slug, {
            activeOnly: !includeExpired,
            limit,
            visibility,
            excludeAuditRows: true,
          });
        })),
        (rec) => rec.valid_from ?? rec.created_at,
      );
    } else if (typeof p.session_id === 'string' && p.session_id.length > 0) {
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listFactsBySession(src, p.session_id as string, {
            activeOnly: !includeExpired,
            limit,
            visibility,
            excludeAuditRows: true,
          }),
        )),
        byCreated,
      );
    } else if (p.since !== undefined) {
      const since = parseSinceParam(p.since);
      if (since) {
        rows = mergeNewest(
          await Promise.all(factSources.map(src =>
            ctx.engine.listFactsSince(src, since, {
              eventTime: true,
              activeOnly: !includeExpired,
              limit,
              visibility,
              excludeAuditRows: true,
            }),
          )),
          byEventTime,
        );
      }
    } else {
      // No filter: return recent across the granted source(s).
      rows = mergeNewest(
        await Promise.all(factSources.map(src =>
          ctx.engine.listFactsSince(src, new Date(0), {
            eventTime: true,
            activeOnly: !includeExpired,
            limit,
            visibility,
            excludeAuditRows: true,
          }),
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

    if (grep) rows = rows.filter(r => r.fact.toLowerCase().includes(grep));

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
    if (queryText) {
      const searchScope = sourceScopeOpts(ctx);
      // #4352 — recall's page-search arm enforces `visibility: private` for
      // untrusted callers (matches the facts arms' world-only filter above).
      const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
      const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
      if (!isAvailable('embedding')) {
        const raw = await ctx.engine.searchKeyword(queryText, { limit, excludePrivate, ...searchScope });
        searchResults = dedupResults(raw);
        // #3783 — direct FTS path: every row is a keyword hit by construction.
        markKeywordHits(searchResults);
        stampEvidenceSafe(searchResults);
        await stampContentFlags(ctx.engine, searchResults);
        searchDegraded = 'keyword_only_no_embedding_provider';
      } else {
        searchResults = await hybridSearchCached(ctx.engine, queryText, {
          limit,
          expansion: false,
          excludePrivate,
          ...searchScope,
        });
      }
      bumpLastRetrievedAt(ctx.engine, searchResults.map(r => r.page_id));
    }

    // ── MEMORY_VERBS v1 — server-side budget packing. Facts pack first (cheap,
    // high-precision one-liners, per-arm limit-capped so starvation is bounded),
    // then search results take the remainder. packToBudget treats budget<=0 as
    // a no-op, so an exhausted remainder must drop explicitly.
    let packedFacts = rows;
    let packedResults = searchResults;
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    if (budgetTokens !== null) {
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

    return {
      facts: packedFacts.map(r => ({
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
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
        provenance: r.source,
      })),
      total: packedFacts.length,
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
            })),
            ...(searchDegraded ? { search_degraded: searchDegraded } : {}),
          }
        : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

/** Parse an `entities` param (comma-string or array) to a trimmed name list. */
function parseEntityList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim());
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const context_pack: Operation = {
  name: 'context_pack',
  description:
    'MEMORY VERB (v1): budget-packed session-boundary bundle for a set of standing entities — entity cards + open threads + hot facts, zero-LLM, sub-second. Call at session start (warm cold context) and after compaction (rehydrate what the summary lost). WORLD-ONLY by default; pass include_private (honored for LOCAL trusted callers only) to widen all arms. budget_tokens packs server-side (response reports budget_used + dropped_count; cards pack first, then facts). Branch on structured fields, never prose. protocol_version rides every response.',
  params: {
    entities: { type: 'string', required: true, description: 'Comma-separated entity names/slugs to bundle. Capped at 8.' },
    budget_tokens: { type: 'number', description: 'Server-side token budget (char/4). Cards pack first, then facts. Response adds budget_tokens, budget_used, dropped_count.' },
    since: { type: 'string', description: 'ISO 8601 datetime. When set, open-thread events are filtered to those after this cursor.' },
    session_id: { type: 'string', description: 'Opaque session id; keys the hot-memory cache and (on the push path) the session cursor.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false.' },
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'context-pack' },
  annotations: { title: 'context_pack (boundary bundle)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleContextPack, renderPack, isAfter, PACK_DEFAULT_MAX_ENTITIES } = await import('../context/turn-context.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : undefined;
    if (rawSince !== undefined && !Number.isFinite(Date.parse(rawSince))) {
      throw verbError(
        'invalid_params',
        `context_pack: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`,
        'Pass an ISO 8601 datetime, e.g. since: "2026-08-11T00:00:00Z".',
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
    const res = await assembleContextPack(ctx.engine, {
      sourceId,
      entities,
      since,
      sessionId: typeof p.session_id === 'string' ? p.session_id : undefined,
      includePrivate,
      maxEntities: PACK_DEFAULT_MAX_ENTITIES,
    });

    let cards = res.cards ?? [];
    let facts = res.facts ?? [];
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    if (budgetTokens !== null) {
      const cardCost = (c: (typeof cards)[number]) =>
        estimateTokens(`${c.entity.title} ${c.summary} ${(c.open_threads ?? []).map((t) => t.text).join(' ')}`);
      const cardPack = packToBudget(cards, cardCost, budgetTokens);
      cards = cardPack.items;
      const remaining = budgetTokens - cardPack.meta.used;
      const factPack =
        remaining > 0
          ? packToBudget(facts, (f) => estimateTokens(f.fact), remaining)
          : { items: [] as typeof facts, meta: { budget: 0, used: 0, dropped: facts.length, kept: 0 } };
      facts = factPack.items;
      budgetUsed = cardPack.meta.used + factPack.meta.used;
      droppedCount = cardPack.meta.dropped + factPack.meta.dropped;
    }
    // Recompute open_threads with the SAME since filter the assembler applied
    // (pre-landing review: the raw flatMap silently dropped the documented
    // `since` contract from the structured array whenever budget packing ran).
    const open_threads = cards
      .flatMap((c) => c.open_threads ?? [])
      .filter((t) => !since || (t.date !== null && isAfter(t.date, since)));
    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` is what harnesses inject, so it must honor the same budget the
    // structured arrays report — the assembler's pre-budget rendering would
    // overrun the declared budget_tokens.
    const text = budgetTokens !== null ? renderPack(cards, open_threads, facts) : res.text;

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      entities,
      cards: cards.map((c) => ({
        slug: c.entity.slug,
        title: c.entity.title,
        type: c.entity.type,
        summary: c.summary,
        open_threads: c.open_threads,
        edges: c.edges,
        backlink_count: c.backlink_count,
      })),
      open_threads,
      facts: facts.map((f) => ({
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        // #4206: provenance context (parity with the recall projection).
        context: f.context ?? null,
        confidence: f.confidence,
      })),
      text,
      ...(res.degradedReason ? { degraded_reason: res.degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

const delta: Operation = {
  name: 'delta',
  description:
    'MEMORY VERB (v1): "what changed since T" for heartbeats — pages updated after `since` + hot facts newer than `since` + open-thread events after `since`, zero-LLM. Lets a periodic wake maintain warm state in O(changes) instead of re-deriving. Optionally scope thread deltas to `entities`. WORLD-ONLY by default; include_private honored for local trusted callers only. budget_tokens packs server-side (pages first, then facts). protocol_version rides every response.',
  params: {
    since: { type: 'string', description: 'ISO 8601 cursor. Returns pages/facts/thread-events newer than this timestamp. Optional when session_id carries an established cursor.' },
    since_slug: { type: 'string', description: 'Stateless keyset resume: pass back `next_cursor.slug` from the previous response (paired with `since`=next_cursor.since) to page through pages sharing one timestamp. Ignored when session_id is set (the session cursor carries it).' },
    entities: { type: 'string', description: 'Optional comma-separated entity scope for thread-event deltas. Capped at 8.' },
    budget_tokens: { type: 'number', description: 'Server-side token budget (char/4). Pages pack first, then facts. Response adds budget_tokens, budget_used, dropped_count.' },
    session_id: { type: 'string', description: 'Opaque session id. Drives the per-session cursor: the first call establishes it, each call advances it to the newest DELIVERED change (at-least-once — with has_more:true the undelivered tail returns on the next wake). Without it, pass an explicit `since` for a stateless delta.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false.' },
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'delta' },
  annotations: { title: 'delta (what changed since)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleDeltaContext, renderDelta, PACK_DEFAULT_MAX_ENTITIES } = await import('../context/turn-context.ts');
    const { getSessionContextState, upsertSessionContextState } = await import('../context/session-state.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : null;
    if (rawSince !== null && !Number.isFinite(Date.parse(rawSince))) {
      throw verbError(
        'invalid_params',
        `delta: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`,
        'Pass an ISO 8601 datetime, e.g. since: "2026-08-11T00:00:00Z".',
      );
    }
    // NORMALIZE to ISO immediately (red-team F4): the raw string is echoed
    // into the injectable `text` block, so an attacker-shaped-but-parseable
    // `since` must never reach rendering verbatim.
    const explicitSince = rawSince !== null ? new Date(Date.parse(rawSince)).toISOString() : null;
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

    const state = sessionId ? await getSessionContextState(ctx.engine, sourceId, clientId, sessionId) : null;
    const effectiveSince = explicitSince ?? state?.last_wake_at ?? null;

    if (!effectiveSince) {
      if (!sessionId) {
        throw verbError(
          'invalid_params',
          'delta requires `since` (ISO 8601) or a `session_id` with an established cursor.',
          'Pass since ("2026-08-11T00:00:00Z") for a stateless delta, or a stable session_id — the first call establishes the cursor and later calls return only newer changes.',
        );
      }
      // First wake for this session: establish the cursor at now and report an
      // empty delta (there is no prior point to diff against yet). Opportunistic
      // GC on row creation bounds session-row accumulation on serve-less CLI
      // lanes and remote read callers minting session ids (pre-landing review).
      // AWAITED (v0.45.7): a floating engine promise here races the CLI lane's
      // engine teardown and wedges the process — `gbrain delta --session-id`
      // printed its response but never exited (the exact command the shipped
      // HEARTBEAT.md ambient-delta row tells agents to run). GC is two fast
      // DELETEs on a capped table and internally fail-open, so awaiting costs
      // one first-wake round-trip, never an error. The serve-boot call site
      // (src/mcp/server.ts) stays fire-and-forget — that process is long-lived.
      const now = new Date().toISOString();
      const { gcSessionContextState } = await import('../context/session-state.ts');
      await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, { lastWakeAt: now });
      await gcSessionContextState(ctx.engine);
      return {
        protocol_version: MEMORY_VERBS_VERSION,
        since: now, pages: [], facts: [], threads: [], text: '', has_more: false,
        next_cursor: { since: now, slug: '' },
        ...(budgetTokens !== null
          ? { budget_tokens: budgetTokens, budget_used: 0, dropped_count: 0 }
          : {}),
      };
    }

    // Keyset cursor (red-team F1/F2 fix): pages page by (updated_at, slug), so
    // a >limit cluster at one timestamp is reachable and a delivered page never
    // re-appears unless it changes. The keyset slug lives in the session row
    // (surfaced_slugs[0]); an explicit-`since` caller has no stored slug and
    // resumes via the returned `next_cursor`.
    const cursorSlug = sessionId ? state?.surfaced_slugs?.[0] : undefined;
    const explicitSlug = typeof p.since_slug === 'string' ? p.since_slug : undefined;
    const sinceSlug = explicitSlug ?? cursorSlug;

    const res = await assembleDeltaContext(ctx.engine, {
      sourceId,
      since: effectiveSince,
      ...(sinceSlug !== undefined ? { sinceSlug } : {}),
      entities: parseEntityList(p.entities),
      sessionId: sessionId ?? undefined,
      includePrivate,
      maxEntities: PACK_DEFAULT_MAX_ENTITIES,
    });

    // Pages arrive OLDEST first by (updated_at, slug) — no client-side dedup
    // needed; the keyset already excludes everything at/before the cursor.
    let pages = res.deltaPages ?? [];
    let facts = res.facts ?? [];
    const threads = res.openThreads ?? [];
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    let factsDropped = 0;
    const fetchedPages = pages.length;
    if (budgetTokens !== null) {
      // packToBudget keeps a contiguous PREFIX (order-preserving, stops at the
      // first overflow) — with oldest-first pages the kept set stays contiguous
      // from the cursor, which the advance logic below depends on.
      const pagePack = packToBudget(pages, (pg) => estimateTokens(`${pg.title} ${pg.slug}`), budgetTokens);
      pages = pagePack.items;
      const remaining = budgetTokens - pagePack.meta.used;
      const factPack =
        remaining > 0
          ? packToBudget(facts, (f) => estimateTokens(f.fact), remaining)
          : { items: [] as typeof facts, meta: { budget: 0, used: 0, dropped: facts.length, kept: 0 } };
      facts = factPack.items;
      budgetUsed = pagePack.meta.used + factPack.meta.used;
      droppedCount = pagePack.meta.dropped + factPack.meta.dropped;
      factsDropped = factPack.meta.dropped;
    }
    const pagesDropped = fetchedPages - pages.length;
    // has_more covers ALL undelivered content — fetch-limit overflow, budget-
    // dropped pages, AND budget-dropped facts (pre-landing review: facts were
    // silently lost when pages fit but facts overflowed).
    const hasMore = res.deltaOverflow === true || pagesDropped > 0 || factsDropped > 0;

    // Cursor advance (keyset, at-least-once): advance to the last DELIVERED
    // (updated_at, slug). The keyset's strict `>` means the next wake starts
    // exactly after it — a >limit same-timestamp cluster drains one page at a
    // time across wakes (F1), and a delivered page never re-appears (F2). On a
    // page-less wake with nothing dropped, advance the TIME cursor to now()
    // minus a safety lag (in-flight write txns stamp updated_at at txn START)
    // and clear the keyset slug. If nothing delivered but something dropped, do
    // NOT advance (deliver-before-advance; a too-small budget must not eat it).
    const nextCursor =
      pages.length > 0
        ? { since: pages[pages.length - 1].updated_at, slug: pages[pages.length - 1].slug }
        : { since: effectiveSince, slug: sinceSlug ?? '' };
    if (sessionId) {
      if (pages.length > 0) {
        await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
          lastWakeAt: nextCursor.since,
          cursorSlug: nextCursor.slug,
        });
      } else if (!hasMore) {
        await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
          lastWakeAt: new Date(Date.now() - 2000).toISOString(),
          cursorSlug: '',
        });
      }
    }

    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` must honor the budget AND the boundary-tie exclusion the
    // structured arrays reflect — the assembler's render predates both.
    const text = renderDelta(pages, facts, threads, effectiveSince);

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      since: effectiveSince,
      pages,
      facts: facts.map((f) => ({
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        // #4206: provenance context (parity with the recall projection).
        context: f.context ?? null,
        confidence: f.confidence,
      })),
      threads,
      text,
      has_more: hasMore,
      // Stateless resume: a caller with no session_id passes these back as
      // `since` + `since_slug` on the next call to page deterministically.
      next_cursor: nextCursor,
      ...(res.degradedReason ? { degraded_reason: res.degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

const forget_fact: Operation = {
  name: 'forget_fact',
  description: 'v0.32.2: forget a fact. Rewrites the page\'s `## Facts` fence to strike through the row and set valid_until=today (the DB\'s expired_at derives via valid_until + now() on the next reconcile so the forget survives `gbrain rebuild`). Falls back to legacy DB-only expire for pre-v51 / thin-client rows. Idempotent on already-expired or unknown ids.',
  params: {
    id: { type: 'number', required: true, description: 'Fact id to forget.' },
    reason: { type: 'string', required: false, description: 'Optional reason; written to the fence row\'s context cell as "forgotten: <reason>". Default: "forgotten".' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'forget_fact', id: p.id };
    const id = p.id as number;
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    const { forgetFactInFence } = await import('../facts/forget.ts');
    const result = await forgetFactInFence(ctx.engine, id, { reason });
    if (!result.ok && result.path === 'not_found') {
      throw new OperationError('fact_not_found', `Fact id ${id} not found.`);
    }
    if (!result.ok && result.path === 'already_expired') {
      throw new OperationError('fact_already_expired', `Fact id ${id} already expired.`);
    }
    return { id, expired: true, path: result.path, reason: result.reason };
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
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw verbError(
      'invalid_params',
      `ttl must be a string, got ${typeof raw}.`,
      'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z".',
    );
  }
  const s = raw.trim();
  if (!s) return null;

  // ISO-8601 DURATION syntax is a documented trap — reject with the fix.
  if (/^P(T|\d)/i.test(s) && /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i.test(s)) {
    throw verbError(
      'invalid_params',
      `ttl "${s}" looks like an ISO-8601 duration, which is not accepted.`,
      `Use the shorthand form instead (e.g. "${s.replace(/^PT?/i, '').toLowerCase()}" style: "30d", "12h"), or an absolute ISO 8601 expiry timestamp.`,
    );
  }

  // Relative duration shorthand → now + duration.
  const dur = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  // Absolute ISO 8601 date or datetime.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  throw verbError(
    'invalid_params',
    `Cannot parse ttl "${s}".`,
    'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z". Omit ttl for a fact that never expires.',
  );
}

export const factsOperations: Operation[] = [
  extract_facts, recall, context_pack, delta, forget_fact,
];
