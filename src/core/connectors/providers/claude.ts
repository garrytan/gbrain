/**
 * providers/claude.ts — the Claude.ai live connector.
 *
 * Fetches the user's OWN conversation history from claude.ai's web API using
 * the `sessionKey` cookie, normalized to the flat shape the existing
 * `claude-export` transcript adapter parses (top-level array of
 * `{uuid, name, created_at, chat_messages:[{uuid, sender, created_at, text}]}`).
 *
 * Endpoints (provisional — see CLAUDE_WEB_API_SPEC_TARGET):
 *   GET /api/organizations                                         → [{uuid, capabilities, ...}]
 *   GET /api/organizations/{org}/chat_conversations?limit&offset   → [{uuid, name, created_at, updated_at}]
 *   GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages
 *
 * No bearer re-mint: the sessionKey cookie IS the auth, so a 401 is terminal
 * (→ auth_required, no refreshAccessToken). Chat-capable orgs are discovered
 * lazily and memoized per client instance (each sync builds a fresh client →
 * account-safe); every one is listed, and each conversation is fetched from
 * the org that listed it. The list is paged with limit/offset (C-17).
 */

import type { HostSpecTarget } from '../../bootstrap/host-specs.ts';
import type { ConnectorClient } from '../client.ts';
import { toIso } from './chatgpt.ts';
import type {
  ChatHistoryProvider,
  ConnectorCredential,
  ConversationStub,
  ProbeResult,
} from '../types.ts';

export const CLAUDE_BASE_URL = 'https://claude.ai';

export const CLAUDE_WEB_API_SPEC_TARGET: HostSpecTarget = {
  id: 'claude-ai-web-api-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-25',
  references: [
    'claude.ai web API (undocumented): /api/organizations, /api/organizations/{org}/chat_conversations[/{id}]',
    'src/core/transcripts/claude-export.ts (the export shape this normalizes to)',
    'test/fixtures/connectors/claude-*.json',
  ],
  note:
    'Cookie-auth (sessionKey). Orgs discovered via GET /api/organizations; every org ' +
    'whose capabilities include chat (or that declares none) is listed. ' +
    'chat_conversations?limit&offset pages {uuid,name,created_at,updated_at} as a flat ' +
    'array (an unpaged request is capped); the detail ' +
    '(?tree=True&rendering_mode=messages) returns chat_messages[] whose text is ' +
    'assembled from content blocks when a flat text is absent; sender human/assistant. ' +
    'PROVISIONAL: shapes from public documentation + the export adapter fixtures, ' +
    'not probed live in this repo; drift alarm (no array / no chat_messages) is the backstop.',
};

const memoOrgs = new WeakMap<ConnectorClient, string[]>();
/** Conversation id → the org that listed it, per client. */
const memoConversationOrg = new WeakMap<ConnectorClient, Map<string, string>>();

const LIST_PAGE_LIMIT = 100;
const MAX_LIST_PAGES = 500; // per org; never treat a truncated list as complete

interface OrgRow {
  uuid?: string;
  capabilities?: unknown;
}
interface ConvRow {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}
interface MsgRow {
  uuid?: string;
  sender?: string;
  created_at?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** Every chat-capable org (an org that declares no capabilities counts). */
async function resolveOrgs(client: ConnectorClient, signal?: AbortSignal): Promise<string[]> {
  const cached = memoOrgs.get(client);
  if (cached) return cached;
  const orgs = await client.fetchJSON<OrgRow[]>('/api/organizations', { signal });
  const ids = Array.isArray(orgs)
    ? orgs
        .filter((o) => typeof o?.uuid === 'string' && (!Array.isArray(o.capabilities) || o.capabilities.includes('chat')))
        .map((o) => o.uuid as string)
    : [];
  if (!ids.length) throw new Error('claude: /api/organizations returned no chat-capable org (shape drift)');
  memoOrgs.set(client, ids);
  return ids;
}

/** Assemble message text: prefer flat `text`, else join text-type content blocks. */
function messageText(m: MsgRow): string {
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

export const claudeProvider: ChatHistoryProvider = {
  name: 'claude',
  spoolFormat: 'claude-export',
  strategies: ['browser-session'],
  specTarget: CLAUDE_WEB_API_SPEC_TARGET,
  baseUrl: CLAUDE_BASE_URL,

  async authHeaders(cred: ConnectorCredential): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    if (cred.cookie) h.cookie = cred.cookie;
    // claude.ai also expects this header on API calls from the web app.
    h['anthropic-client-platform'] = 'web_claude_ai';
    return h;
  },

  // No refreshAccessToken: the cookie is the durable auth; a 401 is terminal.

  async probe(client: ConnectorClient, signal?: AbortSignal): Promise<ProbeResult> {
    try {
      const [org] = await resolveOrgs(client, signal);
      const list = await client.fetchJSON<ConvRow[]>(
        `/api/organizations/${encodeURIComponent(org)}/chat_conversations?limit=1`,
        { signal },
      );
      if (!Array.isArray(list)) {
        return { ok: false, kind: 'drift', detail: 'chat_conversations probe returned a non-array' };
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
    const orgs = await resolveOrgs(client, opts.signal);
    const conversationOrg = new Map<string, string>();
    memoConversationOrg.set(client, conversationOrg);
    const stubs: ConversationStub[] = [];
    for (const org of orgs) {
      // Page until an empty page or a page with nothing new (an endpoint that
      // ignores offset returns the same rows again). A whole page at/before
      // the since-bound ends the walk early: the list is newest-first.
      let offset = 0;
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) {
          throw new Error(`claude: list hit the ${MAX_LIST_PAGES}-page cap; refusing to treat a truncated list as complete`);
        }
        const rows = await client.fetchJSON<ConvRow[]>(
          `/api/organizations/${encodeURIComponent(org)}/chat_conversations?limit=${LIST_PAGE_LIMIT}&offset=${offset}`,
          { signal: opts.signal },
        );
        if (!Array.isArray(rows)) {
          throw new Error('claude: chat_conversations returned a non-array (shape drift)');
        }
        let fresh = 0;
        let allOlder = rows.length > 0;
        for (const r of rows) {
          if (typeof r.uuid !== 'string' || conversationOrg.has(r.uuid)) continue;
          fresh++;
          conversationOrg.set(r.uuid, org);
          const updatedAt = toIso(r.updated_at) || toIso(r.created_at);
          if (!opts.stopBefore || !updatedAt || updatedAt > opts.stopBefore) allOlder = false;
          stubs.push({
            id: r.uuid,
            title: typeof r.name === 'string' ? r.name : undefined,
            updatedAt,
            createdAt: toIso(r.created_at) || undefined,
          });
        }
        if (fresh === 0 || allOlder) break;
        offset += rows.length;
      }
    }
    // Sort newest-first by updated_at (the API order is not guaranteed).
    stubs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    for (const s of stubs) {
      if (opts.stopBefore && s.updatedAt && s.updatedAt <= opts.stopBefore) return; // rest are older
      yield s;
    }
  },

  async fetchConversation(
    client: ConnectorClient,
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const org = memoConversationOrg.get(client)?.get(id) ?? (await resolveOrgs(client, opts.signal))[0];
    const conv = await client.fetchJSON<Record<string, unknown>>(
      `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages`,
      { signal: opts.signal },
    );
    const rawMsgs = Array.isArray((conv as { chat_messages?: unknown }).chat_messages)
      ? ((conv as { chat_messages: MsgRow[] }).chat_messages)
      : null;
    if (!rawMsgs) {
      throw new Error(`claude: conversation ${id} has no chat_messages (shape drift)`);
    }
    // Normalize each message to a flat {uuid, sender, created_at, text} the
    // claude-export adapter parses (assemble text from content blocks).
    const chat_messages = rawMsgs.map((m) => ({
      uuid: typeof m.uuid === 'string' ? m.uuid : '',
      sender: m.sender,
      created_at: typeof m.created_at === 'string' ? m.created_at : '',
      text: messageText(m),
    }));
    return {
      uuid: typeof conv.uuid === 'string' ? conv.uuid : id,
      name: typeof conv.name === 'string' ? conv.name : undefined,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      chat_messages,
    };
  },

  sessionInstructions(): string {
    return [
      'Connect Claude with your browser session cookie:',
      '  1. Open https://claude.ai in a browser where you are logged in.',
      '  2. Open DevTools → Application → Cookies → claude.ai; copy the `sessionKey` value.',
      '  3. Run: gbrain connectors auth claude --cookie -   (paste `sessionKey=<value>`, then Ctrl-D)',
      '',
      'Your cookie is stored only on this machine at ~/.gbrain/connectors/claude.json (0600)',
      'and is sent only to claude.ai. If a sync is blocked, use the official export',
      '(Settings → Privacy → Export data) and `gbrain transcripts ingest conversations.json`.',
    ].join('\n');
  },
};
