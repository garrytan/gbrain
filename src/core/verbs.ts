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

/** Frozen protocol version for the MEMORY_VERBS v1 verb set. Single source of truth. */
export const MEMORY_VERBS_VERSION = 1;

// v0.45.7 (issue #1): the frozen set grows from 5 to 7 with two ambient-recall
// verbs. The wire protocol_version STAYS 1 (additive) — MEMORY_VERBS_VERSION is
// unchanged so the five existing schemas + handlers keep stamping 1 and their
// conformance assertions (protocol_version === 1) hold.
export const VERB_NAMES = ['recall', 'remember', 'entity', 'synthesize', 'forget', 'context_pack', 'delta'] as const;
export type VerbName = (typeof VERB_NAMES)[number];

const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
const PROVENANCE_MAX = 500;

// ─── remember ────────────────────────────────────────────────────────────────

const remember: Operation = {
  name: 'remember',
  description:
    'MEMORY VERB (v1): save one fact to durable agent memory — the protocol write verb. ' +
    'provenance is REQUIRED (free text, e.g. "conversation 2026-06-12", "user said in chat", "import: notes.md"). ' +
    'Set `entity` whenever the fact is about a specific person/company/project — entity-scoped recall will not find it otherwise. ' +
    'ttl accepts duration shorthand ("30d", "12h") or an absolute ISO 8601 timestamp; ISO-8601 durations like "P30D" are rejected with a fix. ' +
    'visibility defaults to "world" (readable by every agent connected to this brain; pass "private" for local-CLI-only facts). ' +
    'Response: branch on `status` (inserted|duplicate|superseded), never on `status_text` (human rendering only). ' +
    'On duplicate, `id` is the EXISTING fact\'s id. For bulk extraction from a raw transcript use extract_facts instead.',
  params: {
    fact: { type: 'string', required: true, description: 'The fact to remember, one claim per call.' },
    provenance: {
      type: 'string',
      required: true,
      description:
        'Where this fact came from (REQUIRED, free text, max 500 chars). Examples: "conversation 2026-06-12", "user said in chat", "import: meeting-notes.md".',
    },
    ttl: {
      type: 'string',
      description:
        'Optional expiry: duration shorthand ("30d", "12h", "45m") or absolute ISO 8601 timestamp ("2026-07-12T00:00:00Z"). NOT ISO-8601 durations ("P30D" is rejected). Omit = never expires.',
    },
    entity: {
      type: 'string',
      description:
        'Person/company/project this fact is about (name or slug; canonicalized server-side). Set it whenever the fact has a subject — entity-scoped recall misses unattributed facts.',
    },
    kind: {
      type: 'string',
      enum: [...FACT_KINDS],
      description: 'Fact kind: event | preference | commitment | belief | fact (default).',
    },
    visibility: {
      type: 'string',
      enum: ['world', 'private'],
      description:
        'world (default): readable by every agent connected to this brain — required for the remote remember→recall round-trip. private: local CLI reads only.',
    },
  },
  mutating: true,
  scope: 'write',
  verb: true,
  annotations: { title: 'remember (memory write)', idempotentHint: true },
  handler: async (ctx, p) => {
    const { verbError, parseTtlParam } = await import('./operations.ts');
    const fact = typeof p.fact === 'string' ? p.fact.trim() : '';
    if (!fact) {
      throw verbError(
        'invalid_params',
        'fact must be a non-empty string.',
        'Pass the claim to remember, e.g. fact: "picked Stripe over Adyen — onboarding speed".',
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
    const validUntil = parseTtlParam(p.ttl); // throws verbError(invalid_params) on bad input

    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'remember',
        fact,
        protocol_version: MEMORY_VERBS_VERSION,
      };
    }

    const { writeSingleFact } = await import('./facts/write-single.ts');
    const result = await writeSingleFact(ctx.engine, ctx.sourceId ?? 'default', {
      fact,
      provenance,
      kind: kind as (typeof FACT_KINDS)[number],
      entity: typeof p.entity === 'string' && p.entity.trim() ? p.entity.trim() : null,
      visibility,
      validUntil,
    });

    const statusText =
      result.status === 'inserted'
        ? `remembered as fact #${result.id}`
        : result.status === 'duplicate'
          ? `already knew this — kept fact #${result.id}`
          : `updated — fact #${result.id} supersedes the previous version`;

    return {
      // Opaque STRING at the protocol level [T4]; gbrain serializes its ints.
      id: String(result.id),
      status: result.status,
      status_text: statusText,
      entity_slug: result.entity_slug ?? null,
      valid_until: result.valid_until ? result.valid_until.toISOString() : null,
      ...(result.degraded_dedup ? { degraded_dedup: true } : {}),
      protocol_version: MEMORY_VERBS_VERSION,
    };
  },
  cliHints: { name: 'remember', positional: ['fact'] },
};

// ─── entity ──────────────────────────────────────────────────────────────────

const entity: Operation = {
  name: 'entity',
  description:
    'MEMORY VERB (v1): inspect ONE known person/company/project card — zero LLM calls, sub-100ms. ' +
    'Resolution: alias > exact title > slug-suffix; ties break on most-recently-touched. ' +
    'NEVER errors on a miss: returns found:false plus near-miss suggestions with create_safety hints ' +
    '(exists | probable | unknown — whether writing a new page would duplicate). ' +
    'Routing: for facts/snippets retrieval use recall; for broad questions needing reasoning use synthesize (expensive).',
  params: {
    name: { type: 'string', required: true, description: 'Free-text name, alias, or slug (e.g. "Alice Example", "people/alice-example").' },
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
      remote: ctx.remote !== false,
    });
    return {
      protocol_version: MEMORY_VERBS_VERSION,
      found: result.found,
      latency_ms: Date.now() - t0,
      ...(result.card ? { card: result.card } : {}),
      ...(result.suggestions !== undefined ? { suggestions: result.suggestions } : {}),
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
  empty_answer: 'SYNTHESIS_EMPTY_ANSWER',
  llm_error: 'LLM_CALL_FAILED',
  model_unusable: 'MODEL_NOT_USABLE',
  no_llm: 'NO_ANTHROPIC_API_KEY',
};

const synthesize: Operation = {
  name: 'synthesize',
  description:
    '[EXPENSIVE / SLOW — makes LLM calls, seconds-to-minutes latency, costs money] ' +
    'MEMORY VERB (v1): answer a broad question using cross-page LLM reasoning with citations and gap analysis. ' +
    'Prefer recall (facts/snippets) or entity (one known card, zero LLM) for lookups — use synthesize only when the answer ' +
    'requires combining evidence across pages. Response carries a best-effort cost block (model, tokens, usd_estimate) ' +
    'plus compose-status fields (synthesis_status, pages_gathered, takes_gathered, warnings); when the LLM compose step ' +
    'fails but retrieval succeeded, `answer` degrades to an extractive digest of retrieved pages ' +
    '(synthesis_status: "extractive_fallback") instead of an error.',
  params: {
    question: { type: 'string', required: true, description: 'The question to answer.' },
    since: { type: 'string', description: 'Optional temporal window start (ISO 8601 date or datetime).' },
    until: { type: 'string', description: 'Optional temporal window end (ISO 8601 date or datetime).' },
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
    // Remote-safe delegation: save/take are NEVER offered through this verb,
    // for any caller — the verb is a pure read.
    const result = await runThink(ctx.engine, {
      question,
      since: p.since ? String(p.since) : undefined,
      until: p.until ? String(p.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
      ...(scope.sourceId !== undefined ? { sourceId: scope.sourceId } : {}),
      ...(scope.sourceIds !== undefined ? { allowedSources: scope.sourceIds } : {}),
      remote: ctx.remote === true,
    });

    // [c10] runThink degrades gracefully to a no-LLM stub RESULT; the protocol
    // contract converts that state into an explicit `unavailable` error so
    // agents branch on configure/retry instead of relaying a fake answer.
    // Deliberately unconditional (fires even with a non-empty gather): an
    // unconfigured key routed to the extractive fallback would be masked on
    // every call and never get fixed.
    if (result.warnings.includes('NO_ANTHROPIC_API_KEY')) {
      throw verbError(
        'unavailable',
        'synthesize needs an LLM and none is configured.',
        'Set an API key (e.g. `gbrain config set anthropic_api_key sk-...` or ANTHROPIC_API_KEY) and retry. recall and entity work without one.',
        'chat gateway unconfigured (NO_ANTHROPIC_API_KEY)',
      );
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
      sources: result.citations.map(c => c.page_slug),
      gaps: result.gaps,
      cost,
      synthesis_status: 'ok',
      pages_gathered: result.pagesGathered,
      takes_gathered: result.takesGathered,
      warnings: result.warnings,
      protocol_version: MEMORY_VERBS_VERSION,
    };
  },
  cliHints: { name: 'synthesize', positional: ['question'] },
};

// ─── forget ──────────────────────────────────────────────────────────────────

const forget: Operation = {
  name: 'forget',
  description:
    'MEMORY VERB (v1): expire a remembered fact by id — the protocol delete verb. ' +
    '`id` is the opaque string id returned by remember and recall (facts[].fact_id) — never a page slug. ' +
    'Idempotent: forgetting an already-expired fact returns expired:false (success), unknown id returns a not_found error. ' +
    'The fact is expired (audit trail kept), not deleted.',
  params: {
    id: { type: 'string', required: true, description: 'Opaque fact id from remember/recall (facts[].fact_id). Never a page slug.' },
    reason: { type: 'string', description: 'Optional reason, written to the fact\'s audit trail. Default: "forgotten".' },
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

    const { forgetFactInFence } = await import('./facts/forget.ts');
    // [ship P1.1] trust boundary: scope the forget to the caller's source, and
    // for remote callers to world-visible facts only — a guessed global id
    // can't expire facts outside the caller's source or reach private facts.
    const result = await forgetFactInFence(ctx.engine, numericId, {
      ...(reason ? { reason } : {}),
      sourceId: ctx.sourceId ?? 'default',
      worldOnly: ctx.remote !== false,
    });

    if (!result.ok && result.path === 'not_found') {
      throw verbError(
        'not_found',
        `No fact with id "${rawId}".`,
        'Ids come from remember/recall (facts[].fact_id). recall the entity first to find the right fact.',
      );
    }
    if (!result.ok && result.path === 'already_expired') {
      // Idempotent re-forget: success, nothing changed.
      return {
        id: rawId,
        expired: false,
        reason,
        protocol_version: MEMORY_VERBS_VERSION,
      };
    }

    return {
      id: rawId,
      expired: true,
      reason,
      protocol_version: MEMORY_VERBS_VERSION,
    };
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
  'ok', 'empty_answer', 'not_json', 'no_llm', 'model_unusable', 'llm_error', 'extractive_fallback',
];

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
            kind: { type: 'string', enum: FACT_KINDS as unknown as string[] },
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
      search_degraded: { type: 'string', description: 'Present when the search arm fell back to keyword-only (no embedding provider).' },
      budget_tokens: { type: 'integer', description: 'Present when budget_tokens was passed.' },
      budget_used: { type: 'integer' },
      dropped_count: { type: 'integer' },
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
              },
            },
          },
          backlink_count: { type: 'integer' },
          active_fact_count: { type: 'integer' },
        },
      },
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
      answer: { type: 'string' },
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
                },
              },
            },
            backlink_count: { type: 'integer' },
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
          },
        },
      },
      text: { type: 'string', description: 'Pre-rendered injectable block (envelope-wrapped).' },
      degraded_reason: { type: 'string', description: 'Present when a wall-clock deadline returned a partial pack.' },
      budget_tokens: { type: 'integer', description: 'Present when budget_tokens was passed.' },
      budget_used: { type: 'integer' },
      dropped_count: { type: 'integer' },
    },
  },
  delta: {
    type: 'object',
    required: ['protocol_version', 'since', 'pages', 'facts', 'threads'],
    properties: {
      protocol_version: { type: 'integer', const: MEMORY_VERBS_VERSION },
      since: { type: 'string', description: 'The ISO cursor this delta was computed against.' },
      has_more: { type: 'boolean', description: 'True when changes beyond the fetch limit or budget were NOT delivered; with session_id the cursor advanced only to the last delivered page, so the tail surfaces on the next wake.' },
      next_cursor: {
        type: 'object',
        required: ['since', 'slug'],
        description: 'Keyset to resume from (stateless callers pass back as since + since_slug).',
        properties: { since: { type: 'string' }, slug: { type: 'string' } },
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
            fact: { type: 'string' },
            kind: { type: 'string' },
            entity_slug: { type: ['string', 'null'] },
            valid_from: { type: 'string' },
            confidence: { type: 'number' },
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
      degraded_reason: { type: 'string' },
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
  },
};
