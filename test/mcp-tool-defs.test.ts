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
import { buildToolDefs, paramDefToSchema } from '../src/mcp/tool-defs.ts';
import type { ParamDef } from '../src/core/operations.ts';

// Reference shape — mirrors the canonical `paramDefToSchema` helper from
// src/mcp/tool-defs.ts. Drift between the helper and this reference fails
// the byte-equality test loudly.
//
// v0.34 update: paramDefToSchema is recursive on `items` so nested
// array-of-arrays preserves the inner shape on the MCP wire. The reference
// below mirrors that recursion. The previous shallow `{ items: { type:
// v.items.type } }` (legacy buildToolDefs) silently dropped nested items
// — explicit fixture assertions below catch the drift class.
//
// `default` is included to match paramDefToSchema; no current op uses
// `default:` at the ParamDef level so the round-trip is unchanged for
// every existing operation, but new ops that add a default get it on the
// wire automatically.
type ParamDefLike = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ParamDefLike;
};
function referenceParamDefToSchema(p: ParamDefLike): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: referenceParamDefToSchema(p.items) } : {}),
  };
}
function legacyInlineMap(ops: typeof operations) {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, referenceParamDefToSchema(v)]),
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

  test('every array property has an items clause (strict JSON Schema)', () => {
    // OpenAI's tool API and other strict JSON Schema validators reject an
    // "array" property that lacks "items". An offender causes the entire
    // toolset to fail upload with HTTP 400 before any tool is invoked.
    const violations: string[] = [];
    for (const def of buildToolDefs(operations)) {
      for (const [propName, propSchema] of Object.entries(def.inputSchema.properties)) {
        const s = propSchema as { type?: unknown; items?: unknown };
        if (s && typeof s === 'object' && s.type === 'array' && !s.items) {
          violations.push(`${def.name}.${propName}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural array-items guard (v0.34 fix wave).
//
// JSON Schema strict-mode validators (Gemini Pro strict, OpenAI structured
// outputs) reject `type: 'array'` without `items`. Pre-v0.34 this happened
// in production: `extract_facts.entity_hints` and `handle_to_tweet`'s
// `candidates` both shipped as bare arrays.
//
// This recursive guard walks every tool def's inputSchema and fails the
// suite with a property path if any array lacks `items.type`. Drift-proof
// against future ops adding bare arrays.
// ---------------------------------------------------------------------------

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [k: string]: unknown;
}

function findArrayWithoutItems(node: SchemaNode, path: string[]): string[] {
  const violations: string[] = [];
  if (node && typeof node === 'object') {
    if (node.type === 'array') {
      if (!node.items || typeof node.items !== 'object') {
        violations.push(`${path.join('.') || '<root>'} (array missing items)`);
      } else if (!('type' in node.items)) {
        violations.push(`${path.join('.') || '<root>'}.items (items missing type)`);
      } else {
        violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
      }
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, child] of Object.entries(node.properties)) {
        violations.push(...findArrayWithoutItems(child as SchemaNode, [...path, k]));
      }
    }
    if (node.items && typeof node.items === 'object' && node.type !== 'array') {
      violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
    }
  }
  return violations;
}

describe('paramDefToSchema structural guard', () => {
  test('every operation inputSchema array has items.type set (no bare arrays)', () => {
    const allViolations: string[] = [];
    for (const def of buildToolDefs(operations)) {
      const v = findArrayWithoutItems(def.inputSchema as SchemaNode, [def.name]);
      allViolations.push(...v);
    }
    expect(allViolations).toEqual([]);
  });

  test('extract_facts.entity_hints declares items.type as string', () => {
    const def = buildToolDefs(operations).find(d => d.name === 'extract_facts');
    expect(def).toBeDefined();
    const eh = (def!.inputSchema.properties as Record<string, SchemaNode>).entity_hints;
    expect(eh.type).toBe('array');
    expect(eh.items).toBeDefined();
    expect((eh.items as SchemaNode).type).toBe('string');
  });

  test('paramDefToSchema recursively propagates nested items.items.type', () => {
    // Synthetic ParamDef: array-of-arrays-of-strings. No current op uses
    // this shape, so this test pins the contract for future ops and proves
    // the helper recurses (closes the v0.32 nested-drop bug class).
    const nested: ParamDef = {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    };
    const schema = paramDefToSchema(nested) as SchemaNode;
    expect(schema.type).toBe('array');
    expect((schema.items as SchemaNode).type).toBe('array');
    expect(((schema.items as SchemaNode).items as SchemaNode).type).toBe('string');
  });

  test('paramDefToSchema preserves description on nested items', () => {
    const p: ParamDef = {
      type: 'array',
      description: 'outer',
      items: {
        type: 'string',
        description: 'inner',
      },
    };
    const schema = paramDefToSchema(p) as SchemaNode;
    expect(schema.description).toBe('outer');
    expect((schema.items as SchemaNode).description).toBe('inner');
  });
});
