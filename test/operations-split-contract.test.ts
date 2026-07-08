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

  test('inline operation families live in domain modules, not operations.ts (O5)', () => {
    const domainModules = [
      'operations-shared.ts',
      'operations-pages.ts',
      'operations-put-page.ts',
      'operations-search.ts',
      'operations-tags-links-timeline.ts',
      'operations-versions.ts',
      'operations-profile-episodes.ts',
      'operations-note-sections.ts',
      'operations-context-maps.ts',
      'operations-retrieval-params.ts',
      'operations-retrieval.ts',
      'operations-misc.ts',
    ];
    for (const moduleFile of domainModules) {
      expect(existsSync(new URL(`../src/core/${moduleFile}`, import.meta.url))).toBe(true);
    }

    const operationsSource = readFileSync(
      new URL('../src/core/operations.ts', import.meta.url),
      'utf-8',
    );
    // operations.ts stays the registry assembler: no inline Operation literals.
    expect(operationsSource).not.toMatch(/^const [a-z0-9_]+: Operation = \{/m);
    for (const opName of ['get_page', 'put_page', 'search', 'add_tag', 'get_versions', 'upsert_profile_memory_entry', 'rebuild_note_sections', 'build_context_map', 'retrieve_context', 'sync_brain', 'get_skillpack']) {
      expect(operationsSource).not.toContain(`const ${opName}: Operation = {`);
    }
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
