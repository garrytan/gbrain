import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  buildCodeLaneGraphSnapshot,
  CODE_LANE_CONTEXT_MAP_KIND,
  CODE_LANE_EXTRACTOR_VERSION,
  DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS,
  expandCodeLaneGraph,
  hashCodeLaneSourceSet,
} from '../src/core/services/context-map-code-lane-service.ts';
import {
  buildCodeLaneContextMapEntry,
  codeLaneContextMapId,
  getCodeLaneContextMapEntry,
  listCodeLaneContextMapEntries,
} from '../src/core/services/context-map-service.ts';

test('code-lane service builds derived orientation nodes and edges from codemap frontmatter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await importCodeLanePages(engine);

    const snapshot = await buildCodeLaneGraphSnapshot(engine);

    expect(snapshot.authority).toBe('derived_orientation');
    expect(snapshot.lane_grants_authority).toBe(false);
    expect(snapshot.graph_walk.enabled_by_default).toBe(false);
    expect(snapshot.graph_walk.depth_limit).toBe(1);
    expect(snapshot.graph_walk.fanout_cap).toBe(50);
    expect(snapshot.graph_walk).toEqual(DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS);
    expect(snapshot.nodes[0]?.symbol_id).toContain('systems/mbrain');
    expect(snapshot.nodes[0]?.verification_hint).toContain('reverify_code_claims');
    expect(snapshot.nodes[0]?.verification_hint).toContain('path=src/core/services/context-map-service.ts');
    expect(snapshot.nodes[0]?.verification_hint).not.toContain('path=/workspaces/mbrain');
    expect(snapshot.nodes.every((node) => node.authority === 'derived_orientation')).toBe(true);
    expect(snapshot.nodes.every((node) => node.source_ref && node.repo_path && node.content_hash)).toBe(true);
    expect(snapshot.nodes.every((node) => node.extractor_version === CODE_LANE_EXTRACTOR_VERSION)).toBe(true);
    expect(snapshot.nodes.find((node) => node.symbol_name === 'buildStructuralContextMapEntry()')).toEqual(
      expect.objectContaining({
        repo_path: '/workspaces/mbrain',
        source_ref: 'Source: codemap ingest, 2026-05-19',
        content_hash: 'sha256:build-structural',
      }),
    );
    expect(snapshot.nodes.find((node) => node.symbol_name === 'computeContextMapSourceSetHash()')?.content_hash)
      .toBe('missing');
    expect(snapshot.edges.some((edge) => edge.edge_kind === 'declares')).toBe(true);
    expect(snapshot.edges.every((edge) => edge.authority === 'derived_orientation')).toBe(true);
    expect(snapshot.edges.every((edge) => edge.source_ref && edge.repo_path && edge.content_hash)).toBe(true);
    expect(snapshot.edges.every((edge) => edge.extractor_version === CODE_LANE_EXTRACTOR_VERSION)).toBe(true);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-lane graph walk stays default-off and caps high fanout expansion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-fanout-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await importCodeLanePages(engine);

    const snapshot = await buildCodeLaneGraphSnapshot(engine);
    const expanded = expandCodeLaneGraph(snapshot, snapshot.nodes[0]!.symbol_id, {
      requested: true,
      depth_limit: 1,
      fanout_cap: 2,
    });

    expect(snapshot.graph_walk.enabled_by_default).toBe(false);
    expect(expanded.truncated).toBe(true);
    expect(expanded.truncation_reason).toBe('fanout_cap');
    expect(expanded.edges.length).toBeLessThanOrEqual(2);

    const notRequested = expandCodeLaneGraph(snapshot, snapshot.nodes[0]!.symbol_id);
    expect(notRequested.edges).toHaveLength(0);
    expect(notRequested.truncated).toBe(false);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-lane graph expansion keeps caller and callee directions distinct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-direction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await importCodeLanePages(engine);

    const snapshot = await buildCodeLaneGraphSnapshot(engine);
    const caller = snapshot.nodes.find((node) => node.symbol_name === 'buildStructuralContextMapEntry()');
    const callee = snapshot.nodes.find((node) => node.symbol_name === 'computeContextMapSourceSetHash()');
    if (!caller || !callee) throw new Error('direction fixture nodes missing');

    const callees = expandCodeLaneGraph(snapshot, caller.symbol_id, {
      requested: true,
      direction: 'out',
      depth_limit: 1,
      fanout_cap: 10,
    });
    expect(callees.edges.some((edge) =>
      edge.edge_kind === 'calls'
      && edge.from_symbol_id === caller.symbol_id
      && edge.to_symbol_id === callee.symbol_id)).toBe(true);

    const notCallers = expandCodeLaneGraph(snapshot, caller.symbol_id, {
      requested: true,
      direction: 'in',
      depth_limit: 1,
      fanout_cap: 10,
    });
    expect(notCallers.edges.some((edge) =>
      edge.edge_kind === 'calls'
      && edge.from_symbol_id === caller.symbol_id
      && edge.to_symbol_id === callee.symbol_id)).toBe(false);

    const callers = expandCodeLaneGraph(snapshot, callee.symbol_id, {
      requested: true,
      direction: 'in',
      depth_limit: 1,
      fanout_cap: 10,
    });
    expect(callers.edges.some((edge) =>
      edge.edge_kind === 'calls'
      && edge.from_symbol_id === caller.symbol_id
      && edge.to_symbol_id === callee.symbol_id)).toBe(true);

    const notCallees = expandCodeLaneGraph(snapshot, callee.symbol_id, {
      requested: true,
      direction: 'out',
      depth_limit: 1,
      fanout_cap: 10,
    });
    expect(notCallees.edges.some((edge) =>
      edge.edge_kind === 'calls'
      && edge.from_symbol_id === caller.symbol_id
      && edge.to_symbol_id === callee.symbol_id)).toBe(false);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-lane context map persists code_lane entries and marks codemap changes stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-map-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await importCodeLanePages(engine);

    const entry = await buildCodeLaneContextMapEntry(engine);

    expect(entry.id).toBe(codeLaneContextMapId('workspace:default'));
    expect(entry.kind).toBe(CODE_LANE_CONTEXT_MAP_KIND);
    expect(entry.build_mode).toBe('code_lane_contract');
    expect(entry.status).toBe('ready');
    expect(entry.node_count).toBeGreaterThan(0);
    expect(entry.edge_count).toBeGreaterThan(0);
    expect((entry.graph_json as any).authority).toBe('derived_orientation');

    await importFromContent(engine, 'concepts/query-routing', [
      '---',
      'type: concept',
      'title: Query Routing',
      'codemap:',
      '  - system: systems/mbrain',
      '    pointers:',
      '      - path: src/core/services/retrieve-context-service.ts',
      '        symbol: retrieveContext()',
      '        role: Selects context reads',
      '        edges:',
      '          - kind: unknown-kind',
      '            to_symbol: buildRetrievalTrace',
      '---',
      '# Purpose',
      'Routes retrieval requests through the current workspace model.',
    ].join('\n'), { path: 'concepts/query-routing.md' });

    const stale = await getCodeLaneContextMapEntry(engine, entry.id);
    const listed = await listCodeLaneContextMapEntries(engine, { scope_id: 'workspace:default' });
    const wrongKind = await listCodeLaneContextMapEntries(engine, {
      scope_id: 'workspace:default',
      kind: 'workspace',
    });

    expect(stale?.status).toBe('stale');
    expect(stale?.stale_reason).toBe('code_lane_source_set_changed');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('stale');
    expect(listed[0]?.stale_reason).toBe('code_lane_source_set_changed');
    expect(wrongKind).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-lane source hash changes when codemap metadata changes even with stable content hashes', async () => {
  const manifests = [
    manifestWithCodemap('concepts/query-routing', 'same-content-hash', 'retrieveContext()'),
  ];

  const changed = [
    manifestWithCodemap('concepts/query-routing', 'same-content-hash', 'retrieveContextRenamed()'),
  ];

  expect(hashCodeLaneSourceSet(manifests)).not.toBe(hashCodeLaneSourceSet(changed));
});

test('code-lane symbol ids include file path so same-named symbols do not collide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-symbol-collision-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/collision', [
      '---',
      'type: system',
      'title: Collision',
      'repo_path: /workspaces/collision',
      'codemap:',
      '  - system: systems/collision',
      '    repo_path: /workspaces/collision',
      '    pointers:',
      '      - path: src/a.ts',
      '        symbol: init',
      '        content_hash: sha256:a',
      '      - path: src/b.ts',
      '        symbol: init',
      '        content_hash: sha256:b',
      '      - path: src/caller.ts',
      '        symbol: run',
      '        content_hash: sha256:caller',
      '        edges:',
      '          - kind: calls',
      '            to_symbol: init',
      '---',
      '# Collision',
      'Two files export the same bare symbol name.',
    ].join('\n'), { path: 'systems/collision.md' });

    const snapshot = await buildCodeLaneGraphSnapshot(engine);
    const initNodes = snapshot.nodes.filter((node) => node.symbol_name === 'init');
    const ambiguousCall = snapshot.edges.find((edge) => edge.edge_kind === 'calls');

    expect(initNodes).toHaveLength(2);
    expect(new Set(initNodes.map((node) => node.symbol_id)).size).toBe(2);
    expect(initNodes.map((node) => node.symbol_id).sort()).toEqual([
      'code:symbol:systems/collision:/workspaces/collision:src/a.ts#init',
      'code:symbol:systems/collision:/workspaces/collision:src/b.ts#init',
    ]);
    expect(ambiguousCall?.resolution).toBe('ambiguous');
    expect(ambiguousCall?.to_symbol_id).toBe('code:symbol:systems/collision:unresolved#ambiguous%3Ainit');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code-lane symbol ids encode delimiters without breaking symbol resolution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-lane-symbol-delimiters-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/delimiter-safe', [
      '---',
      'type: system',
      'title: Delimiter Safe Code Lane',
      'repo_path: "/workspaces/example:repo"',
      'codemap:',
      '  - system: "systems/with:colon"',
      '    repo_path: "/workspaces/example:repo"',
      '    pointers:',
      '      - path: "src/parser:core.ts"',
      '        symbol: "parse:core#fast"',
      '        content_hash: sha256:parser',
      '      - path: "src/caller.ts"',
      '        symbol: run',
      '        content_hash: sha256:caller',
      '        edges:',
      '          - kind: calls',
      '            to_symbol: "parse:core#fast"',
      '---',
      '# Delimiter Safe Code Lane',
      'Code-lane identifiers can include delimiters in source metadata.',
    ].join('\n'), { path: 'systems/delimiter-safe.md' });

    const snapshot = await buildCodeLaneGraphSnapshot(engine);
    const parser = snapshot.nodes.find((node) => node.symbol_name === 'parse:core#fast');
    const call = snapshot.edges.find((edge) => edge.edge_kind === 'calls');

    expect(parser?.symbol_id).toContain('systems/with%3Acolon');
    expect(parser?.symbol_id).toContain('/workspaces/example%3Arepo');
    expect(parser?.symbol_id).toContain('src/parser%3Acore.ts');
    expect(parser?.symbol_id).toContain('#parse%3Acore%23fast');
    expect(call).toEqual(expect.objectContaining({
      resolution: 'resolved',
      to_symbol_id: parser?.symbol_id,
    }));
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function importCodeLanePages(engine: SQLiteEngine): Promise<void> {
  await importFromContent(engine, 'systems/mbrain', [
    '---',
    'type: system',
    'title: MBrain',
    'repo_path: /workspaces/mbrain',
    'codemap:',
    '  - system: systems/mbrain',
    '    pointers:',
      '      - path: src/core/services/context-map-service.ts',
      '        symbol: buildStructuralContextMapEntry()',
      '        role: Persists workspace maps',
      '        language: typescript',
      '        chunk_id: chunk-context-map',
      '        start_line: 23',
      '        end_line: 52',
      '        content_hash: sha256:build-structural',
      '        source_ref: "Source: codemap ingest, 2026-05-19"',
      '        edges:',
    '          - kind: calls',
    '            to_symbol: computeContextMapSourceSetHash()',
    '          - kind: references',
    '            to_symbol: listStructuralContextMapEntries()',
    '          - kind: imports',
    '            to_symbol: buildStructuralGraphSnapshot()',
    '          - kind: contains',
    '            to_symbol: workspaceContextMapId()',
    '          - kind: unexpected',
    '            to_symbol: getStructuralContextMapEntry()',
    '      - path: src/core/services/context-map-service.ts',
    '        symbol: computeContextMapSourceSetHash()',
    '        role: Hashes structural source sets',
    '---',
    '# Overview',
    'MBrain persists derived context maps.',
  ].join('\n'), { path: 'systems/mbrain.md' });

  await importFromContent(engine, 'concepts/query-routing', [
    '---',
    'type: concept',
    'title: Query Routing',
    'codemap:',
    '  - system: systems/mbrain',
    '    pointers:',
    '      - path: src/core/services/retrieve-context-service.ts',
    '        symbol: retrieveContext()',
    '        role: Selects context reads',
    '        edges:',
    '          - kind: calls',
    '            to_symbol: buildRetrievalTrace',
    '---',
    '# Purpose',
    'Routes retrieval requests through the current workspace model.',
  ].join('\n'), { path: 'concepts/query-routing.md' });
}

function manifestWithCodemap(slug: string, contentHash: string, symbol: string) {
  return {
    scope_id: 'workspace:default',
    page_id: 1,
    slug,
    path: `${slug}.md`,
    page_type: 'concept' as const,
    title: slug,
    frontmatter: {
      codemap: [
        {
          system: 'systems/mbrain',
          pointers: [
            {
              path: 'src/core/services/retrieve-context-service.ts',
              symbol,
            },
          ],
        },
      ],
    },
    aliases: [],
    tags: [],
    outgoing_wikilinks: [],
    outgoing_urls: [],
    source_refs: [],
    heading_index: [],
    content_hash: contentHash,
    extractor_version: 'phase2-structural-v1',
    last_indexed_at: new Date(0),
  };
}
