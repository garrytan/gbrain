/**
 * grok.ts — Grok Build session (`chat_history.jsonl`) adapter (cathedral-4).
 *
 * One session directory = one session. Layout (verified against a live
 * `~/.grok/sessions` store 2026-08-30; see SPEC_TARGET):
 *
 *   ~/.grok/sessions/<url-encoded-cwd>/prompt_history.jsonl
 *   ~/.grok/sessions/<url-encoded-cwd>/<uuid>/chat_history.jsonl
 *   ~/.grok/sessions/<url-encoded-cwd>/<uuid>/summary.json   (sidecar)
 *
 * Sidecars (updates.jsonl, events.jsonl, rewind_points.jsonl, summary.json,
 * prompt_history.jsonl, …) are not sessions — glob expansion and grok-root
 * discovery skip them the way OpenClaw checkpoint siblings are skipped.
 *
 * TURN SELECTION IS STRUCTURAL: user text is `type:'user'` content blocks
 * `{type:'text', text}` WITHOUT `synthetic_reason` (those are injected
 * system_reminder / task_completed rows). Assistant text is `type:'assistant'`
 * with a non-empty string `content`. system / reasoning / tool_result /
 * backend_tool_call and tool-only assistant rows (empty content + tool_calls)
 * are skipped — the archive records conversation text only (lossy by design,
 * matching the Codex adapter).
 *
 * chat_history.jsonl carries NO per-message timestamps. Session times come
 * from the sibling summary.json (`created_at`, `last_active_at`) — real
 * source times, never invented. Missing summary ⇒ no startedAt (render
 * refuses to fabricate provenance).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';

export const GROK_SPEC_TARGET: HostSpecTarget = {
  id: 'grok-chat-history-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-30',
  references: [
    'local ~/.grok/sessions/<url-encoded-cwd>/<uuid>/chat_history.jsonl (Grok Build, live sample 2026-08-30)',
    'sibling summary.json (info.{id,cwd}, created_at, last_active_at, generated_title, current_model_id)',
    'docs/mcp/GROK-CLI-PIN.md (GROK_HOME relocates the user dir)',
    'test/fixtures/transcripts/grok-session/',
  ],
  note:
    'One JSON object per line in chat_history.jsonl. First line is always ' +
    "{type:'system', content:string} (the injected system prompt — skipped). " +
    "User turns: {type:'user', content:[{type:'text', text}]} — rows with " +
    'synthetic_reason (system_reminder / task_completed) are injected and ' +
    "skipped. Assistant turns: {type:'assistant', content:string, model_id, " +
    'model_fingerprint, reasoning_effort, tool_calls?}; empty content is a ' +
    'tool-only row and is skipped. reasoning (encrypted_content + summary), ' +
    'tool_result, and backend_tool_call are skipped. No per-message ' +
    'timestamps in the JSONL; summary.json created_at is the session start ' +
    'and last_active_at stamps the last kept turn. Unknown fields tolerated.',
};

const GROK_CHAT_HISTORY = 'chat_history.jsonl';
const GROK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROK_CWD_SIDECARS = new Set(['prompt_history.jsonl']);
const GROK_LINE_TYPES = new Set([
  'system',
  'user',
  'assistant',
  'reasoning',
  'tool_result',
  'backend_tool_call',
]);

/** True for the Grok session-store's one importable file per session. */
export function isGrokChatHistoryFile(path: string): boolean {
  return basename(path) === GROK_CHAT_HISTORY;
}

/**
 * True for files that live in a Grok session tree but are not the session
 * log: sidecars next to chat_history.jsonl (UUID parent) and the per-cwd
 * prompt_history.jsonl. Glob expansion skips these so a `~/.grok/sessions/**`
 * pass does not treat thousands of updates.jsonl / summary.json files as
 * sessions (or as host-format drift). NOTE for callers: the UUID-segment
 * heuristic is deliberately broad — discovery applies it only under the grok
 * root (format-scoped), never to other harnesses' roots, so a bare-UUID
 * directory in another harness's tree cannot hide legitimate sessions.
 */
export function isGrokSessionSidecar(path: string): boolean {
  const base = basename(path);
  if (base === GROK_CHAT_HISTORY) return false;
  // Session UUID is a PATH SEGMENT (the session directory). Nested scratch
  // (terminal/*.log, recap_requests/*.json) has a different immediate
  // parent, so we walk every component — not just dirname.
  const segs = path.split(/[/\\]/);
  if (segs.some((s) => GROK_UUID_RE.test(s))) return true;
  if (GROK_CWD_SIDECARS.has(base)) return true;
  return base === 'session_search.sqlite';
}

function textFromUserContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

export type GrokLineResult =
  | { kind: 'message'; message: TranscriptMessage }
  | { kind: 'skip' }
  | { kind: 'typed' };

/**
 * One ALREADY-JSON-PARSED grok chat_history line. Exported so tests pin the
 * dated SPEC_TARGET mapping: synthetic_reason user rows, tool-only
 * assistants, and reasoning/tool traffic never become messages.
 */
export function mapGrokLine(entry: unknown): GrokLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  if (typeof e.type !== 'string' || !GROK_LINE_TYPES.has(e.type)) return { kind: 'skip' };
  if (e.type === 'user') {
    // Injected reminders are not typed user text (Codex skips injected
    // user/developer response_items for the same reason).
    if (typeof e.synthetic_reason === 'string' && e.synthetic_reason) return { kind: 'typed' };
    const text = textFromUserContent(e.content);
    if (!text) return { kind: 'typed' };
    return { kind: 'message', message: { role: 'user', timestamp: '', text } };
  }
  if (e.type === 'assistant') {
    const text = typeof e.content === 'string' ? e.content.trim() : '';
    if (!text) return { kind: 'typed' };
    return { kind: 'message', message: { role: 'assistant', timestamp: '', text } };
  }
  return { kind: 'typed' };
}

interface GrokSummary {
  sessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: string;
  lastActiveAt?: string;
}

function isoOrEmpty(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function readGrokSummary(sessionDir: string): GrokSummary {
  const p = join(sessionDir, 'summary.json');
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (typeof obj !== 'object' || obj === null) return {};
    const s = obj as Record<string, unknown>;
    const info =
      typeof s.info === 'object' && s.info !== null ? (s.info as Record<string, unknown>) : {};
    return {
      sessionId: typeof info.id === 'string' ? info.id : undefined,
      cwd: typeof info.cwd === 'string' ? info.cwd : undefined,
      title: typeof s.generated_title === 'string' ? s.generated_title : undefined,
      model: typeof s.current_model_id === 'string' ? s.current_model_id : undefined,
      createdAt: isoOrEmpty(s.created_at) || undefined,
      lastActiveAt: isoOrEmpty(s.last_active_at) || isoOrEmpty(s.updated_at) || undefined,
    };
  } catch {
    return {};
  }
}

function identityFromPath(path: string): { sessionId?: string; cwd?: string } {
  const sessionDir = dirname(path);
  const sessionId = basename(sessionDir);
  const encoded = basename(dirname(sessionDir));
  let cwd: string | undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded)) cwd = decoded;
  } catch {
    // Malformed percent-encoding — ignore; summary.json may still supply cwd.
  }
  return {
    sessionId: GROK_UUID_RE.test(sessionId) ? sessionId : undefined,
    cwd,
  };
}

/**
 * Keys the claude-code family stamps on EVERY session row (including its
 * `type:'system'` rows, whose `content` is a string). A first line carrying
 * any of them is a claude-code session, not a grok one — without this
 * discriminator the head sniff stole system-led claude sessions: every row
 * then mapped to 'typed', so the session parsed to zero messages with
 * expectedEmpty=true and was silently swallowed. Ordering is the second
 * belt (claude-code detects before grok in transcriptAdapters()).
 */
const CLAUDE_FAMILY_KEYS = ['sessionId', 'parentUuid', 'uuid', 'isSidechain'];

function looksLikeGrokHead(sample: Buffer): boolean {
  const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
  if (!firstLine || !firstLine.startsWith('{')) return false;
  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>;
    return (
      obj !== null &&
      typeof obj === 'object' &&
      obj.type === 'system' &&
      typeof obj.content === 'string' &&
      !CLAUDE_FAMILY_KEYS.some((k) => k in obj)
    );
  } catch {
    // Truncated first line (oversized system prompt vs the 64KB sample):
    // the key sniff covers exactly that case. Observed system lines are
    // ~4–6KB, well under the sample, so this is defence-in-depth.
    return (
      firstLine.includes('"type":"system"') &&
      firstLine.includes('"content"') &&
      !CLAUDE_FAMILY_KEYS.some((k) => firstLine.includes(`"${k}"`))
    );
  }
}

export const grokAdapter: TranscriptAdapter = {
  format: 'grok',
  specTarget: GROK_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl') || isGrokSessionSidecar(path)) return false;
    if (isGrokChatHistoryFile(path)) return true;
    return looksLikeGrokHead(sample);
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const size = statSync(path).size;
    if (size > cap) {
      throw new Error(`grok session too large for import: ${size} bytes (cap ${cap})`);
    }
    const raw = readFileSync(path, 'utf8');
    let skippedLines = 0;
    let typedLines = 0;
    const messages: TranscriptMessage[] = [];

    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(t);
      } catch {
        skippedLines++;
        continue;
      }
      const mapped = mapGrokLine(entry);
      if (mapped.kind === 'skip') continue;
      typedLines++;
      if (mapped.kind === 'message') messages.push(mapped.message);
    }

    const fromPath = identityFromPath(path);
    const summary = readGrokSummary(dirname(path));
    const sessionId = summary.sessionId || fromPath.sessionId || basename(path, '.jsonl');
    const cwd = summary.cwd || fromPath.cwd;
    const startedAt = summary.createdAt;
    const lastActiveAt = summary.lastActiveAt || startedAt;
    if (startedAt && messages.length > 0) {
      for (let i = 0; i < messages.length; i++) {
        messages[i].timestamp = i === messages.length - 1 ? lastActiveAt || startedAt : startedAt;
      }
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      yield {
        meta: {
          harness: 'grok',
          sessionId,
          title: summary.title,
          cwd,
          model: summary.model,
          startedAt: startedAt || messages[0].timestamp || undefined,
          raw: {
            session_id: sessionId,
            cwd: cwd ?? null,
            source_path: path,
          },
        },
        messages,
      };
    }
    const expectedEmpty = sessions === 0 && typedLines > 0 && skippedLines === 0;
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      expectedEmpty,
      zeroSessionsReason:
        sessions === 0
          ? expectedEmpty
            ? 'no user/assistant text turns (tool/reasoning-only session)'
            : 'no user/assistant text turns in grok chat_history'
          : undefined,
    };
  },
};
