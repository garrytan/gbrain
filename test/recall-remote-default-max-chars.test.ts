/**
 * Remote recall with no max_chars must bound the answer like memory_recall does (default 6000), not return
 * every fact (50 rows of ~850 chars). A caller-sent max_chars still wins.
 * Real seams: PGLite, MCP dispatch as a remote caller; no providers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

describe('remote recall default max_chars (pglite)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (let i = 0; i < 40; i++) {
      await engine.insertFact({ fact: `harbor ledger note ${i} ` + 'x'.repeat(800), kind: 'fact', entity_slug: 'companies/acme', source: 'test', visibility: 'world' }, { source_id: 'default' });
    }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  const recall = async (params: Record<string, unknown>) => {
    const auth = { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default' } as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, 'recall', params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { text, json };
  };

  test('no max_chars: the answer is bounded and says it was cut', async () => {
    const out = await recall({ entity: 'companies/acme' });
    expect(out.json.facts.length).toBeLessThan(40);
    expect(out.json.truncated).toBe(true);
  });

  test('an explicit max_chars is still honoured', async () => {
    const out = await recall({ entity: 'companies/acme', max_chars: 12000 });
    expect(out.json.facts.length).toBeGreaterThan(8);
  });
});
