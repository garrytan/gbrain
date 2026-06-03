import { describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function withEngine<T>(
  run: (engine: SQLiteEngine, ctx: OperationContext) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mbrain-agent-session-memory-sqlite-'));
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: console,
      dryRun: false,
    };

    return await run(engine, ctx);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function memoryNoteEvent(text: string) {
  return {
    event_kind: 'explicit_memory_note',
    text,
    occurred_at: '2026-06-03T01:02:03.000Z',
  };
}

async function captureAgentSessionMemory(
  ctx: OperationContext,
  params: Record<string, unknown>,
) {
  return operationsByName.capture_agent_session_memory.handler(ctx, {
    source_kind: 'codex_session',
    session_id: 'session-sqlite-memory',
    client_name: 'codex',
    repo_path: '/Users/meghendra/Work/mbrain',
    workspace_id: 'workspace:mbrain',
    now: '2026-06-03T01:02:04.000Z',
    ...params,
  }) as Promise<any>;
}

describe('agent session memory SQLite operation pipeline', () => {
  test('candidate-only capture creates a profile memory candidate in Memory Inbox', async () => {
    await withEngine(async (engine, ctx) => {
      const preference = 'The user prefers concise implementation planning checkpoints.';
      const result = await captureAgentSessionMemory(ctx, {
        events: [memoryNoteEvent(`Remember that ${preference}`)],
        write_mode: 'candidate_only',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.routes[0].direct_write).toBeNull();
      expect(result.routes[0].route?.created_candidate).toBeDefined();
      expect(result.routes[0].route?.created_candidate).toMatchObject({
        candidate_type: 'profile_update',
        target_object_type: 'profile_memory',
      });

      const candidates = await engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        target_object_type: 'profile_memory',
        limit: 10,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        candidate_type: 'profile_update',
        target_object_type: 'profile_memory',
        proposed_content: expect.stringContaining(preference),
      });

      const sourceItems = await operationsByName.list_source_items.handler(ctx, {
        source_id: result.capture.source_id,
        include_chunks: true,
      }) as any;
      expect(sourceItems.items).toHaveLength(1);
      expect(sourceItems.items[0]).toMatchObject({
        external_id: 'codex_session:session-sqlite-memory',
        origin_event: 'session_capture',
        chunks: [expect.objectContaining({
          id: result.capture.ingest_plan.chunks[0].id,
          redacted_text: expect.stringContaining(preference),
        })],
      });

      const entries = await engine.listProfileMemoryEntries({
        scope_id: 'personal:default',
        limit: 10,
      });
      expect(entries).toHaveLength(0);
    });
  });

  test('direct personal write mode writes explicit profile memory after preflight', async () => {
    await withEngine(async (engine, ctx) => {
      const preference = 'The user prefers concise implementation planning checkpoints.';
      const result = await captureAgentSessionMemory(ctx, {
        events: [memoryNoteEvent(`Remember that ${preference}`)],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
      });

      expect(result.routes[0].direct_write?.kind).toBe('profile_memory');

      const entries = await engine.listProfileMemoryEntries({
        scope_id: 'personal:default',
        subject: 'implementation planning',
        limit: 10,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        subject: 'implementation planning',
        content: expect.stringContaining(preference),
        sensitivity: 'personal',
        export_status: 'private_only',
      });
    });
  });

  test('assistant-authored preference text does not direct-write profile memory', async () => {
    await withEngine(async (engine, ctx) => {
      const preference = 'The user prefers concise implementation planning checkpoints.';
      const result = await captureAgentSessionMemory(ctx, {
        events: [{
          event_kind: 'assistant_response',
          actor: 'assistant',
          text: preference,
          occurred_at: '2026-06-03T01:02:03.000Z',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
      });

      expect(result.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          signal_kind: 'profile_memory',
          evidence_kind: 'agent_inferred',
        }),
      ]));
      expect(result.routes.every((route: any) => route.direct_write === null)).toBe(true);

      const entries = await engine.listProfileMemoryEntries({
        scope_id: 'personal:default',
        subject: 'implementation planning',
        limit: 10,
      });
      expect(entries).toHaveLength(0);

      const episodes = await engine.listPersonalEpisodeEntries({
        scope_id: 'personal:default',
        limit: 10,
      });
      expect(episodes).toHaveLength(0);

      const candidates = await engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        target_object_type: 'profile_memory',
        limit: 10,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].proposed_content).toContain(preference);
    });
  });

  test('secret-bearing signals do not direct-write personal memory', async () => {
    await withEngine(async (engine, ctx) => {
      const result = await captureAgentSessionMemory(ctx, {
        events: [memoryNoteEvent(
          'Remember that the user prefers concise implementation planning checkpoints and has token sk-testsecret123456.',
        )],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
      });

      expect(result.capture.safety.secret_risk).toBe('flagged');
      expect(result.routes.length).toBeGreaterThan(0);
      expect(result.routes.every((route: any) => route.direct_write === null)).toBe(true);

      const candidates = await engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        target_object_type: 'profile_memory',
        limit: 10,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        candidate_type: 'profile_update',
        sensitivity: 'secret',
        target_object_type: 'profile_memory',
      });

      const entries = await engine.listProfileMemoryEntries({
        scope_id: 'personal:default',
        limit: 10,
      });
      expect(entries).toHaveLength(0);
    });
  });
});
