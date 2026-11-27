/**
 * enrich on an engine without raw SQL (the Rust engine): its evidence reads (readableEvidence, the readable fact rows) are
 * executeRaw, so they refuse with engine_capability_missing. The page must fail by name, never be filled from less evidence.
 *
 * Authoring gate
 *  1. Protects: GST-3815's reader-scope reads stay raw SQL on this trunk; a refusal is not a "no evidence" answer.
 *  2. Fails when: retrieveEvidence swallows the refusal into a WARN and enrich writes a page from the other signals.
 *  3. Why new: GST-3815's tests run on PGLite only.
 *  4. Seams: executeRaw on a PGLite engine is made to throw the refusal for the evidence reads.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runEnrichCore, type SynthesizeFn } from '../../src/commands/enrich.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

test('a refused evidence read fails the page by name and writes nothing', async () => {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {} });
  const original = engine.executeRaw.bind(engine);
  const refusal = Object.assign(new Error('executeRaw is not served by this engine'), { code: 'engine_capability_missing' });
  (engine as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
    if (/FROM facts f\s+JOIN pages t|SELECT 'page' AS kind/.test(sql)) throw refusal;
    return original(sql, params);
  };
  let synthesized = 0;
  const synth: SynthesizeFn = async () => { synthesized++; return '## Overview\nAlice Example.'; };
  try {
    const r = await runEnrichCore(engine, { sourceId: 'default', types: ['person'] as never[], order: 'inbound-links', thinThreshold: 400, model: 'test:model', workers: 1, minContextChars: 20, synthesizeFn: synth });
    expect(r.pages_failed ?? 0).toBeGreaterThan(0);
    expect(synthesized).toBe(0);
  } finally {
    (engine as { executeRaw: unknown }).executeRaw = original;
  }
  expect((await engine.getPage('people/alice-example'))!.compiled_truth).toBe('Stub page.');
}, 60000);
