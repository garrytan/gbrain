/**
 * MEMORY_VERBS v1 — the frozen memory protocol verbs (Cathedral 1).
 *
 * Four first-class Operations (`remember`, `entity`, `synthesize`, `forget`)
 * that join the extended `recall` op (operations.ts) as the five-verb façade
 * over the operation catalog. Frozen contract: docs/protocol/MEMORY_VERBS_v1.md
 * — field names and semantics in v1 never change; additions are forever-
 * additive; `protocol_version` rides every response; errors carry enumerated
 * codes + populated `suggestion` (agents read it and self-correct).
 *
 * These are ordinary Operations: they inherit trust-boundary fail-closed
 * semantics (ctx.remote), scope enforcement, and source isolation like every
 * other op. `gbrain serve --surface verbs` exposes exactly the ops marked
 * `verb: true`.
 *
 * Import-cycle note: operations.ts spreads these into its `operations` array
 * at MODULE-EVAL time, so this file must be a RUNTIME LEAF — it may import
 * operations.ts types (erased) but never its values statically. Handlers load
 * verbError/parseTtlParam/sourceScopeOpts via dynamic import (the file's
 * existing style), which resolves after both modules finish evaluating.
 * MEMORY_VERBS_VERSION lives HERE (operations.ts imports it from us) for the
 * same reason. Violating this reintroduces the TDZ crash on whichever module
 * evaluates second.
 */

import type { Operation } from './operations.ts';
import { WRITE_RECEIPT_SCHEMA, WRITE_REQUEST_PARAM, PAGE_MUTATION_PARAMS } from './persistence/params.ts';
import { WRITE_ERROR_CODES } from './persistence/types.ts';

/** Frozen protocol version for the MEMORY_VERBS v1 verb set. Single source of truth. */
export const MEMORY_VERBS_VERSION = 1;

// v0.45.7 (issue #1): the frozen set grows from 5 to 7 with two ambient-recall
// verbs. The wire protocol_version STAYS 1 (additive) — MEMORY_VERBS_VERSION is
// unchanged so the five existing schemas + handlers keep stamping 1 and their
// conformance assertions (protocol_version === 1) hold.
export const VERB_NAMES = ['recall', 'remember', 'entity', 'synthesize', 'forget', 'context_pack', 'delta'] as const;
export type VerbName = (typeof VERB_NAMES)[number];

/**
 * The `remember` INPUT enum — FROZEN at five by the v1 protocol contract
 * (docs/protocol/MEMORY_VERBS_v1.md: "the values and their meanings stay
 * fixed"). Widening the extractor/DB taxonomy does NOT widen this; a caller
 * cannot write an `idea` through the verb surface.
 */
const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;

/**
 * What a reader may RECEIVE. The extractor and the facts table carry `idea`
 * (migration v145), so a stored idea fact flows back through `recall` — a
 * response schema that omitted it would declare a contract the system itself
 * violates. This is a widening for response consumers (strictly more values
 * accepted), and it is deliberately a SEPARATE constant so the input freeze
 * above can never drift into it.
 */
const FACT_KINDS_RESPONSE = [...FACT_KINDS, 'idea'] as const;
const PROVENANCE_MAX = 500;

// ─── remember ────────────────────────────────────────────────────────────────

const remember: Operation = {
  name: 'remember',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'MEMORY VERB (v1): save facts with provenance. Set `entity` (the subject) or entity recall misses it. Branch on `status` (inserted|duplicate|superseded); write_pending: poll get_write_request.',
  params: {
    ...PAGE_MUTATION_PARAMS,
    fact: { type: 'string', description: 'One claim.' },
    items: {
      type: 'array',
      description: '≤20 facts: [{fact, provenance}]',
      items: { type: 'object' },
    },
    provenance: {
      type: 'string',
      // Required for a single fact (the handler refuses with provenance_required); with items it may be given per item.
      description: 'Source (≤500 chars).',
    },
    ttl: {
      type: 'string',
      description: '"30d", "12h" or ISO; omit = never.',
    },
    valid_from: {
      type: 'string',
      description: 'When true (ISO).',
    },
    entity: {
      type: 'string',
      description: 'Subject name or slug.',
    },
    infer_entity: {
      type: 'boolean',
      description: 'Default true.',
    },
    kind: {
      type: 'string', description: 'Default fact.',
      enum: [...FACT_KINDS],
    },
    visibility: {
      type: 'string',
      enum: ['world', 'private'],
      description: 'world (default) or private (local CLI).',
    },
    replaces: { type: 'string', description: 'fact_id this fact replaces (same entity).', fullSurfaceOnly: true },
  },
  mutating: true,
  scope: 'write',
  verb: true,
  annotations: { title: 'remember (memory write)', idempotentHint: true },
  handler: async (ctx, p) => {
    const { verbError, parseTtlParam } = await import('./operations.ts');
    if (p.items !== undefined) {
      const { runRememberBatch } = await import('./remember-batch.ts');
      return runRememberBatch(ctx, p, remember.handler, (code, message, suggestion) => verbError(code as never, message, suggestion));
    }
    const fact = typeof p.fact === 'string' ? p.fact.trim() : '';
    if (!fact) {
      throw verbError(
        'invalid_params',
        'fact must be a non-empty string.',
        p.fact === undefined && Object.keys(p).length === 0
          ? 'The call arrived with no arguments; a tool call cut off at your output-token limit looks like this. Pass fact, or items with fewer entries per call.'
          : 'Pass the claim to remember, e.g. fact: "picked Stripe over Adyen — onboarding speed", or several as items: [{fact, provenance}].',
      );
    }
    // v1 contract: an absent provenance is a missing required parameter (invalid_params), an empty one is provenance_required.
    if (p.provenance === undefined) {
      throw verbError(
        'invalid_params',
        'Missing required parameter: provenance',
        'Pass `provenance` as a string (where the fact came from), e.g. provenance: "user told me, 2026-06-12". With items, provenance may be given per item instead.',
      );
    }
    const provenance = typeof p.provenance === 'string' ? p.provenance.trim() : '';
    if (!provenance) {
      throw verbError(
        'provenance_required',
        'provenance is required and must be non-empty.',
        'Pass where the fact came from, e.g. provenance: "user told me, 2026-06-12" or "import: notes.md".',
      );
    }
    if (provenance.length > PROVENANCE_MAX) {
      throw verbError(
        'invalid_params',
        `provenance exceeds ${PROVENANCE_MAX} chars (got ${provenance.length}).`,
        'Shorten the attribution — provenance is a pointer, not a transcript.',
      );
    }
    const kind = typeof p.kind === 'string' ? p.kind : 'fact';
    if (!FACT_KINDS.includes(kind as (typeof FACT_KINDS)[number])) {
      throw verbError(
        'invalid_params',
        `kind "${kind}" is not a fact kind.`,
        `Use one of: ${FACT_KINDS.join(' | ')}.`,
      );
    }
    const visibility = typeof p.visibility === 'string' ? p.visibility : 'world';
    if (visibility !== 'world' && visibility !== 'private') {
      throw verbError(
        'invalid_params',
        `visibility "${visibility}" is not valid.`,
        'Use "world" (default — agents can recall it) or "private" (local CLI reads only).',
      );
    }
    if (p.valid_from !== undefined && (typeof p.valid_from !== 'string' || !Number.isFinite(Date.parse(p.valid_from)))) {
      throw verbError(
        'invalid_params',
        'valid_from must be an ISO 8601 date or time.',
        'Pass when the fact was said or became true, e.g. valid_from: "2026-03-01", or omit it.',
      );
    }
    const replaces = typeof p.replaces === 'string' ? p.replaces.trim() : typeof p.replaces === 'number' ? String(p.replaces) : undefined;
    if (replaces !== undefined && (!/^\d+$/.test(replaces) || Number(replaces) <= 0)) {
      throw verbError(
        'not_found',
        `No fact with id "${String(p.replaces)}" to replace.`,
        'Pass the opaque fact_id from remember or recall (facts[].fact_id), or omit replaces.',
      );
    }
    if (ctx.dryRun) {
      parseTtlParam(p.ttl); // Dry runs still validate without admitting intent.
      return {
        dry_run: true,
        action: 'remember',
        fact,
        protocol_version: MEMORY_VERBS_VERSION,
      };
    }

    const { submitRememberMutation } = await import('./persistence/memory-mutations.ts');
    const { runMemoryWrite } = await import('./persistence/verb-errors.ts');
    const result = await runMemoryWrite(() => submitRememberMutation(ctx, { ...p, fact, provenance, kind, visibility, ...(replaces !== undefined ? { replaces } : {}) }));
    // F8: the explanation the CLI formatter prints, as a model-visible notice.
    if ((result as { degraded_dedup?: boolean } | null)?.degraded_dedup) {
      const { degradedDedupNotice } = await import('./interop-notices.ts');
      ctx.emitNotice?.(degradedDedupNotice(ctx.config));
    }
    return result;
  },
  cliHints: { name: 'remember', positional: ['fact'] },
};

// ─── entity ──────────────────────────────────────────────────────────────────

const entity: Operation = {
  name: 'entity',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'MEMORY VERB (v1): person/company/account card, zero LLM. Previews are not evidence: fetch the page before stating status or dates. Miss: found:false with near matches and create_safety. Facts: recall.',
  params: {
    name: { type: 'string', required: true, description: 'Name, alias or slug (e.g. "Alice Example").' },
  },
  scope: 'read',
  verb: true,
  annotations: { title: 'entity (card lookup, zero LLM)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { verbError } = await import('./operations.ts');
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) {
      throw verbError(
        'invalid_params',
        'name must be a non-empty string.',
        'Pass the entity to look up, e.g. name: "Alice Example" or name: "people/alice-example".',
      );
    }
    const t0 = Date.now();
    const { buildEntityCard } = await import('./verbs/entity-card.ts');
    const result = await buildEntityCard(ctx.engine, ctx.sourceId ?? 'default', name, {
      remote: ctx.remote !== false, includeReferences: true, surfaceCeiling: ctx.surfaceCeiling,
    });
    const coverage = result.card?.coverage ?? result.coverage;
    if (coverage) {
      const { mentionCoverageNotice } = await import('./mentions/coverage.ts');
      const notice = mentionCoverageNotice(coverage, result.card?.entity.type);
      if (notice) ctx.emitNotice?.(notice);
    }
    return {
      protocol_version: MEMORY_VERBS_VERSION,
      found: result.found,
      latency_ms: Date.now() - t0,
      ...(result.card ? { card: result.card } : {}),
      ...(result.suggestions !== undefined ? { suggestions: result.suggestions } : {}),
      ...(!result.card && result.coverage ? { coverage: result.coverage } : {}),
    };
  },
  cliHints: { name: 'entity', positional: ['name'] },
};

// ─── synthesize ──────────────────────────────────────────────────────────────

// [WP2/T5] compose-failure status → the machine-stable warning code named in
// the empty-gather `unavailable` error message. Freeform tails (provider
// messages) ride `detail` only; the message carries the code.
const SYNTHESIS_FAILURE_CODES: Record<string, string> = {
  not_json: 'LLM_OUTPUT_NOT_JSON',
  output_truncated: 'LLM_OUTPUT_TRUNCATED',
  empty_answer: 'SYNTHESIS_EMPTY_ANSWER',
  llm_error: 'LLM_CALL_FAILED',
  model_unusable: 'MODEL_NOT_USABLE',
  no_llm: 'NO_ANTHROPIC_API_KEY',
};

const synthesize: Operation = {
  name: 'synthesize',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: '[EXPENSIVE / SLOW: LLM calls, costs money] MEMORY VERB (v1): answer a broad question across pages with citations. For lookups use recall or entity.',
  params: {
    question: { type: 'string', description: 'The question.', required: true },
    since: { type: 'string', description: 'Window start (ISO 8601).' },
    until: { type: 'string', description: 'Window end (ISO 8601).' },
  },
  scope: 'read',
  verb: true,
  annotations: { title: 'synthesize (slow, costly — LLM-backed)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { verbError, sourceScopeOpts } = await import('./operations.ts');
    const question = typeof p.question === 'string' ? p.question.trim() : '';
    if (!question) {
      throw verbError(
        'invalid_params',
        'question must be a non-empty string.',
        'Pass the question to synthesize an answer for, e.g. question: "what is our payments strategy?".',
      );
    }
    const scope = sourceScopeOpts(ctx);
    const { runThink } = await import('./think/index.ts');
    const { embedQuery } = await import('./embedding.ts');
    // Remote-safe delegation: save/take are NEVER offered through this verb,
    // for any caller — the verb is a pure read.
    const result = await runThink(ctx.engine, {
      question,
      since: p.since ? String(p.since) : undefined,
      until: p.until ? String(p.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
      ...(scope.sourceId !== undefined ? { sourceId: scope.sourceId } : {}),
      ...(scope.sourceIds !== undefined ? { allowedSources: scope.sourceIds } : {}),
      // Fail-closed: only a context that explicitly says local gets local.
      remote: ctx.remote !== false,
      // #3734: activate takes' vector retrieval arm for the synthesize verb.
      embedQuestion: (q) => embedQuery(q),
    });

    // [c10] runThink degrades gracefully to a no-LLM stub RESULT; the protocol
    // contract converts that state into an explicit `unavailable` error so
    // agents branch on configure/retry instead of relaying a fake answer.
    // Deliberately unconditional (fires even with a non-empty gather): an
    // unconfigured key routed to the extractive fallback would be masked on
    // every call and never get fixed.
    if (result.warnings.includes('NO_ANTHROPIC_API_KEY')) {
      // F9: a key enables paid calls, so the fix asks; the key never rides a command line.
      const { chatKeyFix } = await import('./interop-notices.ts');
      const e = verbError(
        'unavailable',
        'synthesize needs an LLM and none is configured.',
        'Ask the user whether to add a chat-model API key (Anthropic or OpenAI; each synthesized answer is a paid call). Meanwhile recall and entity work without one: answer from their results.',
        'chat gateway unconfigured (NO_ANTHROPIC_API_KEY)',
      );
      e.fix = chatKeyFix();
      throw e;
    }

    // Best-effort cost block [E5/m3]: actual tokens when the gateway reported
    // usage, priced via the canonical table; nulls when accounting is absent.
    const { canonicalLookup } = await import('./model-pricing.ts');
    const usage = result.usage ?? null;
    const pricing = canonicalLookup(result.modelUsed);
    const usdEstimate =
      usage && pricing
        ? (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000
        : null;
    const cost = {
      model: result.modelUsed,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      usd_estimate: usdEstimate,
    };

    // [WP2/T5+E2] compose-status precedence: 'ok' → the synthesized answer;
    // any compose failure with a NON-EMPTY gather → the extractive fallback
    // (quotes/cites ONLY gathered pages); compose failure with an EMPTY
    // gather → typed error. An answer is NEVER fabricated from nothing
    // (ENG-19). Defensive ?? 'ok' mirrors synthesisOk's back-compat posture.
    const status = result.synthesis_status ?? 'ok';
    const { recordThinkAnswer, feedbackMetaFields } = await import('./feedback/record.ts');
    const feedbackMeta = feedbackMetaFields(await recordThinkAnswer(ctx, 'synthesize', result));
    if (status !== 'ok') {
      if (result.extractive) {
        return {
          answer: result.extractive.answer,
          sources: result.extractive.citations.map(c => c.page_slug),
          gaps: result.gaps,
          cost,
          synthesis_status: 'extractive_fallback',
          pages_gathered: result.pagesGathered,
          takes_gathered: result.takesGathered,
          warnings: result.warnings,
          ...feedbackMeta,
          protocol_version: MEMORY_VERBS_VERSION,
        };
      }
      throw verbError(
        'unavailable',
        `retrieved ${result.pagesGathered} pages; compose failed: ${SYNTHESIS_FAILURE_CODES[status] ?? status}`,
        'The LLM compose step failed and retrieval found nothing to fall back on. Rephrase or broaden the question (or the since/until window); if the code names the model or provider, fix the model config and retry.',
        result.warnings.length > 0 ? result.warnings.join('; ') : undefined,
      );
    }

    return {
      answer: result.answer,
      ...(result.answer_raw !== undefined ? { answer_raw: result.answer_raw, quote_check: result.quote_check, unverified_quotes: result.unverified_quotes } : {}),
      sources: result.citations.map(c => c.page_slug),
      gaps: result.gaps,
      cost,
      synthesis_status: 'ok',
      pages_gathered: result.pagesGathered,
      takes_gathered: result.takesGathered,
      warnings: result.warnings,
      ...feedbackMeta,
      protocol_version: MEMORY_VERBS_VERSION,
    };
  },
  cliHints: { name: 'synthesize', positional: ['question'] },
};

// ─── forget ──────────────────────────────────────────────────────────────────

const forget: Operation = {
  name: 'forget',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'MEMORY VERB (v1): expire a remembered fact by its fact_id (never a page slug). Idempotent; the audit trail is kept.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    id: { type: 'string', required: true, description: 'fact_id from remember or recall.' },
    reason: { type: 'string', description: 'Audit note (default "forgotten").' },
    semantic_review: { type: 'boolean', description: 'false: skip overnight rewording review.', fullSurfaceOnly: true },
  },
  mutating: true,
  scope: 'write',
  verb: true,
  annotations: { title: 'forget (expire a fact)', destructiveHint: true, idempotentHint: true },
  handler: async (ctx, p) => {
    const { verbError } = await import('./operations.ts');
    const rawId = typeof p.id === 'string' ? p.id.trim() : typeof p.id === 'number' ? String(p.id) : '';
    const numericId = Number(rawId);
    if (!rawId || !Number.isInteger(numericId) || numericId <= 0) {
      throw verbError(
        'not_found',
        `No fact with id "${String(p.id)}".`,
        'Pass the opaque string id returned by remember or recall (facts[].fact_id) — page slugs are not fact ids.',
      );
    }
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;

    if (ctx.dryRun) {
      return { dry_run: true, action: 'forget', id: rawId, protocol_version: MEMORY_VERBS_VERSION };
    }

    const { submitForgetMutation } = await import('./persistence/memory-mutations.ts');
    const { runMemoryWrite } = await import('./persistence/verb-errors.ts');
    return runMemoryWrite(() => submitForgetMutation(ctx, 'forget', { ...p, id: rawId, ...(reason ? { reason } : {}) }));
  },
  // NO cliHints: `gbrain forget` is a CLI_ONLY command (recall.ts runForget)
  // that dispatches BEFORE cliOps — a cliHint here would be silently
  // shadowed. The CLI surface for forgetting stays the existing command;
  // this verb is the MCP/protocol surface.
};

export const verbOperations: Operation[] = [remember, entity, synthesize, forget];

// ─── RESPONSE_SCHEMAS — the protocol's response-shape registry [c8] ─────────
//
// `Operation` carries input params only; response envelopes live HERE, hand-
// authored, and conformance validates LIVE responses against this registry so
// registry-vs-code drift is caught by the same fixtures that certify servers.
// Field names and semantics are FROZEN (additive-forever); enum values are
// part of the contract.

const EVIDENCE_ENUM = ['alias_hit', 'exact_title_match', 'high_vector_match', 'keyword_exact', 'weak_semantic'];
const CREATE_SAFETY_ENUM = ['exists', 'probable', 'unknown'];
const STATUS_ENUM = ['inserted', 'duplicate', 'superseded'];
// v0.45.x (WP2/T5+E2) — additive-forever. The verb emits 'ok' or
// 'extractive_fallback'; the remaining compose-failure values ride the
// non-verb `think` surface (the verb converts them to the extractive
// fallback or a typed `unavailable` error) and stay enum-listed so any
// v1 server emitting them validates.
const SYNTHESIS_STATUS_ENUM = [
  'ok', 'empty_answer', 'not_json', 'output_truncated', 'no_llm', 'model_unusable', 'llm_error', 'extractive_fallback',
];

/** `coverage` on entity cards and misses (mentions/coverage.ts). */
const COVERAGE_SCHEMA = {
  type: 'object',
  required: ['state', 'pending_pages', 'last_pass_at'],
  properties: {
    state: { type: 'string', enum: ['complete', 'pending', 'disabled', 'type_not_linkable', 'failed'] },
    pending_pages: { type: 'integer' },
    last_pass_at: { type: ['string', 'null'] },
    degraded: { type: 'boolean', const: true },
  },
} as const;

/** One `referenced_by` row (mentions/referrers.ts). */
const REFERENCE_ROW_SCHEMA = {
  type: 'object',
  required: ['slug', 'title', 'type', 'canonical_type', 'date', 'date_source', 'preview'],
  properties: {
    slug: { type: 'string' }, title: { type: 'string' }, type: { type: ['string', 'null'] }, canonical_type: { type: 'string' },
    date: { type: ['string', 'null'] }, date_source: { type: 'string' }, preview: { type: 'string' },
  },
} as const;

const RECALL_BUDGET_ARM_SCHEMA = {
  type: 'object',
  required: ['candidates', 'kept', 'dropped', 'used'],
  properties: {
    candidates: { type: 'integer', minimum: 0, description: 'Authorized, filtered, limit-capped candidates before packing.' },
    kept: { type: 'integer', minimum: 0 },
    dropped: { type: 'integer', minimum: 0 },
    used: { type: 'integer', minimum: 0, description: 'Estimated tokens in retained evidence, excluding the JSON envelope.' },
  },
};

export const RESPONSE_SCHEMAS: Record<VerbName, Record<string, unknown>> = {
  recall: {
    type: 'object',
    required: ['facts', 'total', 'protocol_version'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      total: { type: 'integer' },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'fact', 'kind', 'fact_id', 'provenance'],
          properties: {
            id: { type: 'integer', description: 'LEGACY numeric id (pre-v1 consumers). Use fact_id.' },
            fact_id: { type: 'string', description: 'Opaque protocol id — the value forget accepts.' },
            fact: { type: 'string' },
            kind: { type: 'string', enum: FACT_KINDS_RESPONSE as unknown as string[] },
            entity_slug: { type: ['string', 'null'] },
            provenance: { type: 'string' },
            valid_until: { type: ['string', 'null'] },
            visibility: { type: 'string', enum: ['private', 'world'] },
          },
        },
      },
      results: {
        type: 'array',
        description: 'Search arm — present only when `query` was passed.',
        items: {
          type: 'object',
          required: ['slug', 'title', 'evidence', 'create_safety', 'provenance'],
          properties: {
            slug: { type: 'string' },
            title: { type: ['string', 'null'] },
            chunk: { type: ['string', 'null'] },
            evidence: { type: 'string', enum: EVIDENCE_ENUM },
            create_safety: { type: 'string', enum: CREATE_SAFETY_ENUM },
            provenance: { type: 'string', description: 'Origin page slug.' },
          },
        },
      },
      search_degraded: { type: 'string', description: 'Present when the search arm fell back to keyword-only: keyword_only_no_embedding_provider (no embedding provider) or keyword_only_embedding_disabled (embeddings off by choice; no query text sent to a provider).' },
      budget_tokens: { type: 'integer', description: 'Present for a positive finite numeric budget, including when its floor is zero.' },
      budget_used: { type: 'integer' },
      dropped_count: { type: 'integer' },
      budget_packing: {
        type: 'object',
        description: 'Present only when a valid budget_policy is supplied. Per-arm used and dropped sums match budget_used and dropped_count when those fields exist.',
        required: ['policy', 'applied', 'reason', 'facts', 'results'],
        properties: {
          policy: { type: 'string', enum: ['facts_first', 'query_first'], description: 'Effective policy; ineligible query_first requests fall back to facts_first.' },
          applied: { type: 'boolean', description: 'Whether the requested budget policy applied, not whether all required evidence fit.' },
          reason: { type: 'string', enum: ['no_query', 'no_positive_finite_budget', 'budget_below_one', 'no_candidates', 'first_items_exceed_budget', 'packed'] },
          facts: RECALL_BUDGET_ARM_SCHEMA,
          results: RECALL_BUDGET_ARM_SCHEMA,
        },
      },
    },
  },
  remember: {
    type: 'object',
    required: ['id', 'status', 'status_text', 'entity_slug', 'valid_until', 'protocol_version'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      id: { type: 'string', description: 'Opaque fact id. On status=duplicate this is the EXISTING fact\'s id.' },
      status: { type: 'string', enum: STATUS_ENUM, description: 'Branch on THIS, never on status_text.' },
      status_text: { type: 'string', description: 'Human rendering of status. Display only — never branch on it.' },
      entity_slug: { type: ['string', 'null'] },
      valid_until: { type: ['string', 'null'], description: 'ISO 8601 or null (never expires).' },
      degraded_dedup: { type: 'boolean', description: 'Present (true) when no embedding provider — near-duplicates may insert.' },
      entity_inferred: { type: 'string', enum: ['mention'], description: 'Present when `entity` was omitted and the subject was inferred from an exact mention.' },
      warnings: { type: 'array', items: { type: 'string', enum: ['NO_ENTITY', 'ENTITY_LINK_FAILED'] },
        description: 'NO_ENTITY: saved unattributed. ENTITY_LINK_FAILED: an inferred entity could not be linked; saved unattributed.' },
      hint: { type: 'string', description: 'Present with warnings: how to attribute the fact (pass `entity`).' },
      superseded_fact_id: { type: 'string', description: 'Present on status=superseded: the fact this one replaced.' },
      replaced_by_caller: { type: 'boolean', description: 'Present (true) when the caller named the replaced fact with `replaces`.' },
      write_request: WRITE_RECEIPT_SCHEMA,
    },
  },
  entity: {
    type: 'object',
    required: ['protocol_version', 'found', 'latency_ms'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      found: { type: 'boolean' },
      latency_ms: { type: 'integer' },
      card: {
        type: 'object',
        required: ['entity', 'aka', 'summary', 'last_touched', 'open_threads', 'edges', 'backlink_count', 'active_fact_count'],
        properties: {
          entity: {
            type: 'object',
            required: ['slug', 'title', 'type'],
            properties: { slug: { type: 'string' }, title: { type: 'string' }, type: { type: ['string', 'null'] } },
          },
          aka: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          last_touched: {
            type: 'object',
            required: ['updated_at', 'last_retrieved_at', 'last_timeline_date'],
            properties: {
              updated_at: { type: ['string', 'null'] },
              last_retrieved_at: { type: ['string', 'null'] },
              last_timeline_date: { type: ['string', 'null'] },
            },
          },
          open_threads: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'text', 'date'],
              properties: {
                kind: { type: 'string', enum: ['commitment', 'recent_event'] },
                text: { type: 'string' },
                date: { type: ['string', 'null'] },
                // v0.47 open-loop engine — ADDITIVE OPTIONAL (frozen-v1
                // legal); present only on threads backed by an open_loops row.
                direction: { type: 'string', enum: ['owed_by_me', 'owed_to_me', 'their_turn', 'my_turn'] },
                due: { type: ['string', 'null'] },
                counterparty: { type: ['string', 'null'] },
                status: { type: 'string' },
                loop_id: { type: 'number' },
              },
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'direction', 'slug'],
              properties: {
                type: { type: 'string' },
                direction: { type: 'string', enum: ['out', 'in'] },
                slug: { type: 'string' },
                context: { type: ['string', 'null'] },
                // Temporal typed edges — ADDITIVE OPTIONAL (frozen-v1 legal).
                status: { type: 'string' },
                since: { type: ['string', 'null'] },
                until: { type: ['string', 'null'] },
              },
            },
          },
          backlink_count: { type: 'integer' },
          active_fact_count: { type: 'integer' },
          relationship_note: { type: 'string' },
          // Entity recall — ADDITIVE OPTIONAL (frozen-v1 legal); the `entity`
          // verb sets them, ambient callers (context_pack, delta) do not.
          referenced_by_count: { type: 'integer' },
          referenced_by: {
            type: 'array',
            items: {
              type: 'object',
              required: ['canonical_type', 'total', 'rows'],
              properties: {
                canonical_type: { type: 'string' },
                total: { type: 'integer' },
                rows: { type: 'array', items: REFERENCE_ROW_SCHEMA },
                next: { type: 'object', required: ['tool', 'arguments'], properties: {
                  tool: { type: 'string', const: 'get_backlinks' }, arguments: { type: 'object' }, requires_surface: { type: 'string', enum: ['starter'] } } },
              },
            },
          },
          coverage: COVERAGE_SCHEMA,
        },
      },
      coverage: COVERAGE_SCHEMA,
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slug', 'title', 'create_safety'],
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            create_safety: { type: 'string', enum: CREATE_SAFETY_ENUM },
          },
        },
      },
    },
  },
  synthesize: {
    type: 'object',
    required: ['answer', 'sources', 'cost', 'protocol_version'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      answer: { type: 'string', description: 'Quoted words not found in the evidence are unquoted and marked [unverified]; never present them as quotes.' },
      answer_raw: { type: 'string', description: 'With think.quote_verify on and quotes in the answer: the answer as the model wrote it.' },
      quote_check: { type: 'object', properties: { grounded: { type: 'integer' }, repaired: { type: 'integer' }, unverified: { type: 'integer' } } },
      unverified_quotes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, reason: { type: 'string' } } } },
      sources: { type: 'array', items: { type: 'string' } },
      gaps: { type: 'array', items: { type: 'string' } },
      cost: {
        type: 'object',
        required: ['model', 'input_tokens', 'output_tokens', 'usd_estimate'],
        description: 'Best-effort aggregate (retries/multi-call flows sum; cache hits may undercount). Honest signal, not an invoice.',
        properties: {
          model: { type: 'string' },
          input_tokens: { type: ['integer', 'null'] },
          output_tokens: { type: ['integer', 'null'] },
          usd_estimate: { type: ['number', 'null'] },
        },
      },
      // v0.45.x (WP2/T5+E2) additive compose-status fields — never required
      // (a pre-v0.45.x v1 server that omits them must still certify).
      synthesis_status: {
        type: 'string',
        enum: SYNTHESIS_STATUS_ENUM,
        description:
          'How the answer was produced. ok = LLM synthesis; extractive_fallback = compose failed with a non-empty gather — answer is an extractive digest quoting ONLY retrieved pages, sources cite the digested pages (never fabricated).',
      },
      pages_gathered: { type: 'integer', description: 'Pages retrieved by the gather phase behind this answer.' },
      takes_gathered: { type: 'integer', description: 'Takes retrieved by the gather phase behind this answer.' },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Machine-stable pipeline warning codes (e.g. LLM_OUTPUT_NOT_JSON, LLM_CALL_FAILED: <class> where <class> is timeout | rate_limited | network | provider_error).' },
    },
  },
  forget: {
    type: 'object',
    required: ['id', 'expired', 'reason', 'protocol_version'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      id: { type: 'string' },
      expired: { type: 'boolean', description: 'true = this call expired the fact; false = it was ALREADY expired (idempotent re-forget).' },
      reason: { type: ['string', 'null'] },
      write_request: WRITE_RECEIPT_SCHEMA,
      similar_active: {
        type: 'object',
        description: 'Active facts about the same entity close in meaning to the withdrawn claim (ids and scores only; zero model calls). Similarity is not sameness: ask the user before forgetting any of them.',
        properties: {
          state: { type: 'string', enum: ['checked', 'not_checked_no_embedding', 'not_checked_pending'] },
          candidates: { type: 'array', items: { type: 'object', properties: { fact_id: { type: 'string' }, similarity: { type: 'number' } } } },
          semantic_review: { type: 'string', enum: ['scheduled', 'off', 'unavailable', 'opted_out'] },
          next: { type: 'string' },
        },
      },
    },
  },
  // v0.45.7 (issue #1) — ambient recall. World-only by default; include_private
  // widens all arms (local trusted callers only). protocol_version stays 1.
  context_pack: {
    type: 'object',
    required: ['protocol_version', 'entities', 'cards', 'open_threads', 'facts'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      entities: { type: 'array', items: { type: 'string' } },
      cards: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slug', 'title', 'summary', 'open_threads'],
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            type: { type: ['string', 'null'] },
            summary: { type: 'string' },
            open_threads: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kind', 'text', 'date'],
                properties: {
                  kind: { type: 'string', enum: ['commitment', 'recent_event'] },
                  text: { type: 'string' },
                  date: { type: ['string', 'null'] },
                  // v0.47 open-loop engine — additive optional.
                  direction: { type: 'string', enum: ['owed_by_me', 'owed_to_me', 'their_turn', 'my_turn'] },
                  due: { type: ['string', 'null'] },
                  counterparty: { type: ['string', 'null'] },
                  status: { type: 'string' },
                  loop_id: { type: 'number' },
                },
              },
            },
            edges: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type', 'direction', 'slug'],
                properties: {
                  type: { type: 'string' },
                  direction: { type: 'string', enum: ['out', 'in'] },
                  slug: { type: 'string' },
                  context: { type: ['string', 'null'] },
                  status: { type: 'string' },
                  since: { type: ['string', 'null'] },
                  until: { type: ['string', 'null'] },
                },
              },
            },
            backlink_count: { type: 'integer' },
            relationship_note: { type: 'string' },
          },
        },
      },
      open_threads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'text', 'date'],
          properties: {
            kind: { type: 'string', enum: ['commitment', 'recent_event'] },
            text: { type: 'string' },
            date: { type: ['string', 'null'] },
            // v0.47 open-loop engine — additive optional.
            direction: { type: 'string', enum: ['owed_by_me', 'owed_to_me', 'their_turn', 'my_turn'] },
            due: { type: ['string', 'null'] },
            counterparty: { type: ['string', 'null'] },
            status: { type: 'string' },
            loop_id: { type: 'number' },
          },
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['fact', 'kind'],
          properties: {
            fact: { type: 'string' },
            kind: { type: 'string' },
            entity_slug: { type: ['string', 'null'] },
            valid_from: { type: 'string' },
            confidence: { type: 'number' },
            fact_id: { type: 'string', description: 'Opaque protocol id — the value forget accepts.' },
            provenance: { type: ['string', 'null'], description: 'The stored source attribution (remember --provenance).' },
          },
        },
      },
      text: { type: 'string', description: 'Pre-rendered injectable block (envelope-wrapped).' },
      degraded_reason: { type: 'string', description: 'Present when a wall-clock deadline returned a partial pack.' },
      budget_tokens: { type: 'integer', description: 'Present when budget_tokens was passed.' },
      budget_used: { type: 'integer' },
      dropped_count: { type: 'integer' },
      // C4 pinned questions — additive optional, owner-capable callers only; outside `text` and the budget.
      pinned_questions: {
        type: 'array',
        description: 'Fresh sentences of pinned answers scoped to a packed entity (owner-capable callers only).',
        items: {
          type: 'object',
          required: ['id', 'question', 'answer', 'freshness'],
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            answer: { type: 'array', items: { type: 'string' } },
            freshness: { type: 'string', enum: ['fresh', 'stale'] },
          },
        },
      },
      withheld: {
        type: 'object',
        required: ['stale_sentences', 'question_ids', 'refresh_command'],
        description: 'Pinned-answer sentences left out because their evidence changed or is unreadable.',
        properties: {
          stale_sentences: { type: 'integer' },
          question_ids: { type: 'array', items: { type: 'string' } },
          refresh_command: { type: 'string' },
        },
      },
    },
  },
  delta: {
    type: 'object',
    required: ['protocol_version', 'since', 'pages', 'facts', 'threads'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      since: { type: 'string', description: 'The ISO cursor this delta was computed against.' },
      has_more: { type: 'boolean', description: 'True when more content is waiting (a fetch limit or the budget); each arm advanced only through what it delivered, so the rest surfaces on the next wake. Failure is degraded_reason, never has_more.' },
      next_cursor: {
        type: 'object',
        required: ['since', 'slug'],
        description: 'Where to resume. `cursor` (opaque, both arms exact) is passed back as cursor; older clients pass since + since_slug, which is conservative (may re-deliver, never skips): it holds while any arm failed and stays strictly before the oldest undelivered fact.',
        properties: { since: { type: 'string' }, slug: { type: 'string' }, cursor: { type: 'string' } },
      },
      cursor_arms: {
        type: 'object',
        description: 'Replay audit trail: each arm\'s start and next keyset (pages: since + slug; facts: since + id).',
      },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slug', 'title', 'updated_at'],
          properties: {
            slug: { type: 'string' },
            source_id: { type: 'string' },
            title: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['fact', 'kind'],
          properties: {
            id: { type: 'integer', description: 'Fact id (dedupe key for replay).' },
            fact: { type: 'string' },
            kind: { type: 'string' },
            entity_slug: { type: ['string', 'null'] },
            valid_from: { type: 'string' },
            confidence: { type: 'number' },
            fact_id: { type: 'string', description: 'Opaque protocol id — the value forget accepts.' },
            provenance: { type: ['string', 'null'], description: 'The stored source attribution (remember --provenance).' },
          },
        },
      },
      threads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'text', 'date'],
          properties: {
            kind: { type: 'string', enum: ['commitment', 'recent_event'] },
            text: { type: 'string' },
            date: { type: ['string', 'null'] },
          },
        },
      },
      text: { type: 'string' },
      degraded_reason: { type: 'string', description: 'Comma-joined incomplete parts: deadline, pages, facts, threads, session_state. No cursor moved past anything undelivered; a delta_incomplete notice carries the retry step.' },
      budget_tokens: { type: 'integer' },
      budget_used: { type: 'integer' },
      dropped_count: { type: 'integer' },
    },
  },
};

/** Error envelope schema (uniform across all verbs). */
export const ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: {
      type: 'string',
      enum: [
        'invalid_params',
        'provenance_required',
        'not_found',
        'scope_denied',
        'unavailable',
        'budget_unsatisfiable', // RESERVED — schema-listed, never returned in v1
        'internal',
      ],
    },
    message: { type: 'string' },
    suggestion: { type: 'string', description: 'Populated on every verb error: problem + cause + fix.' },
    detail: { type: 'string', description: 'Freeform specifics (e.g. which dependency failed).' },
    protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
    write_request: WRITE_RECEIPT_SCHEMA,
    write_error: { type: 'string', enum: [...WRITE_ERROR_CODES] },
  },
};
