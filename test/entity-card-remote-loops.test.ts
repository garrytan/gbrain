/**
 * Remote entity cards, context packs and delta never carry open-loop-backed threads.
 *
 * Loops have no visibility or grant of their own: a summary derives from
 * private mail, and a Gmail-source loop can point at a world person page in
 * `default` (#5504). Through the real remote handlers (MCP dispatch,
 * remote: true), neither a same-source loop backed by a private commitment
 * fact nor an out-of-grant google-source loop may surface its summary, due
 * date or loop_id. Trusted local callers still see both loops.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const PRIVATE_LOOP = 'PRIVATE-LOOP-SENTINEL send the signed term sheet';
const GRANT_LOOP = 'OUT-OF-GRANT-LOOP-SENTINEL reply owed about the offer';
const DUE = '2031-03-04T05:06:07.000Z';

let engine: PGLiteEngine;
const loopIds: number[] = [];
const noop = { info: () => {}, warn: () => {}, error: () => {} };
const local = (): OperationContext =>
  ({ engine, config: {} as GBrainConfig, logger: noop, dryRun: false, remote: false, sourceId: 'default' }) as OperationContext;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('gmail-example', 'gmail-example', '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'Alice Example, a founder at acme-example.' }, { sourceId: 'default' });
  const fact = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility)
     VALUES ('default', 'people/alice-example', $1, 'commitment', 'loops-extract-test', 'private') RETURNING id`,
    [PRIVATE_LOOP],
  );
  loopIds.push((await upsertOpenLoop(engine, {
    sourceId: 'default', dedupKey: 'commit:private0001', loopType: 'commitment_owed_by_me',
    counterpartySlug: 'people/alice-example', summary: PRIVATE_LOOP, evidence: [{ message_id: 'm-private-1', quote: 'quote' }],
    detector: 'llm_extract', dueAt: DUE, factId: Number(fact[0].id),
  })).id);
  loopIds.push((await upsertOpenLoop(engine, {
    sourceId: 'gmail-example', dedupKey: 'thread:18c2f4a9b3d21e07:unanswered_inbound', loopType: 'unanswered_inbound',
    counterpartySlug: 'people/alice-example', counterpartySourceId: 'default', counterpartyEmail: 'alice@example.com',
    summary: GRANT_LOOP, evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'quote' }], threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread', dueAt: DUE,
  })).id);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

function expectNoLoop(raw: string) {
  expect(raw).not.toContain('LOOP-SENTINEL');
  expect(raw).not.toContain('2031-03-04');
  expect(raw).not.toContain('loop_id');
}

async function remote(name: string, params: Record<string, unknown>): Promise<{ raw: string; body: Record<string, any> }> {
  const res = await dispatchToolCall(engine as never, name, params, { remote: true, transport: 'stdio', sourceId: 'default' });
  expect(res.isError).toBeFalsy();
  const texts = res.content.map(c => (c as { text?: string }).text ?? '');
  return { raw: texts.join('\n'), body: JSON.parse(texts[0]!) };
}

describe('remote entity, context_pack and delta withhold open loops', () => {
  test('remote entity card carries neither loop, and still returns the card', async () => {
    const { raw, body } = await remote('entity', { name: 'people/alice-example' });
    expect(body.card.entity.slug).toBe('people/alice-example');
    expectNoLoop(raw);
  });

  test('remote context_pack carries neither loop in cards, open_threads or text', async () => {
    __resetHotMemoryCacheForTests();
    const { raw, body } = await remote('context_pack', { entities: 'people/alice-example', session_id: randomUUID() });
    expect(body.cards.map((c: { slug: string }) => c.slug)).toContain('people/alice-example');
    expectNoLoop(raw);
  });

  test('remote context_pack cannot widen with include_private', async () => {
    __resetHotMemoryCacheForTests();
    expectNoLoop((await remote('context_pack', { entities: 'people/alice-example', session_id: randomUUID(), include_private: true })).raw);
  });

  test('remote delta thread events carry neither loop', async () => {
    expectNoLoop((await remote('delta', { since: '2000-01-01T00:00:00Z', entities: 'people/alice-example' })).raw);
  });

  test('trusted local delta with include_private still shows both loops', async () => {
    const body = await operationsByName.delta!.handler(local(), { since: '2000-01-01T00:00:00Z', entities: 'people/alice-example', include_private: true });
    expect(JSON.stringify(body)).toContain(PRIVATE_LOOP);
    expect(JSON.stringify(body)).toContain(GRANT_LOOP);
  });

  test('trusted local entity card still shows both loops with loop_id and due', async () => {
    const body = await operationsByName.entity!.handler(local(), { name: 'people/alice-example' }) as
      { card: { open_threads: Array<{ text: string; loop_id?: number; due?: string | null }> } };
    const loops = body.card.open_threads.filter(t => t.loop_id !== undefined);
    expect(loops.map(t => t.text).sort()).toEqual([GRANT_LOOP, PRIVATE_LOOP].sort());
    expect(loops.map(t => t.loop_id).sort()).toEqual([...loopIds].sort());
    for (const t of loops) expect(new Date(t.due as string).toISOString()).toBe(DUE);
  });

  test('trusted local context_pack with include_private still shows both loops', async () => {
    __resetHotMemoryCacheForTests();
    const body = await operationsByName.context_pack!.handler(local(), { entities: 'people/alice-example', session_id: randomUUID(), include_private: true }) as
      { open_threads: Array<{ text: string; loop_id?: number }> };
    expect(body.open_threads.filter(t => t.loop_id !== undefined).map(t => t.text).sort()).toEqual([GRANT_LOOP, PRIVATE_LOOP].sort());
  });
});

describe('remote open_loops ranking ignores backlinks outside the grant', () => {
  const AS_OF = '2026-10-16T00:00:00Z';
  const AT = '2026-10-10T00:00:00.000Z';
  const top = async (remoteCall: boolean): Promise<string[]> => {
    const params = { as_of: AS_OF, limit: 1 };
    if (!remoteCall) {
      const body = await operationsByName.open_loops!.handler({ ...local(), sourceId: 'gmail-granted' } as OperationContext, params) as { groups: Array<{ counterparty: string }> };
      return body.groups.map(g => g.counterparty);
    }
    const res = await dispatchToolCall(engine as never, 'open_loops', params, {
      remote: true, transport: 'http', sourceId: 'gmail-granted',
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['gmail-granted'] } as never,
    });
    expect(res.isError).toBeFalsy();
    return (JSON.parse((res.content[0] as { text: string }).text) as { groups: Array<{ counterparty: string }> }).groups.map(g => g.counterparty);
  };

  test('a backlink added only in an ungranted source does not change the remote order; trusted local still ranks by it', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('gmail-granted', 'gmail-granted', '{"kind":"google"}'::jsonb), ('private-other', 'private-other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('people/z-example', { title: 'Z Example', type: 'person', compiled_truth: 'Z Example.' }, { sourceId: 'private-other' });
    await engine.putPage('notes/z-ref', { title: 'Z ref', type: 'note', compiled_truth: 'About Z Example.' }, { sourceId: 'private-other' });
    const base = { sourceId: 'gmail-granted', loopType: 'unanswered_inbound' as const, evidence: [{ message_id: 'm', quote: 'q' }],
      detector: 'deterministic_thread' as const, lastActivityAt: AT, openedAt: AT };
    await upsertOpenLoop(engine, { ...base, dedupKey: 'thread:aaaa:unanswered_inbound', counterpartyEmail: 'a@example.invalid', summary: 'Reply owed to a' });
    await upsertOpenLoop(engine, { ...base, dedupKey: 'thread:zzzz:unanswered_inbound', counterpartySlug: 'people/z-example', counterpartySourceId: 'private-other', summary: 'Reply owed to z' });

    expect(await top(true)).toEqual(['a@example.invalid']);
    expect(await top(false)).toEqual(['a@example.invalid']);
    await engine.addLink('notes/z-ref', 'people/z-example', 'about', 'references', 'manual', undefined, undefined, { fromSourceId: 'private-other', toSourceId: 'private-other' });
    expect(await top(true)).toEqual(['a@example.invalid']);
    expect(await top(false)).toEqual(['people/z-example']);
  });
});
