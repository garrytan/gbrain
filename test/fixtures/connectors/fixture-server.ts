/**
 * fixture-server.ts — a scriptable Bun.serve backend-api fixture for the
 * connectors E2E. Impersonates chatgpt.com + claude.ai so the REAL
 * ConnectorClient (retry/classify/pace/off-origin) runs end-to-end.
 *
 * The server holds a mutable `state`: conversation records, a per-endpoint
 * request-hit counter (so tests assert HOW MANY details were fetched — the core
 * of incremental-sync proof), and a `script` of forced responses (401 / 403-HTML
 * / 403-JSON / 429 / truncated-list) keyed by path substring + occurrence.
 */

export interface FixtureConversation {
  id: string;
  title: string;
  createTime: number; // epoch seconds
  updateTime: number; // epoch seconds
  archived?: boolean;
  /** user/assistant turns in order; the server builds the mapping tree. */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Extra abandoned-branch text that must NOT appear in the canonical page. */
  abandonedBranchText?: string;
  /** Force the detail payload to omit `mapping` (drift). */
  omitMapping?: boolean;
}

export interface ForcedResponse {
  /** Match when the request path includes this substring. */
  pathIncludes: string;
  status: number;
  /** Body: string or object (object → JSON). */
  body: string | Record<string, unknown>;
  contentType?: string;
  headers?: Record<string, string>;
  /** Fire only on the Nth matching request (1-based); omit = every match. */
  onCall?: number;
}

export interface FixtureState {
  conversations: FixtureConversation[];
  hits: Record<string, number>;
  script: ForcedResponse[];
  /** claude org id served by /api/organizations. */
  claudeOrg: string;
}

export function newFixtureState(conversations: FixtureConversation[] = []): FixtureState {
  return { conversations, hits: {}, script: [], claudeOrg: 'org-test-1' };
}

function bump(state: FixtureState, key: string): number {
  state.hits[key] = (state.hits[key] ?? 0) + 1;
  return state.hits[key];
}

/** Build a ChatGPT export-shaped mapping tree from turns (+ optional abandoned branch). */
function chatgptDetail(c: FixtureConversation): Record<string, unknown> {
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['n0'], message: null },
  };
  let prev = 'root';
  let ts = c.createTime;
  c.turns.forEach((t, i) => {
    const id = `n${i}`;
    (mapping[prev] as { children: string[] }).children = [id];
    mapping[id] = {
      id,
      parent: prev,
      children: [],
      message: { author: { role: t.role }, create_time: ts, content: { content_type: 'text', parts: [t.text] } },
    };
    prev = id;
    ts += 30;
  });
  // Optional abandoned regeneration branch off the first node (must be dropped).
  if (c.abandonedBranchText) {
    (mapping.n0 as { children: string[] }).children.push('n0alt');
    mapping.n0alt = {
      id: 'n0alt',
      parent: 'n0',
      children: [],
      message: {
        author: { role: 'assistant' },
        create_time: c.createTime + 5,
        content: { content_type: 'text', parts: [c.abandonedBranchText] },
      },
    };
  }
  const out: Record<string, unknown> = {
    title: c.title,
    create_time: c.createTime,
    update_time: c.updateTime,
    conversation_id: c.id,
    current_node: prev,
    mapping,
  };
  if (c.omitMapping) delete out.mapping;
  return out;
}

/** Build a claude export-shaped conversation from turns. */
function claudeDetail(c: FixtureConversation): Record<string, unknown> {
  let ts = c.createTime;
  const chat_messages = c.turns.map((t) => {
    const created = new Date(ts * 1000).toISOString();
    ts += 30;
    // Live claude returns content blocks; the provider assembles text from them.
    return {
      uuid: `m-${created}`,
      sender: t.role === 'user' ? 'human' : 'assistant',
      created_at: created,
      content: [{ type: 'text', text: t.text }],
    };
  });
  return {
    uuid: c.id,
    name: c.title,
    created_at: new Date(c.createTime * 1000).toISOString(),
    updated_at: new Date(c.updateTime * 1000).toISOString(),
    chat_messages,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Consult the script; return a forced Response or null. */
function forced(state: FixtureState, path: string): Response | null {
  for (const f of state.script) {
    if (!path.includes(f.pathIncludes)) continue;
    const key = `forced:${f.pathIncludes}:${f.status}`;
    const n = bump(state, key);
    if (f.onCall && n !== f.onCall) continue;
    const body = typeof f.body === 'string' ? f.body : JSON.stringify(f.body);
    return new Response(body, {
      status: f.status,
      headers: { 'content-type': f.contentType ?? 'application/json', ...(f.headers ?? {}) },
    });
  }
  return null;
}

/** The Bun.serve fetch handler for a ChatGPT fixture. */
export function chatgptHandler(state: FixtureState) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const f = forced(state, path);
    if (f) return f;

    if (url.pathname === '/api/auth/session') {
      bump(state, 'session');
      return jsonResponse({ accessToken: 'fixture-access-token', expires: new Date(Date.now() + 7 * 864e5).toISOString() });
    }
    if (url.pathname === '/backend-api/conversations') {
      bump(state, 'list');
      const archived = url.searchParams.get('is_archived') === 'true';
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '28');
      const pool = state.conversations
        .filter((c) => !!c.archived === archived)
        .sort((a, b) => b.updateTime - a.updateTime);
      const items = pool.slice(offset, offset + limit).map((c) => ({
        id: c.id,
        title: c.title,
        create_time: c.createTime,
        update_time: c.updateTime,
      }));
      return jsonResponse({ items, total: pool.length, offset, limit });
    }
    const m = url.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
    if (m) {
      bump(state, 'detail');
      bump(state, `detail:${decodeURIComponent(m[1])}`);
      const c = state.conversations.find((x) => x.id === decodeURIComponent(m[1]));
      if (!c) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse(chatgptDetail(c));
    }
    return jsonResponse({ error: 'unhandled' }, 404);
  };
}

/** The Bun.serve fetch handler for a Claude fixture. */
export function claudeHandler(state: FixtureState) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const f = forced(state, path);
    if (f) return f;

    if (url.pathname === '/api/organizations') {
      bump(state, 'orgs');
      return jsonResponse([{ uuid: state.claudeOrg }]);
    }
    const list = url.pathname.match(/^\/api\/organizations\/[^/]+\/chat_conversations$/);
    if (list) {
      bump(state, 'list');
      const rows = state.conversations
        .sort((a, b) => b.updateTime - a.updateTime)
        .map((c) => ({
          uuid: c.id,
          name: c.title,
          created_at: new Date(c.createTime * 1000).toISOString(),
          updated_at: new Date(c.updateTime * 1000).toISOString(),
        }));
      return jsonResponse(rows);
    }
    const detail = url.pathname.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)$/);
    if (detail) {
      bump(state, 'detail');
      const c = state.conversations.find((x) => x.id === decodeURIComponent(detail[1]));
      if (!c) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse(claudeDetail(c));
    }
    return jsonResponse({ error: 'unhandled' }, 404);
  };
}

/** Convenience: start an ephemeral server, return {port, stop}. */
export function startFixture(handler: (req: Request) => Response): { port: number; stop: () => void; baseUrl: string } {
  const bun = (globalThis as unknown as { Bun: { serve: (o: unknown) => { port: number; stop: (b?: boolean) => void } } }).Bun;
  const server = bun.serve({ port: 0, fetch: handler });
  return { port: server.port, baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
