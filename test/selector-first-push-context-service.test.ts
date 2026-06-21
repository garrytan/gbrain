import { describe, expect, test } from 'bun:test';
import {
  buildSelectorFirstPushContextEnvelope,
  validateSelectorFirstPushContextEnvelope,
} from '../src/core/services/selector-first-push-context-service.ts';
import type { RetrievalSelector } from '../src/core/types.ts';

const NOW = '2026-06-21T15:00:00.000Z';

const selector: RetrievalSelector = {
  kind: 'compiled_truth',
  scope_id: 'workspace:default',
  slug: 'concepts/push-context',
  selector_id: 'compiled_truth:workspace:default:concepts/push-context',
  content_hash: 'hash-push-context',
  source_refs: [
    'Source: User, direct message, 2026-06-21 23:30 KST',
  ],
};

describe('selector-first push context envelope', () => {
  test('builds a bounded selector envelope that requires read_context before answer use', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-1',
      trace_ids: ['trace-1'],
      selectors: [selector],
      scope_gate: {
        policy: 'allow',
        resolved_scope: 'work',
        decision_reason: 'work_scope_allowed',
        summary_lines: ['Work scope allowed.'],
      },
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: ['probe_candidates_are_not_answer_ground'],
      },
      source_ref_count: 1,
      confidence: 0.72,
      now: NOW,
      ttl_ms: 60_000,
    });

    expect(envelope).toMatchObject({
      schema_version: 1,
      envelope_kind: 'selector_first_push_context',
      request_id: 'request-1',
      trace_ids: ['trace-1'],
      selector_ids: ['compiled_truth:workspace:default:concepts/push-context'],
      content_hashes: ['hash-push-context'],
      source_ref_count: 1,
      confidence: 0.72,
      not_answer_ground_until_read_context: true,
      required_next_tool: 'read_context',
      answer_readiness: {
        ready: false,
        must_read_context: true,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('Source: User');

    const validation = validateSelectorFirstPushContextEnvelope(envelope, { now: NOW });
    expect(validation).toEqual({
      accepted: true,
      reason_codes: [],
      read_context_required: true,
      selector_ids: ['compiled_truth:workspace:default:concepts/push-context'],
    });
  });

  test('rejects expired envelopes', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-expired',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 1_000,
    });

    const validation = validateSelectorFirstPushContextEnvelope(envelope, {
      now: '2026-06-21T15:00:02.000Z',
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason_codes).toContain('expired');
  });

  test('rejects raw text and candidate-only evidence fields', () => {
    const envelope = {
      schema_version: 1,
      envelope_kind: 'selector_first_push_context',
      request_id: 'request-raw',
      created_at: NOW,
      expires_at: '2026-06-21T15:01:00.000Z',
      ttl_ms: 60_000,
      trace_ids: [],
      selector_ids: ['compiled_truth:workspace:default:concepts/push-context'],
      selector_snapshots: [selector],
      content_hashes: ['hash-push-context'],
      source_ref_count: 0,
      confidence: 0.5,
      not_answer_ground_until_read_context: true,
      required_next_tool: 'read_context',
      answer_readiness: {
        ready: false,
        must_read_context: true,
        reason_codes: [],
      },
      raw_text: 'raw personal memory text must never ride along',
      candidate_ids: ['candidate:unsafe'],
      candidate_content: 'candidate content is not answer evidence',
    };

    const validation = validateSelectorFirstPushContextEnvelope(envelope, { now: NOW });

    expect(validation.accepted).toBe(false);
    expect(validation.reason_codes).toContain('raw_text_field_present');
    expect(validation.reason_codes).toContain('candidate_pointer_present');
  });

  test('rejects raw memory text fields recursively instead of stripping them', () => {
    const baseEnvelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-recursive-raw',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    for (const [field, value] of Object.entries({
      text: 'raw text',
      page_text: 'raw page text',
      compiled_truth: 'raw compiled truth',
      timeline: 'raw timeline',
      chunk_text: 'raw chunk text',
      proposed_content: 'raw candidate content',
      personal_memory_text: 'raw personal memory text',
      source_excerpt: 'raw source excerpt',
      evidence_text: 'raw evidence text',
      answer_ground: ['selector pointers are not answer ground'],
    })) {
      const validation = validateSelectorFirstPushContextEnvelope({
        ...baseEnvelope,
        nested: { [field]: value },
      }, { now: NOW });

      expect(validation.accepted).toBe(false);
      expect(validation.reason_codes).toContain('raw_text_field_present');
    }
  });

  test('rejects unknown fields so raw content cannot bypass the bounded schema', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-unknown-field',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    const topLevel = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      content: 'raw personal memory text through a generic key',
    }, { now: NOW });
    expect(topLevel.accepted).toBe(false);
    expect(topLevel.reason_codes).toContain('unknown_field');

    const nested = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      read_context_arguments: {
        selectors: [{
          ...envelope.selector_snapshots[0]!,
          content: 'raw selector text through a generic key',
        }],
      },
    }, { now: NOW });
    expect(nested.accepted).toBe(false);
    expect(nested.reason_codes).toContain('read_context_arguments_invalid');
  });

  test('rejects malformed allowed fields so raw content cannot hide inside schema fields', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-malformed-fields',
      trace_ids: ['trace-1'],
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    const invalidShapes = [
      { request_id: { content: 'raw text hidden in request id' } },
      { created_at: { content: 'raw text hidden in created_at' } },
      { ttl_ms: 'not-a-number' },
      { trace_ids: [{ content: 'raw text hidden in trace ids' }] },
      { content_hashes: [{ content: 'raw text hidden in content hashes' }] },
      { source_ref_count: { content: 'raw text hidden in source ref count' } },
      { confidence: { content: 'raw text hidden in confidence' } },
      { answer_readiness: { ...envelope.answer_readiness, reason_codes: [{ content: 'raw text hidden in reason codes' }] } },
    ];

    for (const invalidShape of invalidShapes) {
      const validation = validateSelectorFirstPushContextEnvelope({
        ...envelope,
        ...invalidShape,
      }, { now: NOW });

      expect(validation.accepted).toBe(false);
      expect(validation.reason_codes).toContain('field_shape_invalid');
    }
  });

  test('rejects malformed selector snapshot fields and stale selector ids', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-malformed-selector',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    for (const invalidSelector of [
      {
        ...envelope.selector_snapshots[0]!,
        line_start: 'not-a-number',
      },
      {
        ...envelope.selector_snapshots[0]!,
        content_hash: 42,
      },
      {
        ...envelope.selector_snapshots[0]!,
        char_start: 5,
      },
    ]) {
      const validation = validateSelectorFirstPushContextEnvelope({
        ...envelope,
        selector_snapshots: [invalidSelector],
        read_context_arguments: { selectors: [invalidSelector] },
      }, { now: NOW });

      expect(validation.accepted).toBe(false);
      expect(validation.reason_codes).toContain('selector_snapshot_invalid');
    }
  });

  test('rejects malformed scope gate fields so raw content cannot hide in allowed metadata', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-malformed-scope-gate',
      selectors: [selector],
      scope_gate: {
        policy: 'allow',
        resolved_scope: 'work',
        decision_reason: 'work_scope_allowed',
        summary_lines: ['Work scope allowed.'],
      },
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    for (const scope_gate of [
      { ...envelope.scope_gate, policy: 'answer_now' },
      { ...envelope.scope_gate, resolved_scope: 'private' },
      { ...envelope.scope_gate, decision_reason: { content: 'raw personal memory text' } },
      { ...envelope.scope_gate, summary_lines: [{ content: 'raw personal memory text' }] },
    ]) {
      const validation = validateSelectorFirstPushContextEnvelope({
        ...envelope,
        scope_gate,
      }, { now: NOW });

      expect(validation.accepted).toBe(false);
      expect(validation.reason_codes).toContain('scope_gate_invalid');
    }
  });

  test('rejects non-runnable selector envelopes with missing or mismatched read_context arguments', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-non-runnable',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    const withoutSnapshots = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      selector_snapshots: undefined,
    }, { now: NOW });
    expect(withoutSnapshots.accepted).toBe(false);
    expect(withoutSnapshots.reason_codes).toContain('selector_snapshots_invalid');

    const withoutArguments = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      read_context_arguments: undefined,
    }, { now: NOW });
    expect(withoutArguments.accepted).toBe(false);
    expect(withoutArguments.reason_codes).toContain('read_context_arguments_invalid');

    const mismatchedArguments = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      read_context_arguments: {
        selectors: [{
          ...envelope.selector_snapshots[0]!,
          selector_id: 'compiled_truth:workspace:default:concepts/other',
          slug: 'concepts/other',
        }],
      },
    }, { now: NOW });
    expect(mismatchedArguments.accepted).toBe(false);
    expect(mismatchedArguments.reason_codes).toContain('selector_ids_mismatch');
  });

  test('rejects envelopes that do not force read_context before factual use', () => {
    const envelope = buildSelectorFirstPushContextEnvelope({
      request_id: 'request-answer-ready',
      selectors: [selector],
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: [],
      },
      now: NOW,
      ttl_ms: 60_000,
    });

    const validation = validateSelectorFirstPushContextEnvelope({
      ...envelope,
      not_answer_ground_until_read_context: false,
      required_next_tool: 'answer_now',
      answer_readiness: {
        ...envelope.answer_readiness,
        must_read_context: false,
      },
    }, { now: NOW });

    expect(validation.accepted).toBe(false);
    expect(validation.reason_codes).toContain('read_context_not_required');
  });
});
