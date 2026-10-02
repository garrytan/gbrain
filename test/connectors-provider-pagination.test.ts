/**
 * Write-path audit C-17 / C-18: connector list passes never silently drop
 * conversations.
 *  - Claude: chat_conversations is paged with limit/offset (the endpoint
 *    caps an unpaged list), every chat-capable org is listed, and timestamps
 *    are normalized to Z-form ISO like ChatGPT's.
 *  - ChatGPT: a conversation removed from the list mid-walk (archived or
 *    deleted) shifts later items to lower offsets; the walk re-covers the
 *    shifted boundary instead of skipping it, and yields each id once.
 */
import { describe, expect, test } from 'bun:test';
import { ConnectorClient } from '../src/core/connectors/client.ts';
import { claudeProvider } from '../src/core/connectors/providers/claude.ts';
import { chatgptProvider } from '../src/core/connectors/providers/chatgpt.ts';
import type { ConversationStub } from '../src/core/connectors/types.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientFor(baseUrl: string, handler: (url: URL) => Response, seen: string[] = []): ConnectorClient {
  return new ConnectorClient({
    baseUrl,
    headers: async () => ({}),
    sleep: () => Promise.resolve(),
    fetchImpl: async (input: string) => {
      const url = new URL(input);
      seen.push(url.pathname + url.search);
      return handler(url);
    },
  });
}

async function collect(gen: AsyncGenerator<ConversationStub>): Promise<ConversationStub[]> {
  const out: ConversationStub[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

describe('claude connector listing (C-17)', () => {
  const iso = (i: number) => new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString();
  function claudeServer(orgs: Array<{ uuid: string; capabilities?: string[]; convs: number }>) {
    return (url: URL): Response => {
      if (url.pathname === '/api/organizations') return json(orgs.map(o => ({ uuid: o.uuid, capabilities: o.capabilities })));
      const list = url.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations$/);
      if (list) {
        const org = orgs.find(o => o.uuid === list[1]);
        if (!org || (org.capabilities && !org.capabilities.includes('chat'))) return json({ error: 'forbidden' }, 403);
        // Newest-first; an unpaged request is capped like the live endpoint.
        const rows = Array.from({ length: org.convs }, (_, i) => ({
          uuid: `${org.uuid}-c${i}`, name: `c${i}`,
          created_at: iso(org.convs - i),
          updated_at: iso(org.convs - i).replace('Z', '123+00:00').replace('.000', '.000'),
        }));
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        return json(rows.slice(offset, offset + limit));
      }
      const detail = url.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)$/);
      if (detail) {
        if (!detail[2].startsWith(`${detail[1]}-`)) return json({ error: 'not found' }, 404);
        return json({ uuid: detail[2], name: 'x', chat_messages: [{ uuid: 'm', sender: 'human', created_at: iso(0), text: 'hi' }] });
      }
      return json({ error: 'unhandled' }, 404);
    };
  }

  test('pages past the endpoint cap and lists every conversation once', async () => {
    const client = clientFor('https://claude.ai', claudeServer([{ uuid: 'org-a', capabilities: ['chat'], convs: 230 }]));
    const stubs = await collect(claudeProvider.listConversations(client, {}));
    expect(stubs).toHaveLength(230);
    expect(new Set(stubs.map(s => s.id)).size).toBe(230);
  });

  test('lists every chat-capable org and fetches each conversation from its own org', async () => {
    const seen: string[] = [];
    const client = clientFor('https://claude.ai', claudeServer([
      { uuid: 'org-a', capabilities: ['chat', 'claude_max'], convs: 3 },
      { uuid: 'org-api', capabilities: ['api'], convs: 5 },
      { uuid: 'org-b', capabilities: ['chat'], convs: 2 },
    ]), seen);
    const stubs = await collect(claudeProvider.listConversations(client, {}));
    expect(stubs.map(s => s.id).sort()).toEqual(['org-a-c0', 'org-a-c1', 'org-a-c2', 'org-b-c0', 'org-b-c1']);
    const conv = await claudeProvider.fetchConversation(client, 'org-b-c1', {});
    expect(conv.uuid).toBe('org-b-c1');
    expect(seen.some(p => p.startsWith('/api/organizations/org-api/chat_conversations'))).toBe(false);
  });

  test('timestamps are normalized to Z-form ISO', async () => {
    const client = clientFor('https://claude.ai', claudeServer([{ uuid: 'org-a', capabilities: ['chat'], convs: 1 }]));
    const [stub] = await collect(claudeProvider.listConversations(client, {}));
    expect(stub.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(stub.createdAt).toMatch(/Z$/);
  });
});

describe('chatgpt connector listing (C-18)', () => {
  test('a conversation archived mid-walk does not make the walk skip its neighbour', async () => {
    const active = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, title: `c${i}`, create_time: 1_786_000_000 - i * 60, update_time: 1_786_000_000 - i * 60 }));
    const archived: typeof active = [];
    let listCalls = 0;
    const client = clientFor('https://chatgpt.com', (url) => {
      if (url.pathname !== '/backend-api/conversations') return json({ error: 'unhandled' }, 404);
      const isArchived = url.searchParams.get('is_archived') === 'true';
      const pool = isArchived ? archived : active;
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const body = { items: pool.slice(offset, offset + limit), total: pool.length, offset, limit };
      // The user archives c3 right after the first page was served.
      if (!isArchived && ++listCalls === 1) archived.push(...active.splice(3, 1));
      return json(body);
    });
    const stubs = await collect(chatgptProvider.listConversations(client, {}));
    const ids = stubs.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Array.from({ length: 60 }, (_, i) => `c${i}`).sort());
  });

  test('a conversation updated mid-walk is yielded once', async () => {
    const active = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, title: `c${i}`, create_time: 1_786_000_000 - i * 60, update_time: 1_786_000_000 - i * 60 }));
    let listCalls = 0;
    const client = clientFor('https://chatgpt.com', (url) => {
      const isArchived = url.searchParams.get('is_archived') === 'true';
      const pool = isArchived ? [] : active;
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const body = { items: pool.slice(offset, offset + limit), total: pool.length, offset, limit };
      // c35 gets a new message and moves to the top after the first page.
      if (!isArchived && ++listCalls === 1) {
        const [moved] = active.splice(35, 1);
        active.unshift({ ...moved, update_time: 1_786_000_500 });
      }
      return json(body);
    });
    const ids = (await collect(chatgptProvider.listConversations(client, {}))).map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
