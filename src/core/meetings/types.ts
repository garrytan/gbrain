/**
 * Meeting-notes source kind (`sources.config.kind = 'meetings'`): the provider
 * seam and the normalized record every provider leaf returns. A provider is one
 * leaf under `providers/` plus one line in `providers/index.ts`.
 */

export type MeetingProviderName = 'fireflies';
export const MEETING_PROVIDERS: readonly MeetingProviderName[] = ['fireflies'];
export function isMeetingProviderName(name: unknown): name is MeetingProviderName {
  return (MEETING_PROVIDERS as readonly unknown[]).includes(name);
}

/** Where a source's pages are recorded, chosen once at `sources add` and never re-inferred. */
export type MeetingRecordMode = 'git' | 'database';
export type MeetingTranscriptMode = 'none' | 'full';

export const MEETINGS_DEFAULT_HISTORY_DAYS = 30;
export const MEETINGS_DEFAULT_LOOKBACK_DAYS = 3;
export const MEETINGS_DEFAULT_SYNC_INTERVAL_MIN = 60;
export const SYNC_INTERVAL_MIN_FLOOR = 5;

export interface MeetingsSourceConfig {
  provider: MeetingProviderName;
  /** How far back the first sync reaches. */
  historyDays: number;
  /** Recent meetings re-listed every run, so late summaries, edits and deletions converge. */
  lookbackDays: number;
  /** `full` also fetches and renders the sentence transcript. */
  transcript: MeetingTranscriptMode;
  /** An environment variable holding the API key, read instead of the credential store. Excluded from the identity. */
  tokenEnv?: string;
  record: MeetingRecordMode;
  /** The page directory: a git checkout directory in `git` mode, null in `database` mode. */
  dir: string | null;
  /** Every page is written `visibility: private`. */
  privateOnly: boolean;
  /** Minutes between scheduled syncs (autopilot's freshness loop). Excluded from the identity. */
  syncIntervalMin: number;
}

export interface MeetingAttendee { name: string | null; email: string | null }
export interface MeetingSentence { speaker: string; startSec: number | null; text: string }

/** One meeting, normalized. Provider prose is raw here; the renderer neutralizes each field. */
export interface MeetingRecord {
  /** Immutable provider id: the page path and hold key derive from it. */
  id: string;
  title: string;
  /** ISO 8601 UTC start time. */
  startedAt: string;
  durationSec: number | null;
  attendees: MeetingAttendee[];
  organizerEmail: string | null;
  summary: string | null;
  actionItems: string[];
  keywords: string[];
  /** Present only when the transcript was requested. */
  transcript: MeetingSentence[] | null;
  url: string | null;
  /** False while the provider is still processing it (no summary yet): it is re-checked, not published. */
  isFinal: boolean;
}

/** A meeting as a listing returns it. */
export interface MeetingStub { id: string; startedAt: string; title: string }

/** The account a key belongs to: the source's account pin. */
export interface MeetingAccount { userId: string; email: string | null; name: string | null }

export interface MeetingProvider {
  name: MeetingProviderName;
  /** Who the key belongs to; throws the client's typed error on a rejected or unreachable key. */
  probe(signal?: AbortSignal): Promise<MeetingAccount>;
  /** One page of meetings that started in [fromDate, toDate), newest first. */
  listMeetings(opts: { fromDate: string; toDate: string; limit: number; skip: number; signal?: AbortSignal }): Promise<MeetingStub[]>;
  /** One meeting, or null when the provider no longer has it. */
  fetchMeeting(id: string, opts: { transcript: boolean; signal?: AbortSignal }): Promise<MeetingRecord | null>;
}

/** A provider payload missing a field it must carry: the item is held, never published partially. */
export class MeetingShapeDriftError extends Error {
  readonly code = 'connector_shape_drift';
  constructor(provider: MeetingProviderName, what: string) {
    super(`${provider}: the response is missing ${what}; the provider's API may have changed`);
    this.name = 'MeetingShapeDriftError';
  }
}

/** A provider application error that is not auth, permission or rate limit. */
export class MeetingProviderError extends Error {
  readonly code = 'connector_provider_error';
  constructor(provider: MeetingProviderName, readonly providerCode: string, message: string) {
    super(`${provider}: ${message} (${providerCode})`);
    this.name = 'MeetingProviderError';
  }
}
