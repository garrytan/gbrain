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
    // MEMORY_VERBS v1: ToolAnnotations passthrough, emitted ONLY when the op
    // defines them. The byte-stability contract is per-op: ops WITHOUT
    // annotations keep the exact pre-v1 shape (pinned explicitly below).
    ...(op.annotations ? { annotations: op.annotations } : {}),
  }));
}

describe('buildToolDefs', () => {
  test('output equals pre-extraction inline mapping byte-for-byte', () => {
    const extracted = buildToolDefs(operations);
    const inline = legacyInlineMap(operations);
    expect(JSON.stringify(extracted)).toBe(JSON.stringify(inline));
  });

  test('explicit strictParams:false / empty opts stay byte-identical to the default emission (WP3)', () => {
    const base = JSON.stringify(buildToolDefs(operations));
    expect(JSON.stringify(buildToolDefs(operations, {}))).toBe(base);
    expect(JSON.stringify(buildToolDefs(operations, { strictParams: false }))).toBe(base);
  });

  test('ops without annotations keep the pre-annotations shape exactly (no annotations key)', () => {
    const extracted = buildToolDefs(operations);
    for (const def of extracted) {
      const op = operations.find(o => o.name === def.name)!;
      if (!op.annotations) {
        expect('annotations' in def).toBe(false);
        expect(Object.keys(def)).toEqual(['name', 'description', 'inputSchema']);
      }
    }
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

  test('put_page warns that content is a whole-page replacement and requires a canonical read first', () => {
    const putPage = buildToolDefs(operations).find(def => def.name === 'put_page');
    expect(putPage).toBeDefined();

    const content = putPage!.inputSchema.properties.content as { description?: string };
    for (const description of [putPage!.description, content.description]) {
      expect(description).toContain('REPLACES the entire page');
      expect(description).toContain('not a partial edit');
      expect(description).toContain('get_page');
      expect(description).toContain('include_content:true');
    }
  });

  test('GBRAIN_MCP_INSTRUCTIONS carries the same put_page contract phrases (triple-home tie)', async () => {
    // The whole-page-replacement contract lives in THREE client-visible homes:
    // the put_page tool description, its content-param description (both
    // pinned above), and the initialize-handshake instructions. A client that
    // reads only the instructions must get the same guidance — this ties the
    // third home to the same phrase set so they cannot drift apart.
    const { GBRAIN_MCP_INSTRUCTIONS } = await import('../src/mcp/instructions.ts');
    for (const phrase of [
      'REPLACES the entire page',
      'not a partial edit',
      'get_page',
      'include_content:true',
    ]) {
      expect(GBRAIN_MCP_INSTRUCTIONS).toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------------------
// WP3 (D14.1) — strictParams emission state.
//
// With mcp.strict_params = 'reject' the transports build schemas that CLOSE
// the property set (`additionalProperties: false`); the two dispatch-level
// passthrough keys (`_meta`, `dry_run`) must then be DECLARED so
// schema-validating clients (Gemini strict, OpenAI structured outputs) don't
// strip them from arguments. Both emission states are pinned here; the
// default state's byte-identity is pinned above.
// ---------------------------------------------------------------------------

describe('buildToolDefs strictParams emission (WP3/D14.1)', () => {
  const strictDefs = buildToolDefs(operations, { strictParams: true });

  test('every strict def closes the schema and declares _meta + dry_run', () => {
    for (const def of strictDefs) {
      expect(def.inputSchema.additionalProperties).toBe(false);
      const props = def.inputSchema.properties as Record<string, { type?: string }>;
      expect(props._meta).toBeDefined();
      expect(props._meta.type).toBe('object');
      expect(props.dry_run).toBeDefined();
      expect(props.dry_run.type).toBe('boolean');
    }
  });

  test('an op with a REAL declared dry_run param keeps its own schema (no clobber)', () => {
    const op = operations.find(o => 'dry_run' in o.params)!;
    expect(op).toBeDefined();
    const def = strictDefs.find(d => d.name === op.name)!;
    const props = def.inputSchema.properties as Record<string, { description?: string }>;
    // The declared param's own description survives; the injected fallback
    // (bare {type:'boolean'}) is only used when the op doesn't declare one.
    expect(props.dry_run.description).toBe(op.params.dry_run.description);
  });

  test('strict mode changes ONLY additionalProperties + the two passthrough keys', () => {
    const base = buildToolDefs(operations);
    for (let i = 0; i < base.length; i++) {
      const strict = strictDefs[i];
      const loose = base[i];
      expect(strict.name).toBe(loose.name);
      // Same declared params, byte-identical per-param schemas.
      for (const [k, v] of Object.entries(loose.inputSchema.properties)) {
        expect(JSON.stringify((strict.inputSchema.properties as Record<string, unknown>)[k])).toBe(JSON.stringify(v));
      }
      const extraKeys = Object.keys(strict.inputSchema.properties)
        .filter(k => !(k in loose.inputSchema.properties));
      expect(extraKeys.sort()).toEqual(['_meta', 'dry_run'].filter(k => !(k in loose.inputSchema.properties)).sort());
      expect(strict.inputSchema.required).toEqual(loose.inputSchema.required);
    }
  });

  test('default emission never carries additionalProperties', () => {
    for (const def of buildToolDefs(operations)) {
      expect('additionalProperties' in def.inputSchema).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// WP3 (T6) — param-description completeness walker.
//
// Every param of every non-localOnly op is an agent-facing contract: a param
// without a description is exactly the "unguessable arg names" consumer
// complaint. localOnly ops are exempt (operator-facing CLI surface). Mirrors
// the findArrayWithoutItems drift-guard pattern below.
// ---------------------------------------------------------------------------

describe('param description completeness (WP3)', () => {
  test('every non-localOnly op param carries a non-empty description', () => {
    const violations: string[] = [];
    for (const op of operations) {
      if (op.localOnly) continue;
      for (const [key, def] of Object.entries(op.params)) {
        if (typeof def.description !== 'string' || def.description.trim() === '') {
          violations.push(`${op.name}.${key}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // WP4 (amendment 22): every non-localOnly op must carry an `area` — the
  // request_tools catalog groups by it, and an op missing from the central
  // OP_AREAS map in operations.ts would silently land in the 'other' bucket.
  // Area NAMES are non-contractual; presence is not.
  test('every non-localOnly op carries a non-empty area (WP4)', () => {
    const violations: string[] = [];
    for (const op of operations) {
      if (op.localOnly) continue;
      if (typeof op.area !== 'string' || op.area.trim() === '') {
        violations.push(op.name);
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
