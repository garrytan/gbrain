import type { BrainEngine } from '../engine.ts';
import type { ContextMapEntry, ContextMapReport, ContextMapReportInput, ContextMapReportRead, ContextMapReportResult } from '../types.ts';
import { getStructuralContextMapEntry, listStructuralContextMapEntries, WORKSPACE_CONTEXT_MAP_KIND, workspaceContextMapId } from './context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

const REPORT_READ_LIMIT = 5;

export async function getStructuralContextMapReport(
  engine: BrainEngine,
  input: ContextMapReportInput = {},
): Promise<ContextMapReportResult> {
  if (input.map_id) {
    const entry = await getStructuralContextMapEntry(engine, input.map_id);
    if (!entry) {
      return {
        selection_reason: 'map_not_found',
        candidate_count: 0,
        report: null,
      };
    }
    return {
      selection_reason: 'direct_map_id',
      candidate_count: 1,
      report: await buildMapReport(engine, entry),
    };
  }

  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const kind = input.kind ?? WORKSPACE_CONTEXT_MAP_KIND;
  const entries = await listStructuralContextMapEntries(engine, {
    scope_id: scopeId,
    kind,
    limit: 100,
  });

  if (entries.length === 0) {
    const workspaceId = kind === WORKSPACE_CONTEXT_MAP_KIND ? workspaceContextMapId(scopeId) : undefined;
    if (workspaceId) {
      const direct = await getStructuralContextMapEntry(engine, workspaceId);
      if (direct) {
        return {
          selection_reason: direct.status === 'ready' ? 'selected_fresh_match' : 'selected_stale_match',
          candidate_count: 1,
          report: await buildMapReport(engine, direct),
        };
      }
    }

    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      report: null,
    };
  }

  const [entry] = [...entries].sort(compareMapEntries);
  return {
    selection_reason: entry.status === 'ready' ? 'selected_fresh_match' : 'selected_stale_match',
    candidate_count: entries.length,
    report: await buildMapReport(engine, entry),
  };
}

async function buildMapReport(
  engine: BrainEngine,
  entry: ContextMapEntry,
): Promise<ContextMapReport> {
  const recommendedReads = await resolveContextMapReads(engine, entry);
  return {
    report_kind: 'structural',
    title: `${entry.title} Report`,
    map_id: entry.id,
    status: entry.status,
    summary_lines: [
      `Context map status is ${entry.status}.`,
      `Graph includes ${entry.node_count} nodes and ${entry.edge_count} edges.`,
      `Recommended reads available: ${recommendedReads.length}.`,
      entry.status === 'stale'
        ? 'Rebuild the context map before trusting broad-synthesis orientation output.'
        : 'This map is safe to use for orientation under the current scope.',
    ],
    recommended_reads: recommendedReads,
  };
}

export async function resolveContextMapReads(
  engine: BrainEngine,
  entry: ContextMapEntry,
  limit = REPORT_READ_LIMIT,
): Promise<ContextMapReportRead[]> {
  const graph = entry.graph_json as {
    nodes?: Array<{
      node_id?: string;
      node_kind?: 'page' | 'section';
      label?: string;
      page_slug?: string;
      section_id?: string;
    }>;
  };
  const nodes = graph.nodes ?? [];
  const prioritized = [
    ...nodes.filter((node) => node.node_kind === 'page'),
    ...nodes.filter((node) => node.node_kind === 'section'),
  ];
  const bounded = Number.isFinite(limit) ? prioritized.slice(0, limit) : prioritized;

  const resolved = await Promise.all(bounded.map((node) => resolveNode(engine, entry.scope_id, node)));
  return resolved.filter((candidate): candidate is ContextMapReportRead => candidate !== null);
}

async function resolveNode(
  engine: BrainEngine,
  scopeId: string,
  node: {
    node_id?: string;
    node_kind?: 'page' | 'section';
    label?: string;
    page_slug?: string;
    section_id?: string;
  },
): Promise<ContextMapReportRead | null> {
  if (!node.node_id || !node.node_kind || !node.page_slug) return null;

  if (node.node_kind === 'page') {
    const [manifest] = await engine.listNoteManifestEntries({
      scope_id: scopeId,
      slug: node.page_slug,
      limit: 1,
    });
    if (!manifest) return null;
    return {
      node_id: node.node_id,
      node_kind: 'page',
      label: node.label ?? manifest.title,
      page_slug: manifest.slug,
      path: manifest.path,
    };
  }

  if (!node.section_id) return null;
  const [section] = await engine.listNoteSectionEntries({
    scope_id: scopeId,
    section_id: node.section_id,
    limit: 1,
  });
  if (!section) return null;
  return {
    node_id: node.node_id,
    node_kind: 'section',
    label: node.label ?? section.heading_text,
    page_slug: section.page_slug,
    path: section.page_path,
    section_id: section.section_id,
  };
}

function compareMapEntries(left: ContextMapEntry, right: ContextMapEntry): number {
  if (left.status !== right.status) {
    return left.status === 'ready' ? -1 : 1;
  }
  const generatedDelta = new Date(right.generated_at).getTime() - new Date(left.generated_at).getTime();
  if (generatedDelta !== 0) return generatedDelta;
  return left.id.localeCompare(right.id);
}
