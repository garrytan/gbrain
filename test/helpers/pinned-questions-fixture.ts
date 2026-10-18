/**
 * Shared fixture for the pinned-question (C4) suites: the B5 offline safety
 * gate and operator journeys run the same scenarios on PGLite
 * (test/pinned-questions-safety.test.ts) and live Postgres
 * (test/e2e/pinned-questions-postgres.test.ts).
 *
 * The stub model answers one sentence per evidence item, each starting with
 * the canary `QZ7`, so any surface that leaks answer text is caught by a
 * substring search. Each scenario gets its own source.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { dispatchToolCall, type ToolResult } from '../../src/mcp/dispatch.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { QuestionChatFn } from '../../src/core/questions/refresh.ts';

export const CANARY = 'QZ7';
export const QUESTION = 'Where does acme-example build widgets and who leads it?';
export const ENTITY = 'companies/acme-example';
export const MODEL = 'anthropic:claude-sonnet-4-6';

export const logger = { info() {}, warn() {}, error() {} };

export function localCtx(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId, dryRun: false, logger };
}

export async function newSource(engine: BrainEngine): Promise<string> {
  const id = `pq-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
  return id;
}

export async function putPage(engine: BrainEngine, sourceId: string, slug: string, content: string, expectedRevision?: string): Promise<void> {
  await submitPageMutation(localCtx(engine, sourceId), { operation: 'put_page', params: {
    slug, content, source_id: sourceId, ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
  } });
}

export const page = (type: string, title: string, body: string, extra = '') => `---\ntype: ${type}\ntitle: ${title}\n${extra}---\n${body}\n`;

export interface Seeded { sourceId: string; factId: number; expiringFactId: number; timelineId: number; takeId: number }

/** A small brain: an entity page, two related pages, facts (one expiring by the clock), a timeline row and a take. */
export async function seedBrain(engine: BrainEngine, opts: { expiringInMs?: number } = {}): Promise<Seeded> {
  const sourceId = await newSource(engine);
  await putPage(engine, sourceId, ENTITY, page('company', 'Acme example', 'Acme example builds widgets in Lisbon.'));
  await putPage(engine, sourceId, 'people/alice-example', page('person', 'Alice example', 'Alice example leads acme-example engineering.'));
  await putPage(engine, sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan for acme-example ships in March.'));
  const fact = await engine.executeRaw<{ id: string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from)
     VALUES ($1, $2, 'Acme example has 40 employees', 'fact', 'test', 'world', 1, now() - interval '1 day') RETURNING id`, [sourceId, ENTITY]);
  const expiring = await engine.executeRaw<{ id: string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, valid_until)
     VALUES ($1, $2, 'Acme example runs a widget sale', 'fact', 'test', 'world', 1, now() - interval '1 day',
       now() + ($3::double precision * interval '1 millisecond')) RETURNING id`, [sourceId, ENTITY, opts.expiringInMs ?? 3_600_000]);
  const [alice] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, 'people/alice-example']);
  const timeline = await engine.executeRaw<{ id: number }>(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES ($1, '2026-02-01', 'test', 'Alice example promoted to engineering lead', '') RETURNING id`, [alice!.id]);
  const take = await engine.executeRaw<{ id: string }>(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, source, active) VALUES ($1, 1, 'Alice example will ship widgets on time', 'take', 'brain', 0.7, 'test', true) RETURNING id`, [alice!.id]);
  return { sourceId, factId: Number(fact[0]!.id), expiringFactId: Number(expiring[0]!.id), timelineId: timeline[0]!.id, takeId: Number(take[0]!.id) };
}

/** Deterministic answer: one canary sentence per evidence line, citing it. */
export function stubAnswer(user: string, opts: { limit?: number; prefix?: string } = {}): string {
  const lines = user.split('\n').filter(l => /^E\d+: /.test(l)).slice(0, opts.limit ?? 12);
  return JSON.stringify({
    sentences: lines.map(l => {
      const ref = l.slice(0, l.indexOf(':'));
      const body = l.slice(l.indexOf(':') + 2).replace(/\s+/g, ' ').slice(0, 90);
      return { text: `${CANARY}${opts.prefix ?? ''} answer citing ${body}.`, cite: [ref] };
    }),
    gaps: [],
  });
}

export interface StubChat { fn: QuestionChatFn; calls: string[]; fail: boolean; gate?: Promise<void> }

export function stubChat(): StubChat {
  const s: StubChat = { calls: [], fail: false, fn: async () => ({ text: '', usage: null, model: MODEL }) };
  s.fn = async (req) => {
    s.calls.push(req.user);
    if (s.gate) await s.gate;
    if (s.fail) throw new Error('503 provider_error from stub');
    return { text: stubAnswer(req.user), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL };
  };
  return s;
}

/** Gateway-level transport for op journeys (the ops call gateway chat like production). */
export function stubTransport(state: { calls: number; fail: boolean }): (opts: ChatOpts) => Promise<ChatResult> {
  return async (opts) => {
    state.calls++;
    if (state.fail) throw new Error('503 provider_error from stub');
    const user = String(opts.messages[opts.messages.length - 1]?.content ?? '');
    const text = stubAnswer(user);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: opts.model ?? MODEL, providerId: 'anthropic',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  };
}

export interface RemoteAuth { scopes: string[]; sourceId: string; boundSlugPrefixes?: string[] }

/** An MCP call as a remote agent (stdio transport with an explicit grant). */
export async function mcp(engine: BrainEngine, tool: string, params: Record<string, unknown>, auth: RemoteAuth): Promise<{ result: ToolResult; body: Record<string, unknown>; text: string }> {
  const result = await dispatchToolCall(engine, tool, params, {
    remote: true, transport: 'stdio', sourceId: auth.sourceId, config: { engine: engine.kind, embedding_disabled: true } as never, logger,
    auth: { token: 't', clientId: 'pq-agent', scopes: auth.scopes, sourceId: auth.sourceId, allowedSources: [auth.sourceId],
      ...(auth.boundSlugPrefixes ? { boundSlugPrefixes: auth.boundSlugPrefixes } : {}) },
  });
  const text = result.content.map(c => (c as { text?: string }).text ?? '').join('\n');
  let body: Record<string, unknown> = {};
  try { body = JSON.parse((result.content[0] as { text: string }).text); } catch { /* non-JSON */ }
  return { result, body, text };
}
