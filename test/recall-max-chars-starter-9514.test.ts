/**
 * #9514: a starter client bounds a recall reply with max_chars.
 *
 * 1. Protects: a remote caller on the starter surface (the Claude Code / opencode default) may pass max_chars to
 *    recall and gets a reply cut to whole facts within it, instead of param_not_on_surface and no way to keep a
 *    70-170 KB answer under its client's size limit. Nothing about the unbounded default changes.
 * 2. Fails when: the starter dispatch refuses recall max_chars, or the bounded reply exceeds the cap.
 * 3. Real seams: dispatchToolCall on in-memory PGLite with world facts written through insertFact.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { allowedOpNames } from '../src/mcp/surface.ts';
import { PARAM_NOT_ON_SURFACE_CODE } from '../src/mcp/hidden-tool-hint.ts';

const ENTITY = 'companies/acme-example';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  for (let i = 0; i < 30; i++) {
    await engine.insertFact({ fact: `acme-example harbor ledger entry ${i} ${'x'.repeat(120)}`, kind: 'fact', entity_slug: ENTITY, source: 'test', visibility: 'world' }, { source_id: 'default' });
  }
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

const starter = { remote: true, transport: 'stdio', surface: 'starter', allowedOps: allowedOpNames(operations, 'starter'), sourceId: 'default' } as const;
const text = (res: Awaited<ReturnType<typeof dispatchToolCall>>) => res.content.map(c => c.text).join('\n');

describe('recall max_chars on the starter surface (#9514)', () => {
  test('a starter client passing max_chars gets a bounded reply, not param_not_on_surface', async () => {
    const res = await dispatchToolCall(engine, 'recall', { entity: ENTITY, max_chars: 600 }, starter as never);
    const out = text(res);
    expect(out).not.toContain(PARAM_NOT_ON_SURFACE_CODE);
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.truncated).toBeTruthy();
    const factChars = (body.facts as Array<{ fact: string }>).reduce((n, f) => n + f.fact.length, 0);
    expect(factChars).toBeLessThanOrEqual(600);
    expect(body.facts.length).toBeGreaterThan(0);
  });

  test('without max_chars the starter reply keeps its unbounded default', async () => {
    const res = await dispatchToolCall(engine, 'recall', { entity: ENTITY }, starter as never);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text).facts.length).toBe(30);
  });
});
