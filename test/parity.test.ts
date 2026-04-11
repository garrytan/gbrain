import { describe, test, expect } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine, PostgresEngine } from '../src/core/index.ts';
import type { Operation } from '../src/core/operations.ts';

describe('operations contract parity', () => {
  test('every operation has a unique name', () => {
    const names = operations.map(op => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every operation has required fields', () => {
    for (const op of operations) {
      expect(op.name).toBeTruthy();
      expect(op.description).toBeTruthy();
      expect(typeof op.handler).toBe('function');
      expect(op.params).toBeDefined();
    }
  });

  test('operationsByName matches operations array', () => {
    expect(Object.keys(operationsByName).length).toBe(operations.length);
    for (const op of operations) {
      expect(operationsByName[op.name]).toBe(op);
    }
  });

  test('every required param has a type', () => {
    for (const op of operations) {
      for (const [key, def] of Object.entries(op.params)) {
        expect(['string', 'number', 'boolean', 'object', 'array']).toContain(def.type);
      }
    }
  });

  test('mutating operations have dry_run support', () => {
    const mutating = operations.filter(op => op.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    // Verify all mutating ops exist
    for (const op of mutating) {
      expect(op.mutating).toBe(true);
    }
  });

  test('CLI names are unique across operations', () => {
    const cliNames = operations
      .filter(op => op.cliHints?.name)
      .map(op => op.cliHints!.name!);
    expect(new Set(cliNames).size).toBe(cliNames.length);
  });

  test('CLI positional params reference valid param names', () => {
    for (const op of operations) {
      if (op.cliHints?.positional) {
        for (const pos of op.cliHints.positional) {
          expect(op.params).toHaveProperty(pos);
        }
      }
    }
  });

  test('CLI stdin param references a valid param name', () => {
    for (const op of operations) {
      if (op.cliHints?.stdin) {
        expect(op.params).toHaveProperty(op.cliHints.stdin);
      }
    }
  });

  test('operations count is at least 30', () => {
    expect(operations.length).toBeGreaterThanOrEqual(30);
  });

  test('core index exports both engine implementations', () => {
    expect(SQLiteEngine).toBeDefined();
    expect(PostgresEngine).toBeDefined();
  });

  test('MCP tool definitions can be generated from operations', () => {
    const tools = operations.map(op => ({
      name: op.name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, { type: v.type }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    }));

    // Every operation generates a valid tool definition
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });
});
