import type {
  BroadSynthesisRouteRead,
  RetrievalSelector,
  RetrievalSelectorKind,
  SearchResult,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export function normalizeRetrievalSelector(
  selector: RetrievalSelector,
  defaults: { scope_id?: string } = {},
): RetrievalSelector {
  const scopeId = selector.scope_id ?? defaults.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const normalized: RetrievalSelector = {
    ...selector,
    scope_id: scopeId,
    source_refs: selector.source_refs ?? [],
    freshness: selector.freshness ?? 'unknown',
  };

  assertSelectorTarget(normalized);
  const normalizedSelectorId = retrievalSelectorId(normalized);
  if (selector.selector_id && selector.selector_id !== normalizedSelectorId) {
    throw new Error('selector_id does not match selector target');
  }
  normalized.selector_id = normalizedSelectorId;
  return normalized;
}

export function retrievalSelectorId(selector: RetrievalSelector): string {
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  let baseId: string;
  switch (selector.kind) {
    case 'page':
    case 'compiled_truth':
      baseId = `${selector.kind}:${scopeId}:${requireValue(selector.slug, `${selector.kind} selector requires slug`)}`;
      break;
    case 'section':
      baseId = `section:${scopeId}:${requireValue(selector.section_id, 'section selector requires section_id')}`;
      break;
    case 'line_span': {
      const lineSpanTarget = requireLineSpanTarget(selector);
      baseId = [
        'line_span',
        scopeId,
        lineSpanTarget.slug,
        String(lineSpanTarget.line_start),
        String(lineSpanTarget.line_end),
      ].join(':');
      break;
    }
    case 'timeline_entry':
    case 'task_working_set':
    case 'task_attempt':
    case 'task_decision':
    case 'profile_memory':
    case 'personal_episode':
      baseId = `${selector.kind}:${scopeId}:${requireValue(selector.object_id, `${selector.kind} selector requires object_id`)}`;
      break;
    case 'timeline_range':
      baseId = `${selector.kind}:${scopeId}:${requireValue(selector.slug, 'timeline_range selector requires slug')}`;
      break;
    case 'source_ref': {
      baseId = `${selector.kind}:${scopeId}:${requireValue(selector.source_ref, 'source_ref selector requires source_ref')}`;
      const target = sourceRefTargetSuffix(selector);
      if (target) baseId = `${baseId}@target:${target}`;
      break;
    }
  }
  return appendCharRangeSuffix(baseId, selector);
}

export function selectorFromRouteRead(read: BroadSynthesisRouteRead): RetrievalSelector {
  return normalizeRetrievalSelector({
    kind: read.node_kind === 'section' ? 'section' : 'page',
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: read.page_slug,
    path: read.path,
    section_id: read.section_id,
    freshness: 'unknown',
  });
}

export function selectorFromSearchResult(result: SearchResult): RetrievalSelector {
  const kind: RetrievalSelectorKind = result.chunk_source === 'timeline'
    ? 'timeline_range'
    : result.chunk_source === 'compiled_truth'
      ? 'compiled_truth'
      : 'page';
  return normalizeRetrievalSelector({
    kind,
    slug: result.slug,
    freshness: result.stale ? 'stale' : 'current',
  });
}

export function parseAnchoredRetrievalPath(path: string): { page_path: string; fragment: string } | null {
  const separatorIndex = path.indexOf('#');
  if (separatorIndex === -1) return null;
  const pagePath = path.slice(0, separatorIndex).trim();
  const fragment = path.slice(separatorIndex + 1).replace(/^\/+|\/+$/g, '');
  if (!pagePath || !fragment) return null;
  return { page_path: pagePath, fragment };
}

function assertSelectorTarget(selector: RetrievalSelector): void {
  assertCharRange(selector);
  switch (selector.kind) {
    case 'page':
    case 'compiled_truth':
      requireValue(selector.slug, `${selector.kind} selector requires slug`);
      return;
    case 'section':
      requireValue(selector.section_id, 'section selector requires section_id');
      return;
    case 'line_span':
      requireLineSpanTarget(selector);
      return;
    case 'timeline_range':
      requireValue(selector.slug, 'timeline_range selector requires slug');
      return;
    case 'source_ref':
      requireValue(selector.source_ref, 'source_ref selector requires source_ref');
      return;
    case 'timeline_entry':
    case 'task_working_set':
    case 'task_attempt':
    case 'task_decision':
    case 'profile_memory':
    case 'personal_episode':
      requireValue(selector.object_id, `${selector.kind} selector requires object_id`);
      return;
  }
}

function assertCharRange(selector: RetrievalSelector): void {
  const charStart = selector.char_start;
  const charEnd = selector.char_end;
  if (charStart !== undefined) {
    requireNonnegativeInteger(charStart, 'selector char_start must be a nonnegative integer');
  }
  if (charEnd !== undefined) {
    requireNonnegativeInteger(charEnd, 'selector char_end must be a nonnegative integer');
  }
  if (charStart !== undefined && charEnd !== undefined && charStart >= charEnd) {
    throw new Error('selector char_start must be < char_end');
  }
}

function appendCharRangeSuffix(baseId: string, selector: RetrievalSelector): string {
  if (selector.char_start === undefined && selector.char_end === undefined) {
    return baseId;
  }
  return `${baseId}@chars:${selector.char_start ?? 0}:${selector.char_end ?? ''}`;
}

function sourceRefTargetSuffix(selector: RetrievalSelector): string | undefined {
  if (selector.section_id) return selector.section_id;
  if (selector.slug) return selector.slug;
  if (selector.path) return selector.path.split('#')[0]?.trim() || undefined;
  return undefined;
}

function requireValue(value: string | undefined, message: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function requireLineSpanTarget(selector: RetrievalSelector): {
  slug: string;
  line_start: number;
  line_end: number;
} {
  const slug = requireValue(selector.slug, 'line_span selector requires slug');
  const lineStart = requirePositiveInteger(
    selector.line_start,
    'line_span selector requires positive integer line_start',
  );
  const lineEnd = requirePositiveInteger(
    selector.line_end,
    'line_span selector requires positive integer line_end',
  );
  if (lineStart > lineEnd) {
    throw new Error('line_span selector requires line_start <= line_end');
  }
  return { slug, line_start: lineStart, line_end: lineEnd };
}

function requirePositiveInteger(value: number | undefined, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function requireNonnegativeInteger(value: number, message: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}
