/**
 * v0.31 Phase 6 — visibility ACL parity with takes (D21).
 *
 * Pins: visibility column is private/world; remote (untrusted) callers see
 * world-only when the recall op enforces the filter. Local CLI sees all.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact(
    { fact: 'world-visible', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'private-only', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'private' },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('visibility column', () => {
  test('insertFact stores visibility in DB', async () => {
    const rows = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM facts WHERE entity_slug = 'vis-test'`,
    );
    const tiers = rows.map(r => r.visibility).sort();
    expect(tiers).toEqual(['private', 'world']);
  });

  test('listFactsByEntity with visibility=[world] returns only world rows', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['world'] });
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe('world-visible');
    expect(rows[0].visibility).toBe('world');
  });

  test('listFactsByEntity with visibility=[private,world] returns both', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['private', 'world'] });
    expect(rows.length).toBe(2);
  });

  test('listFactsByEntity with no visibility filter returns all', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test');
    expect(rows.length).toBe(2);
  });
});

describe('recall op visibility enforcement', () => {
  test('remote=true → only world facts in payload', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: true,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(1);
    expect(payload.facts[0].fact).toBe('world-visible');
  });

  test('remote=false → all visibility tiers in payload', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: false,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(2);
  });
});
