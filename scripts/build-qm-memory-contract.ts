#!/usr/bin/env bun
/**
 * GST-359 D: docs/contracts/qm-memory-provider/v1.json, the QM memory-provider contract, generated from the live
 * operation registry, the actor model and the error catalogue. test/qm-memory-contract.test.ts fails on drift.
 *   bun scripts/build-qm-memory-contract.ts          write the fixture
 *   bun scripts/build-qm-memory-contract.ts --check  exit 1 when the committed fixture is stale
 * A change to the shape is a new file (v2.json); v1.json stays until QM moves.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { paramDefToSchema } from '../src/mcp/tool-defs.ts';
import { CODES } from '../src/core/error-registry.ts';
import { ACTOR_ARGUMENT, ACTOR_DEFERRED_OPS, ACTOR_HEADER, DEFAULT_ATTEST_OPS, EXTERNAL_ID_RE } from '../src/core/access/actor-model.ts';
import { IDEMPOTENCY_KEY_RE, MEMORY_RECALL_MAX_CHARS, MEMORY_RECALL_QUERY_CHARS, MEMORY_WRITE_KINDS, MEMORY_WRITE_MAX_FACTS, MEMORY_WRITE_PROVENANCE_MAX, OWN_RECENT_WINDOW_HOURS, QM_MEMORY_OPS, unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';

export const QM_CONTRACT_PATH = join(import.meta.dir, '..', 'docs', 'contracts', 'qm-memory-provider', 'v1.json');

/** Who fixes each actor_not_attested reason, and how. Every reason the catalogue lists needs a row (the drift test checks). */
export const ACTOR_REASON_FIXES: Record<string, { fixed_by: 'brain_operator' | 'calling_harness'; fix: string }> = {
  no_attest_right: { fixed_by: 'brain_operator', fix: 'gbrain auth rescope --client <id> --attest-actor qm on the brain host; a client that already holds the right takes a new token with grant_type=client_credentials.' },
  op_not_attested: { fixed_by: 'brain_operator', fix: 'gbrain auth rescope --client <id> --attest-actor qm --attest-ops <list>; a deferred operation cannot be attested yet.' },
  argument_mismatch: { fixed_by: 'calling_harness', fix: 'Send acting_user equal to the x-qm-actor header, or omit it.' },
  argument_without_attestation: { fixed_by: 'calling_harness', fix: 'Remove acting_user, or send the x-qm-actor header from a credential holding the attest right.' },
  invalid_actor_id: { fixed_by: 'calling_harness', fix: 'Send the canonical id unchanged: 1-256 visible ASCII characters, no spaces.' },
  actor_required: { fixed_by: 'calling_harness', fix: 'memory_write saves only as an attested person: send x-qm-actor from a credential holding the attest right.' },
};

const ERROR_CODES = ['actor_not_attested', 'actor_unlinked', 'on_behalf_of_invalid_audience', 'invalid_params', 'scope_denied', 'insufficient_scope', 'rate_limited'] as const;

const ERROR_NOTES: Partial<Record<typeof ERROR_CODES[number], string>> = {
  actor_unlinked: 'Refuses memory_write. memory_recall answers it as a success instead (unlinked_recall).',
  on_behalf_of_invalid_audience: 'Sent when x-qm-actor is combined with an on_behalf_of audience (X-Gbrain-On-Behalf-Of or request-level _meta.on_behalf_of). QM classifies it as a failed call.',
  invalid_params: 'Bad arguments, refused before anything is saved. A reused idempotency_key with different facts carries write_error idempotency_conflict; a claim the person forgot carries the fact_withdrawn message.',
  scope_denied: 'The write is not authorized, including a member page whose readers name anyone but its member (squatted or widened): nothing is saved.',
};

function toolEntry(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(name + ' is not in the operation registry');
  return {
    name, description: op.description, scope: op.scope ?? 'read', mutating: op.mutating === true,
    input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)])),
      required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k) },
  };
}

export function buildQmMemoryContract(): Record<string, unknown> {
  const unlinked = unlinkedRecallResult();
  return {
    contract: 'gbrain.qm-memory-provider', version: 1,
    transport: { protocol: 'mcp', session: 'stateless', session_header_issued: false, success_codes_in: 'structuredContent' },
    actor: {
      header: ACTOR_HEADER, argument: ACTOR_ARGUMENT, argument_rule: 'optional; must equal the header; never chooses the person on its own',
      actor_id: { pattern: EXTERNAL_ID_RE.source, case_folding: false },
      system: 'qm', default_attest_ops: [...DEFAULT_ATTEST_OPS], deferred_ops: [...ACTOR_DEFERRED_OPS].sort(),
      audit: 'the audit trail and stored writes record the canonical external id as sent, with its linked member',
    },
    tools: [...QM_MEMORY_OPS].sort().map(toolEntry),
    memory_recall: {
      limits: { max_chars: { ...MEMORY_RECALL_MAX_CHARS, whole_number: true }, query_chars_ranked: MEMORY_RECALL_QUERY_CHARS, own_recent_window_hours: OWN_RECENT_WINDOW_HOURS },
      content: { line: '- <fact> (<YYYY-MM-DD>; <kind>)', truncated_tail: '… <N> more', never: ['page bodies', 'fence markers', 'heading markers'], bounded_by: 'max_chars, cut at a line boundary' },
      order: ['own facts from the last ' + OWN_RECENT_WINDOW_HOURS + ' hours, newest first', 'facts the person may read, ranked by query'],
      ranking: 'keyword-only unless an embedding provider is configured (no embedding call on a keyless brain)',
      structured_content: { facts: [{ id: 'string', text: 'string', date: 'YYYY-MM-DD', kind: 'string' }], truncated: 'boolean', code: 'actor_unlinked (only on unlinked_recall)' },
    },
    unlinked_recall: { isError: false, content: unlinked.content, structuredContent: unlinked.structuredContent },
    memory_write: {
      limits: { facts: { min: 1, max: MEMORY_WRITE_MAX_FACTS }, provenance_chars: MEMORY_WRITE_PROVENANCE_MAX, idempotency_key: IDEMPOTENCY_KEY_RE.source, kinds: [...MEMORY_WRITE_KINDS] },
      saved_as: { page: 'memory/members/<member>', readers: ['member:<member>'], visibility: 'private', provenance: 'qm:<actor id>; <caller provenance>' },
      request_id: 'uuidv5(uuidv5(namespace, "member:<member>"), idempotency_key) for the first fact; later facts derive from it',
      replay: 'the same idempotency_key from the same person returns the first receipt; from another person it is a separate write',
      retries: 'never retried server-side; a write still publishing answers pending',
      committed: { content: 'Saved <N> fact(s).', structuredContent: { status: 'committed', request_id: 'uuid', fact_ids: ['string'] } },
      pending: { content: 'Accepted <N> fact(s); <M> still publishing.', structuredContent: { status: 'pending', request_id: 'uuid', fact_ids: ['string'], pending_request_ids: ['uuid'] }, poll: 'get_write_request {request_id}' },
    },
    errors: {
      shape: { isError: true, content: 'one JSON text block with top-level code, message, suggestion and optional reason and fix', structuredContent: { error: { code: 'string', message: 'string', reason: 'string?', write_error: 'string?', fix: 'object?' } } },
      codes: ERROR_CODES.map(code => {
        const entry: { class: string; summary: string; suggestion?: string; reasons?: readonly string[]; docs?: string } = CODES[code];
        return { code, class: entry.class, summary: entry.summary, ...(entry.suggestion ? { suggestion: entry.suggestion } : {}), docs: entry.docs ?? 'docs/guides/error-codes.md#' + code,
          ...(code === 'actor_not_attested' ? { reasons: (entry.reasons ?? []).map(reason => ({ reason, ...ACTOR_REASON_FIXES[reason] })) } : {}),
          ...(ERROR_NOTES[code] ? { note: ERROR_NOTES[code] } : {}) };
      }),
    },
    wave_2: { audience_header: 'x-qm-audience', encoding: 'base64url of a JSON array of canonical ids', status: 'reserved; not honoured yet' },
  };
}

export function renderQmMemoryContract(): string {
  return JSON.stringify(buildQmMemoryContract(), null, 2) + '\n';
}

if (import.meta.main) {
  const fresh = renderQmMemoryContract();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(QM_CONTRACT_PATH, 'utf8'); } catch { /* missing */ }
    if (current !== fresh) {
      console.error('docs/contracts/qm-memory-provider/v1.json is stale. Run: bun scripts/build-qm-memory-contract.ts');
      process.exit(1);
    }
    console.log('qm-memory-provider v1.json: up to date');
  } else {
    mkdirSync(dirname(QM_CONTRACT_PATH), { recursive: true });
    writeFileSync(QM_CONTRACT_PATH, fresh);
    console.log('wrote ' + QM_CONTRACT_PATH);
  }
}
