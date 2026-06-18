import { findSlugQualityIssues } from '../slug-quality.ts';
import type { PageType } from '../types.ts';
import { validateSlug } from '../utils.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import type { SourceKind } from '../source-registry/source-policy.ts';

export interface RawCanonicalDocumentRequest {
  target_slug?: string;
  type?: PageType;
  title?: string;
  tags?: string[];
  source_refs?: string[];
  source_chunk_ids?: string[];
  facts?: string[];
  timeline_events?: string[];
  frontmatter?: Record<string, unknown>;
  safety_flags?: string[];
}

export interface RawCanonicalDocumentGeneratorInput {
  source_kind?: SourceKind | string;
  source_id?: string;
  source_item_id?: string;
  source_item_title?: string;
  source_content_hash?: string;
  source_locator?: string;
  source_updated_at?: string;
  parser_version?: string;
  extractor_version?: string;
  generator_version?: string;
  now?: string;
  documents: RawCanonicalDocumentRequest[];
}

export interface RawCanonicalDocumentDraft {
  slug: string;
  type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  compiled_truth: string;
  timeline: string;
  markdown: string;
  source_refs: string[];
  warnings: string[];
  blocked_reasons: string[];
  review_status: 'draft';
  generation_policy: 'candidate_first';
}

export interface RawCanonicalDocumentGenerationResult {
  drafts: RawCanonicalDocumentDraft[];
  warnings: string[];
}

interface GroupedRequest {
  slug: string;
  normalizedSlug: string | null;
  type: PageType;
  title: string;
  tags: string[];
  sourceRefs: string[];
  sourceChunkIds: string[];
  facts: string[];
  timelineEvents: string[];
  frontmatter: Record<string, unknown>;
  safetyFlags: string[];
  warnings: string[];
  blockedReasons: string[];
}

const DEFAULT_GENERATOR_VERSION = 'raw-canonical-document-generator:v1';

export function generateRawCanonicalDocumentDrafts(
  input: RawCanonicalDocumentGeneratorInput,
): RawCanonicalDocumentGenerationResult {
  const groups = groupRequests(input);
  const drafts = groups.map((group) => buildDraft(input, group));
  return {
    drafts,
    warnings: drafts.flatMap((draft) => draft.warnings),
  };
}

function groupRequests(input: RawCanonicalDocumentGeneratorInput): GroupedRequest[] {
  const groups = new Map<string, GroupedRequest>();

  input.documents.forEach((request, index) => {
    const prepared = prepareRequest(input, request, index);
    const groupKey = prepared.normalizedSlug ?? `blocked:${index}:${prepared.slug}`;
    const existing = groups.get(groupKey);
    if (!existing) {
      groups.set(groupKey, prepared);
      return;
    }
    mergeGroup(existing, prepared);
  });

  return [...groups.values()];
}

function prepareRequest(
  input: RawCanonicalDocumentGeneratorInput,
  request: RawCanonicalDocumentRequest,
  index: number,
): GroupedRequest {
  const rawSlug = request.target_slug?.trim() ?? '';
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  let normalizedSlug: string | null = null;

  if (!rawSlug) {
    blockedReasons.push('missing_target_slug');
  } else {
    try {
      normalizedSlug = validateSlug(rawSlug);
    } catch {
      blockedReasons.push('invalid_target_slug');
    }
  }

  const sourceRefs = uniqueStrings(request.source_refs ?? []);
  if (sourceRefs.length === 0) blockedReasons.push('missing_source_ref');
  if (!input.source_item_id) blockedReasons.push('missing_source_item');

  const safetyFlags = uniqueStrings(request.safety_flags ?? []).map((flag) => flag.toLowerCase());
  if (safetyFlags.includes('prompt_injection') || safetyFlags.includes('prompt_injection_flagged')) {
    blockedReasons.push('prompt_injection_flagged');
  }
  if (safetyFlags.includes('secret') || safetyFlags.includes('secret_detected')) {
    blockedReasons.push('secret_detected');
  }

  const facts = uniqueStrings(request.facts ?? []);
  const timelineEvents = uniqueStrings(request.timeline_events ?? []);
  if (facts.length === 0 && timelineEvents.length === 0) blockedReasons.push('empty_observation');

  if (normalizedSlug) {
    for (const issue of findSlugQualityIssues(normalizedSlug, `${normalizedSlug}.md`)) {
      warnings.push(`${normalizedSlug} slug warning (${issue.rule}): ${issue.message}`);
    }
  }

  return {
    slug: normalizedSlug ?? (rawSlug || `untargeted-${index + 1}`),
    normalizedSlug,
    type: request.type ?? 'concept',
    title: request.title?.trim() || titleFromSlug(rawSlug) || 'Untitled Raw Canonical Draft',
    tags: normalizeTags(request.tags ?? []),
    sourceRefs,
    sourceChunkIds: uniqueStrings(request.source_chunk_ids ?? []),
    facts,
    timelineEvents,
    frontmatter: { ...(request.frontmatter ?? {}) },
    safetyFlags,
    warnings,
    blockedReasons: uniqueStrings(blockedReasons),
  };
}

function mergeGroup(target: GroupedRequest, source: GroupedRequest): void {
  target.tags = normalizeTags([...target.tags, ...source.tags]);
  target.sourceRefs = uniqueStrings([...target.sourceRefs, ...source.sourceRefs]);
  target.sourceChunkIds = uniqueStrings([...target.sourceChunkIds, ...source.sourceChunkIds]);
  target.facts = uniqueStrings([...target.facts, ...source.facts]);
  target.timelineEvents = uniqueStrings([...target.timelineEvents, ...source.timelineEvents]);
  target.safetyFlags = uniqueStrings([...target.safetyFlags, ...source.safetyFlags]);
  target.warnings = uniqueStrings([...target.warnings, ...source.warnings]);
  target.blockedReasons = uniqueStrings([...target.blockedReasons, ...source.blockedReasons]);
  target.frontmatter = mergeFrontmatter(target.frontmatter, source.frontmatter);
}

function buildDraft(
  input: RawCanonicalDocumentGeneratorInput,
  group: GroupedRequest,
): RawCanonicalDocumentDraft {
  const blockedReasons = [...group.blockedReasons];
  const sourceItemIds = uniqueStrings([input.source_item_id].filter(isNonEmptyString));
  const sourceContentHashes = uniqueStrings([input.source_content_hash].filter(isNonEmptyString));
  if (group.timelineEvents.length > 0 && !stableEventTimestamp(input)) {
    blockedReasons.push('missing_now');
  }

  let frontmatter = buildFrontmatter(input, group, sourceItemIds, sourceContentHashes, blockedReasons.length === 0);
  const warnings = [...group.warnings];
  const canRenderFacts = blockedReasons.length === 0;
  const compiledTruth = canRenderFacts
    ? renderCompiledTruth(group.facts, group.sourceRefs)
    : '';
  const timeline = canRenderFacts
    ? renderTimeline(input, group)
    : '';

  let markdown = '';
  if (group.normalizedSlug && canRenderFacts) {
    try {
      markdown = serializeMarkdown(frontmatter, compiledTruth, timeline, {
        type: group.type,
        title: group.title,
        tags: group.tags,
      });
      const parsed = parseMarkdown(markdown, `${group.normalizedSlug}.md`);
      if (
        parsed.compiled_truth !== compiledTruth
        || parsed.timeline !== timeline
        || parsed.title !== group.title
        || parsed.type !== group.type
        || !sameStringArray(parsed.tags, group.tags)
        || !sameJsonValue(parsed.frontmatter, frontmatter)
      ) {
        blockedReasons.push('markdown_round_trip_failed');
        markdown = '';
      }
    } catch {
      blockedReasons.push('markdown_round_trip_failed');
      markdown = '';
    }
  }

  if (blockedReasons.length > 0) {
    warnings.push(`${group.slug} blocked: ${uniqueStrings(blockedReasons).join(', ')}`);
    frontmatter = buildFrontmatter(input, group, sourceItemIds, sourceContentHashes, false);
  }

  const finalBlockedReasons = uniqueStrings(blockedReasons);
  const canReturnRenderedContent = finalBlockedReasons.length === 0;

  return {
    slug: group.slug,
    type: group.type,
    title: canReturnRenderedContent ? group.title : 'Blocked Raw Canonical Draft',
    frontmatter,
    compiled_truth: canReturnRenderedContent ? compiledTruth : '',
    timeline: canReturnRenderedContent ? timeline : '',
    markdown: canReturnRenderedContent ? markdown : '',
    source_refs: group.sourceRefs,
    warnings: uniqueStrings(warnings),
    blocked_reasons: finalBlockedReasons,
    review_status: 'draft',
    generation_policy: 'candidate_first',
  };
}

function buildFrontmatter(
  input: RawCanonicalDocumentGeneratorInput,
  group: GroupedRequest,
  sourceItemIds: string[],
  sourceContentHashes: string[],
  includeCallerMetadata: boolean,
): Record<string, unknown> {
  return removeUndefined({
    ...(includeCallerMetadata ? group.frontmatter : {}),
    generated_by: 'raw-canonical-document-generator',
    generator_version: input.generator_version ?? DEFAULT_GENERATOR_VERSION,
    review_status: 'draft',
    generation_policy: 'candidate_first',
    source_kind: input.source_kind,
    source_id: input.source_id,
    source_item_ids: sourceItemIds,
    source_chunk_ids: group.sourceChunkIds,
    source_refs: group.sourceRefs,
    source_content_hashes: sourceContentHashes,
    source_locator: includeCallerMetadata ? input.source_locator : undefined,
    source_updated_at: includeCallerMetadata ? input.source_updated_at : undefined,
    source_item_title: includeCallerMetadata ? input.source_item_title : undefined,
    parser_version: input.parser_version,
    extractor_version: input.extractor_version,
  });
}

function renderCompiledTruth(facts: string[], sourceRefs: string[]): string {
  return [
    '## Summary',
    '',
    ...facts.map((fact) => `- ${withCitation(fact, sourceRefs)}`),
  ].join('\n').trim();
}

function renderTimeline(
  input: RawCanonicalDocumentGeneratorInput,
  group: GroupedRequest,
): string {
  const date = stableEventTimestamp(input)?.slice(0, 10) ?? 'unknown-date';
  const itemSuffix = input.source_item_id ? ` (source_item_id: ${input.source_item_id}${renderChunkSuffix(group)})` : '';
  return [
    '## Timeline',
    '',
    ...group.timelineEvents.map((event) => (
      `- **${date}** | ${withCitation(event, group.sourceRefs)}${itemSuffix}`
    )),
  ].join('\n').trim();
}

function renderChunkSuffix(group: GroupedRequest): string {
  return group.sourceChunkIds.length > 0 ? `; source_chunk_ids: ${group.sourceChunkIds.join(', ')}` : '';
}

function withCitation(text: string, sourceRefs: string[]): string {
  const normalized = ensureSentence(text.trim());
  const citations = sourceRefs
    .map((sourceRef) => `[Source: ${sourceRef}]`)
    .filter((citation) => !normalized.includes(citation))
    .join(' ');
  if (!citations) return normalized;
  return `${normalized} ${citations}`.trim();
}

function stableEventTimestamp(input: RawCanonicalDocumentGeneratorInput): string | undefined {
  return input.now ?? input.source_updated_at;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeForJsonCompare(left)) === JSON.stringify(normalizeForJsonCompare(right));
}

function normalizeForJsonCompare(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForJsonCompare);
  if (!value || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeForJsonCompare((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

function ensureSentence(text: string): string {
  if (!text) return text;
  return /[.!?)]$/.test(text) ? text : `${text}.`;
}

function titleFromSlug(slug: string): string {
  const leaf = slug.split('/').filter(Boolean).at(-1) ?? '';
  return leaf
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function mergeFrontmatter(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = merged[key];
    if (Array.isArray(existing) || Array.isArray(value)) {
      merged[key] = uniqueStrings([
        ...arrayOfStrings(existing),
        ...arrayOfStrings(value),
      ]);
      continue;
    }
    if (existing === undefined) merged[key] = value;
  }
  return merged;
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) cleaned[key] = entry;
  }
  return cleaned;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeTags(values: readonly string[]): string[] {
  return [
    ...uniqueStrings(values.filter((value) => value.trim() !== 'raw-canonical-draft')),
    'raw-canonical-draft',
  ];
}

function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isNonEmptyString);
  if (isNonEmptyString(value)) return [value];
  return [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
