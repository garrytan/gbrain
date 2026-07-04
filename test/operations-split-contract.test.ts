import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';

describe('operations module split contract', () => {
  test('operational memory and note-manifest operations live outside operations.ts', () => {
    expect(existsSync(new URL('../src/core/operations-tasks.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/core/operations-note-manifest.ts', import.meta.url))).toBe(true);

    const operationsSource = readFileSync(
      new URL('../src/core/operations.ts', import.meta.url),
      'utf-8',
    );
    expect(operationsSource).not.toContain('const list_tasks: Operation');
    expect(operationsSource).not.toContain('const get_note_manifest_entry: Operation');
  });

  test('retrieve-context graph frontier builder lives outside the main service', () => {
    expect(existsSync(new URL('../src/core/services/retrieve-context-graph-frontier-service.ts', import.meta.url))).toBe(true);

    const retrieveContextSource = readFileSync(
      new URL('../src/core/services/retrieve-context-service.ts', import.meta.url),
      'utf-8',
    );
    expect(retrieveContextSource).not.toContain('function graphFrontierEdge(');
    expect(retrieveContextSource).toContain("from './retrieve-context-graph-frontier-service.ts'");
  });
});
