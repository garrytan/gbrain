import type {
  ActionDraft,
  ActionDraftChannel,
  ActionDraftStatus,
  ActionHistoryEventType,
  ActionItem,
  ActionStatus,
  ActionType,
} from './types.ts';

interface QueryResult<T> {
  rows: T[];
}

interface ActionDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction?<T>(fn: (txDb: ActionDb) => Promise<T>): Promise<T>;
}

interface ActionItemRow {
  id: number;
  title: string;
  type: ActionType;
  status: ActionStatus;
  owner: string;
  waiting_on: string | null;
  due_at: Date | string | null;
  stale_after_hours: number;
  priority_score: number;
  confidence: number;
  source_message_id: string;
  source_thread: string;
  source_contact: string;
  linked_entity_slugs: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
}

interface ActionInsertRow extends ActionItemRow {
  was_inserted: boolean;
}

interface ActionDraftRow {
  id: number;
  action_item_id: number;
  version: number;
  status: ActionDraftStatus;
  channel: ActionDraftChannel;
  recipient: string;
  draft_text: string;
  model: string;
  context_hash: string;
  context_snapshot: Record<string, unknown> | string;
  generated_at: Date | string;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
  send_error: string | null;
}

const TERMINAL_STATUSES = new Set<ActionStatus>(['resolved', 'dropped']);

export interface CreateActionItemInput {
  title: string;
  type: ActionType;
  source_message_id: string;
  owner?: string;
  waiting_on?: string | null;
  due_at?: Date | null;
  stale_after_hours?: number;
  priority_score?: number;
  confidence?: number;
  source_thread?: string;
  source_contact?: string;
  linked_entity_slugs?: string[];
}

export interface ActionMutationOptions {
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface ListActionItemsFilters {
  status?: ActionStatus;
  owner?: string;
  stale?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateActionDraftInput {
  action_item_id: number;
  version?: number;
  status?: ActionDraftStatus;
  channel?: ActionDraftChannel;
  recipient: string;
  draft_text: string;
  model: string;
  context_hash: string;
  context_snapshot: Record<string, unknown>;
  approved_at?: Date | null;
  sent_at?: Date | null;
  send_error?: string | null;
}

export interface ListActionDraftFilters {
  action_item_id?: number;
  status?: ActionDraftStatus;
  limit?: number;
  offset?: number;
}

export interface UpdateActionDraftInput {
  status?: ActionDraftStatus;
  channel?: ActionDraftChannel;
  recipient?: string;
  draft_text?: string;
  model?: string;
  context_hash?: string;
  context_snapshot?: Record<string, unknown>;
  approved_at?: Date | null;
  sent_at?: Date | null;
  send_error?: string | null;
}

export class ActionItemNotFoundError extends Error {
  constructor(id: number) {
    super(`Action item not found: ${id}`);
    this.name = 'ActionItemNotFoundError';
  }
}

export class ActionTransitionError extends Error {
  constructor(itemId: number, fromStatus: ActionStatus, toStatus: ActionStatus) {
    super(`Invalid status transition for action item ${itemId}: ${fromStatus} -> ${toStatus}`);
    this.name = 'ActionTransitionError';
  }
}

export class ActionDraftNotFoundError extends Error {
  constructor(id: number) {
    super(`Action draft not found: ${id}`);
    this.name = 'ActionDraftNotFoundError';
  }
}

export class ActionEngine {
  constructor(private readonly db: ActionDb) {}

  async createItem(input: CreateActionItemInput, options: ActionMutationOptions = {}): Promise<ActionItem> {
    return this.withTransaction(async (db) => {
      const result = await db.query<ActionInsertRow>(
        `WITH inserted AS (
           INSERT INTO action_items (
             title,
             type,
             source_message_id,
             owner,
             waiting_on,
             due_at,
             stale_after_hours,
             priority_score,
             confidence,
             source_thread,
             source_contact,
             linked_entity_slugs
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_message_id) DO NOTHING
           RETURNING *
         )
         SELECT inserted.*, TRUE AS was_inserted
         FROM inserted
         UNION ALL
         SELECT ai.*, FALSE AS was_inserted
         FROM action_items ai
         WHERE ai.source_message_id = $3
           AND NOT EXISTS (SELECT 1 FROM inserted)
         LIMIT 1`,
        [
          input.title,
          input.type,
          input.source_message_id,
          input.owner ?? '',
          input.waiting_on ?? null,
          input.due_at ?? null,
          input.stale_after_hours ?? 48,
          input.priority_score ?? 0,
          input.confidence ?? 0,
          input.source_thread ?? '',
          input.source_contact ?? '',
          input.linked_entity_slugs ?? [],
        ]
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to create action item for source message: ${input.source_message_id}`);
      }

      if (toBoolean(row.was_inserted)) {
        await this.insertHistory(
          db,
          row.id,
          'created',
          options.actor ?? 'system',
          {
            source_message_id: input.source_message_id,
            ...(options.metadata ?? {}),
          }
        );
      }

      return mapActionItem(row);
    });
  }

  async getItem(id: number): Promise<ActionItem | null> {
    const result = await this.db.query<ActionItemRow>(
      `SELECT *
       FROM action_items
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapActionItem(result.rows[0]);
  }

  async listItems(filters: ListActionItemsFilters = {}): Promise<ActionItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }

    if (filters.owner) {
      params.push(filters.owner);
      where.push(`owner = $${params.length}`);
    }

    if (typeof filters.stale === 'boolean') {
      const activeExpression = `status NOT IN ('resolved', 'dropped')`;
      const staleAgeExpression = `(now() - updated_at) > make_interval(hours => stale_after_hours)`;
      const staleLifecycleExpression = `(status = 'stale' OR ${staleAgeExpression})`;
      where.push(
        filters.stale
          ? `${activeExpression} AND ${staleLifecycleExpression}`
          : `${activeExpression} AND NOT ${staleLifecycleExpression}`
      );
    }

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.db.query<ActionItemRow>(
      `SELECT *
       FROM action_items
       ${whereClause}
       ORDER BY priority_score DESC, updated_at DESC, id DESC
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      params
    );

    return result.rows.map(mapActionItem);
  }

  async createDraft(input: CreateActionDraftInput): Promise<ActionDraft> {
    return this.withTransaction(async (db) => {
      const version = input.version ?? (await this.nextDraftVersion(db, input.action_item_id));
      const result = await db.query<ActionDraftRow>(
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
           approved_at,
           sent_at,
           send_error
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         RETURNING *`,
        [
          input.action_item_id,
          version,
          input.status ?? 'pending',
          input.channel ?? 'whatsapp',
          input.recipient,
          input.draft_text,
          input.model,
          input.context_hash,
          JSON.stringify(input.context_snapshot),
          input.approved_at ?? null,
          input.sent_at ?? null,
          input.send_error ?? null,
        ]
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Failed to create action draft for action item: ${input.action_item_id}`);
      }

      return mapActionDraft(row);
    });
  }

  async getDraft(id: number): Promise<ActionDraft | null> {
    const result = await this.db.query<ActionDraftRow>(
      `SELECT *
       FROM action_drafts
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapActionDraft(result.rows[0]);
  }

  async listDrafts(filters: ListActionDraftFilters = {}): Promise<ActionDraft[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (typeof filters.action_item_id === 'number') {
      params.push(filters.action_item_id);
      where.push(`action_item_id = $${params.length}`);
    }

    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.db.query<ActionDraftRow>(
      `SELECT *
       FROM action_drafts
       ${whereClause}
       ORDER BY action_item_id DESC, version DESC, id DESC
       LIMIT ${limitParam}
       OFFSET ${offsetParam}`,
      params
    );

    return result.rows.map(mapActionDraft);
  }

  async updateDraft(id: number, patch: UpdateActionDraftInput): Promise<ActionDraft> {
    const assignments: string[] = [];
    const params: unknown[] = [id];

    if (patch.status !== undefined) {
      params.push(patch.status);
      assignments.push(`status = $${params.length}`);
    }

    if (patch.channel !== undefined) {
      params.push(patch.channel);
      assignments.push(`channel = $${params.length}`);
    }

    if (patch.recipient !== undefined) {
      params.push(patch.recipient);
      assignments.push(`recipient = $${params.length}`);
    }

    if (patch.draft_text !== undefined) {
      params.push(patch.draft_text);
      assignments.push(`draft_text = $${params.length}`);
    }

    if (patch.model !== undefined) {
      params.push(patch.model);
      assignments.push(`model = $${params.length}`);
    }

    if (patch.context_hash !== undefined) {
      params.push(patch.context_hash);
      assignments.push(`context_hash = $${params.length}`);
    }

    if (patch.context_snapshot !== undefined) {
      params.push(JSON.stringify(patch.context_snapshot));
      assignments.push(`context_snapshot = $${params.length}::jsonb`);
    }

    if (patch.approved_at !== undefined) {
      params.push(patch.approved_at);
      assignments.push(`approved_at = $${params.length}`);
    }

    if (patch.sent_at !== undefined) {
      params.push(patch.sent_at);
      assignments.push(`sent_at = $${params.length}`);
    }

    if (patch.send_error !== undefined) {
      params.push(patch.send_error);
      assignments.push(`send_error = $${params.length}`);
    }

    if (assignments.length === 0) {
      throw new Error('updateDraft requires at least one field to update.');
    }

    const result = await this.db.query<ActionDraftRow>(
      `UPDATE action_drafts
       SET ${assignments.join(', ')}
       WHERE id = $1
       RETURNING *`,
      params
    );

    const row = result.rows[0];
    if (!row) {
      throw new ActionDraftNotFoundError(id);
    }

    return mapActionDraft(row);
  }

  async deleteDraft(id: number): Promise<boolean> {
    const result = await this.db.query<{ id: number }>(
      `DELETE FROM action_drafts
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    return result.rows.length > 0;
  }

  async updateItemStatus(
    id: number,
    nextStatus: ActionStatus,
    options: ActionMutationOptions = {}
  ): Promise<ActionItem> {
    return this.withTransaction(async (db) => {
      const currentRow = await this.lockItemById(db, id);
      validateTransition(id, currentRow.status, nextStatus);

      const updateResult = await db.query<ActionItemRow>(
        `UPDATE action_items
         SET status = $2,
             resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, nextStatus]
      );

      const updatedRow = updateResult.rows[0];
      if (!updatedRow) {
        throw new ActionItemNotFoundError(id);
      }

      const eventType: ActionHistoryEventType =
        nextStatus === 'resolved' ? 'resolved' : nextStatus === 'dropped' ? 'dropped' : 'status_change';

      await this.insertHistory(
        db,
        id,
        eventType,
        options.actor ?? 'system',
        {
          from_status: currentRow.status,
          to_status: nextStatus,
          ...(options.metadata ?? {}),
        }
      );

      return mapActionItem(updatedRow);
    });
  }

  async resolveItem(id: number, options: ActionMutationOptions = {}): Promise<ActionItem> {
    return this.updateItemStatus(id, 'resolved', options);
  }

  private async nextDraftVersion(db: ActionDb, actionItemId: number): Promise<number> {
    const result = await db.query<{ next_version: number | string }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM action_drafts
       WHERE action_item_id = $1`,
      [actionItemId]
    );
    const row = result.rows[0];
    if (!row) {
      return 1;
    }
    return Number(row.next_version);
  }

  private async lockItemById(db: ActionDb, id: number): Promise<ActionItemRow> {
    const rowResult = await db.query<ActionItemRow>(
      `SELECT *
       FROM action_items
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    const row = rowResult.rows[0];
    if (!row) {
      throw new ActionItemNotFoundError(id);
    }

    return row;
  }

  private async insertHistory(
    db: ActionDb,
    itemId: number,
    eventType: ActionHistoryEventType,
    actor: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await db.query(
      `INSERT INTO action_history (item_id, event_type, actor, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [itemId, eventType, actor, JSON.stringify(metadata)]
    );
  }

  private async withTransaction<T>(fn: (db: ActionDb) => Promise<T>): Promise<T> {
    if (typeof this.db.transaction === 'function') {
      return this.db.transaction((txDb) => fn(txDb));
    }

    await this.db.query('BEGIN');
    try {
      const result = await fn(this.db);
      await this.db.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.db.query('ROLLBACK');
      } catch {
        // Best effort rollback; preserve original error.
      }
      throw error;
    }
  }
}

function validateTransition(itemId: number, fromStatus: ActionStatus, toStatus: ActionStatus): void {
  if (fromStatus === toStatus || TERMINAL_STATUSES.has(fromStatus)) {
    throw new ActionTransitionError(itemId, fromStatus, toStatus);
  }
}

function mapActionItem(row: ActionItemRow): ActionItem {
  return {
    id: Number(row.id),
    title: row.title,
    type: row.type,
    status: row.status,
    owner: row.owner,
    waiting_on: row.waiting_on,
    due_at: toDate(row.due_at),
    stale_after_hours: Number(row.stale_after_hours),
    priority_score: Number(row.priority_score),
    confidence: Number(row.confidence),
    source_message_id: row.source_message_id,
    source_thread: row.source_thread,
    source_contact: row.source_contact,
    linked_entity_slugs: row.linked_entity_slugs ?? [],
    created_at: ensureDate(row.created_at, 'created_at'),
    updated_at: ensureDate(row.updated_at, 'updated_at'),
    resolved_at: toDate(row.resolved_at),
  };
}

function mapActionDraft(row: ActionDraftRow): ActionDraft {
  return {
    id: Number(row.id),
    action_item_id: Number(row.action_item_id),
    version: Number(row.version),
    status: row.status,
    channel: row.channel,
    recipient: row.recipient,
    draft_text: row.draft_text,
    model: row.model,
    context_hash: row.context_hash,
    context_snapshot: parseJsonObject(row.context_snapshot, 'context_snapshot'),
    generated_at: ensureDate(row.generated_at, 'generated_at'),
    approved_at: toDate(row.approved_at),
    sent_at: toDate(row.sent_at),
    send_error: row.send_error,
  };
}

function parseJsonObject(value: Record<string, unknown> | string, field: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${field} value: expected object`);
  }
  return parsed;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return ensureDate(value, 'timestamp');
}

function ensureDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field} value: ${String(value)}`);
  }
  return parsed;
}

function toBoolean(value: boolean | string): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 't' || value === '1';
}
