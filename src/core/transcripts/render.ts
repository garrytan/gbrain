/**
 * render.ts — session → conversation page(s) for the transcripts-import lane
 * (cathedral-4).
 *
 * Pipeline per session (all BEFORE any engine write; fail-closed — a throw
 * here means the caller aborts the SESSION, never writes a partial page):
 *
 *   redact (secret-scan + user patterns + imperative count)
 *     → render body lines (imessage-slack, REAL timestamps, anchor-escape)
 *       → split at message boundaries into part pages under the embed-skip
 *         threshold → frontmatter (YAML serializer, mandatory type+date).
 *
 * Body format is the conversation-parser `imessage-slack` builtin — the
 * REGEX IS SHARED (imported from builtins.ts), never re-declared: the line
 * we emit must match it (round-trip guarantee) and any BODY line that would
 * match it is escaped so hostile message content cannot forge speakers or
 * timestamps on re-parse.
 *
 * Split pages: bodies over PART_TARGET_BYTES split at message boundaries
 * with OVERLAP_MESSAGES carried into the next part (cross-boundary
 * decision/answer pairs can still ground facts; extraction dedup absorbs the
 * duplicates). Splitting exists because pages over the ~500KB embed_skip
 * threshold import as zero-chunk, unsearchable pages — the 5MB import cap is
 * NOT the binding limit, embed-skip is. Part slugs: part 1 keeps the base
 * slug (stable when a session later grows into more parts); parts 2..N get
 * `-pN`. frontmatter.id is UNIQUE PER PART (`<id8>-pN`) — a shared
 * per-session id would make parts 2..N skip as cross-slug duplicates.
 */

import { safeDump } from 'js-yaml';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BYTES_BLOCK } from '../content-sanity.ts';
import { redactFindings } from '../secret-scan.ts';
import { loadPatterns } from '../skillpack/harvest-lint.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { ensureWellFormed, truncateUtf8 } from '../text-safe.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import type { ParsedSession, TranscriptMessage } from './types.ts';
import { buildTranscriptSlug, transcriptFullId } from './types.ts';

// ── Shared line format (imessage-slack builtin) ─────────────────────────────

const IMESSAGE_SLACK = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack');
if (!IMESSAGE_SLACK) {
  throw new Error('conversation-parser builtin imessage-slack is missing — render format broken');
}
/** The one anchor regex — imported from the parser, never re-declared. */
export const MESSAGE_ANCHOR_RE: RegExp = IMESSAGE_SLACK.regex;

/** Date-heading shapes some builtins treat as day boundaries — escaped too. */
const DATE_HEADING_RE = /^#{1,6}\s*\d{4}-\d{2}-\d{2}\b/;

/** ~4K chars per message keeps pages readable; full text stays in source_uri. */
export const MESSAGE_CHAR_CAP = 4000;

/**
 * Part bodies target well under the embed-skip/block threshold — the tie is
 * CODE, not prose: a part page at or above the content-sanity block line
 * would import as a zero-chunk, unsearchable page, defeating the split.
 * (Operators can lower the threshold via config; the 0.6 factor leaves
 * headroom for frontmatter overhead and modest overrides.)
 */
export const PART_TARGET_BYTES = Math.min(300 * 1024, Math.floor(DEFAULT_BYTES_BLOCK * 0.6));
/** Messages repeated at each part boundary for cross-part fact grounding. */
export const OVERLAP_MESSAGES = 2;

/** Adapter-schema version stamped into transcript_import frontmatter. */
export const TRANSCRIPT_IMPORT_VERSION = 1;

// ── Redaction ────────────────────────────────────────────────────────────────

/** Default user-pattern file — the same convention skillpack harvest uses. */
export function defaultUserPatternsPath(): string {
  return join(homedir(), '.gbrain', 'harvest-private-patterns.txt');
}

/**
 * Agent-directed imperative shapes. Detection only STAMPS A COUNT into the
 * page's transcript_import frontmatter (hash-covered, idempotent) so readers
 * and future triage can see the page carries instruction-shaped content —
 * it never hides or rewrites the text.
 */
const IMPERATIVE_RES: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|context|rules)\b/i,
  /\byou\s+(must|should)\s+now\s+(act|behave|respond)\b/i,
  /\bnew\s+system\s+prompt\b/i,
];

export interface RedactedSession {
  session: ParsedSession;
  redactionCount: number;
  imperativesFlagged: number;
}

export type ImportRedactionPattern = { regex: RegExp; source: string };

/**
 * Compile the import-lane redaction pattern set ONCE per run. The harvest
 * defaults include a slack-channel pattern that also matches issue/PR refs
 * (a token like a hash-prefixed number) — ubiquitous in coding transcripts
 * and NOT private — so it is excluded; the other defaults (private names,
 * emails) plus every user-file pattern stay.
 */
export function loadImportRedactionPatterns(userPatternsPath?: string): ImportRedactionPattern[] {
  return loadPatterns(userPatternsPath ?? defaultUserPatternsPath()).filter(
    (p) => !p.source.includes('(?:^|\\s)#'),
  );
}

/**
 * Secret-scan + user-pattern redaction over every text surface that will be
 * persisted (message text, SPEAKER labels, title, raw-meta string fields).
 * Throws on scanner or pattern failure — page writes are FAIL-CLOSED (unlike
 * the hook corpus lane, these pages are searchable and synced).
 */
export function redactSession(
  session: ParsedSession,
  opts: { userPatternsPath?: string; patterns?: ImportRedactionPattern[] } = {},
): RedactedSession {
  const patterns = opts.patterns ?? loadImportRedactionPatterns(opts.userPatternsPath);
  let redactionCount = 0;
  let imperativesFlagged = 0;

  const clean = (text: string): string => {
    // sanitizeForJsonb (NUL-strip + well-form): transcripts capture raw tool
    // output that legitimately carries U+0000, which Postgres text/jsonb
    // reject at the write boundary (#4392).
    let out = sanitizeForJsonb(text);
    const r = redactFindings(out);
    redactionCount += r.redactions.length;
    out = r.text;
    for (const { regex } of patterns) {
      out = out.replace(regex, () => {
        redactionCount++;
        return '<REDACTED:user-pattern>';
      });
    }
    return out;
  };

  const messages = session.messages.map((m) => {
    for (const re of IMPERATIVE_RES) {
      if (re.test(m.text)) {
        imperativesFlagged++;
        break;
      }
    }
    // Speaker labels are persisted into the anchor line, so they get the
    // same redaction as bodies (a secret or private name in a display name
    // must not bypass the scan).
    return {
      ...m,
      text: clean(m.text),
      ...(m.speaker ? { speaker: clean(m.speaker) } : {}),
    };
  });

  const meta = { ...session.meta };
  if (meta.title) meta.title = clean(meta.title);
  if (meta.raw) {
    // Flatness is ENFORCED, not assumed: strings are cleaned; primitive
    // scalars pass; anything nested (arrays/objects an adapter let through
    // from hostile export data) is DROPPED — it would reach putRawData
    // unscanned otherwise.
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta.raw)) {
      if (typeof v === 'string') raw[k] = clean(v);
      else if (v === null || typeof v === 'number' || typeof v === 'boolean') raw[k] = v;
    }
    meta.raw = raw;
  }

  return { session: { meta, messages }, redactionCount, imperativesFlagged };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** `2026-08-01T10:00:05.000Z` → `(2026-08-01 10:00 AM)` (UTC), matching the builtin. */
function anchorTimestamp(iso: string): string {
  const d = new Date(iso);
  const day = iso.slice(0, 10);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${h}:${mm} ${ampm}`;
}

/**
 * Escape any BODY line that would parse as a message anchor or a date
 * heading: a leading backslash breaks both `^\*\*` and `^#` while staying
 * readable in raw markdown. Without this, a pasted anchor-shaped line inside
 * a message forges speakers/timestamps on round-trip (P0).
 */
export function escapeAnchorLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (MESSAGE_ANCHOR_RE.test(line) || DATE_HEADING_RE.test(line) ? `\\${line}` : line))
    .join('\n');
}

export interface RenderedPart {
  slug: string;
  /** Full page content: YAML frontmatter + body. */
  content: string;
  /** UNIQUE per part — the import-dedup identity. */
  frontmatterId: string;
  part: number;
  of: number;
}

export interface RenderSessionResult {
  parts: RenderedPart[];
  /** Base slug (part 1's slug) — putRawData and reconciliation key off it. */
  baseSlug: string;
  dateIso: string;
}

/**
 * Speaker label for the anchor line. Anchor-forming characters are stripped
 * (never escaped — the label sits INSIDE the anchor, so a speaker containing
 * `**` or `(date):` shapes could otherwise forge message boundaries on
 * round-trip; hostile BODY lines are handled by escapeAnchorLines).
 */
function speakerLabel(m: TranscriptMessage): string {
  const raw = m.speaker?.trim();
  if (!raw) return m.role === 'user' ? 'User' : 'Assistant';
  const cleaned = ensureWellFormed(raw).replace(/\*/g, '').replace(/[()\n:]/g, ' ').trim();
  return cleaned || (m.role === 'user' ? 'User' : 'Assistant');
}

/**
 * Render one redacted session into 1..N part pages. Timestamps: each message
 * uses its own REAL timestamp; a message missing one carries the previous
 * message's timestamp forward (carried, never fabricated — documented in the
 * page header note); a session with NO timestamps at all is unrenderable and
 * throws (the adapter contract requires real times).
 */
export function renderSessionParts(
  redacted: RedactedSession,
  opts: { sourcePath: string } = { sourcePath: '' },
): RenderSessionResult {
  const { session, imperativesFlagged } = redacted;
  const { meta, messages } = session;
  if (!messages.length) throw new Error('renderSessionParts: session has no messages');

  const firstTs = meta.startedAt || messages.find((m) => m.timestamp)?.timestamp;
  if (!firstTs) {
    throw new Error(
      `session ${meta.sessionId} carries no timestamps — refusing to fabricate provenance`,
    );
  }
  const dateIso = firstTs;
  const baseSlug = buildTranscriptSlug(meta.harness, dateIso, {
    sessionId: meta.sessionId,
    title: meta.title,
  });
  // Dedup identity: HARNESS-NAMESPACED 64-bit hash (importFromContent skips
  // any cross-slug frontmatter-id match as a duplicate, so this id must be
  // collision-proof across harnesses, days, and fallback session ids).
  const identityBase = `${meta.harness}-${transcriptFullId(meta.sessionId)}`;

  // One rendered block per message (anchor line + escaped continuation).
  let lastTs = firstTs;
  const blocks: string[] = messages.map((m) => {
    const ts = m.timestamp || lastTs;
    lastTs = ts;
    const text = escapeAnchorLines(truncateUtf8(m.text, MESSAGE_CHAR_CAP));
    const [head, ...rest] = text.split('\n');
    const anchor = `**${speakerLabel(m)}** (${anchorTimestamp(ts)}): ${head}`;
    return rest.length ? `${anchor}\n${rest.join('\n')}` : anchor;
  });

  // Split at message boundaries under the part target, with overlap.
  const groups: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const bytes = Buffer.byteLength(b, 'utf8') + 2;
    if (current.length > 0 && currentBytes + bytes > PART_TARGET_BYTES) {
      groups.push(current);
      const overlap = current.slice(-OVERLAP_MESSAGES);
      current = [...overlap];
      currentBytes = overlap.reduce((n, s) => n + Buffer.byteLength(s, 'utf8') + 2, 0);
    }
    current.push(b);
    currentBytes += bytes;
  }
  if (current.length) groups.push(current);

  const of = groups.length;
  const title = meta.title?.trim() || `${meta.harness} session ${meta.sessionId.slice(0, 12)}`;

  const parts: RenderedPart[] = groups.map((group, idx) => {
    const part = idx + 1;
    const slug = part === 1 ? baseSlug : `${baseSlug}-p${part}`;
    const frontmatterId = `${identityBase}-p${part}`;
    const fm: Record<string, unknown> = {
      type: 'conversation',
      title: of > 1 ? `${title} (part ${part} of ${of})` : title,
      date: dateIso.slice(0, 10),
      id: frontmatterId,
      transcript_import: {
        harness: meta.harness,
        session_id: meta.sessionId,
        version: TRANSCRIPT_IMPORT_VERSION,
        part,
        of,
        ...(imperativesFlagged > 0 ? { imperatives_flagged: imperativesFlagged } : {}),
      },
    };
    const body = group.join('\n\n');
    const content = `---\n${safeDump(fm, { lineWidth: 1000 })}---\n\n${body}\n`;
    return { slug, content, frontmatterId, part, of };
  });

  return { parts, baseSlug, dateIso };
}
