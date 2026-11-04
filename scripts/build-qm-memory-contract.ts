#!/usr/bin/env bun
/**
 * GST-359 D: docs/contracts/qm-memory-provider/v1.json and v2.json, the QM memory-provider contracts, generated from the
 * live operation registry, the actor model and the error catalogue. test/qm-memory-contract.test.ts fails on drift.
 *   bun scripts/build-qm-memory-contract.ts          write both fixtures
 *   bun scripts/build-qm-memory-contract.ts --check  exit 1 when a committed fixture is stale
 * A change to the shape is a new version; v1.json stays byte-identical until QM moves. GST-1094 v2 adds the scope read
 * (source_id / source_ids on memory_recall), GST-900's member-bound acting_user rule and _meta-only unknown-param warnings.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { paramDefToSchema } from '../src/mcp/tool-defs.ts';
import { CODES } from '../src/core/error-registry.ts';
import { ACTOR_ARGUMENT, ACTOR_DEFERRED_OPS, ACTOR_HEADER, DEFAULT_ATTEST_OPS, EXTERNAL_ID_RE, QM_AUDIENCE_HEADER } from '../src/core/access/actor-model.ts';
import { SCOPE_PAGE_SLUG } from '../src/core/access/principals.ts';
import { QUESTION_MAX_CHARS } from '../src/core/facts/question-recall.ts';
import { IDEMPOTENCY_KEY_RE, MEMORY_RECALL_MAX_CHARS, MEMORY_RECALL_QUERY_CHARS, MEMORY_WRITE_KINDS, MEMORY_WRITE_MAX_FACTS, MEMORY_WRITE_PROVENANCE_MAX, OWN_RECENT_WINDOW_HOURS, QM_MEMORY_OPS, unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';

export type QmContractVersion = 1 | 2;
export const QM_CONTRACT_PATHS: Record<QmContractVersion, string> = {
  1: join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v1.json'),
  2: join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v2.json'),
};
export const QM_CONTRACT_PATH = QM_CONTRACT_PATHS[1];
/** The arguments v1 publishes per tool, frozen: later arguments appear from v2 on. */
const V1_PARAMS: Record<string, readonly string[]> = { memory_recall: ['query', 'max_chars', 'acting_user'], memory_write: ['facts', 'idempotency_key', 'acting_user'] };
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

/** v2 changes to v1's fix rows (GST-900: a member-bound credential may name its own member). */
const V2_REASON_FIXES: Partial<typeof ACTOR_REASON_FIXES> = {
  argument_mismatch: { fixed_by: 'calling_harness', fix: 'Send acting_user equal to the x-qm-actor header (with no header, on a credential bound to a member: that member id or a canonical id linked to it), or omit it.' },
  argument_without_attestation: { fixed_by: 'calling_harness', fix: 'Remove acting_user, or send the x-qm-actor header from a credential holding the attest right; a credential bound to no member never sends acting_user alone. detail missing=<attest_right|x-qm-actor, comma-separated> names what this call lacked.' },
};

function toolEntry(name: string, version: QmContractVersion) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(name + ' is not in the operation registry');
  const params = Object.entries(op.params).filter(([k]) => version > 1 || V1_PARAMS[name]!.includes(k));
  return {
    name, description: op.description, scope: op.scope ?? 'read', mutating: op.mutating === true,
    input_schema: { type: 'object', properties: Object.fromEntries(params.map(([k, v]) => [k, paramDefToSchema(v)])),
      required: params.filter(([, v]) => v.required).map(([k]) => k) },
  };
}

export function buildQmMemoryContract(version: QmContractVersion): Record<string, unknown> {
  const unlinked = unlinkedRecallResult();
  const v2 = version > 1;
  const codes = v2 ? [...ERROR_CODES, 'permission_denied' as const] : ERROR_CODES;
  const notes: Record<string, string | undefined> = v2 ? { ...ERROR_NOTES,
    actor_not_attested: 'With no x-qm-actor header, acting_user is accepted only from a credential bound to a member and only naming that member (its member id or a canonical id linked to it); the call then runs exactly as the credential.',
    invalid_params: `${ERROR_NOTES.invalid_params} A memory_write whose source_id is the credential's own source carries reason source_is_member_source (omit source_id instead). recall refuses a question over ${QUESTION_MAX_CHARS} UTF-16 code units with reason question_too_long and detail max_chars=${QUESTION_MAX_CHARS} received_chars=<n>; nothing is read and the question is never cut, so shorten it and retry.`,
    permission_denied: 'memory_recall named a source (source_id or source_ids) outside the credential\'s read grant; nothing was read. memory_write named a source_id that is not one of the credential\'s scope sources (reason source_not_attested, also at publication after the operator drops it), or the scope page names readers (reason scope_page_not_shared); nothing was saved.' } : ERROR_NOTES;
  return {
    contract: 'gbrain.qm-memory-provider', version,
    transport: { protocol: 'mcp', session: 'stateless', session_header_issued: false, success_codes_in: 'structuredContent',
      ...(v2 ? { unknown_arguments: 'an argument a read tool does not declare is ignored and reported only in _meta.warnings ([{code: "unknown_param", param, suggestion?}]), never in content; a write tool refuses it with invalid_params' } : {}) },
    actor: {
      header: ACTOR_HEADER, argument: ACTOR_ARGUMENT, argument_rule: v2
        ? 'optional; on an attested call it must equal the header; with no header it is accepted only from a credential bound to a member and only naming that member (its member id or a canonical id linked to it), and the call then runs exactly as the credential; never chooses the person on its own'
        : 'optional; must equal the header; never chooses the person on its own',
      actor_id: { pattern: EXTERNAL_ID_RE.source, case_folding: false },
      system: 'qm', default_attest_ops: [...DEFAULT_ATTEST_OPS], deferred_ops: [...ACTOR_DEFERRED_OPS].sort(),
      audit: 'the audit trail and stored writes record the canonical external id as sent, with its linked member',
    },
    tools: [...QM_MEMORY_OPS].sort().map(name => toolEntry(name, version)),
    memory_recall: {
      limits: { max_chars: { ...MEMORY_RECALL_MAX_CHARS, whole_number: true, unit: 'UTF-16 code units (JavaScript string length)' }, query_chars_ranked: MEMORY_RECALL_QUERY_CHARS, own_recent_window_hours: OWN_RECENT_WINDOW_HOURS },
      arguments_checked: v2
        ? `query and max_chars are checked before any read, also for an unlinked person (invalid_params); a longer query is ranked on its first ${MEMORY_RECALL_QUERY_CHARS} characters and never refused (recall's question is refused over ${QUESTION_MAX_CHARS}: invalid_params reason question_too_long)`
        : 'query and max_chars are checked before any read, also for an unlinked person (invalid_params)',
      content: { line: '- <fact> (<YYYY-MM-DD>; <kind>)', never: ['page bodies', 'fence markers', 'heading markers', 'line breaks or control characters inside a fact'], bounded_by: 'max_chars: as many whole lines as fit; facts left out set structuredContent.truncated, with no marker line, because every line is one fact' },
      order: ['own facts from the last ' + OWN_RECENT_WINDOW_HOURS + ' hours, newest first', 'facts the person may read, ranked by query'],
      ranking: 'keyword-only unless an embedding provider is configured (no embedding call on a keyless brain)',
      structured_content: { facts: [{ id: 'string', text: 'string', date: 'YYYY-MM-DD', kind: 'string' }], truncated: 'boolean', code: 'actor_unlinked (only on unlinked_recall)' },
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
      applies_to: 'every refusal of memory_recall and memory_write, including the transport\'s scope and unknown-tool refusals',
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
  for (const version of [1, 2] as const) {
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
