import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { getPrecisionLookupRoute } from '../src/core/services/precision-lookup-route-service.ts';

test('precision lookup route service resolves an exact canonical page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-page-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Coordinates structural extraction.',
      '[Source: User, direct message, 2026-04-22 11:50 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const result = await getPrecisionLookupRoute(engine, {
      slug: 'systems/mbrain',
    });

    expect(result.selection_reason).toBe('direct_page_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.route_kind).toBe('precision_lookup');
    expect(result.route?.target_kind).toBe('page');
    expect(result.route?.slug).toBe('systems/mbrain');
    expect(result.route?.section_id).toBeUndefined();
    expect(result.route?.path).toBe('systems/mbrain.md');
    expect(result.route?.retrieval_route).toEqual([
      'direct_canonical_artifact',
      'minimal_supporting_reads',
    ]);
    expect(result.route?.summary_lines).toContain('Precision lookup is anchored to exact canonical page systems/mbrain.');
    expect(result.route?.recommended_reads.map((read) => read.page_slug)).toEqual([
      'systems/mbrain',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service resolves an exact canonical page by path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-path-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Coordinates structural extraction.',
      '[Source: User, direct message, 2026-04-22 12:10 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const result = await getPrecisionLookupRoute(engine, {
      path: 'systems/mbrain.md',
    });

    expect(result.selection_reason).toBe('direct_path_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.target_kind).toBe('page');
    expect(result.route?.slug).toBe('systems/mbrain');
    expect(result.route?.path).toBe('systems/mbrain.md');
    expect(result.route?.summary_lines).toContain('Precision lookup is anchored to exact canonical path systems/mbrain.md.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service resolves an exact canonical section with narrow supporting reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-section-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

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
      '[Source: User, direct message, 2026-04-22 11:51 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const [, runtime] = await engine.listNoteSectionEntries({
      scope_id: 'workspace:default',
      page_slug: 'systems/mbrain',
      limit: 10,
    });
    if (!runtime) {
      throw new Error('runtime section fixture was not indexed');
    }

    const result = await getPrecisionLookupRoute(engine, {
      section_id: runtime.section_id,
    });

    expect(result.selection_reason).toBe('direct_section_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.target_kind).toBe('section');
    expect(result.route?.slug).toBe('systems/mbrain');
    expect(result.route?.section_id).toBe(runtime.section_id);
    expect(result.route?.summary_lines).toContain(`Precision lookup is anchored to exact canonical section ${runtime.heading_text}.`);
    expect(result.route?.recommended_reads.map((read) => read.node_kind)).toEqual([
      'section',
      'page',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service resolves an exact canonical section by anchored path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-section-path-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

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
      '[Source: User, direct message, 2026-04-22 12:20 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const [, runtime] = await engine.listNoteSectionEntries({
      scope_id: 'workspace:default',
      page_slug: 'systems/mbrain',
      limit: 10,
    });
    if (!runtime) {
      throw new Error('runtime section fixture was not indexed');
    }

    const result = await getPrecisionLookupRoute(engine, {
      path: 'systems/mbrain.md#overview/runtime',
    });

    expect(result.selection_reason).toBe('direct_section_path_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.target_kind).toBe('section');
    expect(result.route?.slug).toBe('systems/mbrain');
    expect(result.route?.section_id).toBe(runtime.section_id);
    expect(result.route?.path).toBe('systems/mbrain.md#overview/runtime');
    expect(result.route?.summary_lines).toContain('Precision lookup is anchored to exact canonical section path systems/mbrain.md#overview/runtime.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service resolves a uniquely cited canonical section by source ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-source-ref-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

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

    const result = await getPrecisionLookupRoute(engine, {
      source_ref: 'User, direct message, 2026-04-22 12:30 PM KST',
    });

    expect(result.selection_reason).toBe('direct_source_ref_section_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.target_kind).toBe('section');
    expect(result.route?.section_id).toBe('systems/mbrain#overview/runtime');
    expect(result.route?.path).toBe('systems/mbrain.md#overview/runtime');
    expect(result.route?.summary_lines).toContain('Precision lookup is anchored to exact canonical source ref User, direct message, 2026-04-22 12:30 PM KST.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service degrades explicitly on ambiguous source ref matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-source-ref-ambiguous-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const sharedSourceRef = 'User, direct message, 2026-04-22 12:31 PM KST';

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
      `[Source: ${sharedSourceRef}]`,
    ].join('\n'), { path: 'systems/mbrain.md' });

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
      `[Source: ${sharedSourceRef}]`,
    ].join('\n'), { path: 'systems/brain-graph.md' });

    const result = await getPrecisionLookupRoute(engine, {
      source_ref: sharedSourceRef,
    });

    expect(result.selection_reason).toBe('ambiguous_source_ref_match');
    expect(result.candidate_count).toBe(2);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precision lookup route service degrades explicitly when the exact artifact is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-precision-route-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getPrecisionLookupRoute(engine, {
      slug: 'systems/unknown',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
