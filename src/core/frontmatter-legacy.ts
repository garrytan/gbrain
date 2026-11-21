/**
 * pages-03: pages stored before frontmatter kept its values as written hold the old typing (js-yaml's default
 * schema): `born: 1990-05-01` as "1990-05-01T00:00:00.000Z", `zip: 02134` as 2134, `version: 1.10` as 1.1. The file
 * still holds the text the user wrote. This module lets the two meet:
 *
 * - `alignLegacyTyped`: a file-versus-database comparison reads a file value as the stored one when the old typing of
 *   the file reads as the stored value, so an unchanged file is never drift only because the parser changed.
 * - `legacyWrittenValues`: the first write over such a page takes the file's text back for each value the caller left
 *   as stored, so the write publishes (and stores) what the user wrote instead of the old typing.
 *
 * Sync re-imports every Markdown file once after the upgrade (SYNC_IMPORT_PARSER_VERSION), which stores the values as
 * written for every page whose file is unchanged.
 */
import { dataFrontmatter, LEGACY_TYPED_SCHEMA } from './data-frontmatter.ts';
import { comparableFrontmatter, parseMarkdownHead } from './markdown.ts';

/** parseMarkdown keeps the text it read here, so alignWithStored can read the same file the old way. */
export const PARSED_FILE_TEXT = Symbol.for('gbrain.parsed-file-text');

const OLD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether stored frontmatter can hold an old-typed value at all (a number or an old timestamp text, at any depth). */
export function mayHoldLegacyTyped(value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return OLD_TIMESTAMP.test(value);
  if (Array.isArray(value)) return value.some(mayHoldLegacyTyped);
  return !!value && typeof value === 'object' && Object.values(value).some(mayHoldLegacyTyped);
}

/** The frontmatter of `content` as gbrain typed it before pages-03, as stored JSON holds it; null when it does not parse. */
export function legacyTypedFrontmatter(content: string): Record<string, unknown> | null {
  try {
    const data = dataFrontmatter(parseMarkdownHead(content).safeContent, LEGACY_TYPED_SCHEMA).data;
    return comparableFrontmatter(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown) => stableText(a) === stableText(b);
function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableText((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The top-level keys whose value in `fileText` differs from `stored` only because the old parser typed it: the old
 * reading equals the stored value and today's reading does not. Maps each key to today's reading (the text as written).
 */
export function legacyWrittenValues(current: Record<string, unknown>, fileText: string, stored: Record<string, unknown> | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!stored || !mayHoldLegacyTyped(stored)) return out;
  const legacy = legacyTypedFrontmatter(fileText);
  if (!legacy) return out;
  for (const [key, value] of Object.entries(current)) {
    if (!Object.hasOwn(stored, key) || same(value, stored[key])) continue;
    if (Object.hasOwn(legacy, key) && same(legacy[key], stored[key])) out.set(key, value);
  }
  return out;
}

/** A file parse aligned with a page stored under the old typing: each value that differs only by that typing reads as stored. */
export function alignLegacyTyped(parsed: { frontmatter: Record<string, unknown> }, stored: Record<string, unknown> | null | undefined): void {
  const text = (parsed as { [PARSED_FILE_TEXT]?: string })[PARSED_FILE_TEXT];
  if (typeof text !== 'string' || !stored) return;
  for (const key of legacyWrittenValues(parsed.frontmatter, text, stored).keys()) parsed.frontmatter[key] = stored[key];
}

/**
 * The incoming frontmatter of a write over a page stored under the old typing, with the file's text kept for each value
 * the caller left as stored (`written`: legacyWrittenValues of the page's file). A value the caller changed is its own.
 */
export function restoreWrittenValues(incoming: Record<string, unknown>, stored: Record<string, unknown> | null | undefined, written: Map<string, unknown>): void {
  if (!stored) return;
  for (const [key, value] of written) if (Object.hasOwn(incoming, key) && same(incoming[key], stored[key])) incoming[key] = value;
}
