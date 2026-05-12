import type {
  DerivedArtifactKind,
  DerivedJob,
  DerivedJobInput,
} from './types.ts';

export const DERIVED_SCHEMA_VERSION = 'page-derived-v1';
export const PAGE_DERIVED_ARTIFACTS: DerivedArtifactKind[] = [
  'page_chunks',
  'note_manifest',
  'note_sections',
];

export function normalizeDerivedParameters(input: DerivedJobInput): Record<string, unknown> {
  const parameters = canonicalizeJsonObject(input.derived_parameters ?? {});
  if (input.extractor_version !== undefined) {
    parameters.extractor_version = input.extractor_version;
  }
  if (input.derived_schema_version !== undefined) {
    parameters.derived_schema_version = input.derived_schema_version;
  }
  return parameters;
}

export function derivedExtractorVersion(input: DerivedJobInput): string {
  const parameters = normalizeDerivedParameters(input);
  return typeof parameters.extractor_version === 'string'
    ? parameters.extractor_version
    : 'unknown';
}

export function derivedSchemaVersion(input: DerivedJobInput): string {
  const parameters = normalizeDerivedParameters(input);
  return typeof parameters.derived_schema_version === 'string'
    ? parameters.derived_schema_version
    : DERIVED_SCHEMA_VERSION;
}

export function canonicalDerivedParameters(value: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeJsonObject(value));
}

export function derivedJobMatchesTarget(job: DerivedJob, input: DerivedJobInput): boolean {
  return job.target_content_hash === input.target_content_hash
    && job.manifest_path === (input.manifest_path ?? null)
    && canonicalDerivedParameters(job.derived_parameters) === canonicalDerivedParameters(normalizeDerivedParameters(input));
}

export function retargetDerivedJobSlug(
  job: { manifest_path: string | null; derived_parameters: unknown },
  oldSlug: string,
  newSlug: string,
): { manifest_path: string | null; derived_parameters: Record<string, unknown> } {
  const derived_parameters = canonicalizeJsonObject(parseJsonObject(job.derived_parameters));
  if (typeof derived_parameters.manifest_path === 'string') {
    derived_parameters.manifest_path = retargetDefaultManifestPath(oldSlug, newSlug, derived_parameters.manifest_path);
  }
  return {
    manifest_path: retargetDefaultManifestPath(oldSlug, newSlug, job.manifest_path),
    derived_parameters,
  };
}

export function retargetDefaultManifestPath(
  oldSlug: string,
  newSlug: string,
  path: string | null,
): string | null {
  return path === `${oldSlug}.md` ? `${newSlug}.md` : path;
}

export function canonicalDerivedTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort((left, right) => (
    left.localeCompare(right)
  ));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.length > 0) return JSON.parse(value) as Record<string, unknown>;
  return {};
}

function canonicalizeJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return canonicalizeJsonValue(value) as Record<string, unknown>;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
    );
  }
  return value;
}
