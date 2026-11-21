/**
 * A page that opens with a frontmatter-looking block the parser does not read, and that block names its readers
 * (`readable_by`, in any spelling), is refused (or held on sync and import) instead of being stored as a page every
 * member can read. The parser reads frontmatter only when the opening `---` is the first thing on its line, so
 * ` ---` with a leading space, a tab or a no-break space, `----`, `+++`, or a fence that never closes yields no
 * frontmatter at all, and the readers the author wrote end up as page text.
 *
 * The check reads the content's first non-blank line: when it looks like a fence, the lines up to the next fence-like
 * line (to the end when none closes) are scanned for a readers-like key, written as a block line (`readable_by: [...]`)
 * or inside a flow mapping (`{title: X, readable_by: [...]}`), spelled in any case with `-`, `_` or spaces. Only then is
 * the content parsed: the block counts as unread when the parse consumed nothing of the content. The check can only
 * refuse, never widen, and never changes how a block the parser reads is parsed.
 *
 * It reuses the `invalid_frontmatter` refusal with the reason `ambiguous_protected_key` (gbrain never guesses who may
 * read a page). The message never echoes the author's key spelling.
 */
import { parseMarkdownHead } from '../markdown.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { WriteRequest } from './model.ts';

/** The one read of an open file the head hold needs (a `node:fs/promises` FileHandle has it). */
interface HeadFile { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }

/** The most a file head read for a streamed import covers (the frontmatter head limit). */
const FILE_HEAD_BYTES = 256 * 1024;
const SPACE = '[^\\S\\r\\n]*';
/** A line that looks like a frontmatter fence, indented or not: `---`, `----`, `+++`, with an optional language word. */
const FENCE_OPEN = new RegExp(`^${SPACE}(?:-{3,}|\\+{3,})${SPACE}[A-Za-z]*${SPACE}$`);
const FENCE_CLOSE = new RegExp(`^${SPACE}(?:-{3,}|\\.{3}|\\+{3,})${SPACE}$`);
/** A readers-like key: a block line (optionally a list item), or a flow-mapping entry after `{` or `,`; case, `-`, `_` and spaces ignored. */
const KEY = String.raw`["']?readable[-_ \t]*by["']?[^\S\r\n]*[:=]`;
const BLOCK_KEY = new RegExp(`^${SPACE}(?:-[^\\S\\r\\n]+)*${KEY}`, 'i');
const FLOW_KEY = new RegExp(`[{,]${SPACE}${KEY}`, 'i');

/** The 1-based line of the first readers-like key in the leading fence-looking block of `content`, or null when it opens with no such block or names none. */
function readersKeyLine(content: string): number | null {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  if (first >= lines.length || !FENCE_OPEN.test(lines[first]!)) return null;
  for (let i = first + 1; i < lines.length; i++) {
    if (FENCE_CLOSE.test(lines[i]!)) return null;
    if (BLOCK_KEY.test(lines[i]!) || FLOW_KEY.test(lines[i]!)) return i + 1;
  }
  return null;
}

/** True when the parser read none of `content` as frontmatter. A parse that throws is not unread: the write's later steps parse it again and refuse. */
function parserReadNothing(content: string): boolean {
  try {
    const head = parseMarkdownHead(content.replace(/^\uFEFF/, ''));
    return head.body.length >= head.lifted.length;
  } catch {
    return false;
  }
}

/** The 1-based line of the readers key in a leading block the parser does not read, or null. */
export function unreadReadersLine(content: string): number | null {
  const line = readersKeyLine(content);
  return line !== null && parserReadNothing(content) ? line : null;
}

/** The guidance every `ambiguous_protected_key` hold carries (markdown.ts HOLD_GUIDANCE), so the message stays a recognised frontmatter hold. */
const GUIDANCE = 'gbrain never guesses who may read a page or where it came from. Write that key on its own line with one quoted value, then import it again.';
const DETAIL = 'the page opens with a frontmatter block that is not read, so the readers it names would be ignored; '
  + 'start the opening fence in the first column with no space before it';
const FIX = 'Start the opening and closing --- fences of the frontmatter in the first column (nothing before them), write the readers as readable_by: [alice-example] on its own line, '
  + 'then check who can read the page with gbrain access check --token <name> --as <member>.';

function holdAt(line: number): ContentRefusal {
  return { code: 'invalid_frontmatter', reason: 'ambiguous_protected_key', key: 'readable_by', line,
    message: `Invalid YAML frontmatter: ${DETAIL} at line ${line} (key "readable_by"). ${GUIDANCE}` };
}

/** The hold a file earns on sync and import when its leading block is unread and names readers, or null. */
export function unreadReadersHold(content: string): ContentRefusal | null {
  const line = unreadReadersLine(content);
  return line === null ? null : holdAt(line);
}

/** The same hold from the first 256 KiB of a file (a streamed import or an over-ceiling upload reads no whole string). */
export async function unreadReadersFileHold(file: HeadFile, size: number): Promise<ContentRefusal | null> {
  const buffer = Buffer.alloc(Math.min(FILE_HEAD_BYTES, size));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  return unreadReadersHold(buffer.toString('utf8', 0, bytesRead));
}

/** The write refusal for a hold: remote callers get no key name in the message. */
function refusal(hold: ContentRefusal, where: string, remote: boolean): OperationError {
  const message = remote ? hold.message.replace(' (key "readable_by")', '') : hold.message;
  return opError('invalid_frontmatter', message, `${where} was not written. ${FIX} Then submit again with a new request_id.`,
    { reason: 'ambiguous_protected_key', legacy_error: 'invalid_params', detail: `line ${hold.line}`,
      docs: 'docs/guides/write-refusals.md#invalid_frontmatter-ambiguous_protected_key' });
}

/** Refuses an authored write (put_page, edit_page, capture) whose content opens with an unread block that names readers; nothing is stored. */
export function assertReadersBlockRead(row: Pick<WriteRequest, 'slug' | 'source_id'>, content: string, remote: boolean): void {
  const hold = unreadReadersHold(content);
  if (hold) throw refusal(hold, `Page ${row.slug} in source ${row.source_id}`, remote);
}

/** The same refusal for a capture's raw input (checked before the capture frontmatter wraps it), which has no slug yet. */
export function assertCaptureBlockRead(content: string, remote: boolean): void {
  const hold = unreadReadersHold(content);
  if (hold) throw refusal(hold, 'The capture', remote);
}
