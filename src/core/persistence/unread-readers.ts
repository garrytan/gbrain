/**
 * A page that opens with a frontmatter-looking block the parser does not read, and that block names its readers
 * (`readable_by`, in any spelling), is refused (or held on sync and import) instead of being stored as a page every
 * member can read. The parser reads frontmatter only when the opening `---` is the first thing on its line, so
 * ` ---` with a leading space, a tab or a no-break space, `----`, `+++`, or a fence that never closes yields no
 * frontmatter at all, and the readers the author wrote end up as page text.
 *
 * The check reads the content's first non-blank line: when it looks like a fence, the lines up to the next fence-like
 * line indented like the opener or in the first column (to the end when none closes) are scanned for a readers-like key, written as a block line (`readable_by: [...]`)
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
/** The most of one line the key tests read exactly; a longer line is tested for the key word alone, which stays linear. */
const LINE_MAX = 2048;
const SPACE = '[^\\S\\r\\n]*';
/** A trimmed line that looks like a frontmatter fence: `---`, `----`, `+++`, with an optional language word. */
const FENCE_OPEN = /^(?:-{3,}|\+{3,})\s*[A-Za-z]*$/;
const FENCE_CLOSE = /^(?:-{3,}|\.{3}|\+{3,})$/;
/** A readers-like key: a block line (optionally a list item), or a flow-mapping entry after `{` or `,`; case, `-`, `_` and spaces ignored. */
const KEY = String.raw`["']?readable[-_ \t]*by["']?[^\S\r\n]*[:=]`;
/** What may precede a key on its line without hiding it: list dashes, an explicit-key marker (`?`), an anchor (`&a`) or a tag (`!!str`). */
const DECORATION = String.raw`(?:(?:-|\?|&\S+|!\S*)[^\S\r\n]+)*`;
const BLOCK_KEY = new RegExp(`^${SPACE}${DECORATION}${KEY}`, 'i');
/** An explicit key whose value is on the next line: `? readable_by`. */
const EXPLICIT_KEY = new RegExp(`^${SPACE}(?:-[^\\S\\r\\n]+)*\\?[^\\S\\r\\n]+["']?readable[-_ \\t]*by["']?[^\\S\\r\\n]*$`, 'i');
const FLOW_KEY = new RegExp(`[{,]${SPACE}${DECORATION}${KEY}`, 'i');
const KEY_WORD = /readable[-_ \t]*by["']?[^\S\r\n]*[:=]/i;

/** Zero-width and format characters the parser does not treat as space; they are ignored when looking for a fence or a key, so hiding one before `---` or inside the key hides nothing. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** True when `line` (a comment line is not one) names a readers-like key. */
function namesReaders(line: string): boolean {
  if (line.trimStart().startsWith('#')) return false;
  if (line.length > LINE_MAX) return KEY_WORD.test(line);
  return BLOCK_KEY.test(line) || EXPLICIT_KEY.test(line) || FLOW_KEY.test(line.replace(/[^\S\r\n]#.*$/, ''));
}

/** The leading whitespace of a line. */
const indentOf = (line: string): string => line.slice(0, line.length - line.trimStart().length);

/**
 * Scans the leading fence-looking block of `content`: the 1-based line of its first readers-like key (null when it opens with no such block or
 * names none), and whether the block opened and neither closed nor named a key before the text ended. The block closes at a fence-like line
 * indented exactly like the opener or in the first column, so a `---` inside an indented block scalar does not end it early.
 */
function scanLeadingBlock(content: string): { line: number | null; unclosed: boolean } {
  const lines = content.split(/\r?\n/).map(line => line.replace(ZERO_WIDTH, ''));
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  if (first >= lines.length || lines[first]!.length > LINE_MAX || !FENCE_OPEN.test(lines[first]!.trim())) return { line: null, unclosed: false };
  const opener = indentOf(lines[first]!);
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length <= LINE_MAX && FENCE_CLOSE.test(line.trim()) && (indentOf(line) === opener || indentOf(line) === '')) return { line: null, unclosed: false };
    if (namesReaders(line)) return { line: i + 1, unclosed: false };
  }
  return { line: null, unclosed: true };
}

/** True when the parser read none of `content` as frontmatter. A parse that throws is not unread: the write's later steps parse it again and refuse. */
function parserReadNothing(content: string): boolean {
  try {
    // The content as written (a leading byte order mark included), so the guard and the writer's own parse agree.
    const head = parseMarkdownHead(content);
    return head.body.replace(/^\uFEFF/, '').length >= head.lifted.replace(/^\uFEFF/, '').length;
  } catch {
    return false;
  }
}

/** The 1-based line of the readers key in a leading block the parser does not read, or null. */
export function unreadReadersLine(content: string): number | null {
  const { line } = scanLeadingBlock(content);
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

/** Past this a file whose leading block never closes in its head is held without reading it all (page text is capped far below it). */
const FILE_FULL_BYTES = 256 * 1024 * 1024;

/**
 * The same hold from a file (a streamed import or an over-ceiling upload reads no whole string): its first 256 KiB, and the whole file when
 * the leading fence-looking block has not closed inside that head, so a readers line past the head is still found.
 */
export async function unreadReadersFileHold(file: HeadFile, size: number): Promise<ContentRefusal | null> {
  const buffer = Buffer.alloc(Math.min(FILE_HEAD_BYTES, size));
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  const head = buffer.toString('utf8', 0, bytesRead);
  if (!scanLeadingBlock(head).unclosed || bytesRead >= size) return unreadReadersHold(head);
  if (size > FILE_FULL_BYTES) return holdAt(1);
  const whole = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const { bytesRead: n } = await file.read(whole, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  return unreadReadersHold(whole.toString('utf8', 0, read));
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
