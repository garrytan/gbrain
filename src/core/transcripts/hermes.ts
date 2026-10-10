/**
 * hermes.ts — Hermes state.db (SQLite) adapter (cathedral-4).
 *
 * ONE store file holds MANY sessions (hermes-agent DEFAULT_DB_PATH =
 * <hermes home>/state.db). Reads use SQLite serialize() to capture one
 * transactionally consistent image, including committed WAL frames, then
 * parse a private temp snapshot; source storage stays read-only. The snapshot
 * dir is removed in finally, including early generator cancellation.
 *
 * Compatibility contract: ONLY NousResearch/hermes-agent commit
 * 46d7718a52ff33accb15dc0501736fbdb6833cab, specifically
 * hermes_state_common.py SCHEMA_SQL and hermes_state.py SessionDB. That
 * revision defines sessions(id, source, display_name, title, started_at REAL
 * epoch-seconds, cwd, model) and messages(session_id, role, content,
 * timestamp REAL); test/hermes-native-transcript.test.ts builds a synthetic
 * store through the pinned SessionDB API in its native-fixture lane. This is
 * not a claim of compatibility with other Hermes revisions or populated
 * production stores. The verified target is this exact pinned API only.
 * A bytes>0/sessions==0 drift signal is the runtime backstop.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  id: 'hermes-state-db-46d7718-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-09',
  references: [
    'https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/hermes_state_common.py',
    'hermes-agent hermes_state.py DEFAULT_DB_PATH = <hermes home>/state.db',
    'test/fixtures/transcripts/hermes-fixture-builder.ts (synthetic, schema-matched)',
    'test/hermes-python/build_state_fixture.py + hermes-native-state.db (synthetic, generated via pinned SessionDB)',
    'test/fixtures/transcripts/hermes-schema.sql (full pinned SCHEMA_SQL)',
  ],
  note:
    'SQLite store, WAL mode. sessions: id TEXT PK, source, display_name, ' +
    'title, started_at REAL (epoch seconds), ended_at, cwd, model. messages: ' +
    'session_id, role, content TEXT, timestamp REAL. The import keeps role ' +
    "user/assistant rows with non-empty content; content that looks like a " +
    'JSON block array is unwrapped to its text blocks. active/compacted ' +
    'flags are IGNORED (the archive wants full history, not the live ' +
    'context window). Exact sessions.source filters do not prove per-turn human origin. ' +
    'Verified against the pinned native SessionDB with generated synthetic SQLite and live-WAL fixtures. ' +
    'Other revisions and populated production stores are not covered by this target.',
};

/** Hard cap for the store copy (FTS indexes make legitimate stores large). */
export const HERMES_DB_HARD_CAP = 512 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3\u0000';

function epochToIso(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  const date = new Date(Math.round(v * 1000));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** Unwrap content that is a JSON block array; pass plain text through. */
function contentToText(content: unknown): string {
  if (typeof content !== 'string') return '';
  const t = content.trim();
  if (!t) return '';
  if (t.startsWith('[')) {
    try {
      const blocks = JSON.parse(t) as unknown;
      if (Array.isArray(blocks)) {
        const parts: string[] = [];
        for (const block of blocks) {
          if (typeof block === 'string' && block.trim()) parts.push(block);
          else if (typeof block === 'object' && block !== null) {
            const b = block as Record<string, unknown>;
            if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
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
  role: string;
  content: string | null;
  timestamp: number | null;
}

export const hermesAdapter: TranscriptAdapter = {
  format: 'hermes',
  specTarget: HERMES_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.db')) return false;
    return sample.toString('latin1', 0, 16) === SQLITE_MAGIC;
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    if (opts.sessionSources?.length === 0) throw new Error('sessionSources must contain at least one source');
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

    // SQLite's serialize API captures a transactionally consistent image of
    // the connection's visible database, including committed WAL frames. The
    // old main-file/-wal/-shm copy could combine files from opposite sides of
    // a live checkpoint and fail with SQLITE_CANTOPEN / a torn schema.
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-hermes-'));
    const copyPath = join(tmp, basename(path));
    let sessions = 0;
    try {
      let snapshot: Uint8Array | undefined;
      try {
        const source = new Database(path, { readonly: true });
        try {
          snapshot = source.serialize();
        } finally {
          source.close();
        }
      } catch (err) {
        // A gracefully closed WAL database can retain journal_mode=WAL while
        // having no WAL file at all. SQLite's read-only open rejects that
        // shape on some builds. A raw main-file snapshot is safe only when
        // there are no committed WAL frames and the source stays unchanged
        // throughout the copy; otherwise fail closed instead of mixing files.
        const walPath = path + '-wal';
        const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
        if (walBytes > 0) throw err;
        const before = statSync(path);
        copyFileSync(path, copyPath);
        const after = statSync(path);
        const walAppeared = existsSync(walPath) && statSync(walPath).size > 0;
        if (walAppeared || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
            before.ino !== after.ino || before.dev !== after.dev) {
          throw new Error('Hermes state.db changed during WAL-free snapshot copy; retry the import');
        }
      }
      if (snapshot) writeFileSync(copyPath, snapshot, { mode: 0o600 });

      // Open only the private snapshot writable so SQLite can perform any
      // WAL recovery there. The user-owned source remains strictly read-only.
      const db = new Database(copyPath);
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

        let selectedSessions = 0;
        const msgQuery = db.query<MessageRow, [string]>(
          "SELECT role, content, timestamp FROM messages WHERE session_id = ? " +
            "AND role IN ('user','assistant') ORDER BY timestamp, id",
        );
        for (const row of sessionRows) {
          if (typeof row.id !== 'string' || !row.id) continue;
          if (opts.sessionSources && !opts.sessionSources.includes(row.source ?? '')) continue;
          selectedSessions++;
          const messages: TranscriptMessage[] = [];
          for (const m of msgQuery.all(row.id)) {
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
              raw: {
                session_id: row.id,
                source: row.source ?? null,
                cwd: row.cwd ?? null,
                source_path: path,
              },
            },
            messages,
          };
        }
        // An exact source filter matching nothing is an understood empty.
        // Selected rows yielding no turns retain the legacy drift signal:
        // a renamed role or changed content shape must hold the watermark.
        if (sessions === 0) return {
          bytesRead: size, skippedLines: 0, truncated: false, sessions: 0,
          expectedEmpty: selectedSessions === 0 && opts.sessionSources !== undefined,
          zeroSessionsReason: selectedSessions === 0 && opts.sessionSources
            ? 'no sessions match the requested session sources'
            : 'no sessions with user/assistant text messages in store',
        };
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
