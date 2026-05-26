import { describe, expect, test } from 'bun:test';
import {
  buildSessionGrantPolicyInput,
  evaluateSessionSourceGrant,
  evaluateSessionWriteGrant,
  linkGeneratedAssertionsToTaskEvent,
} from '../src/core/assertions/session-grants.ts';

const now = new Date('2026-05-20T12:00:00.000Z');

describe('Phase 03 session grants', () => {
  test('session_grants expose scoped raw-access and write-policy inputs', () => {
    const grant = {
      id: 'grant-1',
      session_id: 'session-codex-1',
      realm: 'work',
      allowed_tools: ['retrieve_context', 'read_context', 'route_memory_writeback'],
      raw_access_policy: {
        default: 'metadata_chunks',
        permitted_raw_scopes: ['source_chunk', 'task_event_payload'],
        requires_explicit_source_grant: true,
      },
      write_policy: {
        target_scopes: ['assertion', 'memory_candidate'],
        allowed_policy_outcomes: ['canonical_write_allowed', 'create_candidate'],
        requires_target_snapshot_hash: true,
      },
      expires_at: '2026-05-20T13:00:00.000Z',
      revoked_at: null,
    };

    expect(buildSessionGrantPolicyInput(grant, now)).toEqual({
      session_id: 'session-codex-1',
      realm: 'work',
      allowed_tools: ['retrieve_context', 'read_context', 'route_memory_writeback'],
      raw_access_policy: {
        default: 'metadata_chunks',
        permitted_raw_scopes: ['source_chunk', 'task_event_payload'],
        requires_explicit_source_grant: true,
      },
      write_policy: {
        target_scopes: ['assertion', 'memory_candidate'],
        allowed_policy_outcomes: ['canonical_write_allowed', 'create_candidate'],
        requires_target_snapshot_hash: true,
      },
      active: true,
      inactive_reason: null,
    });
  });

  test('session_source_grants enforce source identity, raw scope, chunk/time limits, and sensitivity ceiling', () => {
    const grant = {
      id: 'source-grant-1',
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      max_chunk_count: 2,
      valid_from: '2026-05-20T11:45:00.000Z',
      valid_until: '2026-05-20T12:15:00.000Z',
      sensitivity_ceiling: 'internal',
      revoked_at: null,
    };

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      chunk_count: 2,
      requested_at: now,
      sensitivity_level: 'internal',
    })).toEqual({ allowed: true, denial_reason: null });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-other',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      chunk_count: 1,
      requested_at: now,
      sensitivity_level: 'internal',
    })).toEqual({ allowed: false, denial_reason: 'source_id_mismatch' });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'manual_note',
      raw_scope: 'source_chunk',
      chunk_count: 1,
      requested_at: now,
      sensitivity_level: 'internal',
    })).toEqual({ allowed: false, denial_reason: 'source_kind_mismatch' });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'full_raw_source',
      chunk_count: 1,
      requested_at: now,
      sensitivity_level: 'internal',
    })).toEqual({ allowed: false, denial_reason: 'raw_scope_denied' });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      chunk_count: 3,
      requested_at: now,
      sensitivity_level: 'internal',
    })).toEqual({ allowed: false, denial_reason: 'chunk_limit_exceeded' });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      chunk_count: 1,
      requested_at: new Date('2026-05-20T12:16:00.000Z'),
      sensitivity_level: 'internal',
    })).toEqual({ allowed: false, denial_reason: 'time_window_expired' });

    expect(evaluateSessionSourceGrant(grant, {
      session_id: 'session-codex-1',
      source_id: 'source-abc',
      source_kind: 'codex_session',
      raw_scope: 'source_chunk',
      chunk_count: 1,
      requested_at: now,
      sensitivity_level: 'secret',
    })).toEqual({ allowed: false, denial_reason: 'sensitivity_ceiling_exceeded' });
  });

  test('session_write_grants enforce allowed policy outcomes, expiry, and revocation', () => {
    const grant = {
      id: 'write-grant-1',
      session_id: 'session-codex-1',
      target_scope: 'assertion',
      allowed_policy_outcomes: ['canonical_write_allowed', 'create_candidate'],
      expires_at: '2026-05-20T13:00:00.000Z',
      revocation_state: 'active',
      revoked_at: null,
    };

    expect(evaluateSessionWriteGrant(grant, {
      session_id: 'session-codex-1',
      target_scope: 'assertion',
      policy_outcome: 'canonical_write_allowed',
      requested_at: now,
    })).toEqual({ allowed: true, denial_reason: null });

    expect(evaluateSessionWriteGrant(grant, {
      session_id: 'session-codex-1',
      target_scope: 'projection',
      policy_outcome: 'canonical_write_allowed',
      requested_at: now,
    })).toEqual({ allowed: false, denial_reason: 'target_scope_denied' });

    expect(evaluateSessionWriteGrant(grant, {
      session_id: 'session-codex-1',
      target_scope: 'assertion',
      policy_outcome: 'defer',
      requested_at: now,
    })).toEqual({ allowed: false, denial_reason: 'policy_outcome_denied' });

    expect(evaluateSessionWriteGrant(grant, {
      session_id: 'session-codex-1',
      target_scope: 'assertion',
      policy_outcome: 'canonical_write_allowed',
      requested_at: new Date('2026-05-20T13:00:01.000Z'),
    })).toEqual({ allowed: false, denial_reason: 'grant_expired' });

    expect(evaluateSessionWriteGrant({
      ...grant,
      revocation_state: 'revoked',
      revoked_at: '2026-05-20T12:30:00.000Z',
    }, {
      session_id: 'session-codex-1',
      target_scope: 'assertion',
      policy_outcome: 'canonical_write_allowed',
      requested_at: now,
    })).toEqual({ allowed: false, denial_reason: 'grant_revoked' });
  });
});

describe('Phase 03 task/session assertion links', () => {
  test('generated assertion ids link bidirectionally without mutating previous event history', () => {
    const previousEvents = [
      {
        id: 'event-1',
        session_id: 'session-codex-1',
        task_thread_id: 'task-thread-1',
        event_kind: 'command',
        generated_assertion_ids: ['assertion-existing'],
        history: [{ event_id: 'event-1', assertion_ids: ['assertion-existing'] }],
      },
    ];
    const frozenHistory = structuredClone(previousEvents);

    const result = linkGeneratedAssertionsToTaskEvent({
      events: previousEvents,
      event: {
        id: 'event-2',
        session_id: 'session-codex-1',
        task_thread_id: 'task-thread-1',
        event_kind: 'claim_extraction',
        generated_assertion_ids: [],
        history: [],
      },
      assertions: [
        { id: 'assertion-new-1', origin_session_id: null, origin_task_event_id: null },
        { id: 'assertion-new-2', origin_session_id: null, origin_task_event_id: null },
      ],
    });

    expect(previousEvents).toEqual(frozenHistory);
    expect(result.events).toEqual([
      frozenHistory[0],
      expect.objectContaining({
        id: 'event-2',
        session_id: 'session-codex-1',
        task_thread_id: 'task-thread-1',
        generated_assertion_ids: ['assertion-new-1', 'assertion-new-2'],
      }),
    ]);
    expect(result.assertions).toEqual([
      expect.objectContaining({
        id: 'assertion-new-1',
        origin_session_id: 'session-codex-1',
        origin_task_event_id: 'event-2',
        origin_task_id: 'task-thread-1',
      }),
      expect.objectContaining({
        id: 'assertion-new-2',
        origin_session_id: 'session-codex-1',
        origin_task_event_id: 'event-2',
        origin_task_id: 'task-thread-1',
      }),
    ]);
    expect(result.lineage).toEqual([
      {
        assertion_id: 'assertion-new-1',
        session_id: 'session-codex-1',
        task_event_id: 'event-2',
        task_id: 'task-thread-1',
        link_type: 'generated_from_task_event',
      },
      {
        assertion_id: 'assertion-new-2',
        session_id: 'session-codex-1',
        task_event_id: 'event-2',
        task_id: 'task-thread-1',
        link_type: 'generated_from_task_event',
      },
    ]);
  });
});
