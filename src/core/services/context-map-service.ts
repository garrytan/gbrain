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
import {
  buildCodeLaneGraphSnapshotFromManifests,
  CODE_LANE_BUILD_MODE,
  CODE_LANE_CONTEXT_MAP_KIND,
  CODE_LANE_EXTRACTOR_VERSION,
  CODE_LANE_STALE_REASON_SOURCE_SET_CHANGED,
  computeCodeLaneSourceSetHash,
  hashCodeLaneSourceSet,
} from './context-map-code-lane-service.ts';

export const WORKSPACE_CONTEXT_MAP_KIND = 'workspace';
export const CONTEXT_MAP_BUILD_MODE = 'structural';
export const CONTEXT_MAP_EXTRACTOR_VERSION = 'phase2-context-map-v1';
export const WORKSPACE_CONTEXT_MAP_TITLE = 'Workspace Structural Map';
export const CODE_LANE_CONTEXT_MAP_TITLE = 'Workspace Code Lane Map';
export const CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED = 'source_set_changed';

export function workspaceContextMapId(scopeId: string): string {
  return `context-map:workspace:${scopeId}`;
}

export function codeLaneContextMapId(scopeId: string): string {
  return `context-map:code-lane:${scopeId}`;
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
  if (!entry || entry.kind === CODE_LANE_CONTEXT_MAP_KIND) return null;
  return annotateContextMapFreshness(engine, entry);
}

export async function listStructuralContextMapEntries(
  engine: BrainEngine,
  filters?: ContextMapFilters,
): Promise<ContextMapEntry[]> {
  if (filters?.kind === CODE_LANE_CONTEXT_MAP_KIND) return [];

  const entries = (await engine.listContextMapEntries(filters))
    .filter((entry) => entry.kind !== CODE_LANE_CONTEXT_MAP_KIND);
  const freshnessByScopeKind = new Map<string, { currentSourceSetHash: string; staleReason: string }>();

  return Promise.all(entries.map(async (entry) => {
    const cacheKey = `${entry.kind}\0${entry.scope_id}`;
    let freshness = freshnessByScopeKind.get(cacheKey);
    if (!freshness) {
      freshness = await computeFreshnessInput(engine, entry);
      freshnessByScopeKind.set(cacheKey, freshness);
    }
    return applyFreshness(entry, freshness.currentSourceSetHash, freshness.staleReason);
  }));
}

export async function buildCodeLaneContextMapEntry(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<ContextMapEntry> {
  const manifests = await listAllNoteManifestEntries(engine, scopeId);
  const snapshot = buildCodeLaneGraphSnapshotFromManifests(manifests, scopeId);

  return engine.upsertContextMapEntry({
    id: codeLaneContextMapId(scopeId),
    scope_id: scopeId,
    kind: CODE_LANE_CONTEXT_MAP_KIND,
    title: CODE_LANE_CONTEXT_MAP_TITLE,
    build_mode: CODE_LANE_BUILD_MODE,
    status: 'ready',
    source_set_hash: hashCodeLaneSourceSet(manifests),
    extractor_version: CODE_LANE_EXTRACTOR_VERSION,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.edges.length,
    community_count: 0,
    graph_json: snapshot as unknown as Record<string, unknown>,
    stale_reason: null,
  });
}

export async function getCodeLaneContextMapEntry(
  engine: BrainEngine,
  id: string,
): Promise<ContextMapEntry | null> {
  const entry = await engine.getContextMapEntry(id);
  if (!entry || entry.kind !== CODE_LANE_CONTEXT_MAP_KIND) return null;
  return annotateContextMapFreshness(engine, entry);
}

export async function listCodeLaneContextMapEntries(
  engine: BrainEngine,
  filters?: ContextMapFilters,
): Promise<ContextMapEntry[]> {
  if (filters?.kind && filters.kind !== CODE_LANE_CONTEXT_MAP_KIND) return [];

  const entries = await engine.listContextMapEntries({
    ...filters,
    kind: CODE_LANE_CONTEXT_MAP_KIND,
  });
  return Promise.all(entries.map((entry) => annotateContextMapFreshness(engine, entry)));
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
  const freshness = await computeFreshnessInput(engine, entry);
  return applyFreshness(entry, freshness.currentSourceSetHash, freshness.staleReason);
}

function applyFreshness(
  entry: ContextMapEntry,
  currentSourceSetHash: string,
  staleReason = CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED,
): ContextMapEntry {
  if (entry.source_set_hash === currentSourceSetHash) {
    return entry;
  }

  return {
    ...entry,
    status: 'stale',
    stale_reason: staleReason,
  };
}

async function computeFreshnessInput(
  engine: BrainEngine,
  entry: ContextMapEntry,
): Promise<{ currentSourceSetHash: string; staleReason: string }> {
  if (entry.kind === CODE_LANE_CONTEXT_MAP_KIND) {
    return {
      currentSourceSetHash: await computeCodeLaneSourceSetHash(engine, entry.scope_id),
      staleReason: CODE_LANE_STALE_REASON_SOURCE_SET_CHANGED,
    };
  }

  return {
    currentSourceSetHash: await computeContextMapSourceSetHash(engine, entry.scope_id),
    staleReason: CONTEXT_MAP_STALE_REASON_SOURCE_SET_CHANGED,
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
