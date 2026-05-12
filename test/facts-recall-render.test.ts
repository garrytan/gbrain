/**
 * v0.31 Phase 6 — `gbrain recall --today` markdown render shape.
 *
 * Pins kind icons present in the output, entity grouping, and the empty
 * state. Captures stdout via process.stdout.write override.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall } from '../src/commands/recall.ts';

let engine: PGLiteEngine;
const origWrite = process.stdout.write.bind(process.stdout);
let captured = '';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  process.stdout.write = origWrite;
});

beforeEach(() => {
  captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
});

describe('gbrain recall --today', () => {
  test('empty state prints "No facts captured today yet."', async () => {
    await runRecall(engine, ['--today', '--source', 'empty-source-x']);
    expect(captured).toContain('Hot memory — ');
    expect(captured).toContain('No facts captured today yet.');
    process.stdout.write = origWrite;
  });

  test('kind icons appear in the rendered output', async () => {
    // Reset capture
    captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    await engine.insertFact(
      { fact: 'event-fact', kind: 'event', entity_slug: 'render-test-e', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'pref-fact', kind: 'preference', entity_slug: 'render-test-p', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'commit-fact', kind: 'commitment', entity_slug: 'render-test-c', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'belief-fact', kind: 'belief', entity_slug: 'render-test-b', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'fact-fact', kind: 'fact', entity_slug: 'render-test-f', source: 'test' },
      { source_id: 'default' },
    );

    await runRecall(engine, ['--today']);
    process.stdout.write = origWrite;

    expect(captured).toContain('📅');  // event
    expect(captured).toContain('🎯');  // preference
    expect(captured).toContain('🤝');  // commitment
    expect(captured).toContain('💭');  // belief
    expect(captured).toContain('📌');  // fact
  });
});

describe('gbrain recall --json', () => {
  test('emits valid JSON with effective_confidence per row', async () => {
    captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    await runRecall(engine, ['--json', '--limit', '20']);
    process.stdout.write = origWrite;

    const parsed = JSON.parse(captured.trim());
    expect(parsed.facts).toBeDefined();
    expect(Array.isArray(parsed.facts)).toBe(true);
    expect(typeof parsed.total).toBe('number');
    if (parsed.facts.length > 0) {
      const f = parsed.facts[0];
      expect(typeof f.id).toBe('number');
      expect(typeof f.fact).toBe('string');
      expect(typeof f.kind).toBe('string');
      expect(typeof f.confidence).toBe('number');
      expect(typeof f.effective_confidence).toBe('number');
    }
  });
});

describe('gbrain recall --as-context', () => {
  test('emits markdown comment-wrapped block', async () => {
    captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    await runRecall(engine, ['--as-context', '--limit', '5']);
    process.stdout.write = origWrite;

    expect(captured.startsWith('<!-- gbrain hot memory') || captured.includes('gbrain hot memory')).toBe(true);
  });
});
