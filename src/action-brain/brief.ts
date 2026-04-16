import type { ActionItem, ActionStatus } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface QueryResult<T> {
  rows: T[];
}

interface ActionDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

interface ActionItemRow {
  id: number;
  title: string;
  type: ActionItem['type'];
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

interface LastSyncRow {
  last_sync_at: Date | string | null;
}

export type BriefContextEnricher = (
  items: ActionItem[]
) => Promise<Map<number, string> | Record<number, string>> | Map<number, string> | Record<number, string>;

export interface GenerateMorningBriefOptions {
  now?: Date;
  lastSyncAt?: Date | null;
  timezoneOffsetMinutes?: number;
  contextEnricher?: BriefContextEnricher;
}

export class MorningBriefGenerator {
  constructor(private readonly db: ActionDb) {}

  async generateMorningBrief(options: GenerateMorningBriefOptions = {}): Promise<string> {
    const now = options.now ? ensureDate(options.now, 'now') : new Date();
    const timezoneOffsetMinutes = resolveTimezoneOffsetMinutes(options.timezoneOffsetMinutes, now);
    const items = await this.listActiveItems();
    const lastSyncAt = await this.resolveLastSyncAt(options.lastSyncAt);
    const contextByItemId = await resolveContextByItemId(items, options.contextEnricher);

    const lines: string[] = [];
    lines.push('Action Brain Morning Brief');
    lines.push(`Generated: ${now.toISOString()}`);
    lines.push(formatFreshnessLine(lastSyncAt, now));

    if (isFreshnessDegraded(lastSyncAt, now)) {
      lines.push('WARNING: ingestion degraded (>24h since last wacli sync).');
    }

    if (items.length === 0) {
      lines.push('');
      lines.push('No active commitments');
      return lines.join('\n');
    }

    lines.push('');
    lines.push(...renderSection('Overdue items', selectOverdue(items, now), sortByDueThenPriority, contextByItemId));
    lines.push('');
    lines.push(
      ...renderSection('Due today', selectDueToday(items, now, timezoneOffsetMinutes), sortByDueThenPriority, contextByItemId)
    );
    lines.push('');
    lines.push(...renderSection('Newly created (last 24h)', selectNewlyCreated(items, now), sortByNewestCreated, contextByItemId));
    lines.push('');
    lines.push(...renderSection('Gone stale', selectGoneStale(items, now), sortByOldestActivity, contextByItemId));

    return lines.join('\n');
  }

  private async listActiveItems(): Promise<ActionItem[]> {
    const result = await this.db.query<ActionItemRow>(
      `SELECT *
       FROM action_items
       WHERE status NOT IN ('resolved', 'dropped')
       ORDER BY id ASC`
    );

    return result.rows.map(mapActionItemRow);
  }

  private async resolveLastSyncAt(provided: Date | null | undefined): Promise<Date | null> {
    if (provided) {
      return ensureDate(provided, 'lastSyncAt');
    }

    const result = await this.db.query<LastSyncRow>(
      `SELECT max(created_at) AS last_sync_at
       FROM action_items`
    );

    const raw = result.rows[0]?.last_sync_at ?? null;
    return raw ? ensureDate(raw, 'last_sync_at') : null;
  }
}

function renderSection(
  title: string,
  sectionItems: ActionItem[],
  sorter: (a: ActionItem, b: ActionItem) => number,
  contextByItemId: Map<number, string>
): string[] {
  const sorted = [...sectionItems].sort(sorter);
  const lines = [`## ${title} (${sorted.length})`];

  if (sorted.length === 0) {
    lines.push('- None');
    return lines;
  }

  for (const item of sorted) {
    lines.push(formatItemLine(item, contextByItemId.get(item.id)));
  }

  return lines;
}

function formatItemLine(item: ActionItem, context: string | undefined): string {
  const parts = [`- [#${item.id}] ${item.title}`];

  if (item.owner) {
    parts.push(`owner=${item.owner}`);
  }

  if (item.waiting_on) {
    parts.push(`waiting_on=${item.waiting_on}`);
  }

  if (item.due_at) {
    parts.push(`due=${item.due_at.toISOString()}`);
  }

  parts.push(`status=${item.status}`);
  parts.push(`priority=${item.priority_score.toFixed(2)}`);

  if (context) {
    parts.push(`context=${context}`);
  }

  return parts.join(' | ');
}

async function resolveContextByItemId(
  items: ActionItem[],
  contextEnricher: BriefContextEnricher | undefined
): Promise<Map<number, string>> {
  if (!contextEnricher || items.length === 0) {
    return new Map();
  }

  try {
    const enriched = await contextEnricher(items);

    if (enriched instanceof Map) {
      return enriched;
    }

    const byId = new Map<number, string>();
    for (const [id, context] of Object.entries(enriched)) {
      const parsedId = Number(id);
      if (!Number.isInteger(parsedId) || typeof context !== 'string' || context.trim().length === 0) {
        continue;
      }
      byId.set(parsedId, context.trim());
    }
    return byId;
  } catch {
    // Context enrichment is best-effort; brief generation must succeed without it.
    return new Map();
  }
}

function selectOverdue(items: ActionItem[], now: Date): ActionItem[] {
  const nowMs = now.getTime();
  return items.filter((item) => item.due_at !== null && item.due_at.getTime() < nowMs);
}

function selectDueToday(items: ActionItem[], now: Date, timezoneOffsetMinutes: number): ActionItem[] {
  const nowMs = now.getTime();
  const todayKey = getDateKeyAtOffset(now, timezoneOffsetMinutes);

  return items.filter((item) => {
    if (!item.due_at || item.due_at.getTime() < nowMs) {
      return false;
    }
    return getDateKeyAtOffset(item.due_at, timezoneOffsetMinutes) === todayKey;
  });
}

function selectNewlyCreated(items: ActionItem[], now: Date): ActionItem[] {
  const cutoff = now.getTime() - DAY_MS;
  return items.filter((item) => item.created_at.getTime() >= cutoff);
}

function selectGoneStale(items: ActionItem[], now: Date): ActionItem[] {
  const nowMs = now.getTime();

  return items.filter((item) => {
    if (item.status === 'stale') {
      return true;
    }

    const staleAfterMs = item.stale_after_hours * 60 * 60 * 1000;
    return nowMs - item.updated_at.getTime() > staleAfterMs;
  });
}

function formatFreshnessLine(lastSyncAt: Date | null, now: Date): string {
  if (!lastSyncAt) {
    return 'wacli freshness: last sync unknown';
  }

  const ageHours = Math.max(0, (now.getTime() - lastSyncAt.getTime()) / (60 * 60 * 1000));
  return `wacli freshness: last sync ${lastSyncAt.toISOString()} (${ageHours.toFixed(1)}h ago)`;
}

function isFreshnessDegraded(lastSyncAt: Date | null, now: Date): boolean {
  if (!lastSyncAt) {
    return true;
  }

  return now.getTime() - lastSyncAt.getTime() > DAY_MS;
}

function sortByDueThenPriority(a: ActionItem, b: ActionItem): number {
  const dueDiff = compareNullableDates(a.due_at, b.due_at);
  if (dueDiff !== 0) return dueDiff;

  const priorityDiff = b.priority_score - a.priority_score;
  if (priorityDiff !== 0) return priorityDiff;

  return a.id - b.id;
}

function sortByNewestCreated(a: ActionItem, b: ActionItem): number {
  const createdDiff = b.created_at.getTime() - a.created_at.getTime();
  if (createdDiff !== 0) return createdDiff;

  const priorityDiff = b.priority_score - a.priority_score;
  if (priorityDiff !== 0) return priorityDiff;

  return a.id - b.id;
}

function sortByOldestActivity(a: ActionItem, b: ActionItem): number {
  const updatedDiff = a.updated_at.getTime() - b.updated_at.getTime();
  if (updatedDiff !== 0) return updatedDiff;

  const priorityDiff = b.priority_score - a.priority_score;
  if (priorityDiff !== 0) return priorityDiff;

  return a.id - b.id;
}

function compareNullableDates(a: Date | null, b: Date | null): number {
  const aTime = a?.getTime() ?? Number.POSITIVE_INFINITY;
  const bTime = b?.getTime() ?? Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

function mapActionItemRow(row: ActionItemRow): ActionItem {
  return {
    id: Number(row.id),
    title: row.title,
    type: row.type,
    status: row.status,
    owner: row.owner,
    waiting_on: row.waiting_on,
    due_at: parseOptionalDate(row.due_at, 'due_at'),
    stale_after_hours: Number(row.stale_after_hours),
    priority_score: Number(row.priority_score),
    confidence: Number(row.confidence),
    source_message_id: row.source_message_id,
    source_thread: row.source_thread,
    source_contact: row.source_contact,
    linked_entity_slugs: row.linked_entity_slugs ?? [],
    created_at: ensureDate(row.created_at, 'created_at'),
    updated_at: ensureDate(row.updated_at, 'updated_at'),
    resolved_at: parseOptionalDate(row.resolved_at, 'resolved_at'),
  };
}

function parseOptionalDate(value: Date | string | null, field: string): Date | null {
  if (value === null) {
    return null;
  }

  return ensureDate(value, field);
}

function ensureDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field} value: ${String(value)}`);
  }

  return date;
}

function resolveTimezoneOffsetMinutes(value: number | undefined, now: Date): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  // JS getTimezoneOffset is minutes west of UTC. We store east-of-UTC.
  return -now.getTimezoneOffset();
}

function getDateKeyAtOffset(date: Date, timezoneOffsetMinutes: number): string {
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${shifted.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const INTERNALS_FOR_TESTING = {
  selectOverdue,
  selectDueToday,
  selectNewlyCreated,
  selectGoneStale,
  isFreshnessDegraded,
};
