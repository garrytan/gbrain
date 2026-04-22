import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  ContextMapEntry,
  ContextMapFilters,
  NoteManifestEntry,
  NoteSectionEntry,
} from '../types.ts';
import { buildStructuralGraphSnapshot } from './note-structural-graph-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { listAllNoteManifestEntries, listAllNoteSectionEntries } from './structural-entry-pagination.ts';

export const WORKSPACE_CONTEXT_MAP_KIND = 'workspace';
export const CONTEXT_MAP_BUILD_MODE = 'structural';
export const CONTEXT_MAP_EXTRACTOR_VERSION = 'phase2-context-map-v1';
export const WORKSPACE_CONTEXT_MAP_TITLE = 'Workspace Structural Map';
export const CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED = 'source_set_changed';

export function workspaceContextMapId(scopeId: string): string {
  return `context-map:workspace:${scopeId}`;
}

export async function buildStructuralContextMapEntry(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<ContextMapEntry> {
  const [manifests, sections, snapshot] = await Promise.all([
    listAllNoteManifestEntries(engine, scopeId),
    listAllNoteSectionEntries(engine, scopeId),
    buildStructuralGraphSnapshot(engine, scopeId),
  ]);

  return engine.upsertContextMapEntry({
    id: workspaceContextMapId(scopeId),
    scope_id: scopeId,
    kind: WORKSPACE_CONTEXT_MAP_KIND,
    title: WORKSPACE_CONTEXT_MAP_TITLE,
    build_mode: CONTEXT_MAP_BUILD_MODE,
    status: 'ready',
    source_set_hash: hashContextMapSourceSet(manifests, sections),
    extractor_version: CONTEXT_MAP_EXTRACTOR_VERSION,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.edges.length,
    community_count: 0,
    graph_json: {
      scope_id: snapshot.scope_id,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    },
    stale_reason: null,
  });
}

export async function getStructuralContextMapEntry(
  engine: BrainEngine,
  id: string,
): Promise<ContextMapEntry | null> {
  const entry = await engine.getContextMapEntry(id);
  if (!entry) return null;
  return annotateContextMapFreshness(engine, entry);
}

export async function listStructuralContextMapEntries(
  engine: BrainEngine,
  filters?: ContextMapFilters,
): Promise<ContextMapEntry[]> {
  const entries = await engine.listContextMapEntries(filters);
  const hashByScope = new Map<string, string>();

  return Promise.all(entries.map(async (entry) => {
    let currentHash = hashByScope.get(entry.scope_id);
    if (!currentHash) {
      currentHash = await computeContextMapSourceSetHash(engine, entry.scope_id);
      hashByScope.set(entry.scope_id, currentHash);
    }
    return applyFreshness(entry, currentHash);
  }));
}

export async function computeContextMapSourceSetHash(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<string> {
  const [manifests, sections] = await Promise.all([
    listAllNoteManifestEntries(engine, scopeId),
    listAllNoteSectionEntries(engine, scopeId),
  ]);
  return hashContextMapSourceSet(manifests, sections);
}

async function annotateContextMapFreshness(
  engine: BrainEngine,
  entry: ContextMapEntry,
): Promise<ContextMapEntry> {
  const currentSourceSetHash = await computeContextMapSourceSetHash(engine, entry.scope_id);
  return applyFreshness(entry, currentSourceSetHash);
}

function applyFreshness(
  entry: ContextMapEntry,
  currentSourceSetHash: string,
): ContextMapEntry {
  if (entry.source_set_hash === currentSourceSetHash) {
    return entry;
  }

  return {
    ...entry,
    status: 'stale',
    stale_reason: CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED,
  };
}

function hashContextMapSourceSet(
  manifests: NoteManifestEntry[],
  sections: NoteSectionEntry[],
): string {
  const payload = {
    manifests: manifests
      .map((entry) => ({
        slug: entry.slug,
        content_hash: entry.content_hash,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
    sections: sections
      .map((entry) => ({
        section_id: entry.section_id,
        content_hash: entry.content_hash,
      }))
      .sort((left, right) => left.section_id.localeCompare(right.section_id)),
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}
