// Persisted context map and context atlas registry operations.
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { getAtlasOrientationBundle } from './services/atlas-orientation-bundle-service.ts';
import { getAtlasOrientationCard } from './services/atlas-orientation-card-service.ts';
import { getStructuralContextAtlasOverview } from './services/context-atlas-overview-service.ts';
import { getStructuralContextAtlasReport } from './services/context-atlas-report-service.ts';
import {
  buildStructuralContextAtlasEntry,
  getStructuralContextAtlasEntry,
  listStructuralContextAtlasEntries,
  selectStructuralContextAtlasEntry,
} from './services/context-atlas-service.ts';
import { getStructuralContextMapExplanation } from './services/context-map-explain-service.ts';
import { findStructuralContextMapPath } from './services/context-map-path-service.ts';
import { queryStructuralContextMap } from './services/context-map-query-service.ts';
import { getStructuralContextMapReport } from './services/context-map-report-service.ts';
import { buildStructuralContextMapEntry, getStructuralContextMapEntry, listStructuralContextMapEntries } from './services/context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './services/note-manifest-service.ts';

const build_context_map: Operation = {
  name: 'build_context_map',
  description: 'Build or rebuild the persisted structural workspace context map.',
  params: {
    scope_id: {
      type: 'string',
      description: 'Context-map scope id (default: workspace:default)',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'build_context_map', scope_id: scopeId };
    }
    return buildStructuralContextMapEntry(ctx.engine, scopeId);
  },
  cliHints: { name: 'map-build' },
};

const get_context_map_entry: Operation = {
  name: 'get_context_map_entry',
  description: 'Get one persisted structural context map by id.',
  params: {
    id: { type: 'string', required: true, description: 'Context map id' },
  },
  handler: async (ctx, p) => {
    const entry = await getStructuralContextMapEntry(ctx.engine, String(p.id));
    if (!entry) {
      throw new OperationError('page_not_found', `Context map entry not found: ${String(p.id)}`, 'Run map-build for the relevant scope first.');
    }
    return entry;
  },
  cliHints: { name: 'map-get', positional: ['id'] },
};

const list_context_map_entries: Operation = {
  name: 'list_context_map_entries',
  description: 'List persisted structural context map entries.',
  params: {
    scope_id: {
      type: 'string',
      description: 'Context-map scope id (default: workspace:default)',
    },
    kind: { type: 'string', description: 'Optional context-map kind filter' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return listStructuralContextMapEntries(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'map-list', aliases: { n: 'limit' } },
};

const CONTEXT_ATLAS_DEPRECATION_NOTICE =
  'Deprecated legacy context-atlas operation; use context maps and graph frontier planning.';

function contextAtlasDescription(_description: string): string {
  return CONTEXT_ATLAS_DEPRECATION_NOTICE;
}

const build_context_atlas: Operation = {
  name: 'build_context_atlas',
  description: contextAtlasDescription('Build or rebuild the persisted workspace atlas registry entry.'),
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'build_context_atlas',
        scope_id: scopeId,
      };
    }
    return buildStructuralContextAtlasEntry(ctx.engine, scopeId);
  },
  cliHints: { name: 'atlas-build' },
};

const get_context_atlas_entry: Operation = {
  name: 'get_context_atlas_entry',
  description: contextAtlasDescription('Get one persisted atlas registry entry by id.'),
  tier: 'admin',
  params: {
    id: { type: 'string', required: true, description: 'Atlas entry id' },
  },
  handler: async (ctx, p) => {
    const entry = await getStructuralContextAtlasEntry(ctx.engine, String(p.id));
    if (!entry) {
      throw new OperationError('page_not_found', `Context atlas entry not found: ${String(p.id)}`, 'Run atlas-build for the relevant scope first.');
    }
    return entry;
  },
  cliHints: { name: 'atlas-get', positional: ['id'] },
};

const list_context_atlas_entries: Operation = {
  name: 'list_context_atlas_entries',
  description: contextAtlasDescription('List persisted atlas registry entries.'),
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: { type: 'string', description: 'Optional atlas kind filter' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return listStructuralContextAtlasEntries(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'atlas-list', aliases: { n: 'limit' } },
};

const select_context_atlas_entry: Operation = {
  name: 'select_context_atlas_entry',
  description: contextAtlasDescription('Select the best persisted atlas registry entry for a scope.'),
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: { type: 'string', description: 'Optional atlas kind filter' },
    max_budget_hint: {
      type: 'number',
      description: 'Optional maximum allowed budget hint',
    },
    allow_stale: {
      type: 'boolean',
      description: 'Allow stale atlas entries when no fresh match exists',
    },
  },
  handler: async (ctx, p) => {
    return selectStructuralContextAtlasEntry(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-select' },
};

const get_context_atlas_overview: Operation = {
  name: 'get_context_atlas_overview',
  description: contextAtlasDescription('Render a compact overview artifact for a persisted atlas entry.'),
  tier: 'admin',
  params: {
    atlas_id: {
      type: 'string',
      description: 'Optional atlas entry id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional atlas kind filter when atlas_id is omitted',
    },
    max_budget_hint: {
      type: 'number',
      description: 'Optional maximum allowed budget hint for selection',
    },
    allow_stale: {
      type: 'boolean',
      description: 'Allow stale atlas entries when atlas_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getStructuralContextAtlasOverview(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-overview' },
};

const get_context_atlas_report: Operation = {
  name: 'get_context_atlas_report',
  description: contextAtlasDescription('Render a compact human-readable report for a persisted atlas entry.'),
  tier: 'admin',
  params: {
    atlas_id: {
      type: 'string',
      description: 'Optional atlas entry id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional atlas kind filter when atlas_id is omitted',
    },
    max_budget_hint: {
      type: 'number',
      description: 'Optional maximum allowed budget hint for selection',
    },
    allow_stale: {
      type: 'boolean',
      description: 'Allow stale atlas entries when atlas_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getStructuralContextAtlasReport(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-report' },
};

const get_atlas_orientation_card: Operation = {
  name: 'get_atlas_orientation_card',
  description: contextAtlasDescription('Render a compact orientation card from atlas selection and the workspace corpus card.'),
  tier: 'admin',
  params: {
    atlas_id: {
      type: 'string',
      description: 'Optional atlas entry id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional atlas kind filter when atlas_id is omitted',
    },
    max_budget_hint: {
      type: 'number',
      description: 'Optional maximum allowed budget hint for selection',
    },
    allow_stale: {
      type: 'boolean',
      description: 'Allow stale atlas entries when atlas_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getAtlasOrientationCard(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-orientation-card' },
};

const get_atlas_orientation_bundle: Operation = {
  name: 'get_atlas_orientation_bundle',
  description: contextAtlasDescription('Render a compact atlas bundle from atlas report and atlas orientation card.'),
  tier: 'admin',
  params: {
    atlas_id: {
      type: 'string',
      description: 'Optional atlas entry id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Atlas scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional atlas kind filter when atlas_id is omitted',
    },
    max_budget_hint: {
      type: 'number',
      description: 'Optional maximum allowed budget hint for selection',
    },
    allow_stale: {
      type: 'boolean',
      description: 'Allow stale atlas entries when atlas_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getAtlasOrientationBundle(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-orientation-bundle' },
};

const get_context_map_report: Operation = {
  name: 'get_context_map_report',
  description: 'Render a compact human-readable report for a persisted context map.',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getStructuralContextMapReport(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'map-report' },
};

const get_context_map_explanation: Operation = {
  name: 'get_context_map_explanation',
  description: 'Render a bounded local explanation for one node inside a persisted context map.',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
    node_id: {
      type: 'string',
      required: true,
      description: 'Exact structural node id to explain',
    },
  },
  handler: async (ctx, p) => {
    return getStructuralContextMapExplanation(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      node_id: String(p.node_id),
    });
  },
  cliHints: { name: 'map-explain' },
};

const query_context_map: Operation = {
  name: 'query_context_map',
  description: 'Run a bounded structural query over one persisted context map.',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
    query: {
      type: 'string',
      required: true,
      description: 'Plain-text structural query string',
    },
    limit: {
      type: 'number',
      description: 'Max matched nodes to return (default 5)',
    },
  },
  handler: async (ctx, p) => {
    return queryStructuralContextMap(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      query: String(p.query),
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'map-query', aliases: { n: 'limit' } },
};

const find_context_map_path: Operation = {
  name: 'find_context_map_path',
  description: 'Find a bounded structural path inside one persisted context map.',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
    from_node_id: {
      type: 'string',
      required: true,
      description: 'Exact start node id',
    },
    to_node_id: {
      type: 'string',
      required: true,
      description: 'Exact target node id',
    },
    max_depth: {
      type: 'number',
      description: 'Optional maximum search depth (default 6)',
    },
  },
  handler: async (ctx, p) => {
    return findStructuralContextMapPath(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      from_node_id: String(p.from_node_id),
      to_node_id: String(p.to_node_id),
      max_depth: typeof p.max_depth === 'number' ? p.max_depth : undefined,
    });
  },
  cliHints: { name: 'map-path', positional: ['from_node_id', 'to_node_id'] },
};

export function createContextMapOperations(): Operation[] {
  return [
    build_context_map,
    get_context_map_entry,
    list_context_map_entries,
    get_context_map_report,
    get_context_map_explanation,
    query_context_map,
    find_context_map_path,
    build_context_atlas,
    get_context_atlas_entry,
    list_context_atlas_entries,
    select_context_atlas_entry,
    get_context_atlas_overview,
    get_context_atlas_report,
    get_atlas_orientation_card,
    get_atlas_orientation_bundle,
  ];
}
