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
  ],
  note:
    'SQLite store, WAL mode. sessions: id TEXT PK, source, display_name, ' +
    'title, started_at REAL (epoch seconds), ended_at, cwd, model. messages: ' +
    'session_id, role, content TEXT, timestamp REAL. The import keeps role ' +
    "user/assistant rows with non-empty content; content that looks like a " +
    'JSON block array is unwrapped to its text blocks. active/compacted ' +
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

        const msgQuery = db.query<MessageRow, [string]>(
          "SELECT role, content, timestamp FROM messages WHERE session_id = ? " +
            "AND role IN ('user','assistant') ORDER BY timestamp, id",
        );
        for (const row of sessionRows) {
          if (typeof row.id !== 'string' || !row.id) continue;
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
