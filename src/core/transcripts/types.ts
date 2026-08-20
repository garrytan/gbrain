/**
 * types.ts — the transcript-adapter seam (cathedral-4).
 *
 * One contract for every dead-log format gbrain can import: coding-harness
 * session logs (Claude Code, Codex, OpenClaw, Hermes) and consumer chat
 * exports (ChatGPT, Claude.ai). Each adapter is a leaf module in this
 * directory; the registry in detect.ts is the only place formats are
 * enumerated. Every adapter carries a DATED SPEC_TARGET (the
 * bootstrap/host-specs.ts discipline) because these are host formats gbrain
 * does not control.
 *
 * Cardinality: one FILE may contain MANY sessions (Hermes state.db, ChatGPT
 * conversations.json), so `parse` is an AsyncGenerator of sessions whose
 * RETURN value is the per-file diagnostics — a zero-yield file must still be
 * able to explain itself (drift signal: bytesRead > 0 with zero sessions).
 *
 * Timestamps are REAL source timestamps, always. Every supported format
 * carries per-message times; an adapter must surface them, never invent them
 * — forged times would corrupt provenance and the rendered page's
 * conversation format round-trip.
 */

import { createHash } from 'crypto';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import { slugifySegment } from '../sync.ts';

export type TranscriptFormat =
  | 'claude-code'
  | 'codex'
  | 'openclaw'
  | 'hermes'
  | 'chatgpt'
  | 'claude-export';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  /** Display name when the source carries one (consumer exports); omitted → role label. */
  speaker?: string;
  /** ISO 8601 UTC, from the SOURCE. Adapters never invent timestamps. */
  timestamp: string;
  text: string;
}

export interface TranscriptSessionMeta {
  harness: TranscriptFormat;
  /** Source-native session/conversation id (uniqueness suffix for the slug). */
  sessionId: string;
  title?: string;
  cwd?: string;
  model?: string;
  /** ISO 8601 UTC session start; slug date derives from this (fallback: first message). */
  startedAt?: string;
  /**
   * Raw session metadata for engine.putRawData — a plain OBJECT, never a
   * pre-stringified JSON string (the postgres.js double-encode trap).
   */
  raw?: Record<string, unknown>;
}

export interface ParsedSession {
  meta: TranscriptSessionMeta;
  /** Oldest → newest. Empty-message sessions are skipped by the caller. */
  messages: TranscriptMessage[];
}

/**
 * Per-file diagnostics: the AsyncGenerator RETURN value. `sessions` counts
 * yields; `zeroSessionsReason` makes an empty file explain itself (the
 * parser-drift signal is `bytesRead > 0 && sessions === 0`).
 */
export interface FileDiagnostics {
  bytesRead: number;
  skippedLines: number;
  truncated: boolean;
  sessions: number;
  zeroSessionsReason?: string;
}

export interface ParseSessionsOpts {
  /**
   * Per-format byte budget. Most adapters REJECT a monolithic file over budget
   * rather than truncating it; codex instead degrades to a bounded head+tail
   * read, so an over-budget rollout still imports.
   */
  maxBytes?: number;
}

export interface TranscriptAdapter {
  format: TranscriptFormat;
  specTarget: HostSpecTarget;
  /** Cheap sniff over the file's head bytes; detect.ts owns ordering. */
  detect(path: string, sample: Buffer): boolean;
  parse(path: string, opts?: ParseSessionsOpts): AsyncGenerator<ParsedSession, FileDiagnostics>;
}

// ── Byte caps (format-specific; see adapter headers) ────────────────────────

/** Hard cap for any single session-log file. */
export const TRANSCRIPT_JSONL_HARD_CAP = 50 * 1024 * 1024;
/**
 * Monolithic consumer-export JSON cannot be partially parsed — over this the
 * adapter rejects with a split-the-export error instead of truncating.
 */
export const TRANSCRIPT_EXPORT_JSON_HARD_CAP = 200 * 1024 * 1024;

// ── Slug construction (ONE helper — no per-adapter templates) ───────────────

/** Per-provider page directories, matching skills/conversation-archive layout. */
const SLUG_DIRS: Record<TranscriptFormat, string> = {
  'claude-code': 'conversations/sessions',
  codex: 'conversations/sessions',
  openclaw: 'conversations/sessions',
  hermes: 'conversations/sessions',
  chatgpt: 'conversations/chatgpt',
  'claude-export': 'conversations/claude',
};

const HARNESS_FORMATS: ReadonlySet<TranscriptFormat> = new Set([
  'claude-code',
  'codex',
  'openclaw',
  'hermes',
]);

/**
 * Stable HASHED id suffixes. Always a sha256 prefix, never a cleaned prefix
 * of the source id: prefix identity let same-prefix session ids silently
 * overwrite a same-day page (slug collision) or dedup-skip a different-day
 * one (frontmatter-id collision) — reproduced adversarially against PGLite.
 * 12 hex chars (48 bits) for the slug keeps collisions negligible at
 * backfill-everything scale; 16 hex chars (64 bits) for the dedup identity.
 */
export function transcriptSlugId(sourceId: string): string {
  return createHash('sha256').update(sourceId).digest('hex').slice(0, 12);
}

export function transcriptFullId(sourceId: string): string {
  return createHash('sha256').update(sourceId).digest('hex').slice(0, 16);
}

/** Max slugified-title length inside an export slug (keeps slugs readable). */
const TITLE_SLUG_MAX = 48;

/**
 * The one slug builder for every imported conversation page.
 *
 * Harness sessions:  conversations/sessions/YYYY-MM-DD-<harness>-<hash12>
 * ChatGPT threads:   conversations/chatgpt/YYYY-MM-DD-<titleslug>-<hash12>
 * Claude.ai threads: conversations/claude/YYYY-MM-DD-<titleslug>-<hash12>
 *
 * `dateIso` is the session start (UTC); callers fall back to the first
 * message timestamp when the source lacks a start time. Part pages append
 * their own `-pN` suffix at render time — never here.
 */
export function buildTranscriptSlug(
  format: TranscriptFormat,
  dateIso: string,
  meta: { sessionId: string; title?: string },
): string {
  const day = dateIso.slice(0, 10);
  const id = transcriptSlugId(meta.sessionId);
  if (HARNESS_FORMATS.has(format)) {
    return `${SLUG_DIRS[format]}/${day}-${format}-${id}`;
  }
  const title = slugifySegment(meta.title ?? '').slice(0, TITLE_SLUG_MAX).replace(/-$/, '');
  const label = title || 'untitled';
  return `${SLUG_DIRS[format]}/${day}-${label}-${id}`;
}
