/**
 * #6982: the guard every unmanaged writer that mirrors a checkout file into `pages` runs first. A fence writer plans
 * its edit on the file and then copies the file's body over the page's database body (`refreshPageBody`, a narrow
 * UPDATE with no version of its own). That copy is only safe when the database body is the file's body: otherwise the
 * database holds an edit the file lacks (a database-only write with `sync.write_through` off, a remote write, a
 * failed write-through) or the file holds one sync has not imported, and the copy silently drops one of them.
 *
 * The comparison is the one the mirror can lose: the parsed and sanitized file body and timeline against the stored
 * ones, trimmed as the importer trims them. Frontmatter, title, type and tags are not compared because the mirror
 * never writes them. `mirrorFileBody` re-reads the stored body under a row lock inside the caller's transaction and
 * writes only when it still equals the body the caller compared, keeping the replaced body in page_versions first.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { sanitizeText } from '../batch-rows.ts';
import { parseMarkdown, parseMarkdownHead } from '../markdown.ts';
import { contentHash, contentHashFrontmatterAndTags } from '../utils.ts';
import { stableJson } from '../persistence/digest.ts';
import { classifyItemFailure } from '../item-failure.ts';

export interface StoredBody {
  compiled_truth: string | null;
  timeline: string | null;
}

/** The diagnostic and repair choices for a held unmanaged file/body mirror. */
export function fileDatabaseDriftToken(slug: string, sourceId: string, when: 'before' | 'during',
  disposition = 'its rows stay unfenced, active and searchable until they agree', step = 'the fence step'): string {
  return `${slug} (file_database_drift: the canonical file and the database body ${when === 'before' ? 'differ' : `changed while ${step} ran`}, `
    + `so neither was replaced and ${disposition}. If the file holds the newer edit, `
    + `gbrain sync --source ${sourceId} imports it; if the database copy is newer, re-save it with write-through on `
    + `(gbrain get ${slug} --source ${sourceId}, then gbrain put ${slug} --source-id ${sourceId}); when both changed, ask the user which edit wins)`;
}

/** The file's body and timeline as the mirror would store them. */
export function mirroredBody(fileBytes: string, slug: string): { compiled_truth: string; timeline: string } {
  const parsed = parseMarkdown(fileBytes, `${slug}.md`);
  return { compiled_truth: sanitizeText(parsed.compiled_truth), timeline: sanitizeText(parsed.timeline ?? '') };
}

/** Whether mirroring `fileBytes` over `stored` would replace nothing but whitespace the importer trims. */
export function fileBodyMatchesStored(fileBytes: string, slug: string, stored: StoredBody): boolean {
  const file = mirroredBody(fileBytes, slug);
  return file.compiled_truth.trim() === (stored.compiled_truth ?? '').trim() && file.timeline.trim() === (stored.timeline ?? '').trim();
}

/** The live page's stored body, or null when there is no live page. `lock` takes the row lock (inside a transaction). */
export async function readStoredBody(engine: BrainEngine, sourceId: string, slug: string, lock = false): Promise<StoredBody | null> {
  const [row] = await engine.executeRaw<StoredBody>(
    `SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [sourceId, slug]);
  return row ?? null;
}

async function storedBodyUnchanged(tx: BrainEngine, sourceId: string, slug: string, expected: StoredBody): Promise<boolean> {
  const current = await readStoredBody(tx, sourceId, slug, true);
  return current !== null && current.compiled_truth === expected.compiled_truth && current.timeline === expected.timeline;
}

/**
 * Keep the preimage lock in the publication transaction while isolating a best-effort cache mirror in a savepoint.
 * False holds publication on drift. An unexpected mirror failure rolls back only the cache attempt and reports it;
 * publication may continue under the retained lock. Run-scoped failures still abort the publication transaction.
 */
export async function bestEffortStoredBodyMirror(tx: BrainEngine, sourceId: string, slug: string, expected: StoredBody,
  mirror: (savepoint: BrainEngine) => Promise<boolean>, onFailure: (err: unknown) => void): Promise<boolean> {
  if (!await storedBodyUnchanged(tx, sourceId, slug, expected)) return false;
  try { return await tx.transaction(mirror); }
  catch (err) {
    if (classifyItemFailure(err).scope === 'run') throw err;
    onFailure(err);
    return true;
  }
}

/**
 * Inside `tx`: lock the page, and when its stored body is still `expected` (the body the caller compared before
 * planning), keep it in page_versions and store `next`. The row keeps its content_hash unless `hash` is given.
 * Returns false, writing nothing, when the page is gone or moved.
 */
export async function replaceStoredBody(tx: BrainEngine, sourceId: string, slug: string, next: { compiled_truth: string; timeline: string },
  expected: StoredBody, hash?: string): Promise<boolean> {
  if (!await storedBodyUnchanged(tx, sourceId, slug, expected)) return false;
  const page = await tx.getPage(slug, { sourceId });
  if (!page) return false;
  await tx.createVersion(slug, { sourceId });
  await tx.refreshPageBody(slug, sourceId, next.compiled_truth, next.timeline, hash ?? (page.content_hash || contentHash(page)));
  return true;
}

/**
 * Inside `tx`: `replaceStoredBody` with the body `fileBytes` mirrors. Without `hash` the row keeps its content_hash,
 * so the next sync re-imports and re-chunks the page.
 */
export async function mirrorFileBody(tx: BrainEngine, sourceId: string, slug: string, fileBytes: string, expected: StoredBody, hash?: string): Promise<boolean> {
  return replaceStoredBody(tx, sourceId, slug, mirroredBody(fileBytes, slug), expected, hash);
}

/** Page states a checkout file is compared with: the live row, then its newest page_versions rows. */
const HISTORY_ROWS = 20;

interface StoredState extends StoredBody {
  frontmatter: Record<string, unknown> | null;
  title: string | null;
  type: string | null;
  tags: unknown;
}

/**
 * Whether the file's body, timeline, every frontmatter key it carries (ephemeral keys aside), its tags, and the title
 * and type its frontmatter declares equal `state`'s.
 */
function fileHeldBy(fileBytes: string, slug: string, state: StoredState): boolean {
  if (!fileBodyMatchesStored(fileBytes, slug, state)) return false;
  const parsed = parseMarkdown(fileBytes, `${slug}.md`);
  const declared = parseMarkdownHead(fileBytes).frontmatter;
  if (declared.title !== undefined && sanitizeText(parsed.title).trim() !== (state.title ?? '').trim()) return false;
  if (parsed.typeExplicit && parsed.type !== state.type) return false;
  const storedTags = Array.isArray(state.tags) ? state.tags.map(String) : [];
  if (JSON.stringify([...new Set(parsed.tags)].sort()) !== JSON.stringify([...new Set(storedTags)].sort())) return false;
  const file = contentHashFrontmatterAndTags({ frontmatter: parsed.frontmatter });
  const stored = contentHashFrontmatterAndTags({ frontmatter: state.frontmatter ?? {} });
  return Object.entries(file.frontmatter).every(([key, value]) => stored.frontmatter[key] !== undefined && stableJson(value) === stableJson(stored.frontmatter[key]));
}

/**
 * #6982, the database→file direction: whether gbrain may replace or remove the checkout file at `filePath` for page
 * `slug` without losing an edit. It may when the file is absent, or when the file holds nothing the database lacks:
 * its body, timeline and frontmatter equal the live page's or one of its newest page_versions rows (the state before
 * the database write being published). Otherwise the file carries an edit only it holds (a hand edit sync has not
 * imported, or an unindexed file at the path), and the caller leaves it and reports the page.
 *
 * `expectedFileBytes` is what the caller passes to `writePageThrough` (null: the file must still be absent), so a file
 * that changes between this check and the write is refused there too.
 */
export async function replaceableFile(engine: BrainEngine, sourceId: string, slug: string, filePath: string):
  Promise<{ ok: true; expectedFileBytes: string | null } | { ok: false }> {
  if (!existsSync(filePath)) return { ok: true, expectedFileBytes: null };
  const bytes = readFileSync(filePath, 'utf-8');
  const states = await engine.executeRaw<StoredState>(
    `(SELECT p.compiled_truth, p.timeline, p.frontmatter, p.title, p.type,
             to_jsonb(ARRAY(SELECT t.tag FROM tags t WHERE t.page_id = p.id)) AS tags
        FROM pages p WHERE p.source_id = $1 AND p.slug = $2)
     UNION ALL
     (SELECT v.compiled_truth, v.timeline, v.frontmatter, v.title, v.type, v.tags FROM page_versions v JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL ORDER BY v.id DESC LIMIT ${HISTORY_ROWS})`,
    [sourceId, slug]);
  return states.some(state => fileHeldBy(bytes, slug, state)) ? { ok: true, expectedFileBytes: bytes } : { ok: false };
}
