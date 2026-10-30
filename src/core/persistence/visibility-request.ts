/**
 * #7841: a page write whose content asks for `visibility: private` publishes a
 * private page or is refused (`visibility_not_applied`); it never commits, or
 * comes back as a no-op, with the page still world-readable.
 *
 * The request is read from the content's leading frontmatter block line by line,
 * and from the parse of a visibility line, so a request the stored page would not
 * keep is still seen: a key or value in another case (`Visibility: private`,
 * `visibility: Private`, which page privacy does not read as private), a value
 * the parse reshapes (a block scalar, a list) or a line the parse drops. Only a
 * request for `private` is checked, so the guard can only refuse: it never widens
 * a page and never changes what a remote caller may read or write. A request that
 * is kept passes unchanged.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { WriteRequest } from './model.ts';

/** The values the content's frontmatter gives `visibility` (top-level key, any case), lowercased; empty without a closed block. */
export function declaredVisibilities(content: string): string[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trim() !== '---') return [];
  const values: string[] = [];
  for (i++; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i]!)) return values;
    const m = /^(["']?)visibility\1\s*:(.*)$/i.exec(lines[i]!);
    if (m) values.push(m[2]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase());
  }
  return [];
}

/** Every string the frontmatter's `visibility` key (any case) holds, trimmed and lowercased; a list contributes its string items. */
function visibilityValues(frontmatter: Record<string, unknown> | null | undefined): string[] {
  const flatten = (value: unknown): string[] => typeof value === 'string' ? [value.trim().toLowerCase()] : Array.isArray(value) ? value.flatMap(flatten) : [];
  return Object.entries(frontmatter ?? {}).flatMap(([key, value]) => key.toLowerCase() === 'visibility' ? flatten(value) : []);
}

/** The writes whose caller-authored frontmatter is checked: derived writers (add_tag, append_page, maintenance publishes) never carry a request. */
export const privateRequestGuarded = (operation: string, kind: unknown): boolean =>
  (operation === 'put_page' || operation === 'edit_page' || operation === 'capture') && kind !== 'managed_maintenance_page';

/**
 * The private request `content` carries, with the frontmatter it parses to, or null.
 * The content asks for private when a visibility line says so or when the parse
 * reads a visibility key (any case) as private, so a spelling the line scan cannot
 * read is still seen: a value on the next line, a block scalar, a list, a flow
 * mapping, an explicit or merged key. The parse decides; the line scan is only the
 * fallback when the parse throws.
 */
export function readPrivateRequest(content: string, parse: () => Record<string, unknown> | null | undefined): { frontmatter: Record<string, unknown> | null | undefined } | null {
  const inline = declaredVisibilities(content).includes('private');
  let frontmatter: Record<string, unknown> | null | undefined;
  try { frontmatter = parse(); } catch (error) { if (inline) throw error; return null; }
  return inline || visibilityValues(frontmatter).includes('private') ? { frontmatter } : null;
}

/** Page privacy reads only this: the stored frontmatter's lowercase `visibility` key holding exactly `private`. */
const keptPrivate = (published: Record<string, unknown> | null | undefined): boolean => published?.visibility === 'private';

/**
 * #7848: true when `content` asks for `visibility: private` but `frontmatter`, the frontmatter it would store, does not
 * carry exactly that. Sync and import hold such a file (`noncanonicalPrivateHold`); doctor reads a stored page with
 * `content` '' (its frontmatter decides).
 */
export function noncanonicalPrivateRequest(content: string, frontmatter: Record<string, unknown> | null | undefined): boolean {
  return readPrivateRequest(content, () => frontmatter) !== null && !keptPrivate(frontmatter);
}

/** #7848: the `visibility_noncanonical` hold a file earns on sync and import, or null when `noncanonicalPrivateRequest` is false. */
export function noncanonicalPrivateHold(content: string, frontmatter: Record<string, unknown> | null | undefined): ContentRefusal | null {
  if (!noncanonicalPrivateRequest(content, frontmatter)) return null;
  return { code: 'visibility_noncanonical', message: 'The frontmatter asks for visibility: private in a spelling page privacy does not read (another case, a block scalar, a list, '
    + 'a flow mapping or a merge key), so the page would be world-readable; it was not imported. Write visibility: private on its own frontmatter line, lowercase, then sync or import the file again.' };
}

/** Refuses a write that asked for `visibility: private` when `published` (the frontmatter it would store) does not carry exactly that. */
export function assertPrivateRequestKept(row: Pick<WriteRequest, 'slug' | 'source_id'>, published: Record<string, unknown> | null | undefined): void {
  if (keptPrivate(published)) return;
  throw privateRequestRefusal(row, published);
}

/** #7880: the `visibility_not_applied` refusal of a write whose `published` frontmatter does not keep its private request (an unmanaged capture the screen held `visibility_noncanonical`). */
export function privateRequestRefusal(row: Pick<WriteRequest, 'slug' | 'source_id'>, published: Record<string, unknown> | null | undefined): OperationError {
  return visibilityNotApplied(row, visibilityValues(published).includes('private') ? 'noncanonical_value' : 'not_kept');
}

function visibilityNotApplied(row: Pick<WriteRequest, 'slug' | 'source_id'>, reason: 'noncanonical_value' | 'not_kept'): OperationError {
  const cause = reason === 'noncanonical_value'
    ? 'Its frontmatter spells the key or value in another case, which page privacy does not read as private.'
    : 'Its frontmatter asks for private, but the page as it would be stored does not carry visibility: private.';
  return opError('visibility_not_applied', `The write asks for visibility: private, but page ${row.slug} would stay world-readable, so nothing was written (${reason}). Write visibility: private on its own frontmatter line, lowercase, and submit again.`,
    `${cause} Page ${row.slug} in source ${row.source_id} is unchanged. Read it and its revision, write \`visibility: private\` on its own frontmatter line (lowercase key and value), and submit again with a new request_id.`,
    { reason, docs: 'docs/guides/write-refusals.md#visibility_not_applied',
      fix: readFix(`Shows page ${row.slug} in source ${row.source_id} as it is now, with its revision.`,
        { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug], mcp: { tool: 'get_page', arguments: { slug: row.slug, source_id: row.source_id } } }) });
}
