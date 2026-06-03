import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { type OperationContext, OperationError, operationsByName, parseOpArgs } from '../src/core/operations.ts';

function throwingPreviewContext(): OperationContext {
  return {
    engine: new Proxy({}, {
      get(_target, prop) {
        throw new Error(`preview_agent_session_memory must not read engine.${String(prop)}`);
      },
    }) as BrainEngine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

function ctx(engine = {} as BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun,
  };
}

function memoryNoteEvents() {
  return [{
    event_kind: 'explicit_memory_note',
    text: 'Remember that the user prefers concise implementation planning checkpoints.',
    occurred_at: '2026-06-03T01:02:03.000Z',
  }];
}

describe('agent session memory operations', () => {
  test('preview and capture operations are registered with CLI hints and mutability', () => {
    const preview = operationsByName.preview_agent_session_memory;
    const capture = operationsByName.capture_agent_session_memory;

    expect(preview).toBeDefined();
    expect(capture).toBeDefined();
    expect(preview.cliHints?.name).toBe('agent-session-preview');
    expect(capture.cliHints?.name).toBe('agent-session-capture');
    expect(preview.mutating).toBe(false);
    expect(capture.mutating).toBe(true);
    expect(preview.params.apply).toBeUndefined();
    expect(preview.params.dry_run).toBeUndefined();
    expect(capture.params.apply?.type).toBe('boolean');
    expect(capture.params.dry_run?.type).toBe('boolean');
  });

  test('preview returns the full pipeline contract without reading the engine', async () => {
    const result = await operationsByName.preview_agent_session_memory.handler(throwingPreviewContext(), {
      source_kind: 'codex_session',
      session_id: 'session-preview-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      events: memoryNoteEvents(),
      write_mode: 'direct_personal_when_allowed',
      apply: true,
      now: '2026-06-03T01:02:04.000Z',
    }) as any;

    expect(result.applied).toBe(false);
    expect(result.dry_run).toBe(false);
    expect(result.capture.events).toHaveLength(1);
    expect(result.capture.events[0]).toMatchObject({
      source_kind: 'codex_session',
      session_id: 'session-preview-1',
      client_name: 'codex',
      event_kind: 'explicit_memory_note',
      actor: 'user',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
    });
    expect(result.observations).toHaveLength(1);
    expect(result.summary.session_id).toBe('session-preview-1');
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal_kind: 'profile_memory',
        candidate_type: 'profile_update',
        target_object_type: 'profile_memory',
      }),
    ]));
    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: expect.objectContaining({
          decision: 'create_candidate',
          applied: false,
        }),
        direct_write: null,
      }),
    ]));
    expect(result.activation_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_kind: 'memory_candidate',
      }),
    ]));
  });

  test('CLI parser accepts events as a JSON array string', () => {
    const encodedEvents = JSON.stringify(memoryNoteEvents());
    const params = parseOpArgs(operationsByName.capture_agent_session_memory, [
      '--source-kind',
      'codex_session',
      '--session-id',
      'session-cli-1',
      '--events',
      encodedEvents,
      '--apply',
      '--dry-run',
    ]);

    expect(params).toEqual({
      source_kind: 'codex_session',
      session_id: 'session-cli-1',
      events: encodedEvents,
      apply: true,
      dry_run: true,
    });
  });

  test('invalid event payloads throw invalid_params OperationError', async () => {
    await expect(operationsByName.preview_agent_session_memory.handler(ctx(), {
      source_kind: 'codex_session',
      session_id: 'session-invalid-json',
      events: '{not-json',
    })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
    });

    await expect(operationsByName.capture_agent_session_memory.handler(ctx(), {
      source_kind: 'codex_session',
      session_id: 'session-missing-text',
      events: [{ event_kind: 'explicit_memory_note' }],
    })).rejects.toBeInstanceOf(OperationError);

    await expect(operationsByName.capture_agent_session_memory.handler(ctx(), {
      source_kind: 'codex_session',
      session_id: 'session-missing-text',
      events: [{ event_kind: 'explicit_memory_note' }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  test('invalid optional event fields throw invalid_params OperationError', async () => {
    const base = {
      source_kind: 'codex_session',
      session_id: 'session-invalid-field',
    };

    await expect(operationsByName.preview_agent_session_memory.handler(ctx(), {
      ...base,
      events: [{ ...memoryNoteEvents()[0], actor: 'observer' }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(operationsByName.preview_agent_session_memory.handler(ctx(), {
      ...base,
      events: [{ ...memoryNoteEvents()[0], metadata: 'not metadata' }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(operationsByName.preview_agent_session_memory.handler(ctx(), {
      ...base,
      events: [{ ...memoryNoteEvents()[0], event_id: { id: 'event-1' } }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });

    await expect(operationsByName.preview_agent_session_memory.handler(ctx(), {
      ...base,
      events: [{ ...memoryNoteEvents()[0], repo_path: ['src/core/operations.ts'] }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  test('valid event metadata object is preserved in preview capture', async () => {
    const result = await operationsByName.preview_agent_session_memory.handler(throwingPreviewContext(), {
      source_kind: 'codex_session',
      session_id: 'session-metadata',
      events: [{
        ...memoryNoteEvents()[0],
        actor: 'user',
        event_id: 'event-with-metadata',
        client_name: 'codex',
        repo_path: null,
        workspace_id: 'workspace:mbrain',
        metadata: {
          review_id: 'task-8-follow-up',
          finding_count: 2,
        },
      }],
    }) as any;

    expect(result.capture.events[0]).toMatchObject({
      event_id: 'event-with-metadata',
      client_name: 'codex',
      repo_path: null,
      workspace_id: 'workspace:mbrain',
      metadata: {
        review_id: 'task-8-follow-up',
        finding_count: 2,
      },
    });
  });

  test('preview response does not echo raw secret-bearing session text', async () => {
    const rawSecret = 'sk-testsecret123456';
    const result = await operationsByName.preview_agent_session_memory.handler(throwingPreviewContext(), {
      source_kind: 'codex_session',
      session_id: 'session-secret-response',
      events: [{
        event_kind: 'explicit_memory_note',
        text: `Remember that the user prefers concise plans and pasted ${rawSecret}.`,
        occurred_at: '2026-06-03T01:02:03.000Z',
      }],
    }) as any;

    const encoded = JSON.stringify(result);
    expect(result.capture.safety.secret_risk).toBe('flagged');
    expect(encoded).not.toContain(rawSecret);
    expect(result.capture.events[0].text).toContain('[REDACTED:openai_api_key]');
    expect(result.capture.ingest_plan.chunks[0].chunk_text).toBe(result.capture.ingest_plan.chunks[0].redacted_text);
  });
});
