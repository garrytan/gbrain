import { afterEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { initActionSchema } from '../../src/action-brain/action-schema.ts';
import { MorningBriefGenerator } from '../../src/action-brain/brief.ts';

type ActionStatus = 'open' | 'waiting_on' | 'in_progress' | 'stale' | 'resolved' | 'dropped';
type ActionType = 'commitment' | 'follow_up' | 'decision' | 'question' | 'delegation';

let db: PGlite | null = null;

afterEach(async () => {
  if (db) {
    await db.close();
    db = null;
  }
});

async function createGenerator(): Promise<{ db: PGlite; generator: MorningBriefGenerator }> {
  db = await PGlite.create();
  await initActionSchema(db);
  return { db, generator: new MorningBriefGenerator(db) };
}

interface InsertItemInput {
  title: string;
  source_message_id: string;
  status?: ActionStatus;
  type?: ActionType;
  owner?: string;
  waiting_on?: string | null;
  due_at?: string | null;
  stale_after_hours?: number;
  priority_score?: number;
  confidence?: number;
  created_at?: string;
  updated_at?: string;
}

async function insertItem(localDb: PGlite, input: InsertItemInput): Promise<number> {
  const result = await localDb.query(
    `INSERT INTO action_items (
       title,
       type,
       status,
       owner,
       waiting_on,
       due_at,
       stale_after_hours,
       priority_score,
       confidence,
       source_message_id,
       source_thread,
       source_contact,
       linked_entity_slugs,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '', '', '{}', $11, $12)
     RETURNING id`,
    [
      input.title,
      input.type ?? 'commitment',
      input.status ?? 'open',
      input.owner ?? 'abhi',
      input.waiting_on ?? null,
      input.due_at ?? null,
      input.stale_after_hours ?? 48,
      input.priority_score ?? 0,
      input.confidence ?? 0.8,
      input.source_message_id,
      input.created_at ?? '2026-04-10T00:00:00.000Z',
      input.updated_at ?? '2026-04-10T00:00:00.000Z',
    ]
  );

  return Number((result.rows[0] as { id: number | string }).id);
}

interface InsertDraftInput {
  action_item_id: number;
  status?: 'pending' | 'approved' | 'rejected' | 'sent' | 'send_failed' | 'superseded';
  version?: number;
  recipient?: string;
  draft_text?: string;
  send_error?: string | null;
}

async function insertDraft(localDb: PGlite, input: InsertDraftInput): Promise<number> {
  const result = await localDb.query(
    `INSERT INTO action_drafts (
       action_item_id,
       version,
       status,
       channel,
       recipient,
       draft_text,
       model,
       context_hash,
       context_snapshot,
       send_error
     )
     VALUES ($1, $2, $3, 'whatsapp', $4, $5, 'gpt-5.2', 'hash', '{}'::jsonb, $6)
     RETURNING id`,
    [
      input.action_item_id,
      input.version ?? 1,
      input.status ?? 'pending',
      input.recipient ?? 'whatsapp:+15551234567',
      input.draft_text ?? 'Ping for status update.',
      input.send_error ?? null,
    ]
  );

  return Number((result.rows[0] as { id: number | string }).id);
}

function sectionItemLines(brief: string, sectionTitle: string): string[] {
  const lines = brief.split('\n');
  const sectionIndex = lines.findIndex((line) => line.startsWith(`## ${sectionTitle} (`));

  if (sectionIndex === -1) {
    throw new Error(`Section not found: ${sectionTitle}`);
  }

  const rows: string[] = [];
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      break;
    }
    if (line.startsWith('- [#')) {
      rows.push(line);
    }
  }

  return rows;
}

describe('MorningBriefGenerator', () => {
  test('#15 renders required sections with deterministic ordering', async () => {
    const { db: localDb, generator } = await createGenerator();
    const now = new Date('2026-04-16T12:00:00.000Z');

    const overdue1 = await insertItem(localDb, {
      title: 'Overdue first',
      source_message_id: 'brief-001',
      due_at: '2026-04-16T09:00:00.000Z',
      created_at: '2026-04-12T09:00:00.000Z',
      updated_at: '2026-04-16T09:00:00.000Z',
      priority_score: 20,
    });

    const overdue2 = await insertItem(localDb, {
      title: 'Overdue second',
      source_message_id: 'brief-002',
      due_at: '2026-04-16T11:00:00.000Z',
      created_at: '2026-04-12T11:00:00.000Z',
      updated_at: '2026-04-16T11:00:00.000Z',
      priority_score: 10,
    });

    const dueToday1 = await insertItem(localDb, {
      title: 'Due today first',
      source_message_id: 'brief-003',
      due_at: '2026-04-16T13:00:00.000Z',
      created_at: '2026-04-12T13:00:00.000Z',
      updated_at: '2026-04-16T12:30:00.000Z',
      priority_score: 8,
    });

    const dueToday2 = await insertItem(localDb, {
      title: 'Due today second',
      source_message_id: 'brief-004',
      due_at: '2026-04-16T18:00:00.000Z',
      created_at: '2026-04-12T18:00:00.000Z',
      updated_at: '2026-04-16T12:35:00.000Z',
      priority_score: 7,
    });

    const newlyCreated = await insertItem(localDb, {
      title: 'Newly created item',
      source_message_id: 'brief-005',
      due_at: null,
      created_at: '2026-04-16T10:30:00.000Z',
      updated_at: '2026-04-16T10:30:00.000Z',
      priority_score: 3,
    });

    const stale = await insertItem(localDb, {
      title: 'Stale follow-up',
      source_message_id: 'brief-006',
      due_at: null,
      created_at: '2026-04-10T12:00:00.000Z',
      updated_at: '2026-04-13T10:00:00.000Z',
      stale_after_hours: 24,
      priority_score: 30,
    });

    const brief = await generator.generateMorningBrief({
      now,
      lastSyncAt: new Date('2026-04-16T11:45:00.000Z'),
    });

    expect(brief).toContain('## Overdue items (2)');
    expect(brief).toContain('## Due today (2)');
    expect(brief).toContain('## Newly created (last 24h) (1)');
    expect(brief).toContain('## Gone stale (1)');

    const overdueLines = sectionItemLines(brief, 'Overdue items');
    expect(overdueLines.map((line) => Number(line.match(/^\- \[#(\d+)\]/)?.[1] ?? -1))).toEqual([overdue1, overdue2]);

    const dueTodayLines = sectionItemLines(brief, 'Due today');
    expect(dueTodayLines.map((line) => Number(line.match(/^\- \[#(\d+)\]/)?.[1] ?? -1))).toEqual([dueToday1, dueToday2]);

    const newlyCreatedLines = sectionItemLines(brief, 'Newly created (last 24h)');
    expect(newlyCreatedLines.map((line) => Number(line.match(/^\- \[#(\d+)\]/)?.[1] ?? -1))).toEqual([newlyCreated]);

    const staleLines = sectionItemLines(brief, 'Gone stale');
    expect(staleLines.map((line) => Number(line.match(/^\- \[#(\d+)\]/)?.[1] ?? -1))).toEqual([stale]);
  });

  test('#16 adds degraded warning when last sync is older than 24h', async () => {
    const { db: localDb, generator } = await createGenerator();

    await insertItem(localDb, {
      title: 'One active item',
      source_message_id: 'brief-016',
      due_at: '2026-04-17T12:00:00.000Z',
      created_at: '2026-04-15T12:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-15T11:00:00.000Z'),
    });

    expect(brief).toContain('wacli freshness: last sync 2026-04-15T11:00:00.000Z (25.0h ago)');
    expect(brief).toContain('WARNING: ingestion degraded (>24h since last wacli sync).');
  });

  test('#17 keeps freshness header without warning when sync is recent', async () => {
    const { db: localDb, generator } = await createGenerator();

    await insertItem(localDb, {
      title: 'One active item',
      source_message_id: 'brief-017',
      due_at: '2026-04-17T12:00:00.000Z',
      created_at: '2026-04-15T12:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-15T13:30:00.000Z'),
    });

    expect(brief).toContain('wacli freshness: last sync 2026-04-15T13:30:00.000Z (22.5h ago)');
    expect(brief).not.toContain('WARNING: ingestion degraded (>24h since last wacli sync).');
  });

  test('#18 swallows context enrichment errors and still renders the brief', async () => {
    const { db: localDb, generator } = await createGenerator();

    const id = await insertItem(localDb, {
      title: 'Item with optional context',
      source_message_id: 'brief-018',
      due_at: '2026-04-17T12:00:00.000Z',
      created_at: '2026-04-16T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-16T11:30:00.000Z'),
      contextEnricher: () => {
        throw new Error('gbrain unavailable');
      },
    });

    expect(brief).toContain(`- [#${id}] Item with optional context`);
    expect(brief).not.toContain('context=');
  });

  test('uses operator timezone offset when classifying due-today boundaries', async () => {
    const { db: localDb, generator } = await createGenerator();

    const boundaryItemId = await insertItem(localDb, {
      title: 'Timezone boundary item',
      source_message_id: 'brief-tz-001',
      due_at: '2026-04-16T16:30:00.000Z',
      created_at: '2026-04-16T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
      priority_score: 10,
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T15:30:00.000Z'),
      lastSyncAt: new Date('2026-04-16T14:00:00.000Z'),
      timezoneOffsetMinutes: 480,
    });

    expect(brief).toContain('## Due today (0)');
    expect(sectionItemLines(brief, 'Due today').length).toBe(0);
    expect(brief).toContain(`- [#${boundaryItemId}] Timezone boundary item`);
  });

  test('renders inline pending drafts only for items that appear in brief sections', async () => {
    const { db: localDb, generator } = await createGenerator();
    const now = new Date('2026-04-16T12:00:00.000Z');

    const eligibleItemId = await insertItem(localDb, {
      title: 'Eligible due-today item',
      source_message_id: 'brief-1061-eligible',
      due_at: '2026-04-16T18:00:00.000Z',
      created_at: '2026-04-14T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });
    const ineligibleItemId = await insertItem(localDb, {
      title: 'Ineligible non-section item',
      source_message_id: 'brief-1061-ineligible',
      due_at: null,
      created_at: '2026-04-10T10:00:00.000Z',
      updated_at: '2026-04-16T11:59:00.000Z',
      stale_after_hours: 48,
    });

    const eligibleDraftId = await insertDraft(localDb, {
      action_item_id: eligibleItemId,
      status: 'pending',
      draft_text: 'Following up quickly on this.',
    });
    const ineligibleDraftId = await insertDraft(localDb, {
      action_item_id: ineligibleItemId,
      status: 'pending',
      draft_text: 'This should not render inline because the item is not in any section.',
    });

    const brief = await generator.generateMorningBrief({
      now,
      lastSyncAt: new Date('2026-04-16T11:50:00.000Z'),
    });

    expect(brief).toContain(`draft[#${eligibleDraftId} v1] pending`);
    expect(brief).toContain(`approve=gbrain action draft approve ${eligibleDraftId}`);
    expect(brief).not.toContain(`draft[#${ineligibleDraftId} v1] pending`);
  });

  test('shows send failures section only when send_failed drafts exist', async () => {
    const { db: localDb, generator } = await createGenerator();
    const now = new Date('2026-04-16T12:00:00.000Z');

    const itemId = await insertItem(localDb, {
      title: 'Waiting on reply from broker',
      source_message_id: 'brief-1061-send-failed',
      due_at: '2026-04-16T17:00:00.000Z',
      created_at: '2026-04-15T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });

    const before = await generator.generateMorningBrief({
      now,
      lastSyncAt: new Date('2026-04-16T11:30:00.000Z'),
    });
    expect(before).not.toContain('## Send failures (');

    const sendFailedId = await insertDraft(localDb, {
      action_item_id: itemId,
      status: 'send_failed',
      draft_text: 'Reminder that payment is pending.',
      send_error: 'wacli send timeout after 30s',
    });

    const after = await generator.generateMorningBrief({
      now,
      lastSyncAt: new Date('2026-04-16T11:30:00.000Z'),
    });

    expect(after).toContain('## Send failures (1)');
    expect(after).toContain(`draft_id=${sendFailedId}`);
    expect(after).toContain('send_error=wacli send timeout after 30s');
  });

  test('caps rendered brief line lengths for long context and draft payloads', async () => {
    const { db: localDb, generator } = await createGenerator();

    const itemId = await insertItem(localDb, {
      title: 'Long line stress test item',
      source_message_id: 'brief-1061-linecap',
      due_at: '2026-04-17T12:00:00.000Z',
      created_at: '2026-04-16T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });
    await insertDraft(localDb, {
      action_item_id: itemId,
      status: 'pending',
      version: 1,
      draft_text: `draft ${'x'.repeat(500)}`,
    });
    await insertDraft(localDb, {
      action_item_id: itemId,
      status: 'send_failed',
      version: 2,
      draft_text: 'retry failed',
      send_error: `err ${'y'.repeat(500)}`,
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-16T11:50:00.000Z'),
      contextEnricher: () => ({ [itemId]: `ctx ${'z'.repeat(800)}` }),
    });

    for (const line of brief.split('\n')) {
      if (line.length === 0) continue;
      expect(line.length).toBeLessThanOrEqual(280);
    }
  });

  test('does not render inline draft blocks when no pending drafts exist', async () => {
    const { db: localDb, generator } = await createGenerator();

    await insertItem(localDb, {
      title: 'Item without drafts',
      source_message_id: 'brief-1061-no-drafts',
      due_at: '2026-04-16T18:00:00.000Z',
      created_at: '2026-04-15T10:00:00.000Z',
      updated_at: '2026-04-16T10:00:00.000Z',
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-16T11:30:00.000Z'),
    });

    expect(brief).not.toContain('draft[#');
    expect(brief).not.toContain('## Send failures (');
  });

  test('#19 emits no active commitments when there are no non-terminal items', async () => {
    const { db: localDb, generator } = await createGenerator();

    await insertItem(localDb, {
      title: 'Resolved item',
      source_message_id: 'brief-019',
      status: 'resolved',
      created_at: '2026-04-16T10:00:00.000Z',
      updated_at: '2026-04-16T11:00:00.000Z',
    });

    const brief = await generator.generateMorningBrief({
      now: new Date('2026-04-16T12:00:00.000Z'),
      lastSyncAt: new Date('2026-04-16T11:30:00.000Z'),
    });

    expect(brief).toContain('No active commitments');
    expect(brief).not.toContain('## Overdue items');
  });
});
