/**
 * Fireflies.ai meeting provider (GraphQL, bearer API key on every plan).
 * `transcripts(fromDate, toDate, limit, skip)` lists meetings; `transcript(id)`
 * fetches one. Application errors arrive in HTTP 200 bodies (`errors[]`) and are
 * classified by `validate` into the client's typed errors. Sentences are
 * requested only in `transcript: full` mode.
 */
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorClient, ConnectorRateLimitedError, type ConnectorFetch } from '../../connectors/client.ts';
import { MeetingProviderError, MeetingShapeDriftError, type MeetingAccount, type MeetingProvider, type MeetingRecord, type MeetingStub } from '../types.ts';

export const FIREFLIES_BASE_URL = 'https://api.fireflies.ai';
const ENDPOINT = '/graphql';
/** Fireflies caps a listing page at 50. */
export const FIREFLIES_PAGE_LIMIT = 50;
/** A meeting with no summary this long after it started is published without one. */
export const SUMMARY_WAIT_MS = 48 * 3600_000;

const USER_QUERY = 'query GbrainUser { user { user_id email name } }';
const LIST_QUERY = `query GbrainTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) { id title date }
}`;
const MEETING_FIELDS = `id title date duration transcript_url organizer_email participants
    meeting_attendees { displayName email name }
    summary { overview action_items keywords }`;
const MEETING_QUERY = `query GbrainTranscript($id: String!) { transcript(id: $id) { ${MEETING_FIELDS} } }`;
const MEETING_WITH_SENTENCES_QUERY = `query GbrainTranscript($id: String!) { transcript(id: $id) { ${MEETING_FIELDS}
    sentences { speaker_name text start_time } } }`;

interface GraphQLError { message?: unknown; code?: unknown; extensions?: { code?: unknown; status?: unknown; metadata?: { retryAfter?: unknown } } }

const lower = (value: unknown) => (typeof value === 'string' ? value : '').toLowerCase();

/** The next 00:00 UTC after `now`: when a daily quota resets. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Throws the typed error for a GraphQL error body; returns for a body with data. Exported for tests. */
export function classifyFirefliesBody(body: unknown, now: number): void {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const first = errors[0] as GraphQLError;
  const code = lower(first.extensions?.code ?? first.code);
  const message = lower(first.message);
  const text = typeof first.message === 'string' ? first.message.slice(0, 200) : 'unknown error';
  if (/auth|unauthenticated|invalid_api_key|api key/.test(code) || /invalid api key|unauthori[sz]ed|authentication/.test(message)) {
    throw new ConnectorAuthError(`fireflies: the API key was rejected (${code || 'auth'})`);
  }
  if (/forbidden|permission|not_authorized|privilege/.test(code)) throw new ConnectorAccessDeniedError(`fireflies: ${text}`);
  if (/too_many|rate|quota|limit/.test(code) || /rate limit|too many requests|quota/.test(message)) {
    const retryAfter = first.extensions?.metadata?.retryAfter;
    const retryAt = typeof retryAfter === 'number' && retryAfter > 0
      ? (retryAfter > 1e12 ? retryAfter : now + retryAfter * 1000)
      : nextUtcMidnight(now);
    throw new ConnectorRateLimitedError(`fireflies: rate limited (${code || 'quota'})`, retryAt);
  }
  if (/not_found|object_not_found/.test(code)) return;
  throw new MeetingProviderError('fireflies', code || 'graphql_error', text);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const iso = (value: unknown): string | null => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function notFound(body: unknown): boolean {
  const errors = (body as { errors?: GraphQLError[] } | null)?.errors;
  return Array.isArray(errors) && errors.some(e => /not_found/.test(lower(e.extensions?.code ?? e.code)));
}

export function normalizeFirefliesMeeting(raw: Record<string, unknown>, opts: { transcript: boolean; now: number }): MeetingRecord {
  const id = str(raw.id);
  const startedAt = iso(raw.date);
  if (!id) throw new MeetingShapeDriftError('fireflies', 'transcript.id');
  if (!startedAt) throw new MeetingShapeDriftError('fireflies', 'transcript.date');
  const summary = raw.summary as { overview?: unknown; action_items?: unknown; keywords?: unknown } | null | undefined;
  if (summary !== null && summary !== undefined && typeof summary !== 'object') throw new MeetingShapeDriftError('fireflies', 'transcript.summary');
  const attendees = Array.isArray(raw.meeting_attendees)
    ? (raw.meeting_attendees as Array<Record<string, unknown>>).map(a => ({ name: str(a?.displayName) ?? str(a?.name), email: str(a?.email)?.toLowerCase() ?? null }))
    : [];
  for (const email of Array.isArray(raw.participants) ? raw.participants : []) {
    const address = str(email)?.toLowerCase();
    if (address && !attendees.some(a => a.email === address)) attendees.push({ name: null, email: address });
  }
  const actionItems = (Array.isArray(summary?.action_items) ? summary!.action_items.map(String) : (str(summary?.action_items) ?? '').split('\n'))
    .map(line => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
  const overview = str(summary?.overview);
  let transcript: MeetingRecord['transcript'] = null;
  if (opts.transcript) {
    if (!Array.isArray(raw.sentences)) throw new MeetingShapeDriftError('fireflies', 'transcript.sentences');
    transcript = (raw.sentences as Array<Record<string, unknown>>).map(s => ({
      speaker: str(s?.speaker_name) ?? 'Unknown speaker',
      startSec: typeof s?.start_time === 'number' ? s.start_time : null,
      text: typeof s?.text === 'string' ? s.text : '',
    })).filter(s => s.text.trim());
  }
  const durationMin = typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : null;
  const hasSummary = !!overview || actionItems.length > 0;
  return {
    id,
    title: str(raw.title) ?? 'Untitled meeting',
    startedAt,
    durationSec: durationMin === null ? null : Math.round(durationMin * 60),
    attendees,
    organizerEmail: str(raw.organizer_email)?.toLowerCase() ?? null,
    summary: overview,
    actionItems,
    keywords: Array.isArray(summary?.keywords) ? (summary!.keywords as unknown[]).map(String).filter(Boolean) : [],
    transcript,
    url: str(raw.transcript_url),
    isFinal: hasSummary || opts.now - Date.parse(startedAt) >= SUMMARY_WAIT_MS,
  };
}

export interface FirefliesOpts {
  token: string;
  fetchImpl?: ConnectorFetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  deadlineAt?: number;
  maxRequests?: number;
  /** Largest response read, bytes. */
  maxResponseBytes?: number;
  userAgent: string;
}

export function firefliesProvider(opts: FirefliesOpts): MeetingProvider {
  const now = opts.now ?? Date.now;
  const client = new ConnectorClient({
    baseUrl: FIREFLIES_BASE_URL,
    headers: async () => ({ authorization: `Bearer ${opts.token}` }),
    userAgent: opts.userAgent,
    minDelayMs: 1100,
    requestTimeoutMs: 60_000,
    maxResponseBytes: opts.maxResponseBytes ?? 16 * 1024 * 1024,
    validate: body => classifyFirefliesBody(body, now()),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
    ...(opts.maxRequests !== undefined ? { maxRequests: opts.maxRequests } : {}),
    now,
  });
  const query = <T>(q: string, variables: Record<string, unknown>, signal?: AbortSignal) =>
    client.postJSON<{ data?: T; errors?: unknown }>(ENDPOINT, { query: q, variables }, { signal });
  return {
    name: 'fireflies',
    async probe(signal) {
      const body = await query<{ user?: Record<string, unknown> | null }>(USER_QUERY, {}, signal);
      const user = body.data?.user;
      const userId = str(user?.user_id);
      if (!userId) throw new MeetingShapeDriftError('fireflies', 'user.user_id');
      return { userId, email: str(user?.email)?.toLowerCase() ?? null, name: str(user?.name) } satisfies MeetingAccount;
    },
    async listMeetings({ fromDate, toDate, limit, skip, signal }) {
      const body = await query<{ transcripts?: unknown }>(LIST_QUERY, { fromDate, toDate, limit: Math.min(limit, FIREFLIES_PAGE_LIMIT), skip }, signal);
      if (!body.data || !Array.isArray(body.data.transcripts)) throw new MeetingShapeDriftError('fireflies', 'data.transcripts');
      return (body.data.transcripts as Array<Record<string, unknown>>).map(raw => {
        const id = str(raw?.id);
        const startedAt = iso(raw?.date);
        if (!id || !startedAt) throw new MeetingShapeDriftError('fireflies', 'transcripts[].id or date');
        return { id, startedAt, title: str(raw.title) ?? 'Untitled meeting' } satisfies MeetingStub;
      });
    },
    async fetchMeeting(id, { transcript, signal }) {
      const body = await query<{ transcript?: Record<string, unknown> | null }>(transcript ? MEETING_WITH_SENTENCES_QUERY : MEETING_QUERY, { id }, signal);
      if (notFound(body)) return null;
      if (!body.data || !('transcript' in body.data)) throw new MeetingShapeDriftError('fireflies', 'data.transcript');
      if (body.data.transcript === null) return null;
      return normalizeFirefliesMeeting(body.data.transcript!, { transcript, now: now() });
    },
  };
}
