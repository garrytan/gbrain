/**
 * Regression test for the MCP tool-def extraction (v0.16.0 Lane 1A).
 *
 * Before v0.15 the mapping lived inline in src/mcp/server.ts. After the
 * extraction, buildToolDefs is the single source of truth; the subagent tool
 * registry calls it with a filtered OPERATIONS subset. This test pins the
 * extracted output to the pre-extraction shape byte-for-byte so we don't
 * silently drift the MCP-facing tool schema.
 */

import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

// Pre-extraction inline shape — lifted verbatim from the original
// src/mcp/server.ts block so any future drift fails this test loudly.
function legacyInlineMap(ops: typeof operations) {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, {
          type: v.type === 'array' ? 'array' : v.type,
          ...(v.description ? { description: v.description } : {}),
          ...(v.enum ? { enum: v.enum } : {}),
          ...(v.items ? { items: { type: v.items.type } } : {}),
        }]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

describe('buildToolDefs', () => {
  test('output equals pre-extraction inline mapping byte-for-byte', () => {
    const extracted = buildToolDefs(operations);
    const inline = legacyInlineMap(operations);
    expect(JSON.stringify(extracted)).toBe(JSON.stringify(inline));
  });

  test('preserves operation count', () => {
    expect(buildToolDefs(operations).length).toBe(operations.length);
  });

  test('accepts an arbitrary Operation subset (for subagent tool registry)', () => {
    const subset = operations.slice(0, 3);
    const defs = buildToolDefs(subset);
    expect(defs.length).toBe(3);
    expect(defs.map(d => d.name)).toEqual(subset.map(o => o.name));
  });

  test('empty input returns empty array', () => {
    expect(buildToolDefs([])).toEqual([]);
  });

  test('every def has object inputSchema with properties + required array', () => {
    for (const def of buildToolDefs(operations)) {
      expect(def.inputSchema.type).toBe('object');
      expect(typeof def.inputSchema.properties).toBe('object');
      expect(Array.isArray(def.inputSchema.required)).toBe(true);
    }
  });

  test('no array property is missing items (Gemini Pro strict JSON Schema compat)', () => {
    // Strict JSON Schema validators (Gemini Pro tool-call API is the canonical
    // offender, but ChatGPT and others follow the same rule) reject any
    // { type: 'array' } that lacks an items field. A single bad property in the
    // tools/list response blocks the entire MCP tool surface for that session.
    const missing: string[] = [];
    function walk(node: unknown, path: string): void {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'array' && !('items' in obj)) {
        missing.push(path);
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, `${path}.${k}`);
      }
    }
    for (const def of buildToolDefs(operations)) {
      walk(def.inputSchema, `${def.name}.inputSchema`);
    }
    expect(missing).toEqual([]);
  });
});
