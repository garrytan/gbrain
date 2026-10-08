/**
 * #6146: a fact delivered by `context_pack` or `delta` traces back to its
 * record. Each `facts[]` entry carries recall's v1 names: `fact_id` (the
 * opaque id `forget` accepts) and `provenance` (the stored source attribution,
 * what `remember --provenance` wrote). Remote callers get the provenance
 * through the same credential redaction as the fact text; the trusted local
 * CLI gets it as stored. The rendered `text` is unchanged: provenance never
 * enters it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number) => [...randomBytes(n)].map(b => ALNUM[b % ALNUM.length]).join('');
const KEY = ['sk', rand(40)].join('-');

let engine: PGLiteEngine;
const noop = { info: () => {}, warn: () => {}, error: () => {} };
const local = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger: noop, dryRun: false, remote: false, sourceId: 'default' }) as OperationContext;

type Fact = { fact: string; entity_slug: string | null; fact_id?: string; provenance?: string | null; id?: number };
type Body = { facts: Fact[]; text: string };

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact({ fact: 'Project Boreal uses the colour green.', entity_slug: 'projects/boreal-example', source: 'POC-CORRECTION-2026-10-06', visibility: 'world', embedding: null } as never, { source_id: 'default' });
  await engine.insertFact({ fact: 'Project Atlas uses the colour blue.', entity_slug: null, source: `test:${KEY}`, visibility: 'world', embedding: null } as never, { source_id: 'default' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

async function recallIds(): Promise<Map<string, { id: number; source: string }>> {
  const body = await operationsByName.recall!.handler(local(), { since: '2000-01-01T00:00:00Z' }) as { facts: Array<{ id: number; fact: string; source: string }> };
  return new Map(body.facts.map(f => [f.fact, { id: f.id, source: f.source }]));
}

const ARGS = { context_pack: () => ({ entities: 'projects/boreal-example', session_id: randomUUID() }), delta: () => ({ since: '2000-01-01T00:00:00Z' }) } as const;

describe('#6146 context_pack and delta facts carry fact_id and provenance', () => {
  for (const name of ['context_pack', 'delta'] as const) {
    test(`${name}, trusted local CLI: fact_id matches recall and provenance is the stored source`, async () => {
      __resetHotMemoryCacheForTests();
      const recalled = await recallIds();
      const body = await operationsByName[name]!.handler(local(), ARGS[name]()) as Body;
      const boreal = body.facts.find(f => f.fact.startsWith('Project Boreal'))!;
      const atlas = body.facts.find(f => f.fact.startsWith('Project Atlas'))!;
      expect(boreal.fact_id).toBe(String(recalled.get(boreal.fact)!.id));
      expect(boreal.provenance).toBe('POC-CORRECTION-2026-10-06');
      expect(atlas.fact_id).toBe(String(recalled.get(atlas.fact)!.id));
      expect(atlas.provenance).toBe(`test:${KEY}`);
      expect(body.text).not.toContain('POC-CORRECTION');
    });

    test(`${name}, remote MCP caller: provenance is redacted like the fact text`, async () => {
      __resetHotMemoryCacheForTests();
      const res = await dispatchToolCall(engine as never, name, ARGS[name](), { remote: true, transport: 'stdio', sourceId: 'default' });
      const raw = res.content.map(c => (c as { text?: string }).text ?? '').join('\n');
      expect(raw.includes(KEY)).toBe(false);
      const body = JSON.parse((res.content[0] as { text: string }).text) as Body;
      const atlas = body.facts.find(f => f.fact.startsWith('Project Atlas'))!;
      expect(atlas.provenance).toBe('test:<REDACTED:openai>');
      expect(atlas.fact_id).toMatch(/^\d+$/);
      const boreal = body.facts.find(f => f.fact.startsWith('Project Boreal'))!;
      expect(boreal.provenance).toBe('POC-CORRECTION-2026-10-06');
    });
  }
});
