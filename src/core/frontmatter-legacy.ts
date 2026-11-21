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
import type { BrainEngine } from './engine.ts';

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

/**
 * The frontmatter a page stored under the old typing held for this parse: each value whose file text the old parser
 * typed is read as stored. Null when no value differs only by that typing. The import's content hash over it equals the
 * stored hash exactly when the one-time re-read changes how values are kept and nothing the page means.
 */
export function legacyStoredFrontmatter(current: Record<string, unknown>, fileText: string, stored: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const written = legacyWrittenValues(current, fileText, stored);
  if (!stored || written.size === 0) return null;
  const out = { ...current };
  for (const key of written.keys()) out[key] = stored[key];
  return out;
}

/**
 * The stored hash to carry the paid page phases' records from, or null: a page stored under the old frontmatter typing
 * whose one-time re-read changes its hash and nothing it means (`hashWith` of the file's old typing is the stored hash).
 */
export function legacyHashToCarry(existing: { content_hash?: string | null; deleted_at?: unknown; frontmatter?: unknown } | null | undefined,
  frontmatter: Record<string, unknown>, fileText: string, hash: string, hashWith: (frontmatter: Record<string, unknown>) => string): string | null {
  if (!existing?.content_hash || existing.content_hash === hash || existing.deleted_at) return null;
  const storedMeaning = legacyStoredFrontmatter(frontmatter, fileText, comparableFrontmatter(existing.frontmatter as Record<string, unknown> | null | undefined));
  return storedMeaning && hashWith(storedMeaning) === existing.content_hash ? existing.content_hash : null;
}

/**
 * Carries the content_hash-keyed records of the paid page phases (extract_atoms' scan state, chronicle's ledger) from
 * a page's old hash to its new one, so a re-read that changes only how values are kept does not scan or judge the page
 * again. A page whose atoms carry the old hash (scanned before the scan-state table) gets a finished scan at the new
 * hash. Inserts only where the new hash has no record. Runs inside the import's page write.
 */
export async function carryHashKeyedPageState(tx: BrainEngine, sourceId: string, pageId: number, fromHash: string, toHash: string): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)
     SELECT s.incarnation, $1, $3, COALESCE(e.fail_count, 0), COALESCE(e.tombstoned, true), e.partial_input_chars
       FROM sources s LEFT JOIN extract_atoms_page_state e ON e.source_incarnation=s.incarnation AND e.page_id=$1 AND e.content_hash=$2
      WHERE s.id=$4 AND (e.page_id IS NOT NULL OR EXISTS (SELECT 1 FROM pages atom WHERE atom.type='atom' AND atom.source_id=$4
        AND atom.frontmatter->>'source_hash'=substring($2 from 1 for 16) AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
        AND atom.deleted_at IS NULL))
     ON CONFLICT DO NOTHING`,
    [pageId, fromHash, toHash, sourceId]);
  const columns = `extractor_version, slug, state, reason, trigger, principal_kind, principal_id, request_id, no_extract, attempts,
    next_attempt_at, cost_usd, unpriced, event_slugs, event_hashes, decided_at, updated_at, campaign_id, attempt_cap_usd, max_attempts,
    pricing_policy, campaign_max_usd, cost_attempts, judge_input_hash, judge_window_chars, judge_window_hash, judge_input_failures`;
  await tx.executeRaw(
    `INSERT INTO chronicle_page_state (source_id, page_id, content_hash, ${columns})
     SELECT source_id, page_id, $3, ${columns} FROM chronicle_page_state WHERE source_id=$4 AND page_id=$1 AND content_hash=$2
     ON CONFLICT DO NOTHING`,
    [pageId, fromHash, toHash, sourceId]);
}
