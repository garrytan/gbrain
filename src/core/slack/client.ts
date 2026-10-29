/**
 * Slack Web API client for the slack source kind: `auth.test`,
 * `conversations.info`, `conversations.history`, `conversations.replies`
 * and `users.list`, each a GET with the bot token as a bearer header (never
 * in a query string or a body). Slack answers application errors inside
 * HTTP 200 bodies (`ok: false`); `classifySlackBody` turns them into the
 * connector client's typed errors. Requests are spaced for Slack's Tier 3
 * limits (about 50 a minute), and a 429 waits for its Retry-After.
 */
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorClient, ConnectorRateLimitedError, type ConnectorFetch } from '../connectors/client.ts';
import type { SlackAccount, SlackChannelInfo, SlackMessage, SlackUser } from './types.ts';

export const SLACK_BASE_URL = 'https://slack.com';
const PAGE_LIMIT = 200;
/** Cursor pages one listing may walk before it is treated as runaway. */
const MAX_PAGES = 500;

/** A Slack application error that is not auth, permission, a channel the app cannot read, or a rate limit. */
export class SlackApiError extends Error {
  readonly code = 'connector_provider_error';
  constructor(readonly method: string, readonly slackError: string) {
    super(`slack: ${method} failed (${slackError})`);
    this.name = 'SlackApiError';
  }
}

/** A channel the app cannot read: not invited (`not_in_channel`), or private and not visible to it (`channel_not_found`). */
export class SlackChannelUnavailableError extends Error {
  readonly code = 'connector_channel_unavailable';
  constructor(readonly channelId: string, readonly slackError: string) {
    super(slackError === 'not_in_channel'
      ? `slack: the app is not a member of channel ${channelId}; invite it there with /invite @<your app>`
      : `slack: channel ${channelId} was not found; check the id, and for a private channel invite the app with /invite @<your app>`);
    this.name = 'SlackChannelUnavailableError';
  }
}

/** A Slack response missing a field it must carry: the item is held, never published partially. */
export class SlackShapeDriftError extends Error {
  readonly code = 'connector_shape_drift';
  constructor(what: string) {
    super(`slack: the response is missing ${what}; the Slack API may have changed`);
    this.name = 'SlackShapeDriftError';
  }
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type']);
const DENIED_ERRORS = new Set(['access_denied', 'no_permission', 'team_access_not_granted', 'ekm_access_denied', 'org_login_required']);
const CHANNEL_ERRORS = new Set(['not_in_channel', 'channel_not_found']);

function methodOf(pathOrUrl: string): string {
  return pathOrUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\//, '').split('?')[0] ?? pathOrUrl;
}

/** Throws the typed error for an `ok: false` body; returns for an `ok: true` one. Exported for tests. */
export function classifySlackBody(body: unknown, pathOrUrl: string, now: number): void {
  const value = body as { ok?: unknown; error?: unknown; needed?: unknown } | null;
  if (value?.ok === true) return;
  const error = typeof value?.error === 'string' ? value.error : 'unknown_error';
  const method = methodOf(pathOrUrl);
  if (AUTH_ERRORS.has(error)) throw new ConnectorAuthError(`slack: the token was rejected (${error})`);
  if (error === 'missing_scope') {
    const needed = typeof value?.needed === 'string' ? value.needed : 'a required';
    throw new ConnectorAccessDeniedError(`slack: the app token lacks the ${needed} scope for ${method}; add it under OAuth & Permissions and reinstall the app`);
  }
  if (DENIED_ERRORS.has(error)) throw new ConnectorAccessDeniedError(`slack: ${method} was refused (${error})`);
  if (CHANNEL_ERRORS.has(error)) {
    const channel = new URL(pathOrUrl, SLACK_BASE_URL).searchParams.get('channel') ?? 'unknown';
    throw new SlackChannelUnavailableError(channel, error);
  }
  if (error === 'ratelimited') throw new ConnectorRateLimitedError(`slack: ${method} was rate limited`, now + 60_000);
  throw new SlackApiError(method, error);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export interface SlackClientOpts {
  token: string;
  userAgent: string;
  fetchImpl?: ConnectorFetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxRequests?: number;
  deadlineAt?: number;
  /** Spacing between requests, ms. Default 1200 (Tier 3). */
  minDelayMs?: number;
}

export interface SlackApi {
  authTest(signal?: AbortSignal): Promise<SlackAccount>;
  conversationInfo(channel: string, signal?: AbortSignal): Promise<SlackChannelInfo>;
  /** Every top-level message with oldest <= ts < latest (epoch seconds), oldest first. */
  history(channel: string, oldest: number, latest: number, signal?: AbortSignal): Promise<SlackMessage[]>;
  /** The replies in a thread, oldest first, without the parent. */
  replies(channel: string, threadTs: string, signal?: AbortSignal): Promise<SlackMessage[]>;
  usersList(signal?: AbortSignal): Promise<Map<string, SlackUser>>;
}

export function slackApi(opts: SlackClientOpts): SlackApi {
  const now = opts.now ?? Date.now;
  const client = new ConnectorClient({
    baseUrl: SLACK_BASE_URL,
    headers: async () => ({ authorization: `Bearer ${opts.token}` }),
    userAgent: opts.userAgent,
    minDelayMs: opts.minDelayMs ?? 1200,
    requestTimeoutMs: 60_000,
    maxResponseBytes: 16 * 1024 * 1024,
    validate: (body, pathOrUrl) => classifySlackBody(body, pathOrUrl, now()),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
    ...(opts.maxRequests !== undefined ? { maxRequests: opts.maxRequests } : {}),
    now,
  });
  const get = <T>(method: string, params: Record<string, string>, signal?: AbortSignal) =>
    client.fetchJSON<T & { response_metadata?: { next_cursor?: string } }>(`/api/${method}?${new URLSearchParams(params).toString()}`, { signal });
  async function paged<T>(method: string, params: Record<string, string>, field: string, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await get<Record<string, unknown>>(method, { ...params, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) }, signal);
      const items = body[field];
      if (!Array.isArray(items)) throw new SlackShapeDriftError(`${method}.${field}`);
      out.push(...items as T[]);
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) return out;
    }
    throw new SlackApiError(method, `more than ${MAX_PAGES} pages`);
  }
  return {
    async authTest(signal) {
      const body = await get<{ team_id?: unknown; team?: unknown; user_id?: unknown; enterprise_id?: unknown }>('auth.test', {}, signal);
      const teamId = str(body.team_id);
      if (!teamId) throw new SlackShapeDriftError('auth.test.team_id');
      return { teamId, enterpriseId: str(body.enterprise_id), team: str(body.team), botUserId: str(body.user_id) };
    },
    async conversationInfo(channel, signal) {
      const body = await get<{ channel?: Record<string, unknown> }>('conversations.info', { channel }, signal);
      const raw = body.channel;
      const id = str(raw?.id);
      if (!raw || !id) throw new SlackShapeDriftError('conversations.info.channel.id');
      if (raw.is_im === true || raw.is_mpim === true) throw new SlackApiError('conversations.info', 'direct messages are not a channel source');
      if (raw.is_member === false) throw new SlackChannelUnavailableError(id, 'not_in_channel');
      return { id, name: str(raw.name) ?? id, isPrivate: raw.is_private === true, isArchived: raw.is_archived === true };
    },
    async history(channel, oldest, latest, signal) {
      const messages = await paged<SlackMessage>('conversations.history',
        { channel, oldest: oldest.toFixed(6), latest: latest.toFixed(6), inclusive: 'true' }, 'messages', signal);
      for (const m of messages) if (!str(m?.ts)) throw new SlackShapeDriftError('conversations.history.messages[].ts');
      const at = (m: SlackMessage) => Number(m.ts);
      return messages.filter(m => at(m) >= oldest && at(m) < latest).sort((a, b) => at(a) - at(b));
    },
    async replies(channel, threadTs, signal) {
      const messages = await paged<SlackMessage>('conversations.replies', { channel, ts: threadTs }, 'messages', signal);
      for (const m of messages) if (!str(m?.ts)) throw new SlackShapeDriftError('conversations.replies.messages[].ts');
      return messages.filter(m => m.ts !== threadTs).sort((a, b) => Number(a.ts) - Number(b.ts));
    },
    async usersList(signal) {
      const members = await paged<Record<string, unknown>>('users.list', {}, 'members', signal);
      const users = new Map<string, SlackUser>();
      for (const m of members) {
        const id = str(m?.id);
        if (!id) continue;
        const profile = (m.profile ?? {}) as Record<string, unknown>;
        users.set(id, { name: str(profile.display_name) ?? str(profile.real_name) ?? str(m.real_name) ?? str(m.name) ?? id,
          deleted: m.deleted === true, bot: m.is_bot === true });
      }
      return users;
    },
  };
}
