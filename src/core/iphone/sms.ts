import { Database } from 'bun:sqlite';
import type { ConversationSegment, SmsMessage, SqliteDatabaseLike } from './types.ts';

export const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
export const MAX_MESSAGE_TEXT_CHARS = 20_000;

export class IPhoneSmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPhoneSmsError';
  }
}

interface SmsRow {
  message_id: number;
  date_value: number | bigint | string | null;
  text: string | null;
  is_from_me: number | null;
  handle: string | null;
  chat_id: number | null;
  chat_identifier: string | null;
  chat_display_name: string | null;
  service: string | null;
}

export interface SegmentMessagesOpts {
  /** Optional cap for tests and staged imports. */
  limitMessages?: number;
}

export function openSmsDb(path: string): SqliteDatabaseLike {
  return new Database(path, { readonly: true }) as unknown as SqliteDatabaseLike;
}

export function readSmsMessages(db: SqliteDatabaseLike, opts: SegmentMessagesOpts = {}): SmsMessage[] {
  assertRequiredTables(db);
  const messageCols = columnsFor(db, 'message');
  const handleCols = columnsFor(db, 'handle');
  const chatCols = columnsFor(db, 'chat');
  const joinCols = columnsFor(db, 'chat_message_join');
  assertRequiredColumns('message', messageCols, ['date', 'text', 'handle_id']);
  assertRequiredColumns('handle', handleCols, ['id']);
  assertRequiredColumns('chat_message_join', joinCols, ['chat_id', 'message_id']);
  const messageTextValue = columnValueExpr(messageCols, 'm', ['text']);
  const messageText = `SUBSTR(${messageTextValue}, 1, ${MAX_MESSAGE_TEXT_CHARS}) AS text`;
  const messageDate = columnExpr(messageCols, 'm', ['date'], 'date_value');
  const messageIsFromMe = columnExpr(messageCols, 'm', ['is_from_me'], 'is_from_me');
  const messageService = columnValueExpr(messageCols, 'm', ['service']);
  const handleId = columnExpr(handleCols, 'h', ['id'], 'handle');
  const chatId = columnExpr(joinCols, 'cmj', ['chat_id'], 'chat_id');
  const chatIdentifier = columnExpr(chatCols, 'c', ['chat_identifier', 'guid'], 'chat_identifier');
  const chatDisplayName = columnExpr(chatCols, 'c', ['display_name'], 'chat_display_name');
  const chatService = columnValueExpr(chatCols, 'c', ['service_name']);
  const limitClause = opts.limitMessages && opts.limitMessages > 0 ? ` LIMIT ${Math.floor(opts.limitMessages)}` : '';
  const rows = db.query<SmsRow>(
    `SELECT
       m.ROWID AS message_id,
       ${messageDate},
       ${messageText},
       ${messageIsFromMe},
       ${handleId},
       ${chatId},
       ${chatIdentifier},
       ${chatDisplayName},
       COALESCE(${chatService}, ${messageService}) AS service
     FROM message m
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     LEFT JOIN chat c ON c.ROWID = cmj.chat_id
     WHERE m.text IS NOT NULL AND TRIM(m.text) <> ''
     ORDER BY COALESCE(cmj.chat_id, -m.handle_id, m.ROWID), m.date, m.ROWID${limitClause}`,
  ).all();

  return rows.map(rowToMessage).filter((msg): msg is SmsMessage => msg !== null);
}

export function segmentMessagesByMonth(messages: readonly SmsMessage[]): ConversationSegment[] {
  const groups = new Map<string, SmsMessage[]>();
  for (const msg of messages) {
    const groupKey = msg.chatId !== null ? `chat:${msg.chatId}` : `handle:${msg.handle ?? 'unknown'}`;
    const month = monthKey(msg.timestamp);
    const key = `${groupKey}:${month}`;
    const list = groups.get(key) ?? [];
    list.push(msg);
    groups.set(key, list);
  }

  const segments: ConversationSegment[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id - b.id);
    const first = list[0];
    const participantHandles = Array.from(new Set(
      list
        .map((msg) => msg.handle)
        .filter((handle): handle is string => !!handle && handle.trim().length > 0),
    )).sort();
    const month = monthKey(first.timestamp);
    segments.push({
      id: key.replace(/[^a-zA-Z0-9:_-]/g, '-'),
      chatId: first.chatId,
      chatIdentifier: first.chatIdentifier,
      chatDisplayName: first.chatDisplayName,
      service: first.service,
      month,
      participantHandles,
      messages: list,
    });
  }

  return segments.sort((a, b) => {
    if (a.month !== b.month) return a.month.localeCompare(b.month);
    return a.id.localeCompare(b.id);
  });
}

export function parseAppleMessageDate(value: number | bigint | string | null | undefined): Date {
  if (value === null || value === undefined || value === '') {
    throw new IPhoneSmsError('message.date is empty');
  }
  const raw = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(raw)) {
    throw new IPhoneSmsError(`message.date is not numeric: ${String(value)}`);
  }

  const abs = Math.abs(raw);
  const seconds =
    abs > 1e15 ? raw / 1_000_000_000 :
    abs > 1e12 ? raw / 1_000_000 :
    abs > 1e10 ? raw / 1_000 :
    raw;

  const date = new Date(APPLE_EPOCH_MS + seconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new IPhoneSmsError(`message.date is outside supported range: ${String(value)}`);
  }
  return date;
}

function rowToMessage(row: SmsRow): SmsMessage | null {
  const text = (row.text ?? '').trim();
  if (!text) return null;
  let timestamp: Date;
  try {
    timestamp = parseAppleMessageDate(row.date_value);
  } catch {
    return null;
  }
  return {
    id: Number(row.message_id),
    chatId: row.chat_id === null || row.chat_id === undefined ? null : Number(row.chat_id),
    chatIdentifier: row.chat_identifier ?? null,
    chatDisplayName: row.chat_display_name ?? null,
    service: row.service ?? null,
    handle: row.handle ?? null,
    isFromMe: Number(row.is_from_me ?? 0) === 1,
    timestamp,
    text,
  };
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function assertRequiredTables(db: SqliteDatabaseLike): void {
  for (const table of ['message', 'handle', 'chat', 'chat_message_join']) {
    const row = db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    ).get(table);
    if (!row) throw new IPhoneSmsError(`sms.db is missing required table: ${table}`);
  }
}

function columnsFor(db: SqliteDatabaseLike, table: string): Set<string> {
  const rows = db.query<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

function assertRequiredColumns(table: string, columns: Set<string>, required: string[]): void {
  for (const column of required) {
    if (!columns.has(column)) {
      throw new IPhoneSmsError(`sms.db table ${table} is missing required column: ${column}`);
    }
  }
}

function columnExpr(columns: Set<string>, tableAlias: string, candidates: string[], alias: string): string {
  return `${columnValueExpr(columns, tableAlias, candidates)} AS ${alias}`;
}

function columnValueExpr(columns: Set<string>, tableAlias: string, candidates: string[]): string {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return `${tableAlias}."${candidate.replace(/"/g, '""')}"`;
  }
  return 'NULL';
}
