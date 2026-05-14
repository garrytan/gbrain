import type {
  PageLineSpanProjection,
  PageLineSpanProjectionOptions,
  PageProjection,
  PageProjectionOptions,
  PageTextWindow,
  PageType,
  PageWindowField,
} from './types.ts';
import { scalarLength } from './text-offsets.ts';

export type NormalizedPageProjectionWindows = Partial<Record<PageWindowField, {
  char_start: number;
  char_limit: number;
}>>;

export type NormalizedPageLineSpanProjectionOptions = {
  line_start: number;
  line_end: number;
};

export const PAGE_WINDOW_FIELDS = ['compiled_truth', 'timeline'] as const satisfies readonly PageWindowField[];

export function normalizePageProjectionWindows(
  options: PageProjectionOptions = {},
): NormalizedPageProjectionWindows {
  const windows: NormalizedPageProjectionWindows = {};
  for (const field of PAGE_WINDOW_FIELDS) {
    const request = options.windows?.[field];
    if (!request) continue;
    windows[field] = {
      char_start: normalizeCharStart(request.char_start ?? 0),
      char_limit: normalizeCharLimit(request.char_limit),
    };
  }
  return windows;
}

export function rowToPageProjection(
  row: Record<string, unknown>,
  windows: NormalizedPageProjectionWindows,
): PageProjection {
  const contentWindows: PageProjection['content_windows'] = {};
  for (const field of PAGE_WINDOW_FIELDS) {
    const request = windows[field];
    if (!request) continue;
    const totalChars = Number(row[`${field}_total_chars`] ?? 0);
    const charStart = Math.min(request.char_start, totalChars);
    const text = String(row[`${field}_window_text`] ?? '');
    contentWindows[field] = buildPageTextWindow(text, charStart, totalChars);
  }

  return {
    id: Number(row.id),
    slug: String(row.slug),
    type: row.type as PageType,
    title: String(row.title),
    frontmatter: parseJsonObject(row.frontmatter),
    content_hash: row.content_hash ? String(row.content_hash) : undefined,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
    content_windows: contentWindows,
  };
}

export function normalizePageLineSpanProjectionOptions(
  options: PageLineSpanProjectionOptions,
): NormalizedPageLineSpanProjectionOptions {
  const lineStart = normalizePositiveInteger(options.line_start, 'line_start');
  const lineEnd = normalizePositiveInteger(options.line_end, 'line_end');
  if (lineStart > lineEnd) {
    throw new RangeError('line_start must be <= line_end');
  }
  return { line_start: lineStart, line_end: lineEnd };
}

export function rowToPageLineSpanProjection(
  row: Record<string, unknown>,
  options: NormalizedPageLineSpanProjectionOptions,
): PageLineSpanProjection {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    type: row.type as PageType,
    title: String(row.title),
    frontmatter: parseJsonObject(row.frontmatter),
    content_hash: row.content_hash ? String(row.content_hash) : undefined,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
    text: String(row.line_span_text ?? ''),
    line_start: options.line_start,
    line_end: options.line_end,
  };
}

function normalizeCharStart(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('char_start must be a non-negative finite number');
  }
  if (!Number.isInteger(value)) {
    throw new RangeError('char_start must be an integer');
  }
  return Math.floor(value);
}

function normalizeCharLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('char_limit must be a positive finite number');
  }
  if (!Number.isInteger(value)) {
    throw new RangeError('char_limit must be an integer');
  }
  return Math.floor(value);
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer`);
  }
  return Math.floor(value);
}

function buildPageTextWindow(text: string, charStart: number, totalChars: number): PageTextWindow {
  const returnedChars = scalarLength(text);
  const nextCharStart = charStart + returnedChars;
  const hasMore = nextCharStart < totalChars;
  return {
    text,
    char_start: charStart,
    total_chars: totalChars,
    returned_chars: returnedChars,
    next_char_start: hasMore ? nextCharStart : null,
    has_more: hasMore,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
