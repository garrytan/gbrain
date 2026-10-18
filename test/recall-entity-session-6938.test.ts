/** #6938: entity and session intersect before LIMIT, with or without a window. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine, NewFact } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runRecall } from '../src/commands/recall.ts';
import { testBackends } from './helpers/test-backends.ts';

const ENTITY = 'people/session-example';
const SESSION = "wanted-'%_session";
const WANTED = 'older desired fact with literal 50%_done';
const OTHER = 'newer unrelated session fact';

for (const backend of testBackends()) describe(`entity/session intersection (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB, getEngine } = await import('./e2e/helpers.ts');
      await setupDB();
      engine = getEngine();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other-source', 'Other source')");
    const seed = (fact: string, session: string, date: string, extra: Partial<NewFact> = {}, source = 'default') =>
      engine.insertFact({ fact, kind: 'fact', entity_slug: ENTITY, source: 'test', source_session: session,
        valid_from: new Date(date), visibility: 'world', ...extra }, { source_id: source });
    await seed(WANTED, SESSION, '2020-01-01');
    await seed(OTHER, 'other-session', '2026-01-01');
    await seed('wanted session but another entity', SESSION, '2025-01-01', { entity_slug: 'people/someone-else' });
    await seed('private newest fact', SESSION, '2025-02-01', { visibility: 'private' });
    await seed('expired newest fact', SESSION, '2025-03-01');
    await engine.executeRaw("UPDATE facts SET expired_at = '2025-04-01' WHERE fact = 'expired newest fact'");
    await seed('TTL-lapsed newest fact', SESSION, '2025-04-01', { valid_until: new Date('2025-05-01') });
    await seed('another source newest fact', SESSION, '2025-05-01', {}, 'other-source');
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') {
      const { teardownDB } = await import('./e2e/helpers.ts');
      await teardownDB();
    } else await engine?.disconnect();
  });

  async function op(params: Record<string, unknown>) {
    const result = await dispatchToolCall(engine, 'recall', { entity: ENTITY, session_id: SESSION, limit: 1, ...params },
      { remote: true, sourceId: 'default' });
    expect(result.isError).toBeFalsy();
    return (JSON.parse(result.content[0].text).facts as Array<{ fact: string }>).map(f => f.fact);
  }
  async function cli(args: string[]) {
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try { await runRecall(engine, [ENTITY, '--session', SESSION, '--limit', '1', '--source', 'default', '--json', ...args]); }
    finally { process.stdout.write = original; }
    return (JSON.parse(output).facts as Array<{ fact: string }>).map(f => f.fact);
  }

  test('remote op applies session, entity, visibility and active fences before LIMIT', async () => {
    expect(await op({})).toEqual([WANTED]);
    expect(await op({ since: '2019-01-01' })).toEqual([WANTED]);
  });
  test('local CLI preserves the intersection without changing entity ordering', async () => {
    expect(await cli([])).toEqual(['private newest fact']);
    expect(await cli(['--since', '2019-01-01'])).toEqual(['private newest fact']);
    // Local callers may see private facts; grep selects the public fixture.
    expect(await cli(['--grep', '50%_done'])).toEqual([WANTED]);
    expect(await cli(['--grep', '50%_done', '--since', '2019-01-01'])).toEqual([WANTED]);
  });
  test('an absent session returns empty, not entity or text-fallback facts', async () => {
    expect(await op({ session_id: 'missing-session' })).toEqual([]);
    expect(await cli(['--session', 'missing-session'])).toEqual([]);
  });
  test('literal grep and session selectors compose before LIMIT', async () => {
    expect(await op({ grep: '50%_done' })).toEqual([WANTED]);
    expect(await op({ grep: '50Xdone' })).toEqual([]);
  });
  test('entity-only and session-only arms retain their selectors', async () => {
    expect(await op({ session_id: undefined })).toEqual([OTHER]);
    expect(await op({ entity: undefined })).toEqual(['wanted session but another entity']);
  });
  test('engine intersection preserves pagination, history and source isolation', async () => {
    const opts = { sessionId: SESSION, visibility: ['world'] as const };
    // Read through both storage adapters, without the operation's policy fold.
    const rows = await engine.listFactsByEntity('default', ENTITY, { ...opts, visibility: ['world'], limit: 1 });
    expect(rows.map(r => r.fact)).toEqual([WANTED]);
    expect(await engine.listFactsByEntity('default', ENTITY, { ...opts, visibility: ['world'], offset: 1 })).toEqual([]);
    const history = await engine.listFactsByEntity('default', ENTITY, { ...opts, visibility: ['world'], activeOnly: false });
    expect(history.map(r => r.fact)).toEqual(['TTL-lapsed newest fact', 'expired newest fact', WANTED]);
    expect((await engine.listFactsByEntity('other-source', ENTITY, { sessionId: SESSION })).map(r => r.fact))
      .toEqual(['another source newest fact']);
  });
});
