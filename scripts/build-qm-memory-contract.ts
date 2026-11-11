#!/usr/bin/env bun
/**
 * GST-359 D: docs/contracts/qm-memory-provider/v1.json and v2.json, the QM memory-provider contracts, generated from the
 * live operation registry, the actor model and the error catalogue. test/qm-memory-contract.test.ts fails on drift.
 *   bun scripts/build-qm-memory-contract.ts          write both fixtures
 *   bun scripts/build-qm-memory-contract.ts --check  exit 1 when a committed fixture is stale
 * A change to the shape is a new version; v1.json stays byte-identical until QM moves. GST-1094 v2 adds the scope read
 * (source_id / source_ids on memory_recall), GST-900's member-bound acting_user rule and _meta-only unknown-param warnings.
 * GST-1158 F1 v3 adds the personal tools (own DM, read as the attested person) with frozen result shapes, forget_fact
 * among them, and each memory_recall fact's arm (F5).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { paramDefToSchema } from '../src/mcp/tool-defs.ts';
import { CODES } from '../src/core/error-registry.ts';
import { ACTOR_ARGUMENT, ACTOR_DEFERRED_OPS, ACTOR_HEADER, DEFAULT_ATTEST_OPS, EXTERNAL_ID_RE, QM_AUDIENCE_HEADER } from '../src/core/access/actor-model.ts';
import { SCOPE_PAGE_SLUG } from '../src/core/access/principals.ts';
import { QUESTION_MAX_CHARS } from '../src/core/facts/question-recall.ts';
import { IDEMPOTENCY_KEY_RE, MEMORY_RECALL_MAX_CHARS, MEMORY_RECALL_QUERY_CHARS, MEMORY_WRITE_KINDS, MEMORY_WRITE_MAX_FACTS, MEMORY_WRITE_PROVENANCE_MAX, OWN_RECENT_WINDOW_HOURS, QM_MEMORY_OPS, QM_PERSONAL_OPS, unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';
import { WRITE_REQUEST_STATES } from '../src/core/persistence/types.ts';
import { TERMINAL_STATES } from '../src/core/persistence/model.ts';

export type QmContractVersion = 1 | 2 | 3;
export const QM_CONTRACT_PATHS: Record<QmContractVersion, string> = {
  1: join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v1.json'),
  2: join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v2.json'),
  3: join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v3.json'),
};
export const QM_CONTRACT_PATH = QM_CONTRACT_PATHS[1];
/** The arguments v1 publishes per tool, frozen: later arguments appear from v2 on. */
const V1_PARAMS: Record<string, readonly string[]> = { memory_recall: ['query', 'max_chars', 'acting_user'], memory_write: ['facts', 'idempotency_key', 'acting_user'] };
/** The arguments v2 publishes per tool, frozen: #8694's query_keep appears from v3 on. */
const V2_PARAMS: Record<string, readonly string[]> = { memory_recall: [...V1_PARAMS.memory_recall!, 'source_id', 'source_ids'], memory_write: [...V1_PARAMS.memory_write!, 'source_id'] };
/** The deferred operations v1 published, frozen: GST-1158 F9 deferred more from v2 on. */
const V1_DEFERRED_OPS: readonly string[] = ['capture', 'extract_facts', 'list_write_conflicts', 'takes_add', 'takes_resolve', 'takes_supersede', 'takes_update'];
/** Catalogue summaries v1 published before they changed, frozen. */
const V1_SUMMARIES: Record<string, string> = {
  actor_not_attested: "A call named the person it serves (the x-qm-actor header or the acting_user argument) in a way gbrain does not honour: the credential holds no attest right, the operation is not in its attested operations, the argument differs from the header or comes without an attested header, or the id is not 1-256 visible ASCII characters; or a write that saves only as an attested person (memory_write) named none; or the request carries x-qm-audience, a channel audience gbrain does not serve yet. Nothing was read or written.",
};

/** Who fixes each actor_not_attested reason, and how. Every reason the catalogue lists needs a row (the drift test checks). */
export const ACTOR_REASON_FIXES: Record<string, { fixed_by: 'brain_operator' | 'calling_harness'; fix: string }> = {
  no_attest_right: { fixed_by: 'brain_operator', fix: 'gbrain auth rescope --client <id> --attest-actor qm on the brain host; a client that already holds the right takes a new token with grant_type=client_credentials.' },
  op_not_attested: { fixed_by: 'brain_operator', fix: 'gbrain auth rescope --client <id> --attest-actor qm --attest-ops <list>; a deferred operation cannot be attested yet.' },
  argument_mismatch: { fixed_by: 'calling_harness', fix: 'Send acting_user equal to the x-qm-actor header, or omit it.' },
  argument_without_attestation: { fixed_by: 'calling_harness', fix: 'Remove acting_user, or send the x-qm-actor header from a credential holding the attest right.' },
  invalid_actor_id: { fixed_by: 'calling_harness', fix: 'Send the canonical id unchanged: 1-256 visible ASCII characters, no spaces.' },
  actor_required: { fixed_by: 'calling_harness', fix: 'memory_write saves only as an attested person: send x-qm-actor from a credential holding the attest right.' },
  audience_not_supported: { fixed_by: 'calling_harness', fix: 'Send the call without x-qm-audience; channel turns are refused until wave 2 and nothing is read or written.' },
};

const ERROR_CODES = ['actor_not_attested', 'actor_unlinked', 'on_behalf_of_invalid_audience', 'invalid_params', 'scope_denied', 'insufficient_scope', 'unknown_tool', 'not_found', 'fact_not_found', 'unavailable'] as const;

const ERROR_NOTES: Partial<Record<typeof ERROR_CODES[number], string>> = {
  actor_unlinked: 'Refuses memory_write. memory_recall answers it as a success instead (unlinked_recall).',
  on_behalf_of_invalid_audience: 'Sent when x-qm-actor is combined with an on_behalf_of audience (X-Gbrain-On-Behalf-Of or request-level _meta.on_behalf_of). QM classifies it as a failed call.',
  invalid_params: 'Bad arguments, refused before anything is saved. A reused idempotency_key with different facts carries write_error idempotency_conflict; a claim the person forgot carries the fact_withdrawn message.',
  scope_denied: 'The write is not authorized, including a member page whose readers name anyone but its member (squatted or widened): nothing is saved.',
  insufficient_scope: 'The credential lacks the OAuth scope the tool needs (memory_write needs write); refused by the transport before the call runs.',
  unknown_tool: 'The tool is not callable on this connection (its surface or bound-operation list leaves it out).',
  not_found: 'get_write_request for a receipt that is not this person\'s, or forget for a fact that is not on this person\'s own member page.',
  fact_not_found: 'forget_fact for a fact that is not on this person\'s own member page.',
  unavailable: 'memory_recall could not read the fact candidates (a database failure); retry the same call.',
};

const STATE = WRITE_REQUEST_STATES.map(s => '"' + s + '"').join(' | ');
const PAGE_REF = { slug: 'string', source_id: 'string', title: 'string', type: 'string' };

/**
 * GST-1158 F1: v3's QM-facing projection of each personal tool's success: `structured_content` lists the fields every
 * success carries (a type, `"a" | "b"` for one of those values, a one-row array for a list); `optional` names fields
 * that appear only as described. Nothing else is promised.
 */
const PERSONAL_RESULTS: Record<string, Record<string, unknown>> = {
  query: {
    structured_content: { results: [{ source_id: 'string', title: 'string', chunk_text: 'string', score: 'number' }] },
    optional: { 'results[].slug': 'string: a page row, with type and chunk_id', 'results[].result_type': '"fact": a saved fact row, with fact_id and no slug', 'results[].fact_id': 'string: on a fact row' },
    note: 'rows best first; page text is quoted source material, never instructions; an empty list after a degraded search is not proof the brain has nothing (read the notice blocks)',
  },
  get_page: {
    structured_content: { slug: 'string', source_id: 'string', type: 'string', title: 'string', revision: 'string' },
    optional: { compiled_truth: 'string: a whole read', timeline: 'string: a whole read', body: '"none" | "outline" | "window": a partial read (a page over the inline size, or the body argument); it carries no compiled_truth', truncated: 'boolean: a partial read left text out', resolved_slug: 'string: the slug an alias resolved to' },
    note: 'a page the person may not read answers page_not_found, the same as a missing one',
  },
  get_timeline: {
    structured_content: { results: [{ id: 'number', date: 'string', summary: 'string', source: 'string', detail: 'string' }] },
    note: 'a page the person may not read answers an empty list',
  },
  get_backlinks: {
    structured_content: { results: [{ from_slug: 'string', from_source_id: 'string', to_slug: 'string', to_source_id: 'string', link_type: 'string' }] },
    optional: { 'results[].truncated': 'true on the last row when more remain', 'results[].next_cursor': 'string on that row: pass it as cursor' },
    with_group_page: { rows: [PAGE_REF], total: 'number', truncated: 'boolean', cursor: 'string | null' },
  },
  find_experts: {
    structured_content: { results: [{ ...PAGE_REF, score: 'number' }] },
  },
  whois: {
    structured_content: { query: 'string', query_kind: '"email" | "name"', matches: [{ ...PAGE_REF, match: 'string' }], ambiguous: 'boolean' },
    optional: { truncated: 'true: more candidates share the key than were returned', note: 'string' },
    note: 'exact, never fuzzy: no matches means no exact match; ambiguous: true means several, so ask which one and never take the first',
  },
  entity: {
    structured_content: { protocol_version: 'number', found: 'boolean' },
    optional: { card: 'object when found: card.entity holds slug, source_id, title and type', suggestions: 'array of {slug, title} when not found', ambiguous: 'true: the name matched several entities' },
    with_names: { protocol_version: 'number', results: [{ name: 'string', found: 'boolean' }] },
  },
  context_pack: {
    content: 'the rendered pack text alone, as memory_recall\'s; it is not repeated in structuredContent',
    structured_content: { protocol_version: 'number', entities: ['string'], cards: [PAGE_REF], open_threads: 'array', facts: [{ fact: 'string', kind: 'string', fact_id: 'string' }], entity_facts: 'array' },
  },
  volunteer_context: {
    structured_content: { pages: [{ slug: 'string', source_id: 'string', display: 'string', confidence: 'number', rationale: 'string' }], count: 'number', window_turns: 'number' },
    note: 'stats: true answers a usage summary instead, which this contract does not freeze',
  },
  get_write_request: {
    structured_content: { request_id: 'string', state: STATE, retry_after_ms: 'number | null', operation: 'string', source_id: 'string', slug: 'string | null', created_at: 'string', updated_at: 'string' },
    optional: { write_error: 'string: why a write ended without publishing', outcome: 'object: the published write\'s result' },
    states: {
      known: [...WRITE_REQUEST_STATES], terminal: WRITE_REQUEST_STATES.filter(s => TERMINAL_STATES.has(s)), published: 'committed',
      unknown: 'a state not listed here means unknown, not published: never report the write as saved; poll again or report it as unknown',
      poll: 'until a terminal state, after retry_after_ms when it is set',
    },
  },
  forget_fact: {
    structured_content: { id: 'number', request_id: 'string', state: STATE },
    optional: { expired: 'boolean: the fact is withdrawn' },
    note: 'withdraws only a fact on the person\'s own member page (any other id is fact_not_found); send request_id (a UUID) so a retry replays the same withdrawal; a state other than committed is read with get_write_request',
  },
};

/** v3 error notes beside v2's: the codes the personal tools add. */
const V3_ERROR_NOTES: Record<string, string> = {
  page_not_found: 'get_page for a page that does not exist or that the person may not read; one answer for both.',
  result_too_large: 'A personal read whose answer, with structuredContent, is over the connection\'s result cap; nothing was returned. Ask for less: get_page body: "outline" or "window", or a smaller limit.',
};

/** v2 changes to v1's fix rows (GST-900: a member-bound credential may name its own member). */
const V2_REASON_FIXES: Partial<typeof ACTOR_REASON_FIXES> = {
  argument_mismatch: { fixed_by: 'calling_harness', fix: 'Send acting_user equal to the x-qm-actor header (with no header, on a credential bound to a member: that member id or a canonical id linked to it), or omit it.' },
  argument_without_attestation: { fixed_by: 'calling_harness', fix: 'Remove acting_user, or send the x-qm-actor header from a credential holding the attest right; a credential bound to no member never sends acting_user alone. detail missing=<attest_right|x-qm-actor, comma-separated> names what this call lacked.' },
};

function toolEntry(name: string, version: QmContractVersion) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(name + ' is not in the operation registry');
  const frozen = version === 1 ? V1_PARAMS[name] : version === 2 ? V2_PARAMS[name] : undefined;
  const params = Object.entries(op.params).filter(([k]) => !frozen || frozen.includes(k));
  return {
    name, description: op.description, scope: op.scope ?? 'read', mutating: op.mutating === true,
    input_schema: { type: 'object', properties: Object.fromEntries(params.map(([k, v]) => [k, paramDefToSchema(v)])),
      required: params.filter(([, v]) => v.required).map(([k]) => k) },
  };
}

export function buildQmMemoryContract(version: QmContractVersion): Record<string, unknown> {
  const unlinked = unlinkedRecallResult();
  const v2 = version > 1;
  const v3 = version > 2;
  const codes: readonly (keyof typeof CODES)[] = v3 ? [...ERROR_CODES, 'permission_denied', 'page_not_found', 'result_too_large'] : v2 ? [...ERROR_CODES, 'permission_denied'] : ERROR_CODES;
  const notes: Record<string, string | undefined> = v2 ? { ...ERROR_NOTES,
    actor_not_attested: 'With no x-qm-actor header, acting_user is accepted only from a credential bound to a member and only naming that member (its member id or a canonical id linked to it); the call then runs exactly as the credential.',
    invalid_params: `${ERROR_NOTES.invalid_params} A memory_write whose source_id is the credential's own source carries reason source_is_member_source (omit source_id instead). recall refuses a question over ${QUESTION_MAX_CHARS} UTF-16 code units with reason question_too_long and detail max_chars=${QUESTION_MAX_CHARS} received_chars=<n>; nothing is read and the question is never cut, so shorten it and retry.`,
    permission_denied: 'memory_recall named a source (source_id or source_ids) outside the credential\'s read grant; nothing was read. memory_write named a source_id that is not one of the credential\'s scope sources (reason source_not_attested, also at publication after the operator drops it), or the scope page names readers (reason scope_page_not_shared); nothing was saved.', ...(v3 ? V3_ERROR_NOTES : {}) } : ERROR_NOTES;
  return {
    contract: 'gbrain.qm-memory-provider', version,
    transport: { protocol: 'mcp', session: 'stateless', session_header_issued: false, success_codes_in: 'structuredContent',
      ...(v2 ? { unknown_arguments: 'an argument a read tool does not declare is refused with invalid_params, and nothing is read, when its nearest declared argument is a source scope or a filter (source for source_id, sources for source_ids, type for types) or its own name is in a scope or filter family the tool declares (source_name on a tool that declares source_id); any other argument a read tool does not declare is ignored and reported only in _meta.warnings ([{code: "unknown_param", param, suggestion?}]), never in content, unless the brain sets mcp.strict_params to reject; a write tool refuses every argument it does not declare with invalid_params' } : {}) },
    actor: {
      header: ACTOR_HEADER, argument: ACTOR_ARGUMENT, argument_rule: v2
        ? 'optional; on an attested call it must equal the header; with no header it is accepted only from a credential bound to a member and only naming that member (its member id or a canonical id linked to it), and the call then runs exactly as the credential; never chooses the person on its own'
        : 'optional; must equal the header; never chooses the person on its own',
      actor_id: { pattern: EXTERNAL_ID_RE.source, case_folding: false },
      system: 'qm', default_attest_ops: [...DEFAULT_ATTEST_OPS], deferred_ops: v2 ? [...ACTOR_DEFERRED_OPS].sort() : [...V1_DEFERRED_OPS],
      audit: 'the audit trail and stored writes record the canonical external id as sent, with its linked member',
    },
    tools: [...QM_MEMORY_OPS].sort().map(name => toolEntry(name, version)),
    ...(v3 ? { personal_tools: {
      read_as: 'the attested person (x-qm-actor): what that person may read, their own restricted pages included, so use these tools only in the person\'s own conversations; no tool here is marked as a shared-scope read yet',
      opt_in: 'only get_write_request is in default_attest_ops: the brain operator lists each other tool in the client\'s --attest-ops (gbrain auth rescope --client <id> --attest-actor qm --attest-ops <list>), or it is refused with actor_not_attested reason op_not_attested',
      structured_content: 'an attested success carries the result in structuredContent and keeps it as JSON in content (notice blocks follow it); a list arrives as structuredContent.results; context_pack\'s text alone fills content, as memory_recall\'s does; an unattested call to the same tool gets no structuredContent',
      result_rule: 'each result lists the fields every success carries; other fields may appear and must be ignored',
      tools: [...QM_PERSONAL_OPS].sort().map(name => ({ ...toolEntry(name, version), personal_only: true, result: PERSONAL_RESULTS[name] })),
    } } : {}),
    memory_recall: {
      limits: { max_chars: { ...MEMORY_RECALL_MAX_CHARS, whole_number: true, unit: 'UTF-16 code units (JavaScript string length)' }, query_chars_ranked: MEMORY_RECALL_QUERY_CHARS, own_recent_window_hours: OWN_RECENT_WINDOW_HOURS },
      arguments_checked: v3
        ? `query, max_chars and query_keep are checked before any read, also for an unlinked person (invalid_params); a longer query is never refused (recall's question is refused over ${QUESTION_MAX_CHARS}: invalid_params reason question_too_long) and is ranked on its first ${MEMORY_RECALL_QUERY_CHARS} characters, or on its last ${MEMORY_RECALL_QUERY_CHARS} with query_keep tail; a call that sends query_keep gets structuredContent.query_truncated, true when the query was cut`
        : v2
        ? `query and max_chars are checked before any read, also for an unlinked person (invalid_params); a longer query is ranked on its first ${MEMORY_RECALL_QUERY_CHARS} characters and never refused (recall's question is refused over ${QUESTION_MAX_CHARS}: invalid_params reason question_too_long)`
        : 'query and max_chars are checked before any read, also for an unlinked person (invalid_params)',
      content: { line: '- <fact> (<YYYY-MM-DD>; <kind>)', never: ['page bodies', 'fence markers', 'heading markers', 'line breaks or control characters inside a fact'], bounded_by: 'max_chars: as many whole lines as fit; facts left out set structuredContent.truncated, with no marker line, because every line is one fact' },
      order: ['own facts from the last ' + OWN_RECENT_WINDOW_HOURS + ' hours, newest first', 'facts the person may read, ranked by query'],
      ranking: 'keyword-only unless an embedding provider is configured (no embedding call on a keyless brain)',
      structured_content: { facts: [{ id: 'string', text: 'string', date: 'YYYY-MM-DD', kind: 'string', ...(v3 ? { arm: '"own" | "ranked"' } : {}) }], truncated: 'boolean', ...(v3 ? { query_truncated: 'boolean, only when the call sent query_keep' } : {}), code: 'actor_unlinked (only on unlinked_recall)' },
      ...(v3 ? { arm: 'own: the person\'s own fact from the last ' + OWN_RECENT_WINDOW_HOURS + ' hours; ranked: matched by query (a fact found both ways is own); a call that names sources answers ranked rows only' } : {}),
      ...(v2 ? { scope_read: {
        arguments: ['source_id', 'source_ids'],
        rule: 'a call that names sources is read as their audience, never as the person: no own facts first and no member-page fact; a page restricted to named readers stays hidden; privacy is never relaxed',
        sources: 'narrowed inside the credential\'s read grant like recall\'s source_ids; a source outside it is permission_denied; source_id and source_ids together read their intersection, and an empty intersection reads nothing',
        without_sources: 'the person read above (own recent facts, then what the person may read across the read grant): use it only for the person\'s own conversations',
      } } : {}),
    },
    unlinked_recall: { isError: false, content: unlinked.content, structuredContent: unlinked.structuredContent },
    memory_write: {
      limits: { facts: { min: 1, max: MEMORY_WRITE_MAX_FACTS }, provenance_chars: MEMORY_WRITE_PROVENANCE_MAX, idempotency_key: { pattern: IDEMPOTENCY_KEY_RE.source }, kinds: [...MEMORY_WRITE_KINDS],
        provenance: 'one line: no line breaks or control characters, and not starting with qm: (gbrain adds qm:<actor id> itself)',
        valid_from: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fraction]][Z|±HH:MM], a real calendar day in years 0001-9999' },
      validation: 'every fact is checked before any is saved: one bad fact refuses the whole call with invalid_params and the idempotency_key stays unused',
      saved_as: { page: 'memory/members/<member>', readers: ['member:<member>'], visibility: 'private', provenance: 'qm:<actor id>; <caller provenance>' },
      request_id: 'uuidv5(uuidv5(namespace, "member:<member>"), idempotency_key) for the first fact; later facts derive from it',
      replay: 'the same idempotency_key from the same person returns the first receipt; from another person it is a separate write',
      retries: 'never retried server-side; a write still publishing answers pending',
      committed: { content: 'Saved <N> fact(s).', structuredContent: { status: 'committed', request_id: 'uuid', fact_ids: ['string'] }, fact_ids: 'distinct; facts repeating one claim in a call share one id, and <N> counts distinct facts' },
      pending: { content: 'Accepted <N> fact(s); <M> still publishing.', structuredContent: { status: 'pending', request_id: 'uuid', fact_ids: ['string'], pending_request_ids: ['uuid'] }, poll: 'get_write_request {request_id}' },
      ...(v2 ? { scope_write: {
        argument: 'source_id',
        rule: 'names one of the credential\'s scope sources (attest_sources, which the brain operator sets on the host); checked on the call and again when the write publishes, so a source the operator drops refuses queued writes; omit it to save for the person alone, exactly as without it',
        saved_as: { page: SCOPE_PAGE_SLUG, readers: 'none: whoever holds read on the scope source, which only scope credentials may', visibility: 'world', provenance: 'qm:<actor id>; <caller provenance>' },
        request_id: 'uuidv5(uuidv5(namespace, "member:<member>#source:<source_id>"), idempotency_key) for the first fact; later facts derive from it; without source_id the member derivation above is unchanged',
        replay: 'per person and source: the same idempotency_key in another source is a separate write',
        pending: 'a scope source with a repository publishes git-first through its writer and answers pending until it commits; a source without one commits to the database',
        recall: 'read it with memory_recall source_id (read as the scope); a memory_recall without sources never reads a scope source',
        withdrawal: 'forget and forget_fact reach only the person\'s own member page, so a scope fact is not_found remotely',
      } } : {}),
    },
    errors: {
      shape: { isError: true, content: 'one JSON text block with top-level code, message, suggestion and optional reason and fix', structuredContent: { error: { code: 'string', message: 'string', reason: 'string?', write_error: 'string?', fix: 'object?' } } },
      applies_to: v3 ? 'every refusal of memory_recall and memory_write, and of a personal tool called with x-qm-actor, including the transport\'s scope and unknown-tool refusals' : 'every refusal of memory_recall and memory_write, including the transport\'s scope and unknown-tool refusals',
      codes: codes.map(code => {
        const entry: { class: string; summary: string; suggestion?: string; reasons?: readonly string[]; docs?: string } = CODES[code];
        return { code, class: entry.class, summary: (v2 ? undefined : V1_SUMMARIES[code]) ?? entry.summary, ...(entry.suggestion ? { suggestion: entry.suggestion } : {}), docs: entry.docs ?? 'docs/guides/error-codes.md#' + code,
          ...(code === 'actor_not_attested' ? { reasons: (entry.reasons ?? []).map(reason => ({ reason, ...ACTOR_REASON_FIXES[reason], ...(v2 ? V2_REASON_FIXES[reason] : {}) })) } : {}),
          ...(notes[code] ? { note: notes[code] } : {}) };
      }),
    },
    wave_2: { audience_header: QM_AUDIENCE_HEADER, encoding: 'base64url of a JSON array of canonical ids', status: 'refused until wave 2',
      refusal: { code: 'actor_not_attested', reason: 'audience_not_supported', tools_call: 'errors.shape, with or without x-qm-actor', other_methods: 'JSON-RPC error -32600 whose data carries code and reason (tools/list, resources/list, resources/read)' } },
  };
}

export function renderQmMemoryContract(version: QmContractVersion): string {
  return JSON.stringify(buildQmMemoryContract(version), null, 2) + '\n';
}

if (import.meta.main) {
  let stale = false;
  for (const version of [1, 2, 3] as const) {
    const path = QM_CONTRACT_PATHS[version];
    const fresh = renderQmMemoryContract(version);
    if (process.argv.includes('--check')) {
      let current = '';
      try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
      if (current !== fresh) {
        console.error('docs/contracts/qm-memory-provider/v' + version + '.json is stale. Run: bun scripts/build-qm-memory-contract.ts');
        stale = true;
      } else console.log('qm-memory-provider v' + version + '.json: up to date');
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fresh);
      console.log('wrote ' + path);
    }
  }
  if (stale) process.exit(1);
}
