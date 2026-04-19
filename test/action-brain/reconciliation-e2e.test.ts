import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectWacliMessages, readWacliCollectorCheckpoint, type WacliListMessagesRunner } from '../../src/action-brain/collector.ts';
import { actionBrainOperations } from '../../src/action-brain/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { Operation, OperationContext } from '../../src/core/operations.ts';

interface EngineWithDb {
  db: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
}

const CHECKPOINT_CURSOR = '2026-04-16T09:10:00.000Z';

const THREAD_48H_FIXTURE = [
  {
    MsgID: 'm1',
    Timestamp: '2026-04-16T09:00:00.000Z',
    ChatName: 'Ops Thread',
    SenderName: 'Joe',
    FromMe: false,
    Text: 'I will send the signed assay report by noon.',
  },
  {
    MsgID: 'm2',
    Timestamp: '2026-04-16T09:05:00.000Z',
    ChatName: 'Ops Thread',
    SenderName: 'Mukesh',
    FromMe: false,
    Text: 'I will share the weighbridge receipt in 30 minutes.',
  },
  {
    MsgID: 'm3',
    Timestamp: CHECKPOINT_CURSOR,
    ChatName: 'Ops Thread',
    SenderName: 'Joe',
    FromMe: false,
    Text: 'Noted. Still working on the report.',
  },
  {
    MsgID: 'm4',
    Timestamp: CHECKPOINT_CURSOR,
    ChatName: 'Ops Thread',
    SenderName: 'Joe',
    FromMe: false,
    Text: 'Also confirming I saw your reminder.',
  },
  {
    MsgID: 'm5',
    Timestamp: '2026-04-18T09:10:00.000Z',
    ChatName: 'Ops Thread',
    SenderName: 'Mukesh',
    FromMe: false,
    Text: 'I will book the vessel inspection slot for Monday.',
  },
] as const;

function getActionOperation(name: string): Operation {
  const operation = actionBrainOperations.find((op) => op.name === name);
  if (!operation) {
    throw new Error(`Missing action operation: ${name}`);
  }
  return operation;
}

describe('Action Brain reconciliation 48h e2e', () => {
  let engine: PGLiteEngine;
  let ctx: OperationContext;
  let actionIngest: Operation;
  let db: EngineWithDb['db'];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as any);

    ctx = {
      engine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
    };

    actionIngest = getActionOperation('action_ingest');

    await getActionOperation('action_list').handler(ctx, {});
    db = (engine as unknown as EngineWithDb).db;
  });

  beforeEach(async () => {
    await db.query('TRUNCATE action_history, action_items RESTART IDENTITY');
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('reconciles a 5-message 48h thread without duplicates or phantom commitments', async () => {
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'gbrain-action-reconcile-'));
    const checkpointPath = join(checkpointRoot, 'wacli-checkpoint.json');

    const fixtureById = new Map(THREAD_48H_FIXTURE.map((message) => [message.MsgID, message]));
    let sameCursorCallCount = 0;

    const runner: WacliListMessagesRunner = async (request) => {
      let ids: string[];
      if (request.after === null) {
        ids = ['m1', 'm2', 'm3'];
      } else if (request.after === CHECKPOINT_CURSOR) {
        sameCursorCallCount += 1;
        ids = sameCursorCallCount === 1 ? ['m3', 'm4'] : ['m3', 'm4', 'm5'];
      } else {
        throw new Error(`unexpected cursor: ${String(request.after)}`);
      }

      return {
        success: true,
        data: {
          messages: ids.map((id) => fixtureById.get(id)),
        },
        error: null,
      };
    };

    try {
      const firstPoll = await collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-16T09:30:00.000Z'),
        runner,
      });

      expect(firstPoll.messages.map((message) => message.MsgID)).toEqual(['m1', 'm2', 'm3']);

      await actionIngest.handler(ctx, {
        messages: firstPoll.messages,
        commitments: [
          {
            who: 'Joe',
            owes_what: 'Send signed assay report',
            to_whom: 'Abhi',
            by_when: null,
            confidence: 0.92,
            type: 'commitment',
            source_message_id: 'm1',
          },
          {
            who: 'Mukesh',
            owes_what: 'Share weighbridge receipt',
            to_whom: 'Abhi',
            by_when: null,
            confidence: 0.93,
            type: 'follow_up',
            source_message_id: 'm2',
          },
        ],
      });

      const secondPoll = await collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-16T10:00:00.000Z'),
        runner,
      });

      expect(secondPoll.messages.map((message) => message.MsgID)).toEqual(['m4']);

      const checkpointAfterSecondPoll = await readWacliCollectorCheckpoint(checkpointPath);
      expect(checkpointAfterSecondPoll.stores.personal?.after).toBe(CHECKPOINT_CURSOR);
      expect(checkpointAfterSecondPoll.stores.personal?.message_ids_at_after).toEqual(['m3', 'm4']);

      const thirdPoll = await collectWacliMessages({
        checkpointPath,
        stores: [{ key: 'personal', storePath: '/stores/personal' }],
        now: new Date('2026-04-18T09:30:00.000Z'),
        runner,
      });

      expect(thirdPoll.messages.map((message) => message.MsgID)).toEqual(['m5']);

      const thirdPollCommitments = [
        {
          who: 'Mukesh',
          owes_what: 'Book vessel inspection slot',
          to_whom: 'Abhi',
          by_when: null,
          confidence: 0.91,
          type: 'commitment',
          source_message_id: 'm5',
        },
      ];

      await actionIngest.handler(ctx, {
        messages: thirdPoll.messages,
        commitments: thirdPollCommitments,
      });

      // Replay the same extraction output (e.g., retry) to ensure idempotent dedup.
      await actionIngest.handler(ctx, {
        messages: thirdPoll.messages,
        commitments: thirdPollCommitments,
      });

      const rows = await db.query(
        `SELECT title, source_message_id
         FROM action_items
         ORDER BY title`
      );

      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.map((row) => row.title)).toEqual([
        'Book vessel inspection slot',
        'Send signed assay report',
        'Share weighbridge receipt',
      ]);
      expect(rows.rows.every((row) => typeof row.source_message_id === 'string' && row.source_message_id.includes(':ab:'))).toBe(true);
    } finally {
      await rm(checkpointRoot, { recursive: true, force: true });
    }
  });
});
