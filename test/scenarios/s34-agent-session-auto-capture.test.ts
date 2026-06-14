/**
 * Scenario S34 - agent-session auto capture.
 *
 * Captured agent sessions become source-backed raw ingest records and activation
 * artifacts without echoing raw secrets back through the operation response.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import {
  readSourceItemByExternalId,
  readSourceItemChunks,
} from '../../src/core/source-registry/raw-ingest-store.ts';
import { allocateSqliteBrain } from './helpers.ts';

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

describe('S34 - agent-session auto capture', () => {
  test('persists redacted session capture as raw ingest and returns activation artifacts', async () => {
    const handle = await allocateSqliteBrain('s34-auto-capture');
    const rawSecret = 'sk-scenariosecret123456789';
    try {
      const ctx = opContext(handle.engine);

      const result = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 's34-session',
        client_name: 'codex',
        repo_path: '/Users/meghendra/Work/mbrain',
        workspace_id: 'workspace:mbrain',
        events: [{
          event_kind: 'explicit_memory_note',
          text: `Remember that the user prefers concise scenario checkpoints and pasted ${rawSecret}.`,
          occurred_at: '2026-06-05T01:00:00.000Z',
        }],
        write_mode: 'candidate_only',
        apply: true,
        now: '2026-06-05T01:00:01.000Z',
      }) as any;

      expect(result.applied).toBe(true);
      expect(result.capture.safety.secret_risk).toBe('flagged');
      expect(result.activation_artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifact_kind: 'memory_candidate' }),
      ]));
      expect(JSON.stringify(result)).not.toContain(rawSecret);

      const item = await readSourceItemByExternalId(
        handle.engine,
        result.capture.source_id,
        'codex_session:s34-session',
      );
      expect(item).toMatchObject({
        source_id: result.capture.source_id,
        origin_event: 'session_capture',
        locator: 'codex_session://s34-session',
        title: 'Agent session s34-session',
        ingest_status: 'ready',
        metadata_json: expect.objectContaining({
          session_id: 's34-session',
          client_name: 'codex',
          workspace_id: 'workspace:mbrain',
        }),
      });

      const chunks = await readSourceItemChunks(handle.engine, item!.id);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        parser_version: 'agent-session:v1',
        extractor_version: 'agent-session-memory:v1',
        prompt_injection_risk: 'none',
        secret_risk: 'redacted',
      });
      expect(chunks[0]?.redacted_text).toContain('[REDACTED:openai_api_key]');
      expect(chunks[0]?.redacted_text).not.toContain(rawSecret);

      const secretRows = (handle.engine as any).database.query(`
        SELECT source_item_id, source_chunk_id, secret_type, redaction_status, purge_plan_status
        FROM secret_detections
        WHERE source_item_id = ?
      `).all(item!.id);
      expect(secretRows).toEqual([
        expect.objectContaining({
          source_item_id: item!.id,
          source_chunk_id: chunks[0]?.id,
          secret_type: 'openai_api_key',
          redaction_status: 'redacted',
          purge_plan_status: 'pending',
        }),
      ]);
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S34 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf-8');
    expect(readme).toContain('| S34 | `s34-agent-session-auto-capture.test.ts` | G1, L6, L7 | ✅ green |');
  });
});
