/**
 * GBRA-200 (HARN-1 gbrain-memory run): a write naming a source outside the caller's write grant used to answer
 * `scope_denied` with prose only, so a harness gave up. The refusal now names the sources the caller's own grant lets
 * it write (`writable_source_ids`) and, for remember, carries the same call aimed there as its fix. It never names a
 * source outside the grant (a federated read source included), and it is identical whether the named source exists.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

type Out = { content: Array<{ text: string }>; isError?: boolean };
const envelope = (out: Out): Record<string, any> => JSON.parse(out.content[0]!.text);
const member = (sourceId: string): AuthInfo => ({ token: 't', clientId: 'member-example', principal: { kind: 'oauth_client', id: 'member-example' },
  scopes: ['read', 'write'], sourceId, allowedSources: ['source-a', 'source-b'] } as AuthInfo);

let engine: PGLiteEngine;
const call = async (op: string, params: Record<string, unknown>, auth: AuthInfo = member('source-a')) =>
  await dispatchToolCall(engine, op, { request_id: randomUUID(), ...params }, { remote: true, transport: 'stdio', sourceId: auth.sourceId, auth } as never) as Out;
const fact = { fact: 'Alice Example prefers tea.', entity: 'alice-example', provenance: 'test' };
const savedFacts = async () => (await engine.executeRaw<{ source_id: string }>("SELECT source_id FROM facts WHERE fact = $1 AND expired_at IS NULL", [fact.fact])).map(r => r.source_id);

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('sync.write_through', 'false');
  for (const id of ['source-a', 'source-b', 'source-c']) await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);
  await engine.executeRaw("INSERT INTO oauth_clients(client_id, client_name, scope, source_id) VALUES ('member-example', 'Synthetic member client', 'read write', 'source-a')");
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('remember outside the write grant (GBRA-200)', () => {
  test('names only the writable source, never the federated read source, and saves nothing', async () => {
    const out = await call('remember', { ...fact, source_id: 'source-c' });
    expect(out.isError).toBe(true);
    const e = envelope(out);
    expect(e.error).toBe('scope_denied');
    expect(e.writable_source_ids).toEqual(['source-a']);
    expect(JSON.stringify(e)).not.toContain('source-b');
    expect(await savedFacts()).toEqual([]);
  });

  test('the fix repeats the call against the writable source, and running it saves the fact there', async () => {
    const e = envelope(await call('remember', { ...fact, source_id: 'source-c' }));
    expect(e.fix).toMatchObject({ next: 'run', mcp: { tool: 'remember', arguments: { ...fact, source_id: 'source-a' } } });
    expect(e.fix.mcp.arguments.request_id).toBeUndefined();
    const retried = await call(e.fix.mcp.tool, e.fix.mcp.arguments);
    expect(retried.isError).toBeFalsy();
    expect(envelope(retried).status).toBe('inserted');
    expect(await savedFacts()).toEqual(['source-a']);
  });

  test('a source that does not exist gets the same refusal as one that does', async () => {
    const existing = envelope(await call('remember', { ...fact, source_id: 'source-c' }));
    const missing = envelope(await call('remember', { ...fact, source_id: 'source-missing' }));
    expect(JSON.stringify(missing).replaceAll('source-missing', 'source-c')).toBe(JSON.stringify(existing));
  });

  test('a grant whose source is a sentinel names no writable source and offers no retry', async () => {
    const e = envelope(await call('remember', { ...fact, source_id: 'source-a' }, member('__all__')));
    expect(e.error).toBe('scope_denied');
    expect(e.writable_source_ids).toEqual([]);
    expect(e.fix?.mcp?.tool).not.toBe('remember');
  });
});

describe('page writes outside the write grant (GBRA-200)', () => {
  test('put_page names the writable source too, without echoing the page back as a fix', async () => {
    const content = '---\ntype: note\ntitle: Note\n---\n# Note\n\nBody.\n';
    const existing = envelope(await call('put_page', { slug: 'notes/example', content, source_id: 'source-c' }));
    expect(existing.writable_source_ids).toEqual(['source-a']);
    expect(JSON.stringify(existing)).not.toContain('source-b');
    expect(JSON.stringify(existing.fix ?? {})).not.toContain('Body.');
    const missing = envelope(await call('put_page', { slug: 'notes/example', content, source_id: 'source-missing' }));
    expect(JSON.stringify(missing).replaceAll('source-missing', 'source-c')).toBe(JSON.stringify(existing));
  });
});
