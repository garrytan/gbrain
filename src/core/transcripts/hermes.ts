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
 *
 * Session kinds (#8901): Hermes stores every automated run beside the user's
 * conversations and tells them apart by `sessions.source` (`cron`, `subagent`,
 * `kanban`, `tool`, a hook's custom label) plus, for delegate children spawned
 * under a desktop or gateway turn (which INHERIT the parent's source), the
 * `_delegate_from` key in `sessions.model_config`. Hermes' own session search
 * hides `kanban`, `subagent` and `tool` and demotes `cron`
 * (tools/session_search_tool.py), and its text index drops `cron`, `subagent`
 * and every row carrying the marker (hermes_state_common.py
 * FTS_TRIGRAM_EXCLUDED_SOURCES, v0.23.0). `parent_session_id` is NEVER a
 * sub-agent signal: compression continuations and branch sessions carry it
 * too (hermes_state_sessions.py). The adapter applies the same predicate when
 * `ParseSessionsOpts.excludeSessionSources` names sources, BEFORE any message
 * is read, so an excluded session is never yielded; `subagent` in the list
 * also drops marker-bearing children under any source.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import { splitSourceList } from '../config-list.ts';
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
  verifiedAt: '2026-11-08',
  references: [
    'installed hermes-agent v0.23.0 hermes_state_common.py SCHEMA_SQL (schema source of truth; model_config, created_source and parent_session_id arrived after the v0.20.0 read)',
    'hermes-agent hermes_state.py DEFAULT_DB_PATH = <hermes home>/state.db',
    'test/fixtures/transcripts/hermes-fixture-builder.ts (synthetic, schema-matched)',
    'hermes-agent tools/clarify_tool.py _result (clarify result shape; #7396)',
    'hermes-agent v0.23.0 hermes_state_common.py FTS_TRIGRAM_EXCLUDED_SOURCES + fts_trigram_session_sql (source OR _delegate_from predicate; #8901)',
    'hermes-agent v0.23.0 tools/session_search_tool.py _HIDDEN_SESSION_SOURCES = kanban, subagent, tool; _DEMOTED_SESSION_SOURCES = cron (#8901)',
    'hermes-agent v0.23.0 hermes_state_sessions.py (continuations and branches carry parent_session_id without the marker; #8901)',
  ],
  note:
    'SQLite store, WAL mode. sessions: id TEXT PK, source, display_name, ' +
    'title, started_at REAL (epoch seconds), ended_at, cwd, model. messages: ' +
    'session_id, role, content TEXT, timestamp REAL, tool_call_id, tool_name. ' +
    'The import keeps role user/assistant rows with non-empty content, and ' +
    'the answered responses of a submitted clarify form (role tool, tool_name ' +
    'clarify) as user rows; other tool rows are dropped. Content that looks like a ' +
    'JSON block array (bare or json:-prefixed) is unwrapped to its text ' +
    'blocks, image blocks as an [image] placeholder. active/compacted ' +
    'flags are IGNORED (the archive wants full history, not the live ' +
    'context window). sessions.source and the _delegate_from key of ' +
    'sessions.model_config (absent in older stores) classify the session kind; ' +
    'parent_session_id never does. PROVISIONAL: no populated production sample verified.',
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
  /** Absent (undefined) in stores from before hermes-agent recorded it. */
  model_config?: string | null;
  /** The immutable creation label (`desktop`, `cli`, `cron`, …); `source` can be rewritten to `local`. Absent in older stores. */
  created_source?: string | null;
}

interface MessageRow {
  role: string;
  content: string | null;
  timestamp: number | null;
  tool_call_id: string | null;
}

/**
 * #7396: the user's answers in a clarify tool result (hermes-agent
 * tools/clarify_tool.py `_result`), in question order. A `status: 'answered'`
 * response counts when the form was submitted or timed out part-way (Hermes
 * keeps the answers the user already locked under `outcome: 'timed_out'`), or,
 * in the earlier batch shape (no `outcome`, no `status`, unanswered as ""), a
 * non-empty response of a form without `timed_out`. Cancelled and undelivered
 * forms count for nothing. The legacy single-question shape is never read: it
 * serializes a timeout into `user_response` as text. Offered choices are never
 * returned.
 */
function clarifyAnswers(content: string | null): Array<{ question: string; text: string }> {
  let result: unknown;
  try { result = JSON.parse(content ?? ''); } catch { return []; }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
  const { outcome, responses, timed_out: timedOut } = result as Record<string, unknown>;
  if (!Array.isArray(responses)) return [];
  const statusShape = outcome !== undefined;
  if (statusShape ? outcome !== 'submitted' && outcome !== 'timed_out' : timedOut === true) return [];
  const answers: Array<{ question: string; text: string }> = [];
  for (const response of responses) {
    if (typeof response !== 'object' || response === null) continue;
    const { question, status, user_response: answer } = response as Record<string, unknown>;
    if (statusShape ? status !== 'answered' : status !== undefined) continue;
    const values = Array.isArray(answer) ? answer : [answer];
    if (!values.length || !values.every(v => typeof v === 'string' && v.trim())) continue;
    answers.push({ question: typeof question === 'string' ? question : '', text: values.join('\n') });
  }
  return answers;
}

/**
 * The source label Hermes gives sub-agent sessions. Delegate children recognised
 * by the `_delegate_from` marker are excluded under this label too (and counted
 * under it unless their own `source` or `created_source` is listed, which is
 * counted first), so the predicate, the default set and the summary line share
 * one spelling.
 */
export const HERMES_SUBAGENT_SOURCE = 'subagent';

/**
 * #8901: what Hermes itself hides from the user's session history
 * (tools/session_search_tool.py _HIDDEN_SESSION_SOURCES, v0.23.0). `subagent`
 * also covers delegate children recognised by the `_delegate_from` marker.
 * `cron` is demoted there, not hidden, so it is opt-in here; `oneshot`
 * (`hermes chat -q`, hidden from Hermes' pickers but not from its search) is a
 * question the user asked and stays importable unless named; a hook's custom
 * source must be named too.
 *
 * INVARIANT: this default is NOT part of the `--since last` checkpoint
 * fingerprint (excluding MORE never needs a rescan). REMOVING a label from it
 * in a later release re-admits sessions that existing watermarks have already
 * passed, so they would be skipped forever (ingest.ts: a run must never skip
 * work permanently); such a removal must ship with a TRANSCRIPT_IMPORT_VERSION
 * bump or a fingerprint key change. Adding a label is free.
 */
export const DEFAULT_HERMES_EXCLUDE_SOURCES: readonly string[] = [HERMES_SUBAGENT_SOURCE, 'kanban', 'tool'];

/** The flag/config word that turns every exclusion off. */
export const HERMES_EXCLUDE_NONE = 'none';

export interface HermesExcludePolicy {
  /** Source labels to drop (deduplicated, trimmed, `none` removed). */
  sources: string[];
  /** True when the flag or the config key set the list; false when the default applies. */
  explicit: boolean;
  /**
   * Set when the config value is not a list the key accepts (a JSON object,
   * number or `null`, a non-string item, or `none` mixed with labels). The
   * caller refuses the run: a malformed value must never read as "exclude
   * nothing" (fail closed) and must never open a new `--since last` scope.
   */
  error?: string;
}

/**
 * The effective exclude set for one run: the flag wins over the config key
 * `transcripts.hermes.exclude_sources` (a JSON array or comma list, the same
 * spellings as `cycle.conversation_facts_backfill.exclude_sources`), which
 * wins over DEFAULT_HERMES_EXCLUDE_SOURCES. An explicit empty list (`none`,
 * `[]`, `""`) excludes nothing. The policy is explicit whenever either input
 * was given, which is what the `--since last` fingerprint keys on.
 */
export function resolveHermesExcludePolicy(input: { flag?: readonly string[] | null; configRaw?: string | null }): HermesExcludePolicy {
  if (input.flag != null) return { sources: normalizeExcludeSources(input.flag), explicit: true };
  if (input.configRaw != null) {
    const parsed = parseHermesExcludeConfig(input.configRaw);
    if (parsed.error) return { sources: [...DEFAULT_HERMES_EXCLUDE_SOURCES], explicit: false, error: parsed.error };
    return { sources: parsed.sources, explicit: true };
  }
  return { sources: [...DEFAULT_HERMES_EXCLUDE_SOURCES], explicit: false };
}

/**
 * The `transcripts.hermes.exclude_sources` value as a label list, or the
 * reason it is refused. One parse: a value that looks like JSON (`[`, `{` or
 * `"` first) must parse and be an array of strings or a string (a JSON-quoted
 * comma list is split WITHOUT its quotes); a JSON scalar that is not a string
 * (`null`, `true`, `42`) is refused; anything else is a comma list. A value
 * that lists nothing is refused unless it is the documented off switch (`""`,
 * `[]`, `none`): for this key "nothing" would mean "exclude nothing" and turn
 * the default protection off silently. `none` beside labels is refused, as the
 * flag refuses it.
 */
export function parseHermesExcludeConfig(raw: string): { sources: string[]; error?: string } {
  const text = raw.trim();
  if (!text) return { sources: [] };
  let items: string[];
  let offSwitch = false;
  if (/^["[{]/.test(text)) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      return { sources: [], error: 'looks like JSON but does not parse (check the quotes and trailing commas)' };
    }
    if (typeof parsed === 'string') {
      items = splitSourceList(parsed);
      offSwitch = parsed.trim() === '' || parsed.trim() === HERMES_EXCLUDE_NONE;
    } else if (!Array.isArray(parsed)) {
      return { sources: [], error: 'is not a JSON array or comma list (got object); a label that reads as JSON goes inside a JSON array, e.g. ["[x]"]' };
    } else if (parsed.some((v) => typeof v !== 'string')) {
      return { sources: [], error: 'lists a non-string item' };
    } else {
      items = parsed.map((v: string) => v.trim()).filter(Boolean);
      offSwitch = parsed.length === 0;
    }
  } else {
    let scalar: unknown;
    let isScalar = false;
    try { scalar = JSON.parse(text); isScalar = true; } catch { /* a comma list or a bare word */ }
    if (isScalar) return { sources: [], error: `is not a JSON array or comma list (got ${scalar === null ? 'null' : typeof scalar}); a label that reads as JSON (true, null, 42) goes inside a JSON array, e.g. ["true"]` };
    items = splitSourceList(text);
    offSwitch = text === HERMES_EXCLUDE_NONE;
  }
  if (items.includes(HERMES_EXCLUDE_NONE) && items.length > 1) return { sources: [], error: `${HERMES_EXCLUDE_NONE} cannot be combined with other sources` };
  if (items.length === 0 && !offSwitch) return { sources: [], error: `lists no source labels (got ${JSON.stringify(text)}); use a JSON array, a comma list, or none` };
  return { sources: normalizeExcludeSources(items) };
}

/** Trim, drop empties and the `none` word, deduplicate, keep the given order. */
export function normalizeExcludeSources(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const v = item.trim();
    if (!v || v === HERMES_EXCLUDE_NONE || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

/**
 * The delegate marker of one session row, read the way Hermes reads it
 * (`json_extract(model_config, '$._delegate_from') IS NOT NULL`). A missing or
 * empty `model_config` is not a delegate; one that is not a JSON object is
 * `unparsed` and not a delegate either (a session is never excluded on a
 * guess). `from` is the parent session id the marker names.
 * @internal exported for tests
 */
export function hermesDelegateMarker(modelConfig: unknown): { delegate: boolean; unparsed: boolean; from?: string } {
  if (modelConfig == null) return { delegate: false, unparsed: false };
  // SQLite lets a BLOB (or a number) sit in the TEXT column; it is unparsed
  // metadata, never a reason to abort the store scan.
  if (typeof modelConfig !== 'string') return { delegate: false, unparsed: true };
  if (!modelConfig.trim()) return { delegate: false, unparsed: false };
  let cfg: unknown;
  try { cfg = JSON.parse(modelConfig); } catch { return { delegate: false, unparsed: true }; }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return { delegate: false, unparsed: true };
  const from = (cfg as Record<string, unknown>)._delegate_from;
  if (from === null || from === undefined) return { delegate: false, unparsed: false };
  // Presence is the signal; the parent id is kept only when it is a string
  // (never serialize an arbitrary structure: a deeply nested value would
  // overflow the stack and abort the store scan).
  return { delegate: true, unparsed: false, ...(typeof from === 'string' ? { from } : {}) };
}

/**
 * Whether one session row is excluded under `excluded`, and under which label
 * it is counted: its `source` when that is listed, else its `created_source`
 * when that is listed (Hermes rewrites the owner's own cli/tui/desktop rows to
 * the routing label `local` and keeps the creation label in the immutable
 * `created_source`; its own kanban check reads both columns, hermes_state.py
 * is_kanban_owned_session), else HERMES_SUBAGENT_SOURCE when the row carries
 * the delegate marker and that label is listed.
 * @internal exported for tests
 */
export function hermesSessionExcluded(
  row: { source: string | null; created_source?: string | null }, marker: { delegate: boolean }, excluded: ReadonlySet<string>,
): { excluded: false } | { excluded: true; label: string; viaMarker: boolean; matched: string[] } {
  if (excluded.size === 0) return { excluded: false };
  // SQLite may hold a BLOB in a TEXT column: only strings are labels.
  const source = typeof row.source === 'string' ? row.source : '';
  const created = typeof row.created_source === 'string' ? row.created_source : '';
  // Every listed label the row matches (a delegate child spawned under a cron
  // run matches `cron` AND `subagent`): the row is counted once, under the
  // first, but each matched label is a label that did something.
  const matched: string[] = [];
  if (source && excluded.has(source)) matched.push(source);
  if (created && created !== source && excluded.has(created)) matched.push(created);
  if (marker.delegate && excluded.has(HERMES_SUBAGENT_SOURCE) && !matched.includes(HERMES_SUBAGENT_SOURCE)) matched.push(HERMES_SUBAGENT_SOURCE);
  if (matched.length === 0) return { excluded: false };
  const label = matched[0];
  return { excluded: true, label, viaMarker: label === HERMES_SUBAGENT_SOURCE && source !== HERMES_SUBAGENT_SOURCE && created !== HERMES_SUBAGENT_SOURCE, matched };
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
    // #8901 accounting (see FileDiagnostics).
    // Normalized here too: a library caller passing `''` or `none` must not
    // exclude rows whose source is NULL or a BLOB.
    const excluded: ReadonlySet<string> = new Set(normalizeExcludeSources(opts.excludeSessionSources ?? []));
    let rowsSeen = 0;
    let sessionsExcluded = 0;
    let delegatesExcluded = 0;
    const labelsMatched = new Set<string>();
    // Null prototype: labels are operator-chosen words, and `constructor` or
    // `__proto__` on a plain object would read an inherited property.
    const excludedBySource: Record<string, number> = Object.create(null);
    try {
      copyFileSync(path, copyPath);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(path + suffix)) copyFileSync(path + suffix, copyPath + suffix);
      }

      const db = new Database(copyPath, { readonly: true });
      try {
        let sessionRows: SessionRow[];
        // Older stores have no model_config / created_source column: sniff
        // first, or the SELECT below would read as schema drift and freeze
        // the watermark.
        let hasModelConfig = false;
        try {
          const sessionColumns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all().map(c => c.name));
          hasModelConfig = sessionColumns.has('model_config');
          sessionRows = db
            .query<SessionRow, []>(
              'SELECT id, title, display_name, started_at, cwd, model, source' +
                (hasModelConfig ? ', model_config' : '') +
                (sessionColumns.has('created_source') ? ', created_source' : '') +
                ' FROM sessions ORDER BY started_at',
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

        // Older stores have no tool columns; they import user/assistant rows as before.
        const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(messages)').all().map(c => c.name));
        const toolColumns = columns.has('tool_name') && columns.has('tool_call_id');
        const msgQuery = db.query<MessageRow, [string]>(
          toolColumns
            ? "SELECT role, content, timestamp, tool_call_id FROM messages WHERE session_id = ? " +
              "AND (role IN ('user','assistant') OR (role = 'tool' AND tool_name = 'clarify')) ORDER BY timestamp, id"
            : "SELECT role, content, timestamp, NULL AS tool_call_id FROM messages WHERE session_id = ? " +
              "AND role IN ('user','assistant') ORDER BY timestamp, id",
        );
        for (const row of sessionRows) {
          if (typeof row.id !== 'string' || !row.id) continue;
          rowsSeen++;
          // #8901: classify and exclude BEFORE the message query, so the count
          // does not depend on message content and excluded rows cost no read.
          const marker = hasModelConfig ? hermesDelegateMarker(row.model_config) : { delegate: false, unparsed: false };
          // Only strings are labels (SQLite may hold a BLOB in a TEXT column);
          // a non-string source is kept out of the frontmatter and the predicate.
          const sourceLabel = typeof row.source === 'string' ? row.source : null;
          const createdLabel = typeof row.created_source === 'string' ? row.created_source : null;
          const verdict = hermesSessionExcluded({ source: sourceLabel, created_source: createdLabel }, marker, excluded);
          if (verdict.excluded) {
            sessionsExcluded++;
            excludedBySource[verdict.label] = (excludedBySource[verdict.label] ?? 0) + 1;
            if (verdict.viaMarker) delegatesExcluded++;
            for (const label of verdict.matched) labelsMatched.add(label);
            continue;
          }
          const messages: TranscriptMessage[] = [];
          const raw: Record<string, unknown> = {
            session_id: row.id,
            source: sourceLabel,
            cwd: row.cwd ?? null,
            source_path: path,
            ...(createdLabel ? { created_source: createdLabel } : {}),
            ...(marker.delegate ? { delegate_from: marker.from ?? null } : {}),
          };
          let clarified = 0;
          for (const m of msgQuery.all(row.id)) {
            if (m.role === 'tool') {
              for (const answer of clarifyAnswers(m.content)) {
                // The question the assistant asked comes first, so the answer reads in context; it is never user speech.
                if (answer.question.trim()) messages.push({ role: 'assistant', timestamp: epochToIso(m.timestamp), text: answer.question });
                raw[`clarify_${clarified}_tool_call_id`] = m.tool_call_id;
                raw[`clarify_${clarified}_question`] = answer.question;
                raw[`clarify_${clarified++}_message_index`] = messages.length;
                messages.push({ role: 'user', timestamp: epochToIso(m.timestamp), text: answer.text });
              }
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
              ...(sourceLabel ? { sessionSource: sourceLabel } : {}),
              ...(createdLabel && createdLabel !== sourceLabel ? { sessionCreatedSource: createdLabel } : {}),
              ...(marker.delegate ? { delegate: true } : {}),
              ...(marker.unparsed ? { hostMetadataUnparsed: true } : {}),
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

    // Every row excluded is an understood empty store, not drift; a store
    // whose remaining rows merely had no text is still today's drift signal.
    const allExcluded = rowsSeen > 0 && sessionsExcluded === rowsSeen;
    return {
      bytesRead: size,
      skippedLines: 0,
      truncated: false,
      sessions,
      zeroSessionsReason:
        sessions === 0
          ? allExcluded
            ? `every session in store excluded by source (${Object.keys(excludedBySource).sort().join(', ')})`
            : 'no sessions with user/assistant text messages in store'
          : undefined,
      ...(allExcluded ? { expectedEmpty: true } : {}),
      ...(sessionsExcluded > 0 ? { sessionsExcluded, excludedBySource, excludeLabelsMatched: [...labelsMatched].sort() } : {}),
      ...(delegatesExcluded > 0 ? { delegatesExcluded } : {}),
    };
  },
};
