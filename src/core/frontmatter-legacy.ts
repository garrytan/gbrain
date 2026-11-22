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
import { coerceFrontmatterString, comparableFrontmatter, parseMarkdownHead } from './markdown.ts';
import type { BrainEngine } from './engine.ts';
import { hasCapability } from './engine-capabilities.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from './persistence/sync-holds.ts';

/** parseMarkdown keeps the text it read here, so alignWithStored can read the same file the old way. */
export const PARSED_FILE_TEXT = Symbol.for('gbrain.parsed-file-text');

const OLD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether stored frontmatter can hold an old-typed value at all (a number or an old timestamp text, at any depth). */
export function mayHoldLegacyTyped(value: unknown): boolean {
  if (typeof value === 'number' || value === null) return true; // null: the old typing's .inf / .nan, as JSON stores them
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

/**
 * A file parse aligned with a page stored under the old typing: each value that differs only by that typing reads as
 * stored, and so does a frontmatter title the old typing read as the stored title (`title: 1.10` stored as `1.1`).
 */
export function alignLegacyTyped(parsed: { frontmatter: Record<string, unknown>; title?: string }, stored: Record<string, unknown> | null | undefined, storedTitle?: string | null): void {
  const text = (parsed as { [PARSED_FILE_TEXT]?: string })[PARSED_FILE_TEXT];
  if (typeof text !== 'string') return;
  if (stored) for (const key of legacyWrittenValues(parsed.frontmatter, text, stored).keys()) parsed.frontmatter[key] = stored[key];
  const title = legacyStoredTitle(parsed.title, text, storedTitle);
  if (title !== null) parsed.title = title;
}

/** The stored title when the file's frontmatter `title:` differs from it only by the old typing (`title: 1.10` stored as '1.1'); else null. */
export function legacyStoredTitle(title: string | undefined, fileText: string, storedTitle: string | null | undefined): string | null {
  return typeof storedTitle === 'string' && typeof title === 'string' && title !== storedTitle && legacyTypedTitle(fileText) === storedTitle ? storedTitle : null;
}

/** The title the old typing gave a typed frontmatter `title:` (a number, a date's UTC day); null for a text title or none. */
function legacyTypedTitle(content: string): string | null {
  try {
    const title = (dataFrontmatter(parseMarkdownHead(content).safeContent, LEGACY_TYPED_SCHEMA).data as Record<string, unknown>).title;
    return title == null || typeof title === 'string' ? null : coerceFrontmatterString(title).trim();
  } catch {
    return null;
  }
}

/**
 * The incoming frontmatter of a write over a page stored under the old typing, with the file's text kept for each value
 * the caller left as stored (`written`: legacyWrittenValues of the page's file). A value the caller changed is its own.
 */
export function restoreWrittenValues(incoming: Record<string, unknown>, stored: Record<string, unknown> | null | undefined, written: Map<string, unknown>): void {
  if (!stored) return;
  for (const [key, value] of written) if (Object.hasOwn(incoming, key)) incoming[key] = keptWritten(incoming[key], stored[key], value);
}

/**
 * The caller's value with the written text kept wherever it left the stored value: the whole value when unchanged, else
 * each untouched entry of a mapping or an equal-length list (the written value's old typing equals the stored value, so
 * every entry's does too). An entry the caller changed, added or removed is its own.
 */
function keptWritten(incoming: unknown, stored: unknown, written: unknown): unknown {
  if (same(incoming, stored)) return written;
  if (Array.isArray(incoming) && Array.isArray(stored) && Array.isArray(written) && incoming.length === stored.length && stored.length === written.length) {
    return incoming.map((entry, i) => keptWritten(entry, stored[i], written[i]));
  }
  if (!isMapping(incoming) || !isMapping(stored) || !isMapping(written)) return incoming;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(incoming)) {
    // An own data property, as the YAML and JSON parsers make: assigning `__proto__` would call the inherited setter.
    Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true,
      value: Object.hasOwn(stored, key) && Object.hasOwn(written, key) ? keptWritten(entry, stored[key], written[key]) : entry });
  }
  return out;
}
const isMapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

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
 * pages-03: whether an import record names the importer before pages-03 (import=1, or no parser stamp on a record from
 * before the stamp), as importedByOldParserSql reads it. Only such a record proves the older release stored the page.
 */
export function recordNamesOldImporter(record: { parser?: { parser_version?: string | null } | null } | null | undefined): boolean {
  return !!record && (record.parser?.parser_version ?? 'import=1;').startsWith('import=1;');
}

/**
 * pages-03: SQL true when page row `page` was stored by the importer before pages-03: its import record, at the page's
 * current revision (or at `renamedFrom`, the SQL text of the revision this transaction just renamed the page from),
 * names an importer before import=2 (or none, on records from before the parser stamp). A page with no such record, or
 * one a later edit moved past the recorded revision, is not proven old.
 */
export function importedByOldParserSql(page: string, renamedFrom?: string): string {
  const revision = `lp.completed_keys->0->>'revision'`;
  const atRevision = renamedFrom ? `(${revision}=${page}.knowledge_revision::text OR ${revision}=${renamedFrom})` : `${revision}=${page}.knowledge_revision::text`;
  return `EXISTS (SELECT 1 FROM op_checkpoints lp JOIN sources ls ON ls.id=${page}.source_id
    WHERE lp.op='${SYNC_IMPORT_PROVENANCE_OP}' AND lp.fingerprint=${page}.source_id||':'||ls.incarnation::text||':'||${page}.id::text
      AND ${atRevision}
      AND COALESCE(lp.completed_keys->0->'parser'->>'parser_version','import=1;') LIKE 'import=1;%')`;
}

/**
 * pages-03: `legacyCarry` (legacyHashToCarry) when the live page `pageId` was stored by the importer before pages-03
 * (importedByOldParserSql), else null. `renamedFrom` is the revision the page had before this sync renamed it in the
 * same transaction (nothing else wrote it in between), so a record at that revision still names the stored values'
 * importer. Only such a page's old hash can be the old typing of the file it reads now: on a page today's importer
 * stored, or one a later write changed, the same rebuilt hash is a real edit (`title: 1.1` changed to `title: 1.10`),
 * so the paid phases' records stay where they are. An engine without raw SQL carries nothing.
 */
export async function provenLegacyCarry(engine: BrainEngine, sourceId: string, pageId: unknown, legacyCarry: string | null, renamedFrom?: string | null): Promise<string | null> {
  if (!legacyCarry || pageId == null || !hasCapability(engine, 'raw_sql')) return null;
  const proven = await engine.executeRaw(`SELECT 1 FROM pages page WHERE page.source_id=$1 AND page.id=$2 AND page.deleted_at IS NULL
    AND ${importedByOldParserSql('page', renamedFrom ? '$3::text' : undefined)}`, renamedFrom ? [sourceId, Number(pageId), renamedFrom] : [sourceId, Number(pageId)]);
  return proven.length > 0 ? legacyCarry : null;
}

/**
 * The stored hash to carry the paid page phases' records from, or null: a page stored under the old frontmatter typing
 * whose one-time re-read changes its hash and nothing it means (`hashWith` of the file's old typing is the stored hash).
 * The hash covers the title lifted out of the frontmatter too, so a `title:` the old typing changed is read as stored
 * (alone or with other values); a title the file changed reads differently under the old typing and is never carried.
 * `hashWith` returns null when it cannot hash that reading (the streamed body differs from the live one).
 */
export function legacyHashToCarry(existing: { content_hash?: string | null; deleted_at?: unknown; frontmatter?: unknown; title?: string | null } | null | undefined,
  parsed: { frontmatter: Record<string, unknown>; title: string }, fileText: string, hash: string,
  hashWith: (frontmatter: Record<string, unknown>, title: string) => string | null): string | null {
  if (!existing?.content_hash || existing.content_hash === hash || existing.deleted_at) return null;
  const view = legacyStoredView(parsed, fileText, existing);
  return view && hashWith(view.frontmatter, view.title) === existing.content_hash ? existing.content_hash : null;
}

/**
 * A file parse read as a page stored under the old typing holds it: each frontmatter value and the title the old parser
 * typed read as stored (legacyStoredFrontmatter, legacyStoredTitle). Null when nothing differs only by that typing.
 */
export function legacyStoredView(parsed: { frontmatter: Record<string, unknown>; title: string }, fileText: string,
  existing: { frontmatter?: unknown; title?: string | null }): { frontmatter: Record<string, unknown>; title: string } | null {
  const frontmatter = legacyStoredFrontmatter(parsed.frontmatter, fileText, comparableFrontmatter(existing.frontmatter as Record<string, unknown> | null | undefined));
  const title = legacyStoredTitle(parsed.title, fileText, existing.title);
  return frontmatter || title !== null ? { frontmatter: frontmatter ?? parsed.frontmatter, title: title ?? parsed.title } : null;
}

/**
 * Whether a page stored under the old typing still holds what this file imported, though an import now stores the file's
 * text (the drift baseline check, sync-run.ts): `unchangedAs` (the import's own no-op test) asks it of the parse read as
 * stored (legacyStoredView), under the hash the older release stored over that reading or, for a row an earlier re-read
 * restamped, under today's hash.
 */
export async function legacyUnchangedAs<P extends { frontmatter: Record<string, unknown>; title: string }>(parsed: P, fileText: string,
  existing: { frontmatter?: unknown; title?: string | null }, hashOf: (view: { frontmatter: Record<string, unknown>; title: string }) => string,
  unchangedAs: (page: P, pageHash?: string) => Promise<boolean>): Promise<boolean> {
  const view = legacyStoredView(parsed, fileText, existing);
  if (!view) return false;
  const page = { ...parsed, ...view };
  return await unchangedAs(page, hashOf(view)) || await unchangedAs(page);
}

/**
 * Carries the content_hash-keyed records of the paid page phases (extract_atoms' scan state, chronicle's ledger) from
 * a page's old hash to its new one, so a re-read that changes only how values are kept does not scan or judge the page
 * again. A page whose atoms carry the old hash (scanned before the scan-state table) gets a finished scan at the new
 * hash. The scan state and the managed atom checkpoints (a partial or held page's disposition lives only there) are
 * copied; a settled chronicle ledger row (extracted or skipped) moves (it holds recorded spend, which campaign and ledger
 * totals sum, so a copy would count it twice). A pending or failed row never moves: a paid judge may still be calling
 * the model for it (a lease ending proves nothing, since no bound holds a judge to it, and a used-up campaign attempt
 * is marked failed while its judge still runs), and that judge's outcome and spend are keyed to the old hash. Such a
 * row stays, its spend counted there; the cycle marks it superseded and the new hash's own row is judged once more.
 * None replaces a record the new hash already has. Runs inside the page write.
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
  // Keyed by content (managedAtomIdentitySql). A drain key's row (a failure's attempt count, a hold, a cut) is copied to
  // the drain key of the new hash, which the drain and the held page's retry read; any other row is copied under its own
  // fingerprint. Every copy names the page's current slug (a rename in the same sync moved it), so a hold listed from
  // either copy shows where the page is now. Either way a run keyed to the old hash keeps its row.
  const { carriedAtomDrainKey } = await import('./persistence/atom-maintenance.ts');
  const checkpoints = await tx.executeRaw<{ fingerprint: string }>(
    `SELECT ac.fingerprint FROM op_checkpoints ac
      WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=$3 AND ac.completed_keys->0->>'kind'='page'
        AND ac.completed_keys->0->>'pageId'=$1 AND ac.completed_keys->0->>'contentHash'=$2
      ORDER BY ac.fingerprint`,
    [String(pageId), fromHash, sourceId]);
  for (const { fingerprint } of checkpoints) {
    const carried = await carriedAtomDrainKey(tx, pageId, fingerprint, fromHash, toHash) ?? `${fingerprint}:carried:${toHash}`;
    await tx.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
       SELECT ac.op, $2, CASE WHEN p.slug IS NOT NULL AND ac.completed_keys->0 ? 'locator'
           THEN jsonb_set(c.keys, '{0,locator}', to_jsonb(p.slug)) ELSE c.keys END
         FROM op_checkpoints ac CROSS JOIN LATERAL (SELECT jsonb_set(ac.completed_keys, '{0,contentHash}', to_jsonb($3::text)) AS keys) c
         LEFT JOIN pages p ON p.id=$4 AND p.source_id=$5 AND p.deleted_at IS NULL
        WHERE ac.op='managed-atoms' AND ac.fingerprint=$1
       ON CONFLICT DO NOTHING`,
      [fingerprint, carried, toHash, pageId, sourceId]);
  }
  // The settled chronicle row moves, naming the page's slug now (a rename in the same sync moved it).
  await tx.executeRaw(
    `UPDATE chronicle_page_state c SET content_hash=$3,
            slug=COALESCE((SELECT p.slug FROM pages p WHERE p.id=c.page_id AND p.source_id=c.source_id AND p.deleted_at IS NULL), c.slug)
      WHERE c.source_id=$4 AND c.page_id=$1 AND c.content_hash=$2 AND c.state NOT IN ('pending','failed')
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
        AND NOT EXISTS (SELECT 1 FROM chronicle_page_state n WHERE n.source_id=c.source_id AND n.page_id=c.page_id
          AND n.content_hash=$3 AND n.extractor_version=c.extractor_version)`,
    [pageId, fromHash, toHash, sourceId]);
}
