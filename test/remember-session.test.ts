/**
 * `remember` records the transport's session on the fact, as `extract_facts` does, so `recall`'s
 * `session_id` filter finds single facts too. The session rides MCP `_meta.session_id`: identity only,
 * never a trust surface, and no new parameter.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('remember records the MCP session', () => {
  test('a fact remembered in a session is recalled by that session, and not by another', async () => {
    const res = await dispatchToolCall(
      engine,
      'remember',
      { fact: 'the ledger closes on Fridays', provenance: 'test', _meta: { session_id: 'sess-a' } },
      { ...STDIO },
    );
    expect(res.isError ?? false).toBe(false);
    const { id } = parsed(res);

    const mine = parsed(await dispatchToolCall(engine, 'recall', { session_id: 'sess-a' }, { ...STDIO }));
    expect(mine.facts.map((f: { fact_id: string }) => f.fact_id)).toContain(id);

    const other = parsed(await dispatchToolCall(engine, 'recall', { session_id: 'sess-b' }, { ...STDIO }));
    expect(other.facts.map((f: { fact_id: string }) => f.fact_id)).not.toContain(id);
  });

  test('the transport-resolved session wins over the arguments-level one', async () => {
    const res = await dispatchToolCall(
      engine,
      'remember',
      { fact: 'the bank settles at noon', provenance: 'test', _meta: { session_id: 'sess-args' } },
      { ...STDIO, sessionId: 'sess-transport' },
    );
    const { id } = parsed(res);
    const byTransport = parsed(
      await dispatchToolCall(engine, 'recall', { session_id: 'sess-transport' }, { ...STDIO }),
    );
    expect(byTransport.facts.map((f: { fact_id: string }) => f.fact_id)).toContain(id);
  });

  test('a fact remembered with no session has none', async () => {
    const res = await dispatchToolCall(engine, 'remember', { fact: 'payroll runs monthly', provenance: 'test' }, { ...STDIO });
    const { id } = parsed(res);
    const any = parsed(await dispatchToolCall(engine, 'recall', { session_id: 'sess-a' }, { ...STDIO }));
    expect(any.facts.map((f: { fact_id: string }) => f.fact_id)).not.toContain(id);
  });
});
