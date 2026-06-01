export interface SqliteStatement<T = Record<string, unknown>> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null | undefined;
}

export interface SqliteDatabaseLike {
  query<T = Record<string, unknown>>(sql: string): SqliteStatement<T>;
  close?(): void;
}

export interface BackupFileRef {
  domain: string;
  relativePath: string;
  fileID: string;
  path: string;
}

export interface ContactRecord {
  recordId: number;
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones: string[];
  emails: string[];
}

export interface SmsMessage {
  id: number;
  chatId: number | null;
  chatIdentifier: string | null;
  chatDisplayName: string | null;
  service: string | null;
  handle: string | null;
  isFromMe: boolean;
  timestamp: Date;
  text: string;
}

export interface ConversationSegment {
  id: string;
  chatId: number | null;
  chatIdentifier: string | null;
  chatDisplayName: string | null;
  service: string | null;
  month: string;
  participantHandles: string[];
  messages: SmsMessage[];
}
