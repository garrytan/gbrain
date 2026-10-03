/**
 * recall kind filter — filter before per-arm LIMIT / budget.
 *
 * PGLite-only, no provider keys.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runRecall } from '../src/commands/recall.ts';

let engine: PGLiteEngine;
const ENTITY = 'people/kind-example';
const LIMIT = 3;

async function recall(params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, 'recall', params, { remote: false, sourceId: 'default' });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as { facts: Array<{ fact: string; kind: string }> };
}

async function recallCli(args: string[]) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runRecall(engine, [...args, '--json']);
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(out.trim()) as { facts: Array<{ fact: string; kind: string }> };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed the preference first so it falls outside the newest LIMIT rows unless
  // kind filtering happens in SQL before LIMIT.
  await engine.insertFact(
    { fact: 'prefers concise status updates', kind: 'preference', entity_slug: ENTITY, source: 'test' },
    { source_id: 'default' },
  );
  for (let i = 0; i < 6; i++) {
    await engine.insertFact(
      { fact: `ambient fact ${i}`, kind: 'fact', entity_slug: ENTITY, source: 'test' },
      { source_id: 'default' },
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall kind filter', () => {
  test('entity arm filters by kind before limit', async () => {
    const payload = await recall({ entity: ENTITY, kind: 'preference', limit: LIMIT });
    expect(payload.facts.map(f => f.fact)).toEqual(['prefers concise status updates']);
    expect(payload.facts.every(f => f.kind === 'preference')).toBe(true);
  });

  test('unfiltered behavior is unchanged', async () => {
    const payload = await recall({ entity: ENTITY, limit: LIMIT });
    expect(payload.facts).toHaveLength(LIMIT);
    expect(payload.facts.some(f => f.fact === 'prefers concise status updates')).toBe(false);
  });

  test('kind composes with budget packing', async () => {
    const payload = await recall({ entity: ENTITY, kind: 'preference', budget_tokens: 100 });
    expect(payload.facts.map(f => f.kind)).toEqual(['preference']);
  });

  test('named CLI forwards --kind to the same filter', async () => {
    const payload = await recallCli([ENTITY, '--kind', 'preference', '--limit', String(LIMIT)]);
    expect(payload.facts.map(f => f.fact)).toEqual(['prefers concise status updates']);
  });

  test('invalid kind fails closed on the verb surface', async () => {
    const result = await dispatchToolCall(engine, 'recall', { kind: 'not-a-kind' }, { remote: false, sourceId: 'default' });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text);
    expect(error.error).toBe('invalid_params');
  });
});
