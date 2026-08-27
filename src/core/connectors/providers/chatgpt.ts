/**
 * providers/chatgpt.ts — the ChatGPT live connector.
 *
 * Fetches the user's OWN conversation history from chatgpt.com's web backend
 * using their session credential, normalized to the EXACT shape the existing
 * `chatgpt-export` transcript adapter parses (top-level array of
 * `{conversation_id, title, create_time, update_time, current_node, mapping}`),
 * so ingest, redaction, slugging, and idempotency are 100% reused.
 *
 * Endpoints (provisional — see CHATGPT_BACKEND_API_SPEC_TARGET):
 *   GET /api/auth/session                      cookie → {accessToken, expires}
 *   GET /backend-api/conversations?offset&limit&order[&is_archived]  → {items,total,offset,limit}
 *   GET /backend-api/conversation/{id}         → export-shaped conversation
 *
 * The durable credential is the raw Cookie header; the accessToken is a
 * ~week-lived bearer re-minted from the cookie on 401 (refreshAccessToken).
 */

import type { HostSpecTarget } from '../../bootstrap/host-specs.ts';
import type { ConnectorClient, ConnectorFetch } from '../client.ts';
import type {
  ChatHistoryProvider,
  ConnectorCredential,
  ConversationStub,
  OAuthPkceConfig,
  ProbeResult,
} from '../types.ts';

export const CHATGPT_BASE_URL = 'https://chatgpt.com';

export const CHATGPT_BACKEND_API_SPEC_TARGET: HostSpecTarget = {
  id: 'chatgpt-backend-api-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-25',
  references: [
    'chatgpt.com web app backend-api (undocumented): /api/auth/session, /backend-api/conversations, /backend-api/conversation/{id}',
    'src/core/transcripts/chatgpt-export.ts (the export shape this normalizes to)',
    'test/fixtures/connectors/chatgpt-*.json',
  ],
  note:
    'Cookie-auth web backend. /api/auth/session returns {accessToken, expires}. ' +
    '/backend-api/conversations?offset&limit&order=updated returns ' +
    '{items:[{id,title,create_time,update_time}], total, offset, limit}; an ' +
    'is_archived=true variant lists archived threads (SECOND pass). ' +
    '/backend-api/conversation/{id} returns the export-shaped {mapping, current_node, ...}. ' +
    'PROVISIONAL: shapes assembled from public documentation + the export ' +
    'adapter fixtures, not probed against a live account in this repo; the ' +
    'drift alarm (list parses but has no items array; detail has no mapping) is ' +
    'the runtime backstop, and the Cloudflare fingerprint 403 may block ' +
    'server-side fetch entirely (Phase 0 spike gate).',
};

/** OAuth PKCE against auth.openai.com — best-effort/forward-compat only (--try-oauth). */
export const CHATGPT_OAUTH: OAuthPkceConfig = {
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_gbrain_connector',
  scopes: ['openid', 'profile', 'offline_access'],
  redirectPort: 1455,
};

const LIST_PAGE_LIMIT = 28; // the UI's max page size
const MAX_LIST_PAGES = 500; // safety cap PER PASS; never treat a truncated list as complete

interface SessionResponse {
  accessToken?: string;
  expires?: string;
}
interface ListItem {
  id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
}
interface ListResponse {
  items?: ListItem[];
  total?: number;
  offset?: number;
  limit?: number;
}

/** Normalize an epoch-seconds float OR an ISO string to a Z-form ISO string. */
export function toIso(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return new Date(Math.round(v * 1000)).toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return '';
}

/**
 * One offset-paginated list pass (normal or archived). Yields stubs
 * newest-first; breaks early once a stub is at/before `stopBefore` (the
 * watermark minus the trailing window) since `order=updated` guarantees the
 * rest are older.
 */
async function* listPass(
  client: ConnectorClient,
  archived: boolean,
  stopBefore: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<ConversationStub> {
  let offset = 0;
  let pages = 0;
  for (;;) {
    const q = new URLSearchParams({
      offset: String(offset),
      limit: String(LIST_PAGE_LIMIT),
      order: 'updated',
    });
    if (archived) q.set('is_archived', 'true');
    const res = await client.fetchJSON<ListResponse>(`/backend-api/conversations?${q.toString()}`, { signal });
    // Drift guard (§2B): a body that parses but lacks the items array must abort
    // the pass, never be treated as "no more" (that would silently truncate).
    if (!res || !Array.isArray(res.items)) {
      throw new Error(
        `chatgpt: conversations list${archived ? ' (archived)' : ''} returned no items array (shape drift)`,
      );
    }
    for (const it of res.items) {
      const id = typeof it.id === 'string' ? it.id : '';
      if (!id) continue;
      const updatedAt = toIso(it.update_time) || toIso(it.create_time);
      if (stopBefore && updatedAt && updatedAt <= stopBefore) return; // rest are older
      yield {
        id,
        title: typeof it.title === 'string' ? it.title : undefined,
        updatedAt,
        createdAt: toIso(it.create_time) || undefined,
      };
    }
    const total = typeof res.total === 'number' ? res.total : offset + res.items.length;
    offset += res.items.length;
    if (res.items.length === 0 || offset >= total) break;
    pages++;
    if (pages >= MAX_LIST_PAGES) {
      throw new Error(
        `chatgpt: list pass hit the ${MAX_LIST_PAGES}-page cap; refusing to treat a truncated list as complete`,
      );
    }
  }
}

export const chatgptProvider: ChatHistoryProvider = {
  name: 'chatgpt',
  spoolFormat: 'chatgpt',
  strategies: ['browser-session', 'oauth-pkce'],
  specTarget: CHATGPT_BACKEND_API_SPEC_TARGET,
  oauth: CHATGPT_OAUTH,
  baseUrl: CHATGPT_BASE_URL,

  async authHeaders(cred: ConnectorCredential): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    if (cred.cookie) h.cookie = cred.cookie;
    if (cred.accessToken) h.authorization = `Bearer ${cred.accessToken}`;
    return h;
  },

  async refreshAccessToken(cred: ConnectorCredential, fetchImpl: ConnectorFetch): Promise<boolean> {
    if (!cred.cookie) return false; // nothing durable to re-mint from
    try {
      const res = await fetchImpl(`${CHATGPT_BASE_URL}/api/auth/session`, {
        headers: { cookie: cred.cookie, accept: 'application/json' },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as SessionResponse;
      if (!body.accessToken) return false;
      cred.accessToken = body.accessToken;
      if (body.expires) {
        const ms = Date.parse(body.expires);
        if (Number.isFinite(ms)) cred.expiresAt = ms;
      }
      return true;
    } catch {
      return false;
    }
  },

  async probe(client: ConnectorClient, signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const res = await client.fetchJSON<ListResponse>(
        '/backend-api/conversations?offset=0&limit=1&order=updated',
        { signal },
      );
      if (!res || !Array.isArray(res.items)) {
        return { ok: false, kind: 'drift', detail: 'conversations probe returned no items array' };
      }
      return { ok: true };
    } catch (e) {
      const name = (e as { name?: string }).name;
      const msg = e instanceof Error ? e.message : String(e);
      if (name === 'ConnectorAuthError') return { ok: false, kind: 'unauthorized', detail: msg };
      if (name === 'ConnectorForbiddenError') return { ok: false, kind: 'forbidden_fingerprint', detail: msg };
      return { ok: false, kind: 'network', detail: msg };
    }
  },

  async *listConversations(
    client: ConnectorClient,
    opts: { signal?: AbortSignal; stopBefore?: string } = {},
  ): AsyncGenerator<ConversationStub> {
    // Pass 1: active threads. Pass 2: archived (D3.1). Each pass breaks at its
    // own since-bound; the run watermark is the max updatedAt seen across BOTH
    // passes (the orchestrator tracks it).
    yield* listPass(client, false, opts.stopBefore, opts.signal);
    yield* listPass(client, true, opts.stopBefore, opts.signal);
  },

  async fetchConversation(
    client: ConnectorClient,
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const conv = await client.fetchJSON<Record<string, unknown>>(
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      { signal: opts.signal },
    );
    if (!conv || typeof conv !== 'object' || typeof conv.mapping !== 'object' || conv.mapping === null) {
      throw new Error(`chatgpt: conversation ${id} has no mapping tree (shape drift)`);
    }
    // The detail payload may omit conversation_id — inject it so the export
    // adapter's session-id resolution is stable and slugs don't collide.
    if (typeof conv.conversation_id !== 'string') conv.conversation_id = id;
    return conv;
  },

  sessionInstructions(): string {
    return [
      'Connect ChatGPT with your browser session cookie:',
      '  1. Open https://chatgpt.com in a browser where you are logged in.',
      '  2. Open DevTools → Network, refresh, click any request to chatgpt.com.',
      '  3. Copy the full `Cookie:` request header value.',
      '  4. Run: gbrain connectors auth chatgpt --cookie -   (paste, then Ctrl-D)',
      '',
      'Your cookie is stored only on this machine at ~/.gbrain/connectors/chatgpt.json (0600)',
      'and is sent only to chatgpt.com. If a sync is blocked by a Cloudflare challenge,',
      'use the official export instead (Settings → Data controls → Export) and',
      '`gbrain transcripts ingest conversations.json`.',
    ].join('\n');
  },
};
