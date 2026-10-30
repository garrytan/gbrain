import { OperationError } from '../ops/contract.ts';
import { writerStamp } from './writer-versions.ts';
import { cursorFenceCause } from './sync-knock-on.ts';
import type { FenceFailureDetail } from '../fence-repair/refusal.ts';
import type { WithdrawalFailureDetail } from '../facts/withdrawal.ts';
import type { Action } from '../agent-output.ts';
import { classifyPgAccessError } from '../pg-access-classify.ts';
import { READ_ONLY_SQLSTATE } from '../postgres-engine/read-write-transactions.ts';

/**
 * #5974: a database refusal during preparation or publication becomes a
 * structured, bounded diagnostic instead of an opaque storage_error. Only
 * fixed identifiers are kept: trigger function, table, operation, guard
 * branch and the source relationship. Page text, SQL and row values never are.
 */
export type PublicationStage = 'preparation' | 'publication' | 'after_file_publication';
/**
 * #6513 (wave 16 G3.5): the public `reason` of a refusal gbrain classifies by its raiser and SQLSTATE (#6904: `schema_missing`,
 * a 42P01/42703 missing relation or column, per `pg-access-classify.ts`). A CLOSED enum:
 * an operator trigger can interpolate a row value at its message prefix, so nothing derived from the message is kept,
 * publicly or owner-side (#5974's rule: fixed identifiers only).
 */
export const PUBLICATION_REASONS = ['attribution_unclassified_table', 'trust_unclassified_table', 'graduation_in_progress', 'schema_missing', 'unknown'] as const;
export type PublicationReason = typeof PUBLICATION_REASONS[number];
export interface PublicationFailureDetail {
  origin: 'database_guard' | 'database_trigger' | 'database';
  sqlstate: string;
  raiser?: string;
  table?: string;
  op?: string;
  branch?: string;
  relationship?: string;
  /** Closed enum (`PUBLICATION_REASONS`) for a refusal without a typed code; absent on the typed guard/trigger refusals. */
  reason?: PublicationReason;
  /** Owner-only, #6904: the relation or column a `schema_missing` refusal names (an identifier, never a value). */
  missing?: string;
  /** Owner-only: source identifiers can name private sources. */
  sources?: { target: string | null; old: string | null; allowed: string[] };
  stage?: PublicationStage;
  /** Owner-only: the build and host that executed the failed attempt. */
  attempt?: { consumer_version: string; consumer_host_id: string | null };
}
/** #6188: a typed fence refusal's location (`fence-repair/refusal.ts`), plus the attempt stamp. */
export type FenceRefusalDetail = FenceFailureDetail & Pick<PublicationFailureDetail, 'stage' | 'attempt'>;
/**
 * #5929: an unexpected exception in the owner. Fixed identifiers only, never
 * application error text or values: the error class, its errno and the top gbrain
 * source frame (repo-relative). #7112: a database server error also keeps its
 * redacted primary message, the failing statement with every literal replaced and the
 * error position (`databaseErrorText`). All of it is owner-only.
 */
export interface OwnerExceptionDetail extends Pick<PublicationFailureDetail, 'stage' | 'attempt'> {
  origin: 'owner_exception'; error_class?: string; errno?: string; frame?: string;
  error_text?: string; statement?: string; position?: number;
}
/** A `fact_withdrawn` refusal's `withdrawn` object (`facts/withdrawal.ts`), plus the attempt stamp. */
export type WithdrawalRefusalDetail = WithdrawalFailureDetail & Pick<PublicationFailureDetail, 'stage' | 'attempt'>;
/** #6696 (A12): the page's recorded canonical file is gone (`prepareFileTarget`); a producer refuses the same write before admission. */
export const CANONICAL_FILE_MISSING = 'canonical_file_missing';
export interface CanonicalFileDetail { origin: typeof CANONICAL_FILE_MISSING; stage?: PublicationStage; attempt?: { consumer_version: string; consumer_host_id: string | null } }
/** #6693: a page write refused because its file holds a committed change sync has not imported (`pending_import`) or sync holds the file (`sync_held`). */
export interface PendingImportDetail { origin: 'pending_import' | 'sync_held'; stage?: PublicationStage; attempt?: { consumer_version: string; consumer_host_id: string | null } }
export interface PublicationFailure { code: string; message: string; detail?: PublicationFailureDetail | FenceRefusalDetail | WithdrawalRefusalDetail | OwnerExceptionDetail | CanonicalFileDetail | PendingImportDetail }

const IDENT = /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/;
const ident = (value: unknown) => typeof value === 'string' && IDENT.test(value) ? value : undefined;
const GUARD_PREFIX = 'writer_coordinator_required:';
/** G7a (writer-guard-schema.ts): the guard's refusal of a git-canonical source's row from a writer without the git protocol. */
const GIT_PROTOCOL_PREFIX = 'git_protocol_required:';
/** trust/schema.ts: the tier trigger's refusal of a raise without owner confirmation. */
const TRUST_PREFIX = 'trust_raise_refused:';
const PURGED_PREFIX = 'purged_content:';
const RELATIONSHIP_TEXT: Record<string, string> = {
  different_source: 'a row in a source this publication does not own',
  missing_source: 'a row whose source could not be resolved',
  old_source_outside: 'a row moved from a source this publication does not own',
  checkpoint_outside_owner: 'a source sync checkpoint outside owner publication',
  topology_outside_administration: 'a source topology change outside writer administration',
  unreadable_state: 'writer state this database role cannot read (row-level security hides it, or its row is missing)',
};

function guardDetail(raw: unknown): Pick<PublicationFailureDetail, 'op' | 'relationship' | 'sources'> {
  if (typeof raw !== 'string' || raw.length > 4096) return {};
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.map(ident).filter((v): v is string => !!v).slice(0, 32) : [];
  const target = ident(parsed.target_source) ?? null, old = ident(parsed.old_source) ?? null;
  return { op: ident(parsed.op), relationship: ident(parsed.relationship),
    ...(target || old || allowed.length ? { sources: { target, old, allowed } } : {}) };
}

/** graduation-schema.ts: the engine-graduation fence refuses with SQLSTATE 55000, not P0001. */
const GRADUATION_SQLSTATE = '55000';
const GRADUATION_RAISER = 'gbrain_graduation_fence';
const UNCLASSIFIED_TABLE: Record<string, PublicationReason> = { gbrain_stamp_write_attribution: 'attribution_unclassified_table', gbrain_stamp_trust_tier: 'trust_unclassified_table' };
/**
 * The closed reason of an untyped refusal: a known raiser's own fixed text (attribution-schema.ts / trust/schema.ts
 * "is not classified for table"), the graduation fence by its SQLSTATE and raiser, else `unknown`. The message decides
 * nothing on its own: the same text from another raiser, or the fence's text under P0001, is `unknown`.
 */
function publicationReason(sqlstate: string, raiser: string | undefined, message: string): PublicationReason {
  if (sqlstate === GRADUATION_SQLSTATE) return raiser === GRADUATION_RAISER ? 'graduation_in_progress' : 'unknown';
  const unclassified = raiser ? UNCLASSIFIED_TABLE[raiser] : undefined;
  return unclassified && message.startsWith(`${raiser} is not classified for table`) ? unclassified : 'unknown';
}

/**
 * #6904: a relation or column the write path needs is missing (42P01 / 42703, `schema_missing` in `pg-access-classify.ts`):
 * the brain schema is behind this build or lost a table, never a gbrain defect. Names the missing identifier from the server's
 * own parser error; a PL/pgSQL RAISE carries caller text, so it is never parsed (#5974 fixed identifiers).
 */
const SCHEMA_MISSING_SQLSTATES = new Set(['42P01', '42703']);
const MISSING_NAME = /(column|relation)\s+"?([A-Za-z_][A-Za-z0-9_.]*)"?(?:\s+of relation\s+"?([A-Za-z_][A-Za-z0-9_.]*)"?)?\s+does not exist/i;
function schemaMissing(sqlstate: string, message: string): PublicationFailure {
  const match = MISSING_NAME.exec(message);
  const missing = match ? ident(match[3] ? `${match[3]}.${match[2]}` : match[2]) : undefined;
  const what = match ? `${match[1]!.toLowerCase()} ${missing ?? 'unnamed'}` : 'relation or column';
  return { code: 'storage_error', message: `Publication failed: the database has no ${what} (${sqlstate}), which this gbrain build needs, so the brain schema is missing a migration or a table. Nothing was committed.`,
    detail: { origin: 'database', sqlstate, reason: 'schema_missing', ...(missing ? { missing } : {}) } };
}

/** Null when the error is not a database refusal this module recognizes. */
export function databaseRefusal(error: unknown): PublicationFailure | null {
  if (error instanceof OperationError || !error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const sqlstate = typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  if (sqlstate && SCHEMA_MISSING_SQLSTATES.has(sqlstate) && classifyPgAccessError(error).reason === 'schema_missing') {
    return schemaMissing(sqlstate, typeof e.message === 'string' && e.routine !== 'exec_stmt_raise' ? e.message : '');
  }
  if (sqlstate === READ_ONLY_SQLSTATE) return { code: 'connection_inherited_read_only', detail: { origin: 'database', sqlstate },
    message: `The database refused this write as read-only (SQLSTATE ${sqlstate}${typeof e.message === 'string' ? `: ${e.message}` : ''}), so nothing was committed: the server connection defaults to read-only transactions (pooler session state left by another client, a role or database default, or a read-only server).` };
  if (sqlstate !== 'P0001' && sqlstate !== GRADUATION_SQLSTATE) return null;
  const where = typeof e.where === 'string' ? e.where : '';
  const raiser = ident(/PL\/pgSQL function (?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)[( ]/.exec(where)?.[1]);
  const table = ident(e.table_name ?? e.table);
  const constraint = typeof (e.constraint_name ?? e.constraint) === 'string' ? String(e.constraint_name ?? e.constraint) : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (sqlstate === GRADUATION_SQLSTATE) {
    const reason = publicationReason(sqlstate, raiser, message);
    return { code: 'storage_error', detail: { origin: raiser ? 'database_trigger' : 'database', sqlstate, ...(raiser ? { raiser } : {}), ...(table ? { table } : {}), reason },
      message: reason === 'graduation_in_progress'
        ? `Publication was refused by the engine graduation fence (${sqlstate} in ${raiser}: ${reason}): this brain is being moved between engines; retry once gbrain migrate --status --json reports the run finished.`
        : `Publication failed (${sqlstate}${raiser ? ` in ${raiser}` : ''}: ${reason}). Inspect owner diagnostics.` };
  }
  if (message.startsWith(PURGED_PREFIX)) return { code: 'purged_content', message: `${message.slice(PURGED_PREFIX.length).trim()}. Nothing was committed.`,
    detail: { origin: 'database_trigger', sqlstate, ...(raiser ? { raiser } : {}), ...(table ? { table } : {}) } };
  if (message.startsWith(GIT_PROTOCOL_PREFIX) || constraint.startsWith('git_canonical_fence')) {
    return { code: 'git_protocol_required', detail: { origin: 'database_guard', sqlstate, raiser: raiser ?? 'gbrain_require_managed_writer', ...(table ? { table } : {}), ...guardDetail(e.detail) },
      message: `The git-canonical database fence refused a write${table ? ` on ${table}` : ''}: the source is git-canonical and this gbrain process does not declare the git protocol (an older gbrain). Nothing was committed.` };
  }
  if (message.startsWith(GUARD_PREFIX) || constraint.startsWith('managed_writer_guard')) {
    const branch = constraint.startsWith('managed_writer_guard:') ? ident(constraint.slice('managed_writer_guard:'.length)) : undefined;
    const detail: PublicationFailureDetail = { origin: 'database_guard', sqlstate, raiser: raiser ?? 'gbrain_require_managed_writer',
      ...(table ? { table } : {}), ...(branch ? { branch } : {}), ...guardDetail(e.detail) };
    const what = detail.relationship ? RELATIONSHIP_TEXT[detail.relationship] ?? 'a row outside its allowlist' : 'a row outside its allowlist';
    return { code: 'writer_coordinator_required', detail, message:
      `The managed-writer database guard refused ${detail.op ? `an ${detail.op}` : 'a write'}${table ? ` on ${table}` : ''}: ${what}. Nothing was committed.` };
  }
  if (message.startsWith(TRUST_PREFIX) || constraint === 'trust_tier_guard') {
    return { code: 'trust_raise_refused', detail: { origin: 'database_trigger', sqlstate, raiser: raiser ?? 'gbrain_stamp_trust_tier', ...(table ? { table } : {}),
      ...guardDetail(e.detail) },
    message: `The trust-tier guard refused a write${table ? ` on ${table}` : ''}: raising a tier needs the owner's confirmation. Nothing was committed.` };
  }
  const reason = publicationReason(sqlstate, raiser, message);
  return { code: 'storage_error', message: `Publication failed (P0001${raiser ? ` in ${raiser}` : ''}: ${reason}). Inspect owner diagnostics.`,
    detail: { origin: raiser ? 'database_trigger' : 'database', sqlstate, ...(raiser ? { raiser } : {}), ...(table ? { table } : {}), reason } };
}

const ERRNO = /^[A-Za-z0-9_]{1,40}$/;

/** The top stack frame inside gbrain's own `src/`, as `src/<path>.ts:<line>`; never an absolute path. */
function gbrainFrame(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('node_modules')) continue;
    const match = /.*[\/\\(\s](src[\/\\][\w./\\-]+?\.ts):(\d+)/.exec(line);
    if (match) return `${match[1]!.replace(/\\/g, '/')}:${match[2]}`;
  }
  return undefined;
}

/**
 * #5929: the public message of an unexpected owner exception. Remote submitters read it, so it names no class,
 * errno or build; those stay in the owner-only detail, `gbrain write-request <id>` on the brain host and the consumer log.
 */
export const OWNER_EXCEPTION_MESSAGE = 'Publication failed on an unexpected owner exception. On the brain host, gbrain write-request <request_id> and the persistence consumer log name its class, database error text, statement, source frame and owner build.';

const ERROR_TEXT_MAX = 240;
const STATEMENT_MAX = 160;
const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const SQL_TOKEN = {
  space: /\s+/y,
  lineComment: /--[^\n]*(?:\n|$)/y,
  param: /\$[0-9]+/y,
  dollar: /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y,
  number: /(?:[0-9]|\.[0-9])[0-9A-Za-z_.]*/y,
  word: /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/y,
  punct: /[(),;.*=<>!+\-/%:[\]|&~^@#?{}]/y,
};

/**
 * #7112: a SQL statement reduced to its keywords, identifiers, parameter markers and operators. Every string literal,
 * dollar-quoted body and number becomes a placeholder, comments drop, and anything unrecognized or unterminated ends
 * the text, so no literal value survives. `names` holds the statement's identifiers, lower-cased.
 */
function sqlShape(query: string): { text: string; names: Set<string> } {
  const names = new Set<string>();
  let out = '';
  let space = false;
  const emit = (token: string) => { out += (space && out ? ' ' : '') + token; space = false; };
  const at = (re: RegExp, i: number) => { re.lastIndex = i; return re.exec(query)?.[0]; };
  let i = 0;
  scan: while (i < query.length) {
    const ch = query[i]!;
    let token: string | undefined;
    if ((token = at(SQL_TOKEN.space, i)) || (token = at(SQL_TOKEN.lineComment, i))) { space = true; i += token.length; continue; }
    if (query.startsWith('/*', i)) {
      let depth = 0;
      for (let j = i; j < query.length; j++) {
        if (query.startsWith('/*', j)) { depth++; j++; } else if (query.startsWith('*/', j)) { depth--; j++; if (depth === 0) { i = j + 1; space = true; continue scan; } }
      }
      break;
    }
    if (ch === "'") {
      const backslash = /(?:^|[^A-Za-z0-9_$\u0080-\uffff])[eE]$/.test(query.slice(Math.max(0, i - 2), i));
      for (let j = i + 1; j < query.length; j++) {
        if (backslash && query[j] === '\\') { j++; continue; }
        if (query[j] !== "'") continue;
        if (query[j + 1] === "'") { j++; continue; }
        emit("'…'"); i = j + 1; continue scan;
      }
      out += '…'; break;
    }
    if (ch === '"') {
      for (let j = i + 1; j < query.length; j++) {
        if (query[j] !== '"') continue;
        if (query[j + 1] === '"') { j++; continue; }
        const name = query.slice(i + 1, j).replace(/""/g, '"');
        if (SQL_NAME.test(name)) { names.add(name.toLowerCase()); emit(`"${name}"`); } else emit('"…"');
        i = j + 1; continue scan;
      }
      out += '…'; break;
    }
    if ((token = at(SQL_TOKEN.param, i))) { emit(token); i += token.length; continue; }
    if ((token = at(SQL_TOKEN.dollar, i))) {
      const close = query.indexOf(token, i + token.length);
      if (close < 0) { out += '…'; break; }
      emit('$…$'); i = close + token.length; continue;
    }
    if ((token = at(SQL_TOKEN.number, i))) { emit('?'); i += token.length; continue; }
    if ((token = at(SQL_TOKEN.word, i))) { names.add(token.toLowerCase()); emit(token); i += token.length; continue; }
    if ((token = at(SQL_TOKEN.punct, i))) { emit(token); i += token.length; continue; }
    out += '…'; break;
  }
  return { text: out.length > STATEMENT_MAX ? `${out.slice(0, STATEMENT_MAX - 1)}…` : out, names };
}

/** Server messages whose every double-quoted token is a catalog name: a bound or literal value cannot appear in them. */
const CATALOG_NAMED = [
  /^null value in column "([A-Za-z_][A-Za-z0-9_$]{0,62})" of relation "([A-Za-z_][A-Za-z0-9_$]{0,62})" violates not-null constraint$/,
  /^duplicate key value violates unique constraint "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/,
  /^new row for relation "([A-Za-z_][A-Za-z0-9_$]{0,62})" violates check constraint "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/,
  /^insert or update on table "([A-Za-z_][A-Za-z0-9_$]{0,62})" violates foreign key constraint "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/,
  /^update or delete on table "([A-Za-z_][A-Za-z0-9_$]{0,62})" violates foreign key constraint "([A-Za-z_][A-Za-z0-9_$]{0,62})" on table "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/,
];
/**
 * Server messages whose quoted token is a name from the statement text, kept only when the statement holds it as an
 * identifier: a bound value cast to regclass or regtype yields the same message with the value in it.
 */
const STATEMENT_NAMED = [
  /^syntax error at or near "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/,
  /^(?:relation|column|type|function|schema|index|constraint|table) "([A-Za-z_][A-Za-z0-9_$]{0,62})" does not exist$/,
  /^column "([A-Za-z_][A-Za-z0-9_$]{0,62})" of relation "([A-Za-z_][A-Za-z0-9_$]{0,62})" does not exist$/,
];

/**
 * #7112: a server message without the values it can carry. A message that matches a known template keeps its object
 * names; any other message loses everything from its first quote to its last (Postgres does not escape a quote inside
 * a quoted value, so the value's own quotes cannot be told apart) and every hexadecimal byte run.
 */
function serverMessageText(message: string, statementNames: Set<string>): string {
  const line = message.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  const kept = CATALOG_NAMED.some(re => re.test(line))
    || STATEMENT_NAMED.some(re => { const m = re.exec(line); return !!m && m.slice(1).every(name => statementNames.has(name.toLowerCase())); });
  let text = line;
  if (!kept) {
    const first = line.search(/["']/);
    const last = Math.max(line.lastIndexOf('"'), line.lastIndexOf("'"));
    if (first >= 0) text = first === last ? `${line.slice(0, first)}"…` : `${line.slice(0, first)}"…"${line.slice(last + 1)}`;
    text = text.replace(/\b0x[0-9a-f]+/gi, '0x…');
  }
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text;
}

/**
 * #7112: what a database server error says, without the values it can carry. Only an error the server itself generated
 * qualifies: a five-character SQLSTATE, a severity and a C routine that is neither a PL/pgSQL RAISE nor ASSERT (their
 * text is the caller's) nor any other class P0 condition. The message goes through `serverMessageText`; the statement
 * keeps its tokens with every literal replaced, never its parameters.
 */
function databaseErrorText(e: Record<string, unknown>): Pick<OwnerExceptionDetail, 'error_text' | 'statement' | 'position'> {
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code) || e.code.startsWith('P0') || typeof e.severity !== 'string'
    || typeof e.routine !== 'string' || /^exec_stmt_(?:raise|assert)$/.test(e.routine)) return {};
  const shape = typeof e.query === 'string' ? sqlShape(e.query) : undefined;
  const errorText = typeof e.message === 'string' ? serverMessageText(e.message, shape?.names ?? new Set()) : undefined;
  const position = Number(e.position);
  return { ...(errorText ? { error_text: errorText } : {}), ...(shape?.text ? { statement: shape.text } : {}),
    ...(Number.isInteger(position) && position > 0 ? { position } : {}) };
}

/** #5929: the bounded identity of an unexpected owner exception (class, errno, frame, and a database error's redacted text), kept owner-only. */
export function ownerExceptionFailure(error: unknown): PublicationFailure {
  const e = (error && typeof error === 'object' ? error : {}) as { constructor?: { name?: unknown }; code?: unknown; errno?: unknown; stack?: unknown; osError?: unknown };
  const errorClass = ident(e.constructor?.name);
  // #6305: an error that names the OS error behind it (a native lock failure) reports that, not its gbrain code.
  const raw = typeof e.osError === 'string' ? e.osError : typeof e.code === 'string' ? e.code : typeof e.errno === 'number' ? String(e.errno) : undefined;
  const errno = raw && ERRNO.test(raw) ? raw : undefined;
  const frame = gbrainFrame(e.stack);
  return { code: 'storage_error', message: OWNER_EXCEPTION_MESSAGE,
    detail: { origin: 'owner_exception', ...(errorClass ? { error_class: errorClass } : {}), ...(errno ? { errno } : {}), ...(frame ? { frame } : {}),
      ...databaseErrorText(e as Record<string, unknown>) } };
}

/** Owner-side text for the consumer log: the class, frame and database error text of an owner exception, else nothing. */
export function ownerExceptionLogText(detail: unknown): string {
  const d = detail as Partial<OwnerExceptionDetail> | null;
  if (!d || d.origin !== 'owner_exception') return '';
  return [d.error_class ? ` class=${d.error_class}` : '', d.errno ? ` errno=${d.errno}` : '', d.frame ? ` frame=${d.frame}` : '',
    d.error_text ? ` error_text=${JSON.stringify(d.error_text)}` : '', d.statement ? ` statement=${JSON.stringify(d.statement)}` : '',
    d.position ? ` position=${d.position}` : ''].join('');
}

/**
 * #5929: when the owner that ran a failed attempt is on another build than
 * this CLI (a long-running `gbrain serve` started before an upgrade), say so
 * with the restart step. Owner-only: the attempt stamp is never public.
 */
export function ownerBuildMismatch(detail: unknown, cliVersion: string): { owner: string; cli: string; why: string; fix: Action } | null {
  const owner = (detail as Partial<PublicationFailureDetail> | null)?.attempt?.consumer_version;
  if (typeof owner !== 'string' || !owner || owner === cliVersion) return null;
  return { owner, cli: cliVersion,
    why: `The owner process that ran this attempt is on gbrain ${owner}; this CLI is ${cliVersion}. Long-running \`gbrain serve\` processes (and autopilot or sync jobs) started before the upgrade still own writes and run the old code.`,
    fix: { consent: [], actor: 'user', requires_exclusive: false,
      why: 'Restart every serve, autopilot and sync process on the brain host so the owner runs this build (`gbrain sources writer status --probe --json` shows it), then submit the write again with a new request_id.',
      user_message: `Restart the gbrain serve (and autopilot) processes on the brain host: they are on ${owner}, this CLI is ${cliVersion}.`,
      verify: { argv: ['gbrain', 'doctor', '--only', 'writer_version', '--json'] } } };
}

/** Stamps which build, host and stage ran the failed attempt. */
export function withAttempt(failure: PublicationFailure, stage: PublicationStage): PublicationFailure {
  if (!failure.detail) return failure;
  const stamp = writerStamp();
  return { ...failure, detail: { ...failure.detail, stage, attempt: { consumer_version: stamp.version, consumer_host_id: stamp.hostId } } };
}

/**
 * The receipt view any caller may read: fixed enums only, no source
 * identifiers, host or build. A fence location keeps its fence, section,
 * reason and problem classes; its row numbers stay owner-side (they can
 * number rows a remote caller never saw).
 */
const PUBLIC_DETAIL_KEYS: ReadonlySet<string> = new Set(['origin', 'sqlstate', 'raiser', 'table', 'op', 'branch', 'relationship', 'reason', 'stage', 'fence', 'cause']);

export function publicFailureDetail(detail: unknown): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  // #5929: an allow-list, so a key added to a stored detail is owner-only unless it is listed here.
  // #6513: `reason` is public only as a member of the closed enum, whatever a stored detail holds under that key.
  const rest = Object.fromEntries(Object.entries(detail).filter(([key, value]) => PUBLIC_DETAIL_KEYS.has(key)
    && (key !== 'reason' || (PUBLICATION_REASONS as readonly unknown[]).includes(value))
    // #6643: a cursor fence refusal's `cause` is public only as a member of its closed enum.
    && (key !== 'cause' || cursorFenceCause({ cause: value }) !== null)));
  if ((rest as { origin?: unknown }).origin === 'fence') {
    const { rows: _rows, issues, ...fence } = ((rest as unknown as FenceFailureDetail).fence ?? {}) as FenceFailureDetail['fence'];
    const publicIssues = Array.isArray(issues) ? issues.map(({ row: _row, ...issue }) => issue) : undefined;
    return { ...rest, fence: { ...fence, ...(publicIssues?.length ? { issues: publicIssues } : {}) } } as unknown as Record<string, unknown>;
  }
  return rest as unknown as Record<string, unknown>;
}
