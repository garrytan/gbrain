/**
 * render.ts — session → conversation page(s) for the transcripts-import lane
 * (cathedral-4).
 *
 * Pipeline per session (all BEFORE any engine write; fail-closed — a throw
 * here means the caller aborts the SESSION, never writes a partial page):
 *
 *   redact (secret-scan + user patterns + imperative count)
 *     → render body lines (imessage-slack, REAL timestamps, anchor-escape)
 *       → group at message boundaries under the layout's part bytes
 *         → frontmatter (YAML serializer, mandatory type+date).
 *
 * Body format is the conversation-parser `imessage-slack` builtin — the
 * REGEX IS SHARED (imported from builtins.ts), never re-declared: the line
 * we emit must match it (round-trip guarantee) and any BODY line that would
 * match it is escaped so hostile message content cannot forge speakers or
 * timestamps on re-parse.
 *
 * Layouts (Wave B; the mode comes from what is stored, see ingest.ts
 * `storedTranscriptLayout`):
 *   - single: a new session is one page, grouped under the page ceiling
 *     (`pages.max_bytes` or the content-sanity block line, whichever is
 *     lower, times PAGE_CEILING_FILL). Since Wave A a page up to that ceiling
 *     is stored, chunked and embedded like any other, so there is no smaller
 *     size a session has to be split at. Its frontmatter is `part: 1, of: 1`,
 *     as before.
 *   - split: a session imported before Wave B as parts of PART_TARGET_BYTES
 *     keeps them and their greedy grouping, so a grown session leaves parts
 *     1..N-1 byte-identical and only the last part (or a new one) changes.
 *     The part count is not in hashed content: the title is
 *     `<title> (part X)` and `transcript_import` carries `part` and the
 *     `part_bytes` the parts are grouped at, never `of`. A single-layout
 *     session that overflows the ceiling (a message larger than the ceiling,
 *     or a session past it) is written the same way, pinned at that ceiling.
 * Groups break at message boundaries with OVERLAP_MESSAGES carried into the
 * next part (cross-boundary decision/answer pairs can still ground facts;
 * extraction dedup absorbs the duplicates). No message is truncated (#6388):
 * one too large for a part becomes continuation blocks that repeat its
 * speaker and timestamp anchor, cut only at code-point boundaries, after
 * redaction and escaping ran over the whole message; continuation blocks are
 * never repeated as overlap. Part slugs: part 1 keeps the base slug; parts
 * 2..N get `-pN`. frontmatter.id is UNIQUE PER PART (`<id8>-pN`) — a
 * shared per-session id would make parts 2..N skip as cross-slug duplicates.
 */

import { gbrainPath } from '../config.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { join } from 'node:path';
import { DEFAULT_BYTES_WARN } from '../content-sanity.ts';
import { applyRedaction, planRedaction, type EchoDictionary, type RedactionPlan } from '../secret-scan.ts';
import { loadPatterns } from '../skillpack/harvest-lint.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';
import { ensureWellFormed } from '../text-safe.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import type { ParsedSession, TranscriptMessage } from './types.ts';
import { buildTranscriptSlug, transcriptFullId, utcTimestamp } from './types.ts';

// ── Shared line format (imessage-slack builtin; escaping lives in outside-content.ts) ──

export { escapeAnchorLines, MESSAGE_ANCHOR_RE } from '../outside-content.ts';

/**
 * The part size sessions were split at before Wave B (#5427 set it under the
 * content-sanity WARN line), and the grouping a stored split session without
 * `part_bytes` keeps. New sessions no longer split at it.
 */
export const PART_TARGET_BYTES = Math.floor(DEFAULT_BYTES_WARN * 0.9);
/**
 * Most part pages one session renders to. A session over it is refused before
 * any write (the session is errored and the scan is not clean): 2,000 parts is
 * 90 MB at the pre-Wave-B part size, and a new session splits only past the
 * page ceiling.
 */
export const TRANSCRIPT_MAX_PARTS = 2_000;
/** Share of the page ceiling a single-layout page's body may fill; the rest is frontmatter headroom. */
export const PAGE_CEILING_FILL = 0.9;
/** `single`: a new session, one page under the ceiling; `split`: a stored split session keeps its parts. */
export type TranscriptLayout = 'single' | 'split';
/** Messages repeated at each part boundary for cross-part fact grounding. */
export const OVERLAP_MESSAGES = 2;

/** Adapter-schema version stamped into transcript_import frontmatter. */
export const TRANSCRIPT_IMPORT_VERSION = 1;

// ── Redaction ────────────────────────────────────────────────────────────────

/** Default user-pattern file — the same convention skillpack harvest uses. */
export function defaultUserPatternsPath(): string {
  return gbrainPath('harvest-private-patterns.txt');
}

/**
 * Agent-directed imperative shapes. Detection only STAMPS A COUNT into the
 * page's transcript_import frontmatter (hash-covered, idempotent) so readers
 * and future triage can see the page carries instruction-shaped content —
 * it never hides or rewrites the text. The write gate
 * (`src/core/write-gate-patterns.ts`) reuses them as `override` patterns.
 */
export const IMPERATIVE_RES: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|context|rules)\b/i,
  /\byou\s+(must|should)\s+now\s+(act|behave|respond)\b/i,
  /\bnew\s+system\s+prompt\b/i,
];

export interface RedactedSession {
  session: ParsedSession;
  redactionCount: number;
  imperativesFlagged: number;
  /** Per message: whether it matched an imperative shape (a split part counts its own messages). */
  imperativeFlags?: readonly boolean[];
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
 *
 * Detector classes (all from `secret-scan.ts`, format-based — not just vendor
 * prefixes): vendor key shapes (anthropic/openai/voyage/github/gitlab/slack/
 * aws/google/stripe/sendgrid/twilio/supabase/npm/huggingface/digitalocean/
 * openrouter/groq/xai/perplexity/replicate/gbrain), JWTs,
 * whole-block PEM private keys, `Bearer <token>` headers, connection strings
 * carrying inline credentials, and — opted in for THIS lane — the
 * high-entropy `KEY=`/`TOKEN=`/`PASSWORD=` assignment heuristic (value must
 * carry a digit and clear the entropy gate). Transcripts are the corpus where
 * a pasted `.env` line is most likely, so recall wins over the false-positive
 * cost here; the push gate and compiled-context scan keep the heuristic off.
 * Also opted in for this lane only: the `labeled_credential` detector
 * (`secret-scan-labeled.ts`), which claims a low-entropy value typed after a
 * password / login / credentials label (`password: hunter2`, `login alice /
 * hunter2`); a claimed value of 8+ characters that is not a stoplisted word
 * joins the echo dictionary below.
 * Every match becomes `<REDACTED:pattern>`; user patterns become
 * `<REDACTED:user-pattern>`.
 *
 * TWO PHASES, ONE SESSION-WIDE ECHO DICTIONARY. Phase 1 PLANS every persisted
 * field (scan + claimed spans); the eligible bearer / high-entropy values
 * every field claims accumulate in one `echoValues` map under the scanner's
 * shared floors and single cap. Phase 2 APPLIES each plan, and the splice
 * reads the FULL map — so a token claimed in a tool message's
 * `Authorization: Bearer …` header is also scrubbed where the assistant
 * echoed it bare in ANOTHER message (or the title, a speaker label, a
 * metadata value), whichever order the two appear in. Redacting each field
 * independently left those cross-field echoes in the page. The per-field
 * `redactions` that feed `redactionCount` (the receipt) are unchanged by the
 * echo pass: an echo is not a claim and adds no finding.
 */
export function redactSession(
  session: ParsedSession,
  opts: { userPatternsPath?: string; patterns?: ImportRedactionPattern[] } = {},
): RedactedSession {
  const patterns = opts.patterns ?? loadImportRedactionPatterns(opts.userPatternsPath);
  let redactionCount = 0;
  let imperativesFlagged = 0;
  const echoValues: EchoDictionary = new Map();

  const plan = (text: string): RedactionPlan =>
    // sanitizeForJsonb (NUL-strip + well-form): transcripts capture raw tool
    // output that legitimately carries U+0000, which Postgres text/jsonb
    // reject at the write boundary (#4392).
    // highEntropy + labeledCredentials: transcripts opt into the assignment
    // heuristic and the labeled-credential detector (see doc comment above);
    // the shared scanner keeps both off by default.
    planRedaction(sanitizeForJsonb(text), { highEntropy: true, labeledCredentials: true, echoValues });

  const apply = (p: RedactionPlan): string => {
    redactionCount += p.redactions.length;
    let out = applyRedaction(p);
    for (const { regex } of patterns) {
      out = out.replace(regex, () => {
        redactionCount++;
        return '<REDACTED:user-pattern>';
      });
    }
    return out;
  };

  // Phase 1: plan every field.
  const imperativeFlags: boolean[] = [];
  const planned = session.messages.map((m) => {
    const imperative = IMPERATIVE_RES.some((re) => re.test(m.text));
    imperativeFlags.push(imperative);
    if (imperative) imperativesFlagged++;
    // Speaker labels are persisted into the anchor line, so they get the
    // same redaction as bodies (a secret or private name in a display name
    // must not bypass the scan).
    return { m, text: plan(m.text), speaker: m.speaker ? plan(m.speaker) : undefined };
  });
  const titlePlan = session.meta.title ? plan(session.meta.title) : undefined;
  // Flatness is ENFORCED, not assumed: strings are planned; primitive
  // scalars pass; anything nested (arrays/objects an adapter let through
  // from hostile export data) is DROPPED — it would reach putRawData
  // unscanned otherwise.
  const rawEntries: Array<{ key: string; plan: RedactionPlan | null; scalar: unknown }> = [];
  if (session.meta.raw) {
    for (const [key, v] of Object.entries(session.meta.raw)) {
      if (typeof v === 'string') rawEntries.push({ key, plan: plan(v), scalar: undefined });
      else if (v === null || typeof v === 'number' || typeof v === 'boolean') {
        rawEntries.push({ key, plan: null, scalar: v });
      }
    }
  }

  // Phase 2: apply with the complete dictionary.
  const messages = planned.map(({ m, text, speaker }) => ({
    ...m,
    text: apply(text),
    ...(speaker ? { speaker: apply(speaker) } : {}),
  }));
  const meta = { ...session.meta };
  if (titlePlan) meta.title = apply(titlePlan);
  if (meta.raw) {
    const raw: Record<string, unknown> = {};
    for (const e of rawEntries) raw[e.key] = e.plan ? apply(e.plan) : e.scalar;
    meta.raw = raw;
  }

  return { session: { meta, messages }, redactionCount, imperativesFlagged, imperativeFlags };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** `2026-08-01T10:00:05.000Z` → `(2026-08-01 10:00 AM)` (UTC), matching the builtin. */
function anchorTimestamp(iso: string): string {
  const d = new Date(iso);
  const day = Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toISOString().slice(0, 10);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${h}:${mm} ${ampm}`;
}

export interface RenderedPart {
  slug: string;
  /** Full page content: YAML frontmatter + body. */
  content: string;
  /** UNIQUE per part — the import-dedup identity. */
  frontmatterId: string;
  part: number;
  /** The keys this collector renders (and so owns on re-ingest), and the body. */
  frontmatter: Record<string, unknown>;
  body: string;
}

export function renderPartContent(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${body}\n`;
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
 * round-trip; hostile BODY lines are handled by neutralizeOutsideText).
 */
function speakerLabel(m: TranscriptMessage): string {
  const raw = m.speaker?.trim();
  if (!raw) return m.role === 'user' ? 'User' : 'Assistant';
  const cleaned = ensureWellFormed(raw).replace(/\*/g, '').replace(/[()\n:]/g, ' ').trim();
  return cleaned || (m.role === 'user' ? 'User' : 'Assistant');
}

const utf8Bytes = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/**
 * One escaped message → 1..N blocks of at most `maxBytes` UTF-8 bytes, each
 * starting with `anchor` (#6388: no message text is dropped). Fragments break
 * at line breaks when a line fits, and inside an over-long line only at a
 * code-point boundary. A cut piece of a line is always a fragment's FIRST
 * line, which sits on the generated anchor line, so every body line is a
 * whole line that neutralizeOutsideText already saw.
 */
function messageBlocks(anchor: string, text: string, maxBytes: number): string[] {
  const whole = `${anchor}${text}`;
  if (Buffer.byteLength(whole, 'utf8') <= maxBytes) return [whole];
  const room = maxBytes - Buffer.byteLength(anchor, 'utf8');
  if (room < 4) {
    throw new Error(`renderSessionParts: partTargetBytes ${maxBytes + 2} leaves no room for message text after its ${anchor.length}-character anchor`);
  }
  const fragments: string[] = [];
  let current: string | null = null;
  let currentBytes = 0;
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (current !== null && currentBytes + 1 + lineBytes <= room) {
      current += `\n${line}`;
      currentBytes += 1 + lineBytes;
      continue;
    }
    if (current !== null) fragments.push(current);
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < line.length;) {
      const cp = line.codePointAt(i)!;
      const b = utf8Bytes(cp);
      if (bytes + b > room) {
        fragments.push(line.slice(start, i));
        start = i;
        bytes = 0;
      }
      bytes += b;
      i += cp > 0xffff ? 2 : 1;
    }
    current = line.slice(start);
    currentBytes = bytes;
  }
  if (current !== null) fragments.push(current);
  return fragments.map((f) => `${anchor}${f}`);
}

/**
 * The dedup identity of one part (`frontmatter.id`): a HARNESS-NAMESPACED
 * 64-bit hash of the session id plus `-pN`. importFromContent skips any
 * cross-slug frontmatter-id match as a duplicate, so it must be
 * collision-proof across harnesses, days, and fallback session ids.
 */
export function transcriptPartId(meta: Pick<ParsedSession['meta'], 'harness' | 'sessionId'>, part: number): string {
  return `${meta.harness}-${transcriptFullId(meta.sessionId)}-p${part}`;
}

/**
 * Render one redacted session into 1..N part pages. `layout` comes from what
 * is stored (default `single`); `partTargetBytes` is the page ceiling for a
 * single-layout session and the stored part size for a split one. Timestamps:
 * each message uses its own REAL timestamp; a message missing one carries the
 * previous message's timestamp forward (carried, never fabricated — documented
 * in the page header note); a session with NO timestamps at all is
 * unrenderable and throws (the adapter contract requires real times).
 */
export function renderSessionParts(
  redacted: RedactedSession,
  opts: { sourcePath: string; partTargetBytes?: number; layout?: TranscriptLayout } = { sourcePath: '' },
): RenderSessionResult {
  const partTargetBytes = opts.partTargetBytes ?? PART_TARGET_BYTES;
  if (!Number.isSafeInteger(partTargetBytes) || partTargetBytes <= 0) {
    throw new Error(`renderSessionParts: partTargetBytes must be a positive integer (got ${partTargetBytes})`);
  }
  const { session, imperativesFlagged } = redacted;
  const { meta, messages } = session;
  if (!messages.length) throw new Error('renderSessionParts: session has no messages');

  const firstTs = meta.startedAt || messages.find((m) => m.timestamp)?.timestamp;
  if (!firstTs) {
    throw new Error(
      `session ${meta.sessionId} carries no timestamps — refusing to fabricate provenance`,
    );
  }
  const dateIso = utcTimestamp(firstTs);
  const baseSlug = buildTranscriptSlug(meta.harness, dateIso, {
    sessionId: meta.sessionId,
    title: meta.title,
  });
  // One or more rendered blocks per message: the whole message is escaped,
  // then split into continuation blocks (same anchor) when it cannot fit a part.
  let lastTs = firstTs;
  const blocks: Array<{ text: string; bytes: number; continued: boolean; message: number }> = messages.flatMap((m, message) => {
    const ts = m.timestamp || lastTs;
    lastTs = ts;
    const text = neutralizeOutsideText(m.text);
    const fragments = messageBlocks(`**${speakerLabel(m)}** (${anchorTimestamp(ts)}): `, text, partTargetBytes - 2);
    return fragments.map((f) => ({ text: f, bytes: Buffer.byteLength(f, 'utf8') + 2, continued: fragments.length > 1, message }));
  });

  // Split at block boundaries under the part target. Overlap repeats up to
  // OVERLAP_MESSAGES whole messages, never a continuation block, and only
  // as many as still fit beside the next block.
  const groups: Array<typeof blocks> = [];
  let current: typeof blocks = [];
  let currentBytes = 0;
  for (const b of blocks) {
    if (current.length > 0 && currentBytes + b.bytes > partTargetBytes) {
      groups.push(current);
      current = current.slice(-OVERLAP_MESSAGES).filter((c) => !c.continued);
      currentBytes = current.reduce((n, c) => n + c.bytes, 0);
      while (current.length > 0 && currentBytes + b.bytes > partTargetBytes) currentBytes -= current.shift()!.bytes;
    }
    current.push(b);
    currentBytes += b.bytes;
  }
  if (current.length) groups.push(current);

  if (groups.length > TRANSCRIPT_MAX_PARTS) {
    throw new Error(`session ${meta.sessionId} renders ${groups.length} parts at ${partTargetBytes} bytes per part, over the ${TRANSCRIPT_MAX_PARTS}-part cap; nothing was written for it`);
  }
  const single = (opts.layout ?? 'single') === 'single' && groups.length === 1;
  const title = meta.title?.trim() || `${meta.harness} session ${meta.sessionId.slice(0, 12)}`;

  const parts: RenderedPart[] = groups.map((group, idx) => {
    const part = idx + 1;
    const slug = part === 1 ? baseSlug : `${baseSlug}-p${part}`;
    const frontmatterId = transcriptPartId(meta, part);
    const imperatives = single || !redacted.imperativeFlags
      ? imperativesFlagged
      : new Set(group.filter((b) => redacted.imperativeFlags![b.message]).map((b) => b.message)).size;
    const fm: Record<string, unknown> = {
      type: 'conversation',
      title: single ? title : `${title} (part ${part})`,
      date: dateIso.slice(0, 10),
      id: frontmatterId,
      transcript_import: {
        harness: meta.harness,
        session_id: meta.sessionId,
        version: TRANSCRIPT_IMPORT_VERSION,
        part,
        ...(single ? { of: 1 } : { part_bytes: partTargetBytes }),
        ...(imperatives > 0 ? { imperatives_flagged: imperatives } : {}),
      },
    };
    const body = group.map((b) => b.text).join('\n\n');
    return { slug, content: renderPartContent(fm, body), frontmatterId, part, frontmatter: fm, body };
  });

  return { parts, baseSlug, dateIso };
}
