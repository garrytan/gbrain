import { afterEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { initActionSchema } from '../../src/action-brain/action-schema.ts';

let db: PGlite | null = null;

afterEach(async () => {
  if (db) {
    await db.close();
    db = null;
  }
});

async function createDb(): Promise<PGlite> {
  db = await PGlite.create();
  return db;
}

describe('Action Brain schema', () => {
  test('creates action_items, action_history, action_drafts, and action_drops with required columns', async () => {
    const localDb = await createDb();

    await initActionSchema(localDb);

    const actionItemsCols = await localDb.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'action_items'`
    );

    const actionHistoryCols = await localDb.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'action_history'`
    );
    const actionDropsCols = await localDb.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'action_drops'`
    );
    const actionDraftCols = await localDb.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'action_drafts'`
    );

    const itemColumns = new Set((actionItemsCols.rows as { column_name: string }[]).map((r) => r.column_name));
    const historyColumns = new Set((actionHistoryCols.rows as { column_name: string }[]).map((r) => r.column_name));
    const dropColumns = new Set((actionDropsCols.rows as { column_name: string }[]).map((r) => r.column_name));
    const draftColumns = new Set((actionDraftCols.rows as { column_name: string }[]).map((r) => r.column_name));

    const requiredItemColumns = [
      'id',
      'title',
      'type',
      'status',
      'owner',
      'waiting_on',
      'due_at',
      'stale_after_hours',
      'priority_score',
      'confidence',
      'source_message_id',
      'source_thread',
      'source_contact',
      'linked_entity_slugs',
      'created_at',
      'updated_at',
      'resolved_at',
    ];

    const requiredHistoryColumns = ['id', 'item_id', 'event_type', 'timestamp', 'actor', 'metadata'];
    const requiredDropColumns = [
      'id',
      'run_id',
      'source_id',
      'source_excerpt',
      'drop_reason',
      'confidence',
      'extractor_version',
      'model',
      'created_at',
    ];
    const requiredDraftColumns = [
      'id',
      'action_item_id',
      'version',
      'status',
      'channel',
      'recipient',
      'draft_text',
      'model',
      'context_hash',
      'context_snapshot',
      'generated_at',
      'approved_at',
      'sent_at',
      'send_error',
    ];

    for (const col of requiredItemColumns) {
      expect(itemColumns.has(col)).toBe(true);
    }

    for (const col of requiredHistoryColumns) {
      expect(historyColumns.has(col)).toBe(true);
    }

    for (const col of requiredDropColumns) {
      expect(dropColumns.has(col)).toBe(true);
    }

    for (const col of requiredDraftColumns) {
      expect(draftColumns.has(col)).toBe(true);
    }

    const inserted = await localDb.query(
      `INSERT INTO action_items (title, type, source_message_id)
       VALUES ('Follow up on shipment ETA', 'follow_up', 'msg-001')
       RETURNING status, stale_after_hours`
    );

    const row = inserted.rows[0] as { status: string; stale_after_hours: number };
    expect(row.status).toBe('open');
    expect(row.stale_after_hours).toBe(48);
  });

  test('is idempotent when initActionSchema is run twice', async () => {
    const localDb = await createDb();

    await initActionSchema(localDb);
    await localDb.query(
      `INSERT INTO action_items (title, type, source_message_id)
       VALUES ('Confirm LC documents', 'commitment', 'msg-002')`
    );

    const before = await localDb.query(
      `SELECT count(*)::int AS n
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('action_items', 'action_history', 'action_drafts', 'action_drops')`
    );

    await initActionSchema(localDb);

    const after = await localDb.query(
      `SELECT count(*)::int AS n
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('action_items', 'action_history', 'action_drafts', 'action_drops')`
    );

    const rows = await localDb.query(`SELECT count(*)::int AS n FROM action_items`);

    const beforeCount = Number((before.rows[0] as { n: number | string }).n);
    const afterCount = Number((after.rows[0] as { n: number | string }).n);
    const rowCount = Number((rows.rows[0] as { n: number | string }).n);

    expect(afterCount).toBe(beforeCount);
    expect(rowCount).toBe(1);
  });
});
