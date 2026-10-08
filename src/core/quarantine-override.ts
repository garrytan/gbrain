/**
 * #6259 (fix wave 12, W1.2): an operator's decision that a quarantined page is
 * not junk, recorded as the `quarantine_override` frontmatter key.
 *
 * The content-quality gate re-derives `quarantine` and `content_flag` on every
 * import, so deleting the marker never sticks: the next sync (or the owner's
 * publication) re-stamps it. `gbrain quarantine clear <slug> --force` writes
 * this key instead. It is bound to the page's title, type and body: while
 * they are unchanged the gate keeps its classifier verdict (junk patterns,
 * operator literals, markup ratio) off the page; any change to them expires
 * the override and the gate decides again. Size gates (oversize `embed_skip`)
 * are not overridden.
 *
 * Trust: only trusted local callers set it. Every untrusted ingress strips it
 * (`settleGateOwnedMarkers`, called by `importFromContent`, which remote put_page,
 * put_pages, HTTP and ingest-capture all reach through `remote: true`); a
 * remote edit that leaves title, type and body unchanged carries the stored
 * override forward, so an unrelated tag edit does not re-hide the page.
 * Company-brain inspection refuses files that carry it.
 */
import type { BrainEngine } from './engine.ts';
import type { ContentSanityResult } from './content-sanity.ts';
import { parseMarkdown, type ParsedMarkdown } from './markdown.ts';
import { sanitizeText } from './batch-rows.ts';
import { sha256 } from './persistence/digest.ts';
import { CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';
import { ATOMS_SCAN_HASH_KEY } from './utils.ts';

export const QUARANTINE_OVERRIDE_KEY = 'quarantine_override';

export interface QuarantineOverride { binding: string; cleared_at: string }

type Bound = Pick<ParsedMarkdown, 'title' | 'type' | 'compiled_truth' | 'timeline'>;

/** What the override is bound to: the classifier's inputs (title, type, body). */
export function quarantineOverrideBinding(page: Bound): string {
  return sha256(JSON.stringify(['quarantine_override/v1', page.title ?? '', page.type ?? '', page.compiled_truth ?? '', page.timeline ?? '']));
}

/** The override for `markdown` exactly as the import gate will parse and canonicalize it. */
export function quarantineOverrideFor(markdown: string, path: string, now = new Date()): QuarantineOverride {
  const parsed = parseMarkdown(markdown, path, { validate: true });
  return { binding: quarantineOverrideBinding({ title: sanitizeText(parsed.title), type: parsed.type,
    compiled_truth: sanitizeText(parsed.compiled_truth), timeline: sanitizeText(parsed.timeline) }), cleared_at: now.toISOString() };
}

function overrideOf(value: unknown): QuarantineOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { binding, cleared_at } = value as Record<string, unknown>;
  return typeof binding === 'string' && /^[0-9a-f]{64}$/.test(binding) && typeof cleared_at === 'string' ? { binding, cleared_at } : null;
}

/** Whether `page` carries an override bound to its current title, type and body. */
export function hasCurrentQuarantineOverride(page: Bound & { frontmatter?: Record<string, unknown> | null }): boolean {
  const override = overrideOf(page.frontmatter?.[QUARANTINE_OVERRIDE_KEY]);
  return !!override && override.binding === quarantineOverrideBinding(page);
}

/**
 * Called by `importFromContent` before the gate assesses `parsed` (already canonicalized).
 *
 * v0.42 (#1699 trust boundary): gate-owned markers are stripped from
 * UNTRUSTED input. parseMarkdown preserves every frontmatter key except
 * type/title/tags/slug, so a remote MCP put_page (ctx.remote !== false,
 * threaded as opts.remote) could otherwise plant `quarantine` (hide a page
 * from search + suppress chunks), `content_flag.detail` (inject text into the
 * agent's trusted "this looks odd" channel) or `embed_skip` on clean content.
 * #1699 part 2: the extract_atoms completion marker is phase-owned; a remote
 * writer planting a matching one would suppress atom mining for the page.
 * Trusted local sync/export round-trips keep them. Fail-closed: strip
 * whenever `remote` is true.
 *
 * #6259: remote input also loses any `quarantine_override` (the gate may
 * carry the stored one forward, `carryStoredQuarantineOverride`); trusted
 * input keeps its own override only while it binds. A stale or malformed
 * override is dropped, and a current one drops classifier markers the content
 * still carries.
 */
export function settleGateOwnedMarkers(parsed: ParsedMarkdown, remote: boolean): void {
  if (remote) {
    for (const key of [QUARANTINE_KEY, CONTENT_FLAG_KEY, EMBED_SKIP_KEY, ATOMS_SCAN_HASH_KEY, QUARANTINE_OVERRIDE_KEY]) delete parsed.frontmatter[key];
    return;
  }
  if (Object.hasOwn(parsed.frontmatter, QUARANTINE_OVERRIDE_KEY) && !hasCurrentQuarantineOverride(parsed)) delete parsed.frontmatter[QUARANTINE_OVERRIDE_KEY];
  dropClassifierMarkers(parsed);
}

/** A classifier marker the content still carries (a file written before the clear) goes with a current override. */
function dropClassifierMarkers(parsed: ParsedMarkdown): void {
  if (!hasCurrentQuarantineOverride(parsed)) return;
  delete parsed.frontmatter[QUARANTINE_KEY];
  if ((parsed.frontmatter[CONTENT_FLAG_KEY] as { reason?: unknown } | undefined)?.reason !== 'oversized') delete parsed.frontmatter[CONTENT_FLAG_KEY];
}

/**
 * The gate verdict for a remote write: when the classifier would hide or
 * markup-flag the page, the stored override is carried forward if it still
 * binds this exact title, type and body, so a remote edit that leaves them
 * unchanged (a tag edit) does not re-hide a cleared page. The stored row is
 * read only on that path, so a clean remote write costs no extra statement
 * (#6007 statement budget).
 */
export async function carryStoredQuarantineOverride(engine: Pick<BrainEngine, 'executeRaw'>, parsed: ParsedMarkdown, result: ContentSanityResult,
  page: { slug: string; sourceId: string | undefined; remote: boolean }): Promise<ContentSanityResult> {
  if (!page.remote || !(result.shouldQuarantine || result.flag_reason === 'markup_heavy')) return result;
  const [stored] = await engine.executeRaw<{ override: unknown }>(
    `SELECT frontmatter->'${QUARANTINE_OVERRIDE_KEY}' AS override FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [page.sourceId ?? 'default', page.slug]);
  const carried = overrideOf(stored?.override);
  if (!carried || carried.binding !== quarantineOverrideBinding(parsed)) return result;
  parsed.frontmatter[QUARANTINE_OVERRIDE_KEY] = carried;
  dropClassifierMarkers(parsed);
  return withQuarantineOverride(result, parsed);
}

/** The gate verdict with the classifier's hide and markup-flag outcomes removed for an overridden page; size outcomes stay. */
export function withQuarantineOverride(result: ContentSanityResult, page: Bound & { frontmatter?: Record<string, unknown> | null }): ContentSanityResult {
  if (!hasCurrentQuarantineOverride(page)) return result;
  const classifier = new Set(['junk_pattern', 'literal_substring', 'high_markup']);
  const kept = result.reasons.map((reason, i) => [reason, result.reason_messages[i]] as const).filter(([reason]) => !classifier.has(reason));
  return { ...result, junk_pattern_matches: [], literal_substring_matches: [],
    reasons: kept.map(([reason]) => reason), reason_messages: kept.map(([, message]) => message!).filter(Boolean),
    shouldQuarantine: false, shouldHardBlock: false, shouldSkipEmbed: result.oversize, shouldFlag: result.oversize,
    flag_reason: result.oversize ? 'oversized' : null };
}
