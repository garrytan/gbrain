/**
 * hermes.ts — Hermes state.db (SQLite) adapter (cathedral-4).
 *
 * ONE store file holds MANY sessions (hermes-agent DEFAULT_DB_PATH =
 * <hermes home>/state.db). Reads are COPY-THEN-READ by default: readonly
 * opens of a WAL-mode SQLite database require write access to the -shm
 * sidecar and can intermittently lock against a live writer, so the adapter
 * copies the DB (+ -wal/-shm sidecars when present) to a temp dir and reads
 * the copy — deterministic, zero lock races, cleaned up in finally.
 *
 * Schema verified against the INSTALLED hermes-agent v0.20.0 source
 * (hermes_state_common.py SCHEMA_SQL) — sessions(id, source, display_name,
 * title, started_at REAL epoch-seconds, cwd, model) and messages(session_id,
 * role, content, timestamp REAL). No populated sample DB existed on the dev
 * machine, so the SPEC_TARGET stays PROVISIONAL and the fixture is built
 * from the same schema by test code; the bytes>0/sessions==0 drift signal is
 * the runtime backstop.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';

export const HERMES_SPEC_TARGET: HostSpecTarget = {
  id: 'hermes-state-db-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-14',
  references: [
    'installed hermes-agent v0.20.0 hermes_state_common.py SCHEMA_SQL (schema source of truth)',
    'hermes-agent hermes_state.py DEFAULT_DB_PATH = <hermes home>/state.db',
    'test/fixtures/transcripts/hermes-fixture-builder.ts (synthetic, schema-matched)',
    'https://github.com/NousResearch/hermes-agent/blob/d76cce4f1161bdac895f7e373ce41cbd04e7c2f2/tools/clarify_tool.py (_result wire shape)',
  ],
  note:
    'SQLite store, WAL mode. sessions: id TEXT PK, source, display_name, ' +
    'title, started_at REAL (epoch seconds), ended_at, cwd, model. messages: ' +
    'session_id, role, content TEXT, timestamp REAL. The import keeps role ' +
    'user/assistant rows with non-empty content and submitted, answered clarify ' +
    'results linked to an earlier assistant tool call. Questions and tool/result ' +
    'provenance remain separate from user speech in redacted raw metadata; ' +
    'other tool output and unselected choices are omitted. Content that looks like a ' +
    'JSON block array (bare or json:-prefixed) is unwrapped to its text ' +
    'blocks, image blocks as an [image] placeholder. active/compacted ' +
    'flags are IGNORED (the archive wants full history, not the live ' +
    'context window). PROVISIONAL: no populated production sample verified.',
};

/** Hard cap for the store copy (FTS indexes make legitimate stores large). */
export const HERMES_DB_HARD_CAP = 512 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3\u0000';

function epochToIso(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  return new Date(Math.round(v * 1000)).toISOString();
}

/** Hermes stores list-shaped message content as this prefix plus the JSON array. */
const CONTENT_JSON_PREFIX = 'json:';
const IMAGE_PLACEHOLDER = '[image]';
const IMAGE_BLOCK_TYPES = new Set(['image_url', 'image', 'input_image']);

/** Unwrap content that is a JSON block array (bare or `json:`-prefixed); image blocks become a placeholder; pass plain text through. */
function contentToText(content: unknown): string {
  if (typeof content !== 'string') return '';
  const t = content.trim();
  if (!t) return '';
  const json = t.startsWith(CONTENT_JSON_PREFIX) ? t.slice(CONTENT_JSON_PREFIX.length).trimStart() : t;
  if (json.startsWith('[')) {
    try {
      const blocks = JSON.parse(json) as unknown;
      if (Array.isArray(blocks)) {
        const parts: string[] = [];
        for (const block of blocks) {
          if (typeof block === 'string' && block.trim()) parts.push(block);
          else if (typeof block === 'object' && block !== null) {
            const b = block as Record<string, unknown>;
            if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
            else if (typeof b.type === 'string' && IMAGE_BLOCK_TYPES.has(b.type)) parts.push(IMAGE_PLACEHOLDER);
          }
        }
        return parts.join('\n').trim();
      }
    } catch {
      // Not JSON after all — fall through to plain text.
    }
  }
  return t;
}

interface SessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  started_at: number | null;
  cwd: string | null;
  model: string | null;
  source: string | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  timestamp: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
}

function parseJson(value: string | null): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Native tool calls are assistant rows even when their text content is empty. */
function rememberClarifyCalls(m: MessageRow, calls: Set<string>): void {
  const entries = parseJson(m.tool_calls);
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const call = record(entry);
    if (call && typeof call.id === 'string' && call.id.trim()) {
      // A later reuse of an id by another tool must not inherit clarification attribution.
      calls.delete(call.id);
      if (record(call.function)?.name === 'clarify') calls.add(call.id);
    }
  }
}

/**
 * Narrow native envelope, not arbitrary tool prose. Only a submitted form's
 * answered values are speech; questions and original linkage stay separately
 * in flat raw metadata (which the common renderer redacts before persistence).
 * Wire shape: NousResearch/hermes-agent tools/clarify_tool.py::_result.
 */
function appendClarifyAnswers(
  m: MessageRow, calls: Set<string>, messages: TranscriptMessage[], raw: Record<string, unknown>,
  next: number,
): number {
  if (m.tool_name !== 'clarify' || !m.tool_call_id || !calls.has(m.tool_call_id)) return next;
  calls.delete(m.tool_call_id);
  const result = record(parseJson(m.content));
  if (result?.outcome !== 'submitted' || !Array.isArray(result.responses)) return next;
  for (const [index, value] of result.responses.entries()) {
    const response = record(value);
    if (response?.status !== 'answered' || typeof response.question !== 'string' || !response.question.trim()) continue;
    const answer = response.user_response;
    let text: string;
    if (typeof answer === 'string' && answer.trim()) text = answer;
    else if (Array.isArray(answer) && answer.length && answer.every(a => typeof a === 'string' && a.trim())) text = answer.join('\n');
    else continue;
    const prefix = `clarify_${next++}_`;
    raw[`${prefix}message_id`] = m.id;
    raw[`${prefix}tool_call_id`] = m.tool_call_id;
    raw[`${prefix}tool_name`] = 'clarify';
    raw[`${prefix}original_role`] = 'tool';
    raw[`${prefix}question`] = response.question;
    raw[`${prefix}response_index`] = index;
    raw[`${prefix}message_index`] = messages.length;
    raw[`${prefix}timestamp`] = epochToIso(m.timestamp);
    // Preserve multi-select boundaries too: joining for display alone loses
    // the distinction between a newline in one choice and two selected choices.
    if (Array.isArray(answer)) {
      for (const [selection, selected] of answer.entries()) raw[`${prefix}selection_${selection}`] = selected;
    }
    messages.push({ role: 'user', timestamp: epochToIso(m.timestamp), text });
  }
  return next;
}

export const hermesAdapter: TranscriptAdapter = {
  format: 'hermes',
  specTarget: HERMES_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.db')) return false;
    return sample.toString('latin1', 0, 16) === SQLITE_MAGIC;
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? HERMES_DB_HARD_CAP;
    const size = statSync(path).size;
    // The cap bounds the TOTAL copied (db + sidecars) — a runaway WAL can
    // dwarf the main file, and only capping the db would let the copy blow
    // through temp storage while advertising a 512MB bound.
    let totalBytes = size;
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) totalBytes += statSync(path + suffix).size;
    }
    if (totalBytes > cap) {
      throw new Error(
        `hermes store too large for import: ${totalBytes} bytes incl. sidecars (cap ${cap})`,
      );
    }

    // Copy-then-read: DB plus WAL/SHM sidecars so un-checkpointed writes are
    // visible in the copy. A live writer can checkpoint BETWEEN the copies —
    // the resulting torn snapshot surfaces as a schema/corruption error from
    // the sessions query below, lands in the drift lane, and (because drift
    // freezes the watermark) is safely retried by the next run.
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-hermes-'));
    const copyPath = join(tmp, basename(path));
    let sessions = 0;
    try {
      copyFileSync(path, copyPath);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(path + suffix)) copyFileSync(path + suffix, copyPath + suffix);
      }

      const db = new Database(copyPath, { readonly: true });
      try {
        let sessionRows: SessionRow[];
        try {
          sessionRows = db
            .query<SessionRow, []>(
              'SELECT id, title, display_name, started_at, cwd, model, source ' +
                'FROM sessions ORDER BY started_at',
            )
            .all();
        } catch (err) {
          // Missing/renamed tables = host schema drift, not a crash.
          return {
            bytesRead: size,
            skippedLines: 0,
            truncated: false,
            sessions: 0,
            zeroSessionsReason: `schema mismatch reading sessions table: ${String(err)}`,
          };
        }

        // Older stores (and the original minimal fixture) have no tool columns.
        // Only fixed, allowlisted names enter this SELECT; schema data is never SQL.
        const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(messages)').all().map(c => c.name));
        const toolColumns = ['tool_name', 'tool_call_id', 'tool_calls']
          .map(name => columns.has(name) ? name : `NULL AS ${name}`).join(', ');
        const toolFilter = columns.has('tool_name') ? " OR (role = 'tool' AND tool_name = 'clarify')" : '';
        const msgQuery = db.query<MessageRow, [string]>(
          `SELECT id, role, content, timestamp, ${toolColumns} FROM messages WHERE session_id = ? ` +
            `AND (role IN ('user','assistant')${toolFilter}) ORDER BY timestamp, id`,
        );
        for (const row of sessionRows) {
          if (typeof row.id !== 'string' || !row.id) continue;
          const messages: TranscriptMessage[] = [];
          const raw: Record<string, unknown> = {
            session_id: row.id, source: row.source ?? null, cwd: row.cwd ?? null, source_path: path,
          };
          const clarifyCalls = new Set<string>();
          let clarificationCount = 0;
          for (const m of msgQuery.all(row.id)) {
            if (m.role === 'assistant') rememberClarifyCalls(m, clarifyCalls);
            if (m.role === 'tool') {
              clarificationCount = appendClarifyAnswers(m, clarifyCalls, messages, raw, clarificationCount);
              continue;
            }
            const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
            if (!role) continue;
            const text = contentToText(m.content);
            if (!text) continue;
            messages.push({ role, timestamp: epochToIso(m.timestamp), text });
          }
          if (!messages.length) continue;
          sessions++;
          yield {
            meta: {
              harness: 'hermes',
              sessionId: row.id,
              title: row.title ?? row.display_name ?? undefined,
              cwd: row.cwd ?? undefined,
              model: row.model ?? undefined,
              startedAt: epochToIso(row.started_at) || messages[0].timestamp || undefined,
              raw,
            },
            messages,
          };
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    return {
      bytesRead: size,
      skippedLines: 0,
      truncated: false,
      sessions,
      zeroSessionsReason:
        sessions === 0 ? 'no sessions with user/assistant text messages in store' : undefined,
    };
  },
};
