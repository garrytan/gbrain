import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

test('precision lookup route operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_precision_lookup_route');
  expect(route?.cliHints?.name).toBe('precision-lookup-route');
});

test('precision lookup route operation returns no-match disclosure and direct route payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_precision_lookup_route');

  if (!route) {
    throw new Error('get_precision_lookup_route operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'systems/unknown',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).route).toBeNull();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Coordinates structural extraction.',
      '',
      '## Runtime',
      'Owns exact retrieval routing.',
      '[Source: User, direct message, 2026-04-22 12:30 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const direct = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'systems/mbrain',
    });

    expect((direct as any).selection_reason).toBe('direct_page_match');
    expect((direct as any).route?.route_kind).toBe('precision_lookup');
    expect((direct as any).route?.slug).toBe('systems/mbrain');

    const byPath = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      path: 'systems/mbrain.md',
    });

    expect((byPath as any).selection_reason).toBe('direct_path_match');
    expect((byPath as any).route?.path).toBe('systems/mbrain.md');

    const bySectionPath = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      path: 'systems/mbrain.md#overview/runtime',
    });

    expect((bySectionPath as any).selection_reason).toBe('direct_section_path_match');
    expect((bySectionPath as any).route?.target_kind).toBe('section');
    expect((bySectionPath as any).route?.path).toBe('systems/mbrain.md#overview/runtime');

    const bySourceRef = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      source_ref: 'User, direct message, 2026-04-22 12:30 PM KST',
    });

    expect((bySourceRef as any).selection_reason).toBe('direct_source_ref_section_match');
    expect((bySourceRef as any).route?.target_kind).toBe('section');
    expect((bySourceRef as any).route?.path).toBe('systems/mbrain.md#overview/runtime');

    await importFromContent(engine, 'systems/brain-graph', [
      '---',
      'type: system',
      'title: Brain Graph',
      '---',
      '# Overview',
      'Maps knowledge structures.',
      '',
      '## Runtime',
      'Owns graph traversal.',
      '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
    ].join('\n'), { path: 'systems/brain-graph.md' });
    await importFromContent(engine, 'systems/brain-cache', [
      '---',
      'type: system',
      'title: Brain Cache',
      '---',
      '# Overview',
      'Caches memory snapshots.',
      '',
      '## Runtime',
      'Owns cache invalidation.',
      '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
    ].join('\n'), { path: 'systems/brain-cache.md' });

    const ambiguous = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      source_ref: 'User, direct message, 2026-04-22 12:31 PM KST',
    });

    expect((ambiguous as any).selection_reason).toBe('ambiguous_source_ref_match');
    expect((ambiguous as any).candidate_count).toBe(2);
    expect((ambiguous as any).route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
