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

export const VERB_NAMES = ['recall', 'remember', 'entity', 'synthesize', 'forget'] as const;
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

const synthesize: Operation = {
  name: 'synthesize',
  description:
    '[EXPENSIVE / SLOW — makes LLM calls, seconds-to-minutes latency, costs money] ' +
    'MEMORY VERB (v1): answer a broad question using cross-page LLM reasoning with citations and gap analysis. ' +
    'Prefer recall (facts/snippets) or entity (one known card, zero LLM) for lookups — use synthesize only when the answer ' +
    'requires combining evidence across pages. Response carries a best-effort cost block (model, tokens, usd_estimate).',
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

    return {
      answer: result.answer,
      sources: result.citations.map(c => c.page_slug),
      gaps: result.gaps,
      cost: {
        model: result.modelUsed,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        usd_estimate: usdEstimate,
      },
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
};

/** Error envelope schema (uniform across all five verbs). */
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
