/**
 * Postgres ACCESS-error classifier — the reason/remediation layer of the
 * db-availability loop (detect → marker → skill → `gbrain db-repair`).
 *
 * Two entry points, one diagnosis type:
 *   - `classifyPgAccessError(err, ctx?)` — for a THROWN error.
 *   - `diagnoseDbConfig(ctx)` — for errorless config-plane reasons
 *     (`no_url`, `env_shadowed`): there is no error object at
 *     `connectEngine`'s no-config exit or in a #427 env shadow, and faking
 *     one (`classifyPgAccessError(new Error('no url'))`) is exactly the
 *     seam-hack this split exists to prevent.
 *
 * TWO-AXIS DESIGN NOTE (mirrored in retry-matcher.ts — do not "fix" one
 * side to match the other): `retry-matcher.ts` answers "should I retry?"
 * and deliberately treats `password authentication failed` as retryable
 * (auth race during DNS failover). THIS module answers "what went wrong
 * and what fixes it?" and reports the same error as `auth_failed` with
 * `transient: false`. Both are correct on their own axis.
 *
 * Invariants:
 *   - `message` and `remediation` are ALWAYS pre-redacted — a diagnosis is
 *     safe to put in an agent transcript, a receipt, or a GitHub issue.
 *   - Every `fix` descriptor is HARDCODED or derived from the CURRENT
 *     config URL (`deriveSessionPoolerUrl`/`deriveDirectUrl`), never from
 *     anything parsed out of error text. `run_command` argv[0] is always
 *     'gbrain' (the advisor --apply seam invariant).
 *   - The reason union is APPEND-ONLY (a compatibility surface once the
 *     bundled skills are in the wild, like progress phase names): reasons
 *     may be added, never renamed or removed.
 *   - Remediation copy has exactly ONE home: this module. db-repair,
 *     doctor, and MCP dispatch all render `diagnosis.remediation`; skills
 *     reference the command, never duplicate recipe text.
 */

import {
  getCode,
  getMessage,
  isRetryableConnError,
} from './retry-matcher.ts';
import { redactConnectionInfo } from './audit/redact-connection-info.ts';
import { redactUrlsInText } from './url-redact.ts';
import {
  deriveDirectUrl,
  deriveSessionPoolerUrl,
  isSupabasePoolerUrl,
} from './connection-manager.ts';
import { extractProjectRef } from './supabase-admin.ts';

/**
 * APPEND-ONLY. Consumers switch exhaustively with a `never` sentinel
 * (mirror the RemoteMcpErrorReason pattern in src/cli.ts) so a new reason
 * is a compile error at every consumer, not a silent fall-through.
 */
export type PgAccessReason =
  | 'no_url'              // config-plane: nothing configured at all
  | 'env_shadowed'        // config-plane: #427 cwd-.env DATABASE_URL ignored
  | 'auth_failed'         // 28P01 / password authentication failed / unknown role
  | 'permission_denied'   // 28000 / 42501 (RLS or missing GRANT)
  | 'tenant_not_found'    // Supavisor "Tenant or user not found"
  | 'ssl_required'        // server demands SSL / pg_hba no-encryption reject
  | 'pool_exhausted'      // 53300 / EMAXCONNSESSION / slot exhaustion
  | 'conn_refused'        // ECONNREFUSED
  | 'dns_failed'          // ENOTFOUND / EAI_AGAIN
  | 'network_unreachable' // ENETUNREACH / EHOSTUNREACH / ETIMEDOUT / CONNECT_TIMEOUT
  | 'conn_dropped'        // 08xxx / CONNECTION_ENDED / CONNECTION_CLOSED / resets
  | 'server_starting'     // "the database system is starting up"
  | 'db_missing'          // 3D000 database does not exist
  | 'schema_missing'      // 42P01 / 42703 missing relation or column
  | 'pgvector_missing'    // vector extension absent
  | 'unknown';

export type PgAccessFix =
  | { kind: 'retry_reconnect' }
  | { kind: 'run_command'; argv: string[] } // argv[0] === 'gbrain', always
  | { kind: 'set_env'; name: string; value: string; why: string }
  | { kind: 'rewrite_config_url'; to: 'session_pooler' | 'transaction_pooler' | 'append_sslmode' }
  | { kind: 'manual'; recipe: string };

/** Mirrors `getDbUrlSource()` in config.ts (pinned by test). Kept local so
 *  this module stays pure/import-light; callers pass the value through. */
export type PgDbUrlSource =
  | 'env:GBRAIN_DATABASE_URL'
  | 'env:DATABASE_URL'
  | 'config-file'
  | 'config-file-path'
  | null;

export interface PgAccessContext {
  /** The CURRENT configured URL (fix derivation input — never error text). */
  url?: string | null;
  source?: PgDbUrlSource;
  /** Engine-free resolver/mount routing id ('host' or a mount id). A mount
   *  failure must never read as a host failure — the id rides into the
   *  marker so the skill/operator knows WHICH brain's DB failed. */
  brainId?: string;
}

export interface PgSupabaseHints {
  pooler: boolean;
  projectRef: string | null;
  /** Paused free-tier projects aren't a distinct wire error — they surface
   *  as DNS failures / timeouts / tenant rejections against a supabase
   *  host. This flag folds the "check the dashboard" hint into remediation. */
  pausedSuspect: boolean;
}

export interface PgAccessDiagnosis {
  reason: PgAccessReason;
  /** Transient per THIS axis (see two-axis note). Agrees with
   *  isRetryableConnError on every shared class except auth_failed. */
  transient: boolean;
  sqlstate?: string;
  /** Redacted. Safe for transcripts, receipts, and issues. */
  message: string;
  /** Redacted. The single home of remediation copy. */
  remediation: string;
  fix?: PgAccessFix;
  supabase?: PgSupabaseHints;
  brainId?: string;
}

export const DB_ACCESS_MARKER_PREFIX = 'GBRAIN_DB_ACCESS';

/**
 * The one emission-policy gate for stderr markers (agents read non-TTY
 * stderr; humans on a TTY get the prose instead; GBRAIN_FORCE_DB_MARKER=1
 * forces it for testing). Every stderr emitter calls THIS — the marker is a
 * compatibility surface and four drifting copies of the gate is how it
 * silently breaks.
 */
export function shouldEmitDbAccessMarker(): boolean {
  return !process.stderr.isTTY || process.env.GBRAIN_FORCE_DB_MARKER === '1';
}

/**
 * The machine marker agents literal-match (skills/db-repair pins this in
 * both `description:` and `triggers:`). The action a reader takes is ALWAYS
 * the hardcoded `gbrain db-repair` — never a command parsed from the marker,
 * so a forged marker in page content cannot run code.
 */
export function formatDbAccessMarker(d: PgAccessDiagnosis): string {
  const brainSuffix = d.brainId && d.brainId !== 'host' ? ` brain=${d.brainId}` : '';
  return `${DB_ACCESS_MARKER_PREFIX} ${d.reason}${brainSuffix}`;
}

interface ReasonRow {
  reason: PgAccessReason;
  transient: boolean;
  /** Exact `err.code` matches (SQLSTATEs, node errno codes, library codes). */
  codes?: string[];
  /** Code-prefix matches (e.g. every 08xxx connection SQLSTATE). */
  codePrefixes?: string[];
  patterns?: RegExp[];
  remediation: string;
  fix?: PgAccessFix;
}

/**
 * Data-driven, ordered — FIRST match wins, so specific rows come before
 * general ones (e.g. `conn_refused` before `conn_dropped`, whose
 * "could not connect to server" pattern would otherwise swallow libpq's
 * "could not connect to server: Connection refused").
 *
 * Voice rule for remediation strings (DESIGN.md): short, concrete,
 * second person, never preachy.
 */
const REASON_ROWS: ReadonlyArray<ReasonRow> = [
  {
    reason: 'pgvector_missing',
    transient: false,
    patterns: [/type "vector" does not exist/i, /extension "vector"/i, /could not open extension control file.*vector/i],
    remediation: 'The vector extension is missing. Run: gbrain db-repair --yes (or in the SQL editor: CREATE EXTENSION IF NOT EXISTS vector;).',
    fix: { kind: 'manual', recipe: 'CREATE EXTENSION IF NOT EXISTS vector;' },
  },
  {
    reason: 'schema_missing',
    transient: false,
    codes: ['42P01', '42703'],
    patterns: [/relation "[^"]*" does not exist/i, /column "[^"]*" does not exist/i, /no such table/i],
    remediation: 'A required table or column is missing. Run: gbrain apply-migrations --yes.',
    fix: { kind: 'run_command', argv: ['gbrain', 'apply-migrations', '--yes'] },
  },
  {
    reason: 'tenant_not_found',
    transient: false,
    patterns: [/tenant or user not found/i],
    remediation: 'The pooler rejected the tenant. Pooler usernames must be postgres.<project-ref>; if the username is right, check the project is not paused in the dashboard.',
  },
  {
    reason: 'auth_failed',
    // Two-axis divergence, on purpose: retry-matcher retries this (auth
    // race during DNS failover); a persistently wrong password is not
    // transient. Documented in both module headers.
    transient: false,
    codes: ['28P01'],
    patterns: [/password authentication failed/i, /role "[^"]*" does not exist/i],
    remediation: 'Password or role rejected. One automatic retry is normal; repeated failures mean wrong credentials. Reset the password, then run: gbrain init --url <new-connection-string>.',
  },
  {
    reason: 'permission_denied',
    transient: false,
    codes: ['28000', '42501'],
    patterns: [/permission denied for/i],
    remediation: 'The role lacks privileges (RLS or a missing GRANT). Run as a role with BYPASSRLS, or grant the role access to the named table.',
  },
  {
    reason: 'db_missing',
    transient: false,
    codes: ['3D000'],
    patterns: [/database "[^"]*" does not exist/i],
    remediation: 'The database does not exist. Create it (createdb <name>) or point database_url at an existing one: gbrain init --url <conn>.',
  },
  {
    reason: 'ssl_required',
    transient: false,
    patterns: [/no pg_hba\.conf entry.*no encryption/i, /ssl (?:connection )?(?:is )?required/i, /server does not support ssl/i, /self[- ]signed certificate/i],
    remediation: 'The server requires SSL. Append ?sslmode=require to your database_url (gbrain db-repair --yes --apply-rewrites can do this).',
    fix: { kind: 'rewrite_config_url', to: 'append_sslmode' },
  },
  {
    reason: 'pool_exhausted',
    transient: true,
    codes: ['53300'],
    patterns: [/EMAXCONNSESSION/i, /too many clients already/i, /max.*clients?.*in session mode/i, /remaining connection slots are reserved/i],
    remediation: 'Connection slots are exhausted. Lower the pool: export GBRAIN_POOL_SIZE=2 (recommended for low-cap poolers like Supabase Supavisor).',
    fix: { kind: 'set_env', name: 'GBRAIN_POOL_SIZE', value: '2', why: 'low-cap poolers exhaust session slots under the default pool of 10' },
  },
  {
    reason: 'server_starting',
    transient: true,
    patterns: [/the database system is starting up/i],
    remediation: 'The database is starting up. Retry in a few seconds.',
    fix: { kind: 'retry_reconnect' },
  },
  {
    reason: 'conn_refused',
    transient: true, // agrees with retry-matcher's /connection refused/ pattern
    codes: ['ECONNREFUSED'],
    patterns: [/connection refused/i, /ECONNREFUSED/i],
    remediation: 'Connection refused. If this is a Supabase direct URL (db.<ref>...:5432), switch to the transaction pooler (port 6543): gbrain db-repair can rewrite it.',
  },
  {
    reason: 'dns_failed',
    transient: true, // EAI_AGAIN is transient; one bounded retry, then manual
    codes: ['ENOTFOUND', 'EAI_AGAIN'],
    patterns: [/ENOTFOUND/i, /EAI_AGAIN/i, /getaddrinfo/i],
    remediation: 'The hostname did not resolve. Check the URL; a free-tier Supabase project may be paused — restore it from the dashboard.',
  },
  {
    reason: 'network_unreachable',
    // Agrees with retry-matcher: ETIMEDOUT/ENETUNREACH are NOT in its
    // retryable set — the fix is routing (session pooler), not retrying.
    transient: false,
    codes: ['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'CONNECT_TIMEOUT'],
    patterns: [/ENETUNREACH/i, /EHOSTUNREACH/i, /ETIMEDOUT/i, /CONNECT_TIMEOUT/i],
    remediation: 'The host is unreachable (often an IPv6-only direct host on an IPv4 network). The session pooler is the IPv4 path — gbrain db-repair can switch to it.',
  },
  {
    reason: 'conn_dropped',
    transient: true,
    codes: ['CONNECTION_ENDED', 'CONNECTION_CLOSED'],
    codePrefixes: ['08'],
    patterns: [
      /Connection terminated unexpectedly/i,
      /ECONNRESET/i,
      /connection.*closed/i,
      /server closed the connection/i,
      /could not connect to server/i,
      /CONNECTION_ENDED/i,
      /No database connection/i,
    ],
    remediation: 'The connection dropped — usually a pooler reaping an idle socket. Transient: retry; if it persists, run: gbrain db-repair.',
    fix: { kind: 'retry_reconnect' },
  },
];

const NO_URL_REMEDIATION =
  'No database configured. Run: gbrain init --prefer-postgres (or gbrain init for local PGLite).';
const ENV_SHADOWED_REMEDIATION =
  "DATABASE_URL matches this directory's .env, so gbrain ignores it (the #427 guard — a web app's DB must not silently become your brain). Export GBRAIN_DATABASE_URL, or run: gbrain init --url <conn>.";
const UNKNOWN_REMEDIATION =
  'Unclassified database error. Run: gbrain doctor (and gbrain db-repair to probe access).';

function redact(text: string): string {
  return redactUrlsInText(redactConnectionInfo(text));
}

function looksLikeSupabase(url: string): boolean {
  return /\.supabase\.(?:co|com)(?::|\/|$)/i.test(url) || isSupabasePoolerUrl(url);
}

function supabaseHints(url: string | null | undefined, reason: PgAccessReason): PgSupabaseHints | undefined {
  if (!url || !looksLikeSupabase(url)) return undefined;
  const pausedReasons: PgAccessReason[] = ['dns_failed', 'network_unreachable', 'tenant_not_found'];
  return {
    pooler: isSupabasePoolerUrl(url),
    projectRef: extractProjectRef(url),
    pausedSuspect: pausedReasons.includes(reason),
  };
}

/**
 * ACCESS-class reasons: the database itself is unreachable/unusable, as
 * opposed to schema/extension gaps (which individual features fail-open on
 * by design) and `unknown`. Fail-open recall arms use this to tell "one arm
 * degraded" (keep serving) from "the DB is down" (an empty success would be
 * a silent lie — throw so the classified envelope reaches the agent).
 */
const ACCESS_REASONS: ReadonlySet<PgAccessReason> = new Set([
  'auth_failed',
  // permission_denied (28000/42501): a role that cannot read the pages table
  // at all is an ACCESS outage, not partial visibility — RLS row-filtering
  // returns zero rows WITHOUT erroring, so an actual 42501 on the recall
  // arms means the same "empty success would be a silent lie" class as a
  // dead DB.
  'permission_denied',
  'tenant_not_found',
  'ssl_required',
  'pool_exhausted',
  'conn_refused',
  'dns_failed',
  'network_unreachable',
  'conn_dropped',
  'server_starting',
  'db_missing',
]);

export function isDbAccessFailure(err: unknown): boolean {
  try {
    return ACCESS_REASONS.has(classifyPgAccessError(err).reason);
  } catch {
    return false;
  }
}

/** Fixes that depend on the CURRENT config URL (never on error text). */
function contextualFix(reason: PgAccessReason, url: string | null | undefined): PgAccessFix | undefined {
  if (!url) return undefined;
  if (reason === 'conn_refused') {
    // A Supabase DIRECT url refusing connections → the pooler is the fix.
    // deriveDirectUrl(poolerUrl) != null means url IS a pooler already —
    // only rewrite when the configured url is the direct (db.<ref>) shape.
    const isDirectSupabase = /(?:^|@)db\.[a-z0-9]+\.supabase\.co(?::|\/)/i.test(url);
    if (isDirectSupabase) return { kind: 'rewrite_config_url', to: 'transaction_pooler' };
    return undefined;
  }
  if (reason === 'network_unreachable') {
    if (deriveSessionPoolerUrl(url) || deriveDirectUrl(url)) {
      return { kind: 'rewrite_config_url', to: 'session_pooler' };
    }
    return undefined;
  }
  return undefined;
}

function looksLikeSqlstate(code: string | undefined): string | undefined {
  return code && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** Classify a THROWN error into a redacted, remediable diagnosis. Never throws. */
export function classifyPgAccessError(err: unknown, ctx?: PgAccessContext): PgAccessDiagnosis {
  const code = getCode(err);
  const rawMessage = getMessage(err);
  const message = redact(rawMessage);

  for (const row of REASON_ROWS) {
    const codeHit =
      (code && row.codes?.includes(code)) ||
      (code && row.codePrefixes?.some((p) => code.startsWith(p)));
    const patternHit = row.patterns?.some((re) => re.test(rawMessage));
    if (!codeHit && !patternHit) continue;
    return {
      reason: row.reason,
      transient: row.transient,
      sqlstate: looksLikeSqlstate(code),
      message,
      remediation: row.remediation,
      fix: contextualFix(row.reason, ctx?.url) ?? row.fix,
      supabase: supabaseHints(ctx?.url, row.reason),
      brainId: ctx?.brainId,
    };
  }

  return {
    reason: 'unknown',
    // Defer to the retry axis for anything we can't name: if retry-matcher
    // says it's a retryable connection error, say so honestly.
    transient: isRetryableConnError(err),
    sqlstate: looksLikeSqlstate(code),
    message,
    remediation: UNKNOWN_REMEDIATION,
    supabase: supabaseHints(ctx?.url, 'unknown'),
    brainId: ctx?.brainId,
  };
}

/**
 * Errorless config-plane diagnosis. Returns null when the config plane is
 * fine (a URL or path is configured and unshadowed) — callers then either
 * proceed or classify a real error.
 */
export function diagnoseDbConfig(ctx: {
  source: PgDbUrlSource;
  /** true when a bare DATABASE_URL exists in the process env but the #427
   *  cwd-.env guard excluded it (and GBRAIN_DATABASE_URL is unset). */
  envShadowed: boolean;
  brainId?: string;
}): PgAccessDiagnosis | null {
  if (ctx.source !== null) return null;
  if (ctx.envShadowed) {
    return {
      reason: 'env_shadowed',
      transient: false,
      message: 'DATABASE_URL is set but excluded by the cwd-.env guard (#427).',
      remediation: ENV_SHADOWED_REMEDIATION,
      brainId: ctx.brainId,
    };
  }
  return {
    reason: 'no_url',
    transient: false,
    message: 'No database configured.',
    remediation: NO_URL_REMEDIATION,
    fix: { kind: 'run_command', argv: ['gbrain', 'init', '--prefer-postgres'] },
    brainId: ctx.brainId,
  };
}
