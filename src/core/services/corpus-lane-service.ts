import type { CorpusLaneArtifactKind, CorpusLaneMetadata } from '../types.ts';

const LANE_SOURCE_REF_PREFIXES = ['corpus_lane:', 'source_record:', 'import_origin:'] as const;
export const CORPUS_LANE_ARTIFACT_KINDS = [
  'note',
  'worktree',
  'transcript',
  'import',
  'source_record',
  'derived',
] as const satisfies readonly CorpusLaneArtifactKind[];

export function extractCorpusLaneMetadata(
  frontmatter: Record<string, unknown> | undefined,
  fallbackImportOrigin?: string,
): CorpusLaneMetadata | undefined {
  if (!frontmatter) return undefined;

  const laneObject = objectValue(frontmatter.corpus_lane);
  const laneId = firstString(
    stringValue(frontmatter.corpus_lane),
    stringValue(laneObject?.lane_id),
    stringValue(frontmatter.corpus_lane_id),
    stringValue(frontmatter.lane_id),
  );
  if (!laneId) return undefined;

  const sourceRecord = firstString(
    stringValue(laneObject?.source_record),
    stringValue(laneObject?.source_record_id),
    stringValue(frontmatter.source_record),
    stringValue(frontmatter.source_record_id),
  );
  const importOrigin = firstString(
    stringValue(laneObject?.import_origin),
    stringValue(frontmatter.import_origin),
    fallbackImportOrigin,
  );
  const artifactKind = firstString(
    stringValue(laneObject?.artifact_kind),
    stringValue(frontmatter.artifact_kind),
  );
  const normalizedArtifactKind = artifactKind && isCorpusLaneArtifactKind(artifactKind)
    ? artifactKind
    : undefined;

  return {
    lane_id: laneId,
    ...(sourceRecord ? { source_record: sourceRecord } : {}),
    ...(importOrigin ? { import_origin: importOrigin } : {}),
    ...(normalizedArtifactKind ? { artifact_kind: normalizedArtifactKind } : {}),
  };
}

export function corpusLaneSourceRefs(lane: CorpusLaneMetadata | undefined): string[] {
  const laneId = stringValue(lane?.lane_id);
  if (!laneId) return [];
  const sourceRecord = stringValue(lane?.source_record);
  const importOrigin = stringValue(lane?.import_origin);
  return mergeSourceRefs([
    `corpus_lane:${laneId}`,
    ...(sourceRecord ? [`source_record:${sourceRecord}`] : []),
    ...(importOrigin ? [`import_origin:${importOrigin}`] : []),
  ]);
}

export function corpusLaneProvenanceSourceRefs(lane: CorpusLaneMetadata | undefined): string[] {
  const sourceRecord = stringValue(lane?.source_record);
  const importOrigin = stringValue(lane?.import_origin);
  return mergeSourceRefs([
    ...(sourceRecord ? [`source_record:${sourceRecord}`] : []),
    ...(importOrigin ? [`import_origin:${importOrigin}`] : []),
  ]);
}

export function extractFrontmatterSourceRefs(
  frontmatter: Record<string, unknown> | undefined,
  fallbackImportOrigin?: string,
): string[] {
  if (!frontmatter) return [];
  return mergeSourceRefs(
    frontmatterSourceRefs(frontmatter.source_refs),
    frontmatterSourceRecordRefs(frontmatter),
    corpusLaneSourceRefs(extractCorpusLaneMetadata(frontmatter, fallbackImportOrigin)),
  );
}

export function corpusLaneFromSourceRefs(sourceRefs: string[]): CorpusLaneMetadata | undefined {
  let laneId: string | undefined;
  let sourceRecord: string | undefined;
  let importOrigin: string | undefined;

  for (const ref of sourceRefs) {
    const trimmed = ref.trim();
    if (!laneId && trimmed.startsWith('corpus_lane:')) {
      laneId = trimmed.slice('corpus_lane:'.length).trim();
      continue;
    }
    if (!sourceRecord && trimmed.startsWith('source_record:')) {
      sourceRecord = trimmed.slice('source_record:'.length).trim();
      continue;
    }
    if (!importOrigin && trimmed.startsWith('import_origin:')) {
      importOrigin = trimmed.slice('import_origin:'.length).trim();
    }
  }

  if (!laneId) return undefined;
  return {
    lane_id: laneId,
    ...(sourceRecord ? { source_record: sourceRecord } : {}),
    ...(importOrigin ? { import_origin: importOrigin } : {}),
  };
}

export function mergeSourceRefs(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const ref of group ?? []) {
      const trimmed = ref.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

export function laneOnlySourceRefs(sourceRefs: readonly string[] | undefined): string[] {
  return (sourceRefs ?? []).filter((ref) =>
    LANE_SOURCE_REF_PREFIXES.some((prefix) => ref.trim().startsWith(prefix))
  );
}

export function isCorpusLaneArtifactKind(value: string): value is CorpusLaneArtifactKind {
  return (CORPUS_LANE_ARTIFACT_KINDS as readonly string[]).includes(value);
}

function frontmatterSourceRefs(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const sourceObject = objectValue(entry);
    if (sourceObject && typeof sourceObject.Source === 'string') {
      return [`Source: ${sourceObject.Source}`];
    }
    return [];
  });
}

function frontmatterSourceRecordRefs(frontmatter: Record<string, unknown>): string[] {
  const laneObject = objectValue(frontmatter.corpus_lane);
  const sourceRecord = firstString(
    stringValue(laneObject?.source_record),
    stringValue(laneObject?.source_record_id),
    stringValue(frontmatter.source_record),
    stringValue(frontmatter.source_record_id),
  );
  const importOrigin = firstString(
    stringValue(laneObject?.import_origin),
    stringValue(frontmatter.import_origin),
  );
  return mergeSourceRefs([
    ...(sourceRecord ? [`source_record:${sourceRecord}`] : []),
    ...(importOrigin ? [`import_origin:${importOrigin}`] : []),
  ]);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}
