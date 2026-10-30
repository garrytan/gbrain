/**
 * GBRA-133: the canonical file a file-wins reconcile (`repair file-drift --prefer file`, `keep_file_bytes`) leaves. The file
 * keeps its own bytes. Only what reconcile's protections kept from the database is added: protected frontmatter keys the file
 * lacks (inserted before the closing `---`) and database-only timeline rows (appended after the file's timeline, at the end of
 * the file; a timeline the file keeps under a bare `## Timeline` heading gets the `<!-- timeline -->` sentinel above it, so the
 * appended rows stay in it). Anything else the result changes (a key's value, a tag, the title, the body, a timeline that is not
 * an extension of the file's) would need a re-render that reorders keys, re-emits lists and rewrites the body, so it refuses.
 */
import type { ParsedPage } from '../import-file.ts';
import { opError } from '../ops/contract.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { digest } from './digest.ts';
import { protectedReconcileKey } from './reconcile-merge.ts';

const SENTINEL = '<!-- timeline -->';

/** The added protected keys and timeline text, or null when the result changes the file anywhere else. */
function appendedParts(file: ParsedPage, result: ParsedPage): { keys: Record<string, unknown>; timeline: string } | null {
  if (file.type !== result.type || file.title !== result.title || file.compiled_truth !== result.compiled_truth) return null;
  if (digest([...file.tags].sort()) !== digest([...result.tags].sort())) return null;
  for (const key of Object.keys(file.frontmatter)) if (digest(file.frontmatter[key] ?? null) !== digest(result.frontmatter[key] ?? null)) return null;
  const keys: Record<string, unknown> = {};
  for (const key of Object.keys(result.frontmatter)) {
    if (Object.hasOwn(file.frontmatter, key)) continue;
    if (!protectedReconcileKey(key)) return null;
    keys[key] = result.frontmatter[key];
  }
  const base = file.timeline.trimEnd();
  if (!result.timeline.startsWith(base)) return null;
  return { keys, timeline: result.timeline.slice(base.length) };
}

/** The file with the protected keys inserted before its closing `---`, or null when it has no frontmatter block to extend. */
function withKeys(raw: string, keys: Record<string, unknown>): string | null {
  if (!Object.keys(keys).length) return raw;
  const close = raw.startsWith('---\n') ? raw.indexOf('\n---', 3) : -1;
  if (close === -1 || (close + 4 < raw.length && raw[close + 4] !== '\n')) return null;
  return `${raw.slice(0, close + 1)}${dumpFrontmatterYaml(keys).trimEnd()}\n${raw.slice(close + 1)}`;
}

/** Each way to append the timeline text, in order of fewer touched bytes. */
function withTimeline(text: string, fileTimeline: string, appended: string): string[] {
  if (!appended) return [text];
  const body = text.replace(/\n+$/, '');
  if (!fileTimeline.trim()) return [`${body}\n\n${SENTINEL}\n\n${appended.replace(/^\n+/, '')}\n`];
  const out = [`${body}${appended}\n`];
  const at = body.lastIndexOf(fileTimeline.trimEnd());
  if (at > 0 && !body.includes(SENTINEL)) out.push(`${body.slice(0, at)}${SENTINEL}\n\n${body.slice(at)}${appended}\n`);
  return out;
}

/**
 * The file bytes with the protected parts appended, verified by reading them back (`reparse`) to exactly `result`.
 * Throws `file_wins_rewrite` when no such append reaches the result.
 */
export function fileWinsContent(raw: string, file: ParsedPage, result: ParsedPage, reparse: (text: string) => ParsedPage,
  page: { sourceId: string; slug: string }): string {
  if (digest(file) === digest(result)) return raw;
  const parts = raw.includes('\r') ? null : appendedParts(file, result);
  const keyed = parts ? withKeys(raw, parts.keys) : null;
  for (const text of keyed === null ? [] : withTimeline(keyed, file.timeline, parts!.timeline)) {
    try { if (digest(reparse(text)) === digest(result)) return text; } catch { /* the next candidate, or the refusal below */ }
  }
  throw opError('file_wins_rewrite', 'File wins would rewrite the canonical file beyond the protected parts it keeps.',
    `Nothing was written. The resolved result of ${page.slug} in '${page.sourceId}' differs from its file in more than appended protected frontmatter keys and database-only timeline rows, so keeping the file would need a full re-render of it. `
      + 'Commit the differences into the file through the door with `gbrain git commit-push`, or preview with `gbrain repair file-drift --prefer database`, then preview again.',
    { detail: 'file_wins_rewrite' });
}
