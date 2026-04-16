import { afterEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { initActionSchema } from '../../src/action-brain/action-schema.ts';
import { ActionEngine, ActionTransitionError } from '../../src/action-brain/action-engine.ts';

let db: PGlite | null = null;

afterEach(async () => {
  if (db) {
    await db.close();
    db = null;
  }
});

async function createEngine(): Promise<{ db: PGlite; engine: ActionEngine }> {
  db = await PGlite.create();
  await initActionSchema(db);
  return { db, engine: new ActionEngine(db) };
}

describe('ActionEngine', () => {
  test('createItem inserts a new action and writes created history', async () => {
    const { db: localDb, engine } = await createEngine();

    const item = await engine.createItem(
      {
        title: 'Follow up shipment ETA with Mukesh',
        type: 'follow_up',
        source_message_id: 'msg-create-001',
        owner: 'abhi',
        source_contact: 'Mukesh',
      },
      { actor: 'extractor' }
    );

    expect(item.id).toBeGreaterThan(0);
    expect(item.status).toBe('open');
    expect(item.owner).toBe('abhi');
    expect(item.source_message_id).toBe('msg-create-001');

    const history = await localDb.query(
      `SELECT event_type, actor
       FROM action_history
       WHERE item_id = $1
       ORDER BY id`,
      [item.id]
    );

    expect(history.rows.length).toBe(1);
    expect((history.rows[0] as { event_type: string }).event_type).toBe('created');
    expect((history.rows[0] as { actor: string }).actor).toBe('extractor');
  });

  test('createItem is idempotent on source_message_id and does not duplicate history', async () => {
    const { db: localDb, engine } = await createEngine();

    const first = await engine.createItem({
      title: 'Send contract draft',
      type: 'commitment',
      source_message_id: 'msg-idempotent-001',
    });

    const second = await engine.createItem({
      title: 'Different title should not overwrite',
      type: 'commitment',
      source_message_id: 'msg-idempotent-001',
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title);

    const counts = await localDb.query(
      `SELECT
         (SELECT count(*)::int FROM action_items WHERE source_message_id = $1) AS item_count,
         (SELECT count(*)::int FROM action_history WHERE item_id = $2) AS history_count`,
      ['msg-idempotent-001', first.id]
    );

    const row = counts.rows[0] as { item_count: number | string; history_count: number | string };
    expect(Number(row.item_count)).toBe(1);
    expect(Number(row.history_count)).toBe(1);
  });

  test('getItem fetches by id and returns null when missing', async () => {
    const { engine } = await createEngine();

    const created = await engine.createItem({
      title: 'Review LC terms',
      type: 'decision',
      source_message_id: 'msg-get-001',
    });

    const fetched = await engine.getItem(created.id);
    const missing = await engine.getItem(999_999);

    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('Review LC terms');
    expect(missing).toBeNull();
  });

  test('updateItemStatus updates lifecycle and appends exactly one history event', async () => {
    const { db: localDb, engine } = await createEngine();

    const created = await engine.createItem({
      title: 'Confirm assay report',
      type: 'follow_up',
      source_message_id: 'msg-status-001',
    });

    const updated = await engine.updateItemStatus(created.id, 'waiting_on', {
      actor: 'reconciler',
      metadata: { reason: 'awaiting reply from lab' },
    });

    expect(updated.status).toBe('waiting_on');
    expect(updated.resolved_at).toBeNull();

    const history = await localDb.query(
      `SELECT event_type
       FROM action_history
       WHERE item_id = $1
       ORDER BY id`,
      [created.id]
    );

    expect(history.rows.length).toBe(2);
    expect((history.rows[1] as { event_type: string }).event_type).toBe('status_change');
  });

  test('rejects invalid transition from resolved to in_progress', async () => {
    const { db: localDb, engine } = await createEngine();

    const created = await engine.createItem({
      title: 'Finalize shipping invoice',
      type: 'commitment',
      source_message_id: 'msg-invalid-transition-001',
    });

    await engine.resolveItem(created.id, { actor: 'ops' });

    await expect(engine.updateItemStatus(created.id, 'in_progress', { actor: 'ops' })).rejects.toBeInstanceOf(
      ActionTransitionError
    );

    const historyCount = await localDb.query(
      `SELECT count(*)::int AS n
       FROM action_history
       WHERE item_id = $1`,
      [created.id]
    );

    expect(Number((historyCount.rows[0] as { n: number | string }).n)).toBe(2);
  });

  test('resolveItem sets resolved status, resolved_at, and resolved history entry', async () => {
    const { db: localDb, engine } = await createEngine();

    const created = await engine.createItem({
      title: 'Send rail schedule update',
      type: 'commitment',
      source_message_id: 'msg-resolve-001',
    });

    const resolved = await engine.resolveItem(created.id, { actor: 'system-resolver' });

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();

    const latestHistory = await localDb.query(
      `SELECT event_type, actor
       FROM action_history
       WHERE item_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [created.id]
    );

    expect((latestHistory.rows[0] as { event_type: string }).event_type).toBe('resolved');
    expect((latestHistory.rows[0] as { actor: string }).actor).toBe('system-resolver');
  });

  test('listItems filters by status, owner, and staleness', async () => {
    const { db: localDb, engine } = await createEngine();

    const staleCandidate = await engine.createItem({
      title: 'Escalate port clearance delay',
      type: 'follow_up',
      source_message_id: 'msg-list-001',
      owner: 'abhi',
      stale_after_hours: 24,
    });

    const waitingOn = await engine.createItem({
      title: 'Waiting on Joe for yard photos',
      type: 'follow_up',
      source_message_id: 'msg-list-002',
      owner: 'abhi',
    });

    const someoneElse = await engine.createItem({
      title: 'Nichol to approve payout',
      type: 'delegation',
      source_message_id: 'msg-list-003',
      owner: 'nichol',
    });

    const staleByStatus = await engine.createItem({
      title: 'Freshly marked stale item',
      type: 'follow_up',
      source_message_id: 'msg-list-004',
      owner: 'abhi',
    });

    await engine.updateItemStatus(waitingOn.id, 'waiting_on', { actor: 'reconciler' });
    await engine.updateItemStatus(staleByStatus.id, 'stale', { actor: 'reconciler' });
    await localDb.query(
      `UPDATE action_items
       SET updated_at = now() - interval '72 hours'
       WHERE id = $1`,
      [staleCandidate.id]
    );

    const ownedByAbhi = await engine.listItems({ owner: 'abhi' });
    const waiting = await engine.listItems({ status: 'waiting_on' });
    const stale = await engine.listItems({ stale: true });

    const ownedIds = new Set(ownedByAbhi.map((item) => item.id));
    expect(ownedIds.has(staleCandidate.id)).toBe(true);
    expect(ownedIds.has(waitingOn.id)).toBe(true);
    expect(ownedIds.has(someoneElse.id)).toBe(false);

    expect(waiting.map((item) => item.id)).toEqual([waitingOn.id]);
    expect(stale.map((item) => item.id)).toEqual([staleByStatus.id, staleCandidate.id]);

    const nonStale = await engine.listItems({ stale: false });
    const nonStaleIds = new Set(nonStale.map((item) => item.id));
    expect(nonStaleIds.has(staleByStatus.id)).toBe(false);
  });
});
