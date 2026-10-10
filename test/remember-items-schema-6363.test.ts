/**
 * #6363: `remember.items` advertised `{ type: 'object' }` with no properties
 * and a description naming only `{fact, provenance}`, so a caller following
 * the schema never learned that each item accepts `entity` (plus the other
 * single-fact fields) and stored unlinked facts.
 *
 * Protects: the advertised per-item schema of `remember.items` names every
 * field the batch handler accepts (`REMEMBER_ITEM_KEYS`), on the full
 * surface as JSON Schema `properties` and on the starter surface in the
 * description, where the nested schema stays open so the starter tool list
 * keeps its budget (test/mcp-schema-budget.test.ts).
 * Fails when: a field is added to the handler's allow-list without the
 * schema, the item schema loses `entity`, or the starter filter stops
 * stripping nested full-surface-only members (budget regression).
 * Why new: mcp-schema-budget pins sizes and top-level phrases; remember-batch
 * tests the handler. Nothing compared the advertised item schema to the
 * handler's accepted keys.
 * Seam: none (operations + the surface filter + the schema mapper).
 */
import { describe, expect, test } from 'bun:test';
import { operations, type Operation } from '../src/core/operations.ts';
import { REMEMBER_ITEM_KEYS } from '../src/core/remember-batch.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

type Schema = Record<string, unknown> & { properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: string[]; description?: string };

function itemsSchema(op: Operation): Schema {
  const [def] = buildToolDefs([op]);
  return (def.inputSchema.properties as Record<string, Schema>).items;
}

const fullRemember = operations.find(o => o.name === 'remember')!;
const starterRemember = filterOpsForSurface(operations, 'starter').find(o => o.name === 'remember')!;

describe('remember.items advertises its per-item fields (#6363)', () => {
  test('full surface: the item schema declares exactly the fields the handler accepts', () => {
    const item = itemsSchema(fullRemember).items!;
    expect(item.type).toBe('object');
    expect(Object.keys(item.properties ?? {}).sort()).toEqual([...REMEMBER_ITEM_KEYS].sort());
    expect(item.required).toEqual(['fact']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties!.entity.type).toBe('string');
    expect(item.properties!.kind.enum).toEqual(fullRemember.params.kind.enum);
    expect(item.properties!.visibility.enum).toEqual(fullRemember.params.visibility.enum);
    expect(item.properties!.infer_entity.type).toBe('boolean');
  });

  test('both surfaces: the items description names entity', () => {
    for (const op of [fullRemember, starterRemember]) {
      expect(itemsSchema(op).description, op === fullRemember ? 'full' : 'starter').toContain('entity');
    }
  });

  test('starter surface: the item stays an open object so the tool keeps its budget', () => {
    const item = itemsSchema(starterRemember).items!;
    expect(item.type).toBe('object');
    expect(item.properties).toBeUndefined();
    expect(item.required).toBeUndefined();
    expect(item.additionalProperties).toBeUndefined();
  });

  test('the handler still accepts every advertised item field', () => {
    for (const key of Object.keys(itemsSchema(fullRemember).items!.properties!)) expect(REMEMBER_ITEM_KEYS.has(key), key).toBe(true);
  });
});

describe('starter surface strips nested full-surface-only members', () => {
  const synthetic = {
    ...fullRemember,
    params: {
      fact: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fact: { type: 'string', required: true, fullSurfaceOnly: true },
            entity: { type: 'string', fullSurfaceOnly: true },
          },
        },
      },
      options: {
        type: 'object',
        properties: {
          keep: { type: 'string' },
          drop: { type: 'boolean', fullSurfaceOnly: true },
        },
      },
    },
  } as unknown as Operation;

  test('a nested properties map that empties is dropped; a partial one keeps its public members', () => {
    const [op] = filterOpsForSurface([synthetic], 'starter');
    expect(op.params.items.items!.properties).toBeUndefined();
    expect(Object.keys(op.params.options.properties!)).toEqual(['keep']);
    // The full surface is untouched.
    const [full] = filterOpsForSurface([synthetic], 'full');
    expect(Object.keys(full.params.items.items!.properties!)).toEqual(['fact', 'entity']);
    expect(Object.keys(full.params.options.properties!)).toEqual(['keep', 'drop']);
  });
});
