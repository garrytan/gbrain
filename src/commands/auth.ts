#!/usr/bin/env bun
/**
 * GBrain token management.
 *
 * Wired into the CLI as of v0.22.5:
 *   gbrain auth create "claude-desktop"
 *   gbrain auth list
 *   gbrain auth revoke "claude-desktop"
 *   gbrain auth test <url> --token <token>
 *
 * Also runs standalone (no compiled binary required):
 *   DATABASE_URL=... bun run src/commands/auth.ts create "claude-desktop"
 *
 * DB-backed commands route through the active BrainEngine (PGLite or
 * Postgres), so they work regardless of which engine the user's brain is
 * configured for. The env-var DATABASE_URL / GBRAIN_DATABASE_URL still
 * picks Postgres via loadConfig() (config.ts DbUrlSource inference),
 * but the SQL itself goes through engine.executeRaw — never through a
 * postgres.js singleton. `test` only hits a remote URL and doesn't need
 * a local DB.
 */
import { createHash } from 'crypto';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { assertAllowedScopes } from '../core/scope.ts';
import { isTrustTier, TRUST_TIERS, type TrustTier } from '../core/trust/tier.ts';
import { setMinTrust, setTokenMinTrust } from '../core/trust/min-trust.ts';
import { generateToken, isUndefinedColumnError, isUndefinedTableError } from '../core/utils.ts';
import { TOKEN_ID_RE, insertUnifiedToken } from '../core/token-mint.ts';
import { normalizeTokenScopes } from '../core/legacy-token-scope.ts';
import { sqlQueryForEngine, type SqlQuery } from '../core/sql-query.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile, type GrantPatch } from '../core/grants/service.ts';
import { parseClientRescopeArgs, parseRescopeGrantArgs, splitRescopeTarget, type RescopeGrantArgs } from '../core/grants/cli.ts';
import { GRANT_PROFILES, GrantError, TOKEN_TTL_MAX_SECONDS, TOKEN_TTL_MIN_SECONDS, grantFromClient } from '../core/grants/model.ts';
import { cliRenderContext, renderAction, type RenderedAction } from '../core/agent-output.ts';
import { migrateLegacyTokens, parseRescopeTokenArgs, renderLegacyGrantAxis, rescopeLegacyToken, resolveRescopeTarget, type MigrateLegacyResult, type RescopeTokenResult } from '../core/grants/legacy-token.ts';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Acquire an engine from the active config, run `fn` with a SqlQuery, and
 * disconnect afterward. Loud-fails when no config is present (matches the
 * prior behavior of getDatabaseUrl(requireDb=true) — auth commands need a
 * brain to write to).
 */
async function withConfiguredSql<T>(
  fn: (sql: SqlQuery, engine: BrainEngine) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  if (!config) {
    console.error('No GBrain config found. Run `gbrain init` first, or set DATABASE_URL / GBRAIN_DATABASE_URL.');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  // v0.32: createEngine returns a disconnected instance. PostgresEngine's `sql`
  // getter falls back to `db.getConnection()` (the module-level singleton)
  // when `_sql` is unset, which throws "connect() has not been called" when
  // db.connect() was never invoked either. Auth commands never go through
  // cli.ts's connectEngine() path (early-routed at cli.ts:685), so we must
  // connect the engine here. Without this call, every auth subcommand
  // (create/list/revoke/register-client/revoke-client) crashes with the
  // misleading "No database connection" error.
  await engine.connect(engineConfig);
  const sql = sqlQueryForEngine(engine);
  try {
    return await fn(sql, engine);
  } finally {
    await engine.disconnect();
  }
}

async function create(name: string, opts: { takesHolders?: string[]; scopes?: string[]; minTrust?: TrustTier } = {}) {
  if (!name) { console.error('Usage: auth create <name> [--takes-holders world,garry] [--scopes read,write] [--min-trust <tier>]'); process.exit(1); }
  // #4043 least-privilege: validate scopes at mint time — the verify path
  // treats a filtered-empty scopes array as DENY, so a typo must fail loudly
  // here, never silently brick (or widen) the token.
  if (opts.scopes !== undefined) {
    try {
      if (opts.scopes.length === 0) throw new Error('at least one scope is required');
      assertAllowedScopes(opts.scopes);
    } catch (e: any) {
      console.error(`Invalid --scopes: ${e.message}`);
      process.exit(1);
    }
  }
  const token = generateToken('gbrain_');
  const hash = hashToken(token);

  try {
    await withConfiguredSql(async (_sql, engine) => {
      // v0.28: persist per-token takes-holder allow-list. Default ['world'] keeps
      // private hunches hidden from MCP-bound tokens.
      const takesHolders = opts.takesHolders && opts.takesHolders.length > 0
        ? opts.takesHolders
        : ['world'];
      // F3: the token is born on the unified grant shape (columns + the
      // permissions JSONB mirror older binaries read). Scopes land in the
      // original-schema scopes TEXT[] column; omitted → NULL → the historical
      // grandfathered full-access grant.
      const [row] = await insertUnifiedToken(engine, {
        name, tokenHash: hash, ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
        grant: { sources: { kind: 'default' }, takesHolders, allowedOperations: null },
      });
      // #5575 (CEO-18): the read floor; the CLI is the only writer of it.
      if (opts.minTrust) await setTokenMinTrust(engine, row!.id, opts.minTrust);
      const scopeLine = opts.scopes !== undefined
        ? `scopes=${JSON.stringify(opts.scopes)}`
        : 'scopes=full access (grandfathered — pass --scopes read,write to narrow)';
      console.log(`Token created for "${name}" (takes_holders=${JSON.stringify(takesHolders)}, ${scopeLine}${opts.minTrust ? `, min_trust=${opts.minTrust}` : ''}):\n`);
      console.log(`  ${token}\n`);
      console.log('Save this token — it will not be shown again.');
      console.log(`Revoke with: gbrain auth revoke "${name}" (or gbrain auth revoke --id <id> from auth list)`);
      console.log(`Change its grants: gbrain auth rescope --token "${name}" --takes-holders world,garry (or --sources, --operations)`);
    });
  } catch (e: any) {
    if (e.code === '23505') {
      console.error(`A token named "${name}" already exists. Revoke it first or use a different name.`);
    } else {
      console.error('Error:', e.message);
    }
    process.exit(1);
  }
}

/** `auth set-min-trust <client|token> <tier|none>` (#5575, CEO-18): local-only, the one way to change a read floor. */
async function setMinTrustCmd(rest: string[]) {
  const [target, value] = rest.filter(a => !a.startsWith('--'));
  if (!target || !value || (value !== 'none' && !isTrustTier(value))) {
    console.error(`Usage: auth set-min-trust <client_id|token id|token name> <${TRUST_TIERS.join('|')}|none>`);
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (_sql, engine) => {
      const change = await setMinTrust(engine, target, value === 'none' ? null : value as TrustTier);
      if (rest.includes('--json')) { console.log(JSON.stringify(change)); return; }
      console.log(`${change.kind === 'oauth_client' ? 'OAuth client' : 'Token'} "${change.name}" (${change.id}): min_trust ${change.before ?? 'none'} -> ${change.after ?? 'none'}.`);
      console.log('Applies on its next request: reads never return rows below this tier, whatever min_trust the client asks for.');
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

/** `auth permissions <name> set-takes-holders <list>`: alias of `auth rescope --token <name> --takes-holders <list>`. */
async function permissions(name: string, action: string, value: string | undefined) {
  if (!name || action !== 'set-takes-holders' || !value) {
    console.error('Usage: auth permissions <name> set-takes-holders world,garry,brain  (alias of: gbrain auth rescope --token <name> --takes-holders <list>)');
    process.exit(1);
  }
  await runRescope(['--token', name, '--takes-holders', value]);
}

/** Render a token row's scope grant honestly (#4043: NULL = grandfathered).
 * Routes through the SAME normalizer the verify path uses — the ops surface
 * must never claim admin on a row the serve actually scopes or denies. */
export function renderTokenScopes(scopes: unknown): string {
  const normalized = normalizeTokenScopes(scopes);
  if (normalized === undefined) return 'admin (grandfathered)';
  if (normalized.length === 0) return '(deny-all)';
  return normalized.join(',');
}

async function list() {
  await withConfiguredSql(async (sql) => {
    const rows = await sql`
      SELECT id, name, scopes, created_at, last_used_at, revoked_at
      FROM access_tokens
      ORDER BY created_at DESC
    `;
    if (rows.length === 0) {
      console.log('No tokens found. Create one: gbrain auth create "my-client"');
      return;
    }
    console.log('ID                                    Name                  Scopes                 Created              Last Used            Status');
    console.log('─'.repeat(126));
    for (const r of rows) {
      const id = String(r.id).padEnd(36);
      const name = (r.name as string).padEnd(20);
      const scopes = renderTokenScopes(r.scopes).padEnd(21);
      const created = new Date(r.created_at as string).toISOString().slice(0, 19);
      const lastUsed = r.last_used_at ? new Date(r.last_used_at as string).toISOString().slice(0, 19) : 'never'.padEnd(19);
      const status = r.revoked_at ? 'REVOKED' : 'active';
      console.log(`${id}  ${name}  ${scopes}  ${created}  ${lastUsed}  ${status}`);
    }
  });
}

async function revoke(name: string) {
  if (!name) { console.error('Usage: auth revoke <name> | auth revoke --id <uuid>'); process.exit(1); }
  await withConfiguredSql(async (sql) => {
    const rows = await sql`
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = ${name} AND revoked_at IS NULL
      RETURNING 1
    `;
    if (rows.length === 0) {
      console.error(`No active token found with name "${name}".`);
      process.exit(1);
    }
    if (rows.length > 1) {
      console.log(`Note: ${rows.length} active tokens carried the name "${name}" — all revoked. Use revoke --id for precision.`);
    }
    console.log(`Token "${name}" revoked.`);
  });
}

/** #4043: names are not unique — revoke-by-id is the precise path. The
 * revocation semantics are canonical in src/core/token-mint.ts
 * (revokeLegacyTokenById); this CLI wrapper keeps its own UPDATE only to
 * RETURN the name for the confirmation line — keep the two in lockstep. */
async function revokeById(id: string) {
  if (!id || !TOKEN_ID_RE.test(id)) {
    console.error('Usage: auth revoke --id <uuid>   (ids are shown by `gbrain auth list`)');
    process.exit(1);
  }
  await withConfiguredSql(async (sql) => {
    const rows = await sql`
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = ${id}::uuid AND revoked_at IS NULL
      RETURNING name
    `;
    if (rows.length === 0) {
      console.error(`No active token found with id "${id}".`);
      process.exit(1);
    }
    console.log(`Token "${rows[0].name}" (${id}) revoked.`);
  });
}

async function test(url: string, token: string) {
  if (!url || !token) {
    console.error('Usage: auth test <url> --token <token>');
    process.exit(1);
  }

  const startTime = Date.now();
  console.log(`Testing MCP server at ${url}...\n`);

  // Step 1: Initialize
  try {
    const initRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'gbrain-smoke-test', version: '1.0' },
        },
        id: 1,
      }),
    });

    if (!initRes.ok) {
      console.error(`  Initialize failed: ${initRes.status} ${initRes.statusText}`);
      const body = await initRes.text();
      if (body) console.error(`  ${body}`);
      process.exit(1);
    }
    console.log('  ✓ Initialize handshake');
  } catch (e: any) {
    console.error(`  ✗ Connection failed: ${e.message}`);
    process.exit(1);
  }

  // Step 2: List tools
  try {
    const listRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 2,
      }),
    });

    if (!listRes.ok) {
      console.error(`  ✗ tools/list failed: ${listRes.status}`);
      process.exit(1);
    }

    const text = await listRes.text();
    // Parse SSE or JSON response
    let toolCount = 0;
    if (text.includes('event:')) {
      // SSE format: extract data lines
      const dataLines = text.split('\n').filter(l => l.startsWith('data:'));
      for (const line of dataLines) {
        try {
          const data = JSON.parse(line.slice(5));
          if (data.result?.tools) toolCount = data.result.tools.length;
        } catch { /* skip non-JSON lines */ }
      }
    } else {
      try {
        const data = JSON.parse(text);
        toolCount = data.result?.tools?.length || 0;
      } catch { /* parse error */ }
    }

    console.log(`  ✓ tools/list: ${toolCount} tools available`);
  } catch (e: any) {
    console.error(`  ✗ tools/list failed: ${e.message}`);
    process.exit(1);
  }

  // Step 3: Call get_stats (real tool call)
  try {
    const statsRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_stats', arguments: {} },
        id: 3,
      }),
    });

    if (!statsRes.ok) {
      console.error(`  ✗ get_stats failed: ${statsRes.status}`);
      process.exit(1);
    }
    console.log('  ✓ get_stats: brain is responding');
  } catch (e: any) {
    console.error(`  ✗ get_stats failed: ${e.message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🧠 Your brain is live! (${elapsed}s)`);
}

async function revokeClient(clientId: string) {
  if (!clientId) {
    console.error('Usage: auth revoke-client <client_id>');
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql) => {
      // Atomic single-statement delete: no race window between count + delete.
      // Postgres cascades to oauth_tokens and oauth_codes (FK ON DELETE CASCADE
      // declared in src/schema.sql:370,382) before the transaction commits.
      const rows = await sql`
        DELETE FROM oauth_clients WHERE client_id = ${clientId}
        RETURNING client_id, client_name
      `;
      if (rows.length === 0) {
        console.error(`No client found with id "${clientId}"`);
        process.exit(1);
      }
      console.log(`OAuth client revoked: "${rows[0].client_name}" (${clientId})`);
      console.log('Tokens and authorization codes purged via cascade.');
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

/**
 * Parse `gbrain auth register-client` argv. Walks the array once instead of
 * the prior `indexOf`-based pattern which (a) silently took only the FIRST
 * occurrence of a repeatable flag (defeated `--redirect-uri https://a
 * --redirect-uri https://b` — only `https://a` made it through), and (b)
 * accepted bare values via lookahead even when adjacent to another flag.
 *
 * v0.41.3 (T3): proper loop-based parser so `--redirect-uri` is repeatable,
 * and `--token-endpoint-auth-method` is recognized. Repeatable flags
 * accumulate into arrays. Unknown flags throw a usage error.
 */
export interface RegisterClientArgs {
  grantTypes: string[];
  scopes: string;
  sourceId: string;
  federatedRead: string[] | undefined;
  redirectUris: string[];
  tokenEndpointAuthMethod: string | undefined;
  boundTools: string[] | undefined;
  delegatedSlugPrefixes?: string[] | null;
  delegatedNamespace?: 'prefixes' | 'job';
  boundSourceId: string | undefined;
  boundBrainId: string | undefined;
  boundSlugPrefixes: string[] | undefined;
  boundMaxConcurrent: number | undefined;
  budgetUsdPerDay: string | null | undefined;
  tokenTtlSeconds: number | undefined;
}

/** --token-ttl bounds: 1 minute .. 90 days (defined in src/core/grants/model.ts). The SERVER default for CLI-minted
 * access tokens is 3600s (oauth-provider.ts tokenTtl) — NOT 30 days; callers
 * that promise long-lived tokens must write oauth_clients.token_ttl. */
export { TOKEN_TTL_MIN_SECONDS, TOKEN_TTL_MAX_SECONDS };

/**
 * Shared --token-ttl value parser (auth register-client + agent register).
 * `hint` is the parser-specific tail naming what omitting the flag means
 * (the two commands have different defaults). Throws the canonical bounds
 * message on anything outside [TOKEN_TTL_MIN_SECONDS, TOKEN_TTL_MAX_SECONDS].
 */
export function parseTokenTtl(raw: string, hint: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < TOKEN_TTL_MIN_SECONDS || v > TOKEN_TTL_MAX_SECONDS) {
    throw new Error(
      `--token-ttl must be an integer number of seconds between ${TOKEN_TTL_MIN_SECONDS} and ${TOKEN_TTL_MAX_SECONDS} (90 days); got ${JSON.stringify(raw)}. ${hint}`,
    );
  }
  return v;
}

export function parseRegisterClientArgs(args: string[]): RegisterClientArgs {
  const out: RegisterClientArgs = {
    grantTypes: ['client_credentials'],
    scopes: 'read',
    sourceId: 'default',
    federatedRead: undefined,
    redirectUris: [],
    tokenEndpointAuthMethod: undefined,
    boundTools: undefined,
    boundSourceId: undefined,
    boundBrainId: undefined,
    boundSlugPrefixes: undefined,
    boundMaxConcurrent: undefined,
    budgetUsdPerDay: undefined,
    tokenTtlSeconds: undefined,
  };
  let i = 0;
  let grantTypesSet = false;
  while (i < args.length) {
    const flag = args[i];
    const value = args[i + 1];
    const requireValue = () => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    };
    switch (flag) {
      case '--grant-types': {
        const v = requireValue();
        out.grantTypes = v.split(',').map(s => s.trim()).filter(Boolean);
        grantTypesSet = out.grantTypes.length > 0;
        i += 2;
        break;
      }
      case '--scopes': {
        // v0.42.x: accept comma-separated input (`--scopes read,write,admin`)
        // in addition to the space-separated OAuth wire form
        // (`--scopes "read write admin"`). init.ts's own registration hint
        // (line ~730) recommends the comma form, but the parser previously
        // only split on whitespace, so a comma-joined string fell through
        // as a single unrecognized token and registerClientManual's
        // assertAllowedScopes rejected it as `Unknown scope
        // "read,write,admin"` — self-contradicting the hint. Normalizing
        // here (rather than in the shared parseScopeString) keeps that
        // function's OAuth-wire-format (RFC 6749 space-delimited) contract
        // intact for DCR/refresh/request-scope parsing, which stays
        // comma-agnostic on purpose.
        const v = requireValue();
        const normalized = v.split(/[\s,]+/).filter(Boolean).join(' ');
        // Zero-token input (`--scopes ","`, `--scopes ",,,"`, `--scopes "  "`,
        // `--scopes ""`) collapses to an empty string under the split above.
        // parseScopeString('') returns [] downstream, and
        // assertAllowedScopes([]) passes vacuously on an empty list — so
        // without this guard, registerClientManual would silently register
        // a client with no usable scopes instead of reporting malformed
        // input. Reject here, at the parser boundary, with a clear message
        // rather than relying on whatever downstream error the raw string
        // happens to produce.
        if (!normalized) {
          throw new Error(`--scopes requires at least one scope (got ${JSON.stringify(v)})`);
        }
        out.scopes = normalized;
        i += 2; break;
      }
      case '--source': out.sourceId = requireValue(); i += 2; break;
      case '--federated-read': {
        const v = requireValue();
        out.federatedRead = v.split(',').map(s => s.trim()).filter(Boolean);
        i += 2; break;
      }
      case '--redirect-uri':
        out.redirectUris.push(requireValue());
        i += 2; break;
      case '--token-endpoint-auth-method':
        out.tokenEndpointAuthMethod = requireValue();
        i += 2; break;
      case '--bound-tools': {
        const v = requireValue();
        out.boundTools = v.split(',').map(s => s.trim()).filter(Boolean);
        if (out.boundTools.length === 0) throw new Error('--bound-tools requires at least one tool name');
        i += 2; break;
      }
      case '--delegated-slug-prefixes': out.delegatedSlugPrefixes = requireValue().split(',').map(s => s.trim()).filter(Boolean); i += 2; break;
      case '--delegated-namespace': {
        const value = requireValue();
        if (value !== 'job' && value !== 'prefixes') throw new Error('--delegated-namespace must be job or prefixes');
        out.delegatedNamespace = value;
        i += 2; break;
      }
      case '--bound-source': out.boundSourceId = requireValue(); i += 2; break;
      case '--bound-brain': out.boundBrainId = requireValue(); i += 2; break;
      case '--bound-slug-prefixes': {
        const v = requireValue();
        out.boundSlugPrefixes = v.split(',').map(s => s.trim()).filter(Boolean);
        i += 2; break;
      }
      case '--bound-max-concurrent': {
        const v = Number(requireValue());
        if (!Number.isInteger(v) || v < 1) {
          throw new Error('--bound-max-concurrent must be a positive integer');
        }
        out.boundMaxConcurrent = v;
        i += 2; break;
      }
      case '--budget-usd-per-day': {
        const v = requireValue();
        if (v !== 'unlimited' && !/^\d+(?:\.\d{1,2})?$/.test(v)) {
          throw new Error('--budget-usd-per-day must be a non-negative decimal with at most 2 decimal places');
        }
        out.budgetUsdPerDay = v === 'unlimited' ? null : v;
        i += 2; break;
      }
      case '--token-ttl': {
        out.tokenTtlSeconds = parseTokenTtl(requireValue(), 'Omit the flag to keep the server default.');
        i += 2; break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  // v0.41.3: if --grant-types not explicitly set and any --redirect-uri was
  // passed, infer authorization_code + refresh_token. The single-flag path
  // (just --redirect-uri ...) is the SECURITY.md-recommended pre-registration
  // pattern; making operators redundantly pass `--grant-types` is footgun.
  if (!grantTypesSet && out.redirectUris.length > 0) {
    out.grantTypes = ['authorization_code', 'refresh_token'];
  }
  return out;
}

/**
 * Column pre-flight (cathedral-6): decide statement shapes BEFORE any
 * transaction. Postgres/PGLite abort the whole tx on any statement error
 * (25P02) and SqlQuery has no savepoint seam, so "catch 42703 and continue"
 * is impossible inside a tx — optional-column degrades must be decided here,
 * outside, once.
 */
export async function preflightOauthClientColumns(sql: SqlQuery): Promise<Set<string>> {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `;
  return new Set(rows.map(r => String(r.column_name)));
}

export interface RegisterScopedClientOpts {
  /** Explicit normalized profile snapshot; old callers keep legacy operation grants. */
  grant?: GrantPatch;
  /** Per-client access-token TTL to persist (oauth_clients.token_ttl). */
  tokenTtlSeconds?: number;
  /** Per-client tool-surface tier, written via provider.rescopeClient — the
   * ONLY surface-column writer (sets surface_set_by='operator', the lock
   * request_tools cannot override). Never a raw column UPDATE. */
  surface?: 'verbs' | 'starter' | 'full';
  /** Result of preflightOauthClientColumns — decides which optional-column
   * writes are attempted. Absent → attempt everything (caller owns errors). */
  columns?: Set<string>;
}

/**
 * The data a scoped-client registration produces — everything a printer
 * (auth register-client's byte-pinned block, agent register's summary,
 * or the admin HTTP route) needs, with ZERO console output produced here.
 */
export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  grantTypes: string[];
  scopes: string;
  authMethod: string;
  redirectUris: string[];
  sourceId: string;
  federatedRead: string[];
  surface?: 'verbs' | 'starter' | 'full';
  tokenTtl?: number;
  created: { source: boolean };
  /** Previous surface row value when opts.surface was written (for the
   * post-commit audit row — audit is fail-open and NEVER runs in the tx). */
  surfaceOld?: string | null;
  /** Optional-column writes skipped by the pre-flight (pre-migration brain). */
  skipped?: { tokenTtl?: boolean; surface?: boolean };
}

/**
 * Exit-free, print-free registration core (cathedral-6 seam). Named
 * registerScopedClient — not run*Core — because unlike the other peels it
 * returns data instead of printing. Takes an INJECTED SqlQuery handle:
 * callers on the engine-bound CLI lane pass the dispatcher's engine's sql
 * (a second withConfiguredSql engine self-deadlocks PGLite's single-writer
 * lock); `registerClient` below keeps withConfiguredSql for the
 * early-routed auth lane. Throws on failure — the thin callers own
 * exit/print mapping.
 */
export async function registerScopedClient(
  sql: SqlQuery,
  name: string,
  parsed: RegisterClientArgs,
  opts: RegisterScopedClientOpts = {},
): Promise<RegisteredClient> {
  const { grantTypes, scopes, sourceId, federatedRead, redirectUris, tokenEndpointAuthMethod } = parsed;
  const agentBindings = parsed.boundTools || parsed.boundSourceId || parsed.boundBrainId ||
    parsed.boundSlugPrefixes || parsed.boundMaxConcurrent !== undefined || parsed.budgetUsdPerDay !== undefined
    ? {
      boundTools: parsed.boundTools,
      delegatedSlugPrefixes: parsed.delegatedSlugPrefixes,
      delegatedNamespace: parsed.delegatedNamespace,
      boundSourceId: parsed.boundSourceId,
      boundBrainId: parsed.boundBrainId,
      boundSlugPrefixes: parsed.boundSlugPrefixes,
      boundMaxConcurrent: parsed.boundMaxConcurrent,
      budgetUsdPerDay: parsed.budgetUsdPerDay,
    }
    : undefined;
  const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
  const provider = new GBrainOAuthProvider({ sql });
  const { clientId, clientSecret } = await provider.registerClientManual(
    name, grantTypes, scopes, redirectUris, sourceId, federatedRead, tokenEndpointAuthMethod, agentBindings, opts.grant,
  );

  const ttl = parsed.tokenTtlSeconds ?? opts.tokenTtlSeconds;
  let tokenTtl: number | undefined;
  let ttlSkipped = false;
  if (ttl !== undefined) {
    if (opts.columns && !opts.columns.has('token_ttl')) {
      // Pre-migration brain: the degrade was decided by the pre-flight,
      // OUTSIDE any transaction — nothing here throws-and-continues.
      ttlSkipped = true;
    } else {
      const updated = await sql`
        UPDATE oauth_clients SET token_ttl = ${ttl}
        WHERE client_id = ${clientId}
        RETURNING client_id
      `;
      if (updated.length === 0) {
        throw new Error(`token_ttl update matched no row for client ${clientId}`);
      }
      tokenTtl = ttl;
    }
  }

  let surfaceApplied: 'verbs' | 'starter' | 'full' | undefined;
  let surfaceOld: string | null | undefined;
  let surfaceSkipped = false;
  if (opts.surface !== undefined) {
    if (opts.columns && !opts.columns.has('surface')) {
      surfaceSkipped = true;
    } else {
      const rescoped = await provider.rescopeClient(clientId, { surface: opts.surface });
      surfaceApplied = opts.surface;
      surfaceOld = rescoped.surfaceOld ?? null;
    }
  }

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    grantTypes,
    scopes,
    authMethod: tokenEndpointAuthMethod || 'client_secret_post',
    redirectUris,
    sourceId,
    federatedRead: federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId],
    ...(tokenTtl !== undefined ? { tokenTtl } : {}),
    ...(surfaceApplied !== undefined ? { surface: surfaceApplied } : {}),
    ...(surfaceOld !== undefined ? { surfaceOld } : {}),
    created: { source: false },
    ...(ttlSkipped || surfaceSkipped
      ? { skipped: { ...(ttlSkipped ? { tokenTtl: true } : {}), ...(surfaceSkipped ? { surface: true } : {}) } }
      : {}),
  };
}

/**
 * The exact lines `auth register-client` prints. BYTE-IDENTICAL contract:
 * connect.ts:defaultRegisterOAuthClient regex-scrapes `Client ID:` /
 * `Client Secret:` from this output in PRODUCTION, and 7+ e2e assertions pin
 * it — pinned by test/auth-register-client-output-pin.test.ts. Each array
 * element is one console.log call (embedded \n are intentional).
 */
export function formatRegisterClientOutput(name: string, r: RegisteredClient, parsed: RegisterClientArgs): string[] {
  const hasBindings = parsed.boundTools || parsed.boundSourceId || parsed.boundBrainId ||
    parsed.boundSlugPrefixes || parsed.boundMaxConcurrent !== undefined || parsed.budgetUsdPerDay !== undefined;
  const lines: string[] = [];
  lines.push(`OAuth client registered: "${name}"\n`);
  lines.push(`  Client ID:           ${r.clientId}`);
  if (r.clientSecret) {
    lines.push(`  Client Secret:       ${r.clientSecret}\n`);
  } else {
    lines.push(`  Client Secret:       <public client — none issued>\n`);
  }
  lines.push(`  Grant types:         ${r.grantTypes.join(', ')}`);
  lines.push(`  Scopes:              ${r.scopes}`);
  lines.push(`  Token auth method:   ${r.authMethod}`);
  if (r.redirectUris.length > 0) {
    lines.push(`  Redirect URIs:       ${r.redirectUris.join(', ')}`);
  }
  lines.push(`  Write source:        ${r.sourceId}`);
  lines.push(`  Federated reads:     ${r.federatedRead.join(', ')}`);
  if (hasBindings) {
    lines.push(`  Bound tools:         ${(parsed.boundTools ?? []).join(', ') || '<none>'}`);
    lines.push(`  Bound source:        ${parsed.boundSourceId ?? '<none>'}`);
    lines.push(`  Bound brain:         ${parsed.boundBrainId ?? '<none>'}`);
    lines.push(`  Bound slug prefixes:${parsed.boundSlugPrefixes ? ' ' + parsed.boundSlugPrefixes.join(', ') : ' <none>'}`);
    lines.push(`  Max concurrency:     ${parsed.boundMaxConcurrent ?? 1}`);
    lines.push(`  Daily budget USD:    ${parsed.budgetUsdPerDay ?? '<none>'}`);
  }
  lines.push('');
  if (r.clientSecret) {
    lines.push('Save the client secret — it will not be shown again.');
  } else {
    lines.push('Public client (PKCE-only) — no secret needed.');
  }
  lines.push(`Revoke with: gbrain auth revoke-client "${r.clientId}"`);
  return lines;
}

async function registerClient(name: string, args: string[]) {
  if (!name) {
    console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--source SOURCE] [--federated-read SRC1,SRC2,...] [--redirect-uri URI ...] [--token-endpoint-auth-method client_secret_post|client_secret_basic|none] [--bound-tools T1,T2] [--bound-source SOURCE] [--bound-brain BRAIN] [--bound-slug-prefixes P1,P2] [--bound-max-concurrent N] [--budget-usd-per-day USD] [--token-ttl SECONDS]');
    process.exit(1);
  }
  let parsed: RegisterClientArgs;
  try {
    parsed = parseRegisterClientArgs(args);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--source SOURCE] [--federated-read SRC1,SRC2,...] [--redirect-uri URI ...] [--token-endpoint-auth-method client_secret_post|client_secret_basic|none] [--bound-tools T1,T2] [--bound-source SOURCE] [--bound-brain BRAIN] [--bound-slug-prefixes P1,P2] [--bound-max-concurrent N] [--budget-usd-per-day USD] [--token-ttl SECONDS]');
    process.exit(1);
  }

  try {
    await withConfiguredSql(async (sql) => {
      const columns = parsed.tokenTtlSeconds !== undefined
        ? await preflightOauthClientColumns(sql)
        : undefined;
      const registered = await registerScopedClient(sql, name, parsed, { columns });
      if (registered.skipped?.tokenTtl) {
        console.error('Note: this brain predates the token_ttl column; run `gbrain apply-migrations --yes`, then rescope. The server default TTL applies.');
      }
      for (const line of formatRegisterClientOutput(name, registered, parsed)) {
        console.log(line);
      }
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

/**
 * v0.42.x (#1914): rescope an existing OAuth client's write source and/or
 * federated read scope. This is the operator surface the DCR registration
 * comment promised ("rescope via the CLI later") — DCR clients land with
 * source_id='default' / federated_read=['default'] and must not self-widen,
 * so widening happens here (trusted local CLI) or via the requireAdmin
 * /admin/api/rescope-client endpoint.
 */
/**
 * WP4: parse the `--surface` rescope value. 'clear' → null (clears both
 * surface AND surface_set_by); one of the three known surfaces → itself;
 * anything else → undefined (caller errors out). Exported for unit tests.
 */
export function parseRescopeSurfaceValue(value: string): 'verbs' | 'starter' | 'full' | null | undefined {
  if (value === 'clear') return null;
  if (value === 'verbs' || value === 'starter' || value === 'full') return value;
  return undefined;
}

async function rescopeClient(clientId: string, args: string[]) {
  if (!clientId) { console.error('Usage: auth rescope-client <client_id> [--profile PROFILE] [grant flags] [--repair] [--dry-run] [--json]  (alias of: gbrain auth rescope --client <client_id>)'); process.exit(1); }
  await runRescope(['--client', clientId, ...args], parseRescopeGrantArgs);
}

/** `gbrain auth rescope-token`: alias of `gbrain auth rescope --token` (src/core/grants/legacy-token.ts). */
async function rescopeToken(args: string[]) {
  await runRescope(args, undefined, true);
}

/**
 * F3 `gbrain auth rescope`: one grant editor for legacy tokens and OAuth
 * clients (src/core/grants/cli.ts splits the target). Refusals print the
 * reason and the next command; with --json they also print a JSON error on
 * stdout so an agent never has to read stderr.
 */
async function runRescope(args: string[], clientParser?: (args: string[]) => RescopeGrantArgs, tokenArgs = false) {
  const json = args.includes('--json');
  try {
    const command = tokenArgs ? { kind: 'token' as const, args } : splitRescopeTarget(args);
    await withConfiguredSql(async (_sql, engine) => {
      if (command.kind === 'migrate-legacy') return printMigrateLegacy(await migrateLegacyTokens(engine, { dryRun: command.dryRun }), command.json);
      const target = command.kind === 'bare' ? await resolveRescopeTarget(engine, command.name) : command.kind === 'client' ? command : { kind: 'token' as const };
      if (target.kind === 'client') {
        const clientId = target.clientId;
        return rescopeClientWith(engine, clientId, clientParser ? clientParser(command.args) : parseClientRescopeArgs(clientId, command.args));
      }
      const tokenArgv = command.kind === 'bare' ? [command.name, ...command.args] : command.args;
      const parsed = parseRescopeTokenArgs(tokenArgv);
      printTokenRescope(await rescopeLegacyToken(engine, parsed), parsed.json);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      const grantError = error instanceof GrantError ? error : undefined;
      console.log(JSON.stringify({ error: { code: grantError?.code ?? 'rescope_failed', reasons: grantError?.reasons ?? [], message } }, null, 2));
    }
    console.error('Error:', message);
    process.exit(1);
  }
}

async function rescopeClientWith(engine: BrainEngine, clientId: string, parsed: RescopeGrantArgs) {
  const existing = await readClientGrant(engine, clientId);
  const profile = parsed.profile ? resolveGrantProfile({
    profile: parsed.profile, existing, sourceId: parsed.patch.sourceId ?? existing.sourceId ?? 'default',
    boundTools: parsed.patch.boundTools ?? undefined,
    federatedRead: parsed.patch.federatedRead,
    boundSlugPrefixes: parsed.patch.boundSlugPrefixes,
    delegatedSlugPrefixes: parsed.patch.delegatedSlugPrefixes ?? undefined,
    delegatedNamespace: parsed.patch.delegatedNamespace,
  }) : {};
  const result = await rescopeClientGrant(engine, clientId, { ...profile, ...parsed.patch }, {
    actor: 'operator:cli', expectedRevision: parsed.expectedRevision ?? existing.revision,
    repair: parsed.repair, dryRun: parsed.dryRun,
  });
  if (parsed.json) { console.log(JSON.stringify({ ...result, principal_grant: grantFromClient(result.after) }, null, 2)); return; }
  console.log(`OAuth client ${parsed.dryRun ? 'grant preview' : 'rescoped'}: ${result.after.clientName} (${clientId})`);
  console.log(`  Revision: ${result.before.revision} -> ${result.after.revision}`);
  console.log(`  Scopes: ${result.after.scopes.join(' ') || '<none>'}`);
  console.log(`  Write source: ${result.after.sourcesNone ? 'none (every read and write refused)' : result.after.sourceId}`);
  console.log(`  Federated reads: ${result.after.federatedRead.join(', ') || '<none>'}`);
  console.log(`  Takes holders: ${result.after.takesHolders === null ? 'world (default)' : result.after.takesHolders.join(', ') || 'none (every take hidden)'}`);
  console.log(`  Tool surface: ${result.after.surface ?? '<server default>'}`);
  console.log(`  Delegated spending: ${result.after.budgetUsdPerDay === null ? 'unlimited' : '$' + result.after.budgetUsdPerDay + '/day'}`);
  console.log('Restrictions apply on the next request. Added scopes require a new access token; the client secret is unchanged.');
}

function printTokenRescope(result: RescopeTokenResult, json: boolean) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  const verb = !result.changed ? 'grants' : result.dryRun ? 'grant preview' : 'rescoped';
  console.log(`Legacy token ${verb}: ${result.name} (${result.id})`);
  const rows: Array<[string, keyof typeof result.before]> = [['Sources', 'sources'], ['Takes holders', 'takesHolders'], ['Operations', 'operations']];
  for (const [label, key] of rows) {
    const before = renderLegacyGrantAxis(result.before[key]);
    const after = renderLegacyGrantAxis(result.after[key]);
    console.log(`  ${label}: ${before === after ? after : `${before} -> ${after}`}`);
  }
  console.log(`  Grant revision: ${result.revision.before === result.revision.after ? result.revision.after : `${result.revision.before} -> ${result.revision.after}`}`);
  if (result.drift.length && !result.written) {
    console.log(`  Drift: ${result.drift.join(', ')} deny every request (the permissions JSON disagrees with the grant columns). `
      + `Ask the user which grant is intended, then run gbrain auth rescope --token ${result.name} --adopt-permissions or --adopt-columns.`);
  }
  if (result.shape === 'legacy_permissions' && !result.written) {
    console.log(`  Shape: legacy permissions JSON (still enforced). The next grant edit migrates it, or run gbrain auth rescope --migrate-legacy.`);
  }
  if (result.migrated) console.log('  Migrated to the unified grant columns; the permissions JSON is kept as a mirror for older gbrain binaries.');
  if (result.refresh) {
    const { available, added, unregistered } = result.refresh;
    console.log(`  New operations available: ${available.length ? available.join(', ') : 'none'}`);
    if (unregistered.length) console.log(`  Granted but no longer registered: ${unregistered.join(', ')}`);
    if (added.length) console.log(`  Added: ${added.join(', ')}`);
    else if (available.length) {
      const add = available.length <= 8 ? `--add ${available.join(',')}` : '--add <op,...>';
      console.log(`  Nothing widened. Grant them with: gbrain auth rescope --token ${result.name} --refresh-operations ${add} (or --all-new)`);
    }
  }
  if (result.changed && !result.dryRun) console.log('Grants apply on the next request; the token secret is unchanged.');
}

function printMigrateLegacy(result: MigrateLegacyResult, json: boolean) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  const verb = result.dryRun ? 'Would migrate' : 'Migrated';
  console.log(`${verb} ${result.migrated.length} legacy token(s) to the unified grant columns; no effective grant changes.`);
  for (const t of result.migrated) {
    console.log(`  ${t.name} (${t.id}): sources ${renderLegacyGrantAxis(t.grant.sources)}; takes holders ${renderLegacyGrantAxis(t.grant.takesHolders)}; operations ${renderLegacyGrantAxis(t.grant.operations)}`);
  }
  for (const t of result.skipped) console.log(`  Skipped ${t.name} (${t.id}): ${t.reason}. Fix: ${t.fix}`);
  if (result.dryRun && result.migrated.length) console.log('Apply with: gbrain auth rescope --migrate-legacy');
}

/**
 * E4 (WP4 expansion): `gbrain auth clients [--usage] [--days N] [--json]`.
 *
 * Lists OAuth clients with their scopes + per-client MCP tool surface
 * (`surface` / `surface_set_by`, WP4), and with `--usage` joins the
 * per-client op-call usage from `mcp_request_log` via the shared reader
 * (src/core/mcp-usage.ts — same hygiene rules as the E3 advisor collector
 * and scripts/derive-starter-ops.ts). Legacy bearer tokens that called in
 * the window appear too (they log under their token name) but carry no
 * per-client surface row. stdio clients never appear — that transport does
 * not write mcp_request_log.
 */
export function parseAuthClientsArgs(args: string[]): { usage: boolean; days: number; json: boolean } {
  const out = { usage: false, days: 30, json: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--usage') out.usage = true;
    else if (flag === '--json') out.json = true;
    else if (flag === '--days') {
      const v = Number(args[i + 1]);
      if (!Number.isInteger(v) || v < 1 || v > 3650) {
        throw new Error('--days must be an integer between 1 and 3650');
      }
      out.days = v;
      i++;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return out;
}

export interface ClientRow {
  client_id: string;
  client_name: string | null;
  scope: string | null;
  surface: string | null;
  surface_set_by: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  /** The operation snapshot: NULL = none stored; absent = the brain predates the column. */
  allowed_operations?: string[] | null;
  /** Soft-revoke stamp (`auth` lifecycle revoke); absent on schemas without it. */
  deleted_at?: string | Date | null;
}

/** The operation-snapshot axis of one client, as `auth clients` reports it. */
export interface ClientOperationsView {
  /** 'all' = no snapshot (SQL NULL); [] = deny-all; a list = pinned; 'unavailable' = old schema. */
  operations: 'all' | string[] | 'unavailable';
  operations_state: 'all' | 'none' | 'list' | 'unavailable';
  /** true only for 'all': operations later upgrades add are reachable without a regrant. */
  includes_future_operations: boolean | null;
  revoked: boolean;
  /** The re-pin command for a live client with no snapshot. */
  fix?: RenderedAction;
}

/**
 * Four distinct operation states (#6008 visibility): SQL NULL is `all` on the
 * operation-snapshot axis only (scopes, surface and source limits still
 * apply); an empty array refuses every operation; a list is pinned; a schema
 * without the column is `unavailable`, never guessed.
 */
export function clientOperationsView(row: ClientRow): ClientOperationsView {
  const revoked = row.deleted_at != null;
  const ops = row.allowed_operations;
  if (ops === undefined) return { operations: 'unavailable', operations_state: 'unavailable', includes_future_operations: null, revoked };
  if (ops === null) {
    const view: ClientOperationsView = { operations: 'all', operations_state: 'all', includes_future_operations: true, revoked };
    if (revoked) return view;
    view.fix = renderAction({
      argv: ['gbrain', 'auth', 'rescope', '--client', row.client_id, '--operations', '<OPERATIONS>'],
      inputs: [{ name: 'OPERATIONS', how: `Ask the user which operations this client should keep (comma-separated, e.g. search,get_page,remember), or pin a profile instead: gbrain auth rescope --client ${row.client_id} --profile <profile> (${GRANT_PROFILES.join(', ')}).` }],
      consent: [], actor: 'agent', requires_exclusive: false,
      why: 'This client has no operation snapshot, so it reaches every operation its scopes and surface allow, including operations later upgrades add. A pinned list or profile keeps new operations from arriving without a regrant.',
      verify: { argv: ['gbrain', 'auth', 'clients', '--json'] },
    }, cliRenderContext());
    return view;
  }
  return { operations: ops, operations_state: ops.length === 0 ? 'none' : 'list', includes_future_operations: false, revoked };
}

/** Text lines for the operation axis (and revocation) of one client. */
export function clientOperationsLines(row: ClientRow): string[] {
  const view = clientOperationsView(row);
  const lines: string[] = [];
  if (view.revoked) lines.push(`  revoked: ${row.deleted_at instanceof Date ? row.deleted_at.toISOString() : String(row.deleted_at)} (credentials no longer work)`);
  if (view.operations_state === 'unavailable') lines.push('  operations: unavailable (this brain predates per-client operation snapshots)');
  else if (view.operations_state === 'none') lines.push('  operations: none (deny-all snapshot)');
  else if (view.operations_state === 'list') {
    const ops = view.operations as string[];
    lines.push(`  operations: ${ops.length} pinned (${ops.slice(0, 8).join(', ')}${ops.length > 8 ? ', ...' : ''})`);
  } else {
    lines.push('  operations: all (no snapshot; includes operations later upgrades add; scopes, surface and source limits still apply)');
    if (view.fix) lines.push(`    re-pin: gbrain auth rescope --client ${row.client_id} --operations <op,...>  (or --profile <profile>)`);
  }
  return lines;
}

/**
 * Projection-widened client listing with a degrade ladder for pre-migration
 * brains: full shape (scope + surface + source-scoping columns) → source
 * columns without surface → the bare original triple. Drops the NEWEST
 * columns first; missing columns render as null. Only schema-shape errors
 * (undefined column/table) degrade — anything else (dropped connection,
 * permission) rethrows instead of silently narrowing the listing. One round
 * trip on a current brain (the widen adds columns, not queries). Exported
 * for the unit suite.
 */
export async function listClientRows(engine: BrainEngine): Promise<ClientRow[]> {
  // The columns each degrade tier drops. isUndefinedColumnError matches any
  // 42703 by code; the column list covers message-only (code-less) variants.
  const isSchemaShapeError = (e: unknown): boolean =>
    isUndefinedTableError(e) ||
    ['allowed_operations', 'deleted_at', 'surface', 'surface_set_by', 'source_id', 'federated_read']
      .some(col => isUndefinedColumnError(e, col));
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read, allowed_operations, deleted_at
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the operation-snapshot columns: operations read `unavailable`.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    return await engine.executeRaw<ClientRow>(
      `SELECT client_id, client_name, scope, surface, surface_set_by, source_id, federated_read
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
  } catch (e) {
    // Brain predates the surface columns — fall through. Rethrow non-shape errors.
    if (!isSchemaShapeError(e)) throw e;
  }
  try {
    const mid = await engine.executeRaw<Omit<ClientRow, 'surface' | 'surface_set_by'>>(
      `SELECT client_id, client_name, scope, source_id, federated_read
         FROM oauth_clients ORDER BY client_name, client_id`,
    );
    return mid.map(r => ({ ...r, surface: null, surface_set_by: null }));
  } catch (e) {
    // Brain predates the source-scoping columns — fall through likewise.
    if (!isSchemaShapeError(e)) throw e;
  }
  const bare = await engine.executeRaw<Pick<ClientRow, 'client_id' | 'client_name' | 'scope'>>(
    `SELECT client_id, client_name, scope FROM oauth_clients ORDER BY client_name, client_id`,
  );
  return bare.map(r => ({ ...r, surface: null, surface_set_by: null, source_id: null, federated_read: null }));
}

/** Clients whose stored or outstanding access-token lifetime an upgrade brought inside the 90-day maximum. */
export async function tokenLifetimeClampedClients(engine: BrainEngine): Promise<Set<string>> {
  try {
    const rows = await engine.executeRaw<{ client_id: string }>(
      `SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`,
    );
    return new Set(rows.map(r => r.client_id));
  } catch (e) {
    if (isUndefinedTableError(e)) return new Set();
    throw e;
  }
}

async function clientsCmd(args: string[]) {
  const usageLine = 'Usage: auth clients [--usage] [--days N] [--json]';
  let parsed: { usage: boolean; days: number; json: boolean };
  try {
    parsed = parseAuthClientsArgs(args);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    console.error(usageLine);
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (_sql, engine) => {
      // Degrade ladder lives in listClientRows: a pre-migration brain still
      // gets the listing (missing columns render as null) instead of an error.
      const clients = await listClientRows(engine);
      const lifetimeClamped = await tokenLifetimeClampedClients(engine);

      const { readClientOpUsage } = await import('../core/mcp-usage.ts');
      const usage = parsed.usage ? await readClientOpUsage(engine, { days: parsed.days }) : [];
      const usageByToken = new Map(usage.map(u => [u.token_name, u]));
      const clientIds = new Set(clients.map(c => c.client_id));
      const legacyUsage = usage.filter(u => !clientIds.has(u.token_name));

      if (parsed.json) {
        console.log(JSON.stringify({
          window_days: parsed.days,
          usage_included: parsed.usage,
          clients: clients.map(c => ({
            client_id: c.client_id,
            client_name: c.client_name,
            scopes: c.scope,
            surface: c.surface,
            surface_set_by: c.surface_set_by,
            source_id: c.source_id,
            federated_read: c.federated_read,
            ...clientOperationsView(c),
            revoked_at: c.deleted_at ?? null,
            token_lifetime_clamped: lifetimeClamped.has(c.client_id),
            usage: usageByToken.get(c.client_id) ?? null,
          })),
          // Legacy bearer tokens seen in the window (no oauth_clients row).
          legacy_tokens: legacyUsage,
        }, null, 2));
        return;
      }

      if (clients.length === 0 && legacyUsage.length === 0) {
        console.log('No OAuth clients registered. Register one: gbrain auth register-client "my-client"');
        return;
      }
      const fmtTop = (u: (typeof usage)[number]) =>
        Object.entries(u.ops).slice(0, 5).map(([op, n]) => `${op}(${n})`).join(', ');
      for (const c of clients) {
        const u = usageByToken.get(c.client_id);
        console.log(`${c.client_name ?? '<unnamed>'} (${c.client_id})`);
        const surfaceStr = c.surface
          ? `${c.surface}${c.surface_set_by ? ` (set by ${c.surface_set_by})` : ''}`
          : '<server/config resolution>';
        console.log(`  scopes: ${c.scope ?? '<none>'}    surface: ${surfaceStr}`);
        console.log(`  write source: ${c.source_id ?? '<none>'}    federated reads: ${(c.federated_read ?? []).join(', ') || '<none>'}`);
        for (const line of clientOperationsLines(c)) console.log(line);
        if (lifetimeClamped.has(c.client_id)) console.log('  access-token lifetime: clamped to the 90-day maximum by an upgrade (docs/mcp/ADMIN.md#access-token-lifetime)');
        if (parsed.usage) {
          if (u) {
            const auto = u.likely_automation ? '    [automation-shaped: >90% context_pack/delta]' : '';
            console.log(`  calls (${parsed.days}d): ${u.total_calls} across ${u.distinct_ops.length} ops    last seen: ${u.last_seen}${auto}`);
            console.log(`  top ops: ${fmtTop(u)}`);
          } else {
            console.log(`  calls (${parsed.days}d): 0 (no HTTP MCP calls in window; stdio use is not logged)`);
          }
        }
        console.log('');
      }
      if (parsed.usage && legacyUsage.length > 0) {
        console.log(`Legacy bearer tokens seen in the last ${parsed.days}d (no per-client surface row):`);
        for (const u of legacyUsage) {
          const auto = u.likely_automation ? '    [automation-shaped]' : '';
          console.log(`  ${u.token_name}: ${u.total_calls} calls across ${u.distinct_ops.length} ops    last seen: ${u.last_seen}${auto}`);
          console.log(`    top ops: ${fmtTop(u)}`);
        }
      }
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

/**
 * Entry point for the `gbrain auth` CLI subcommand. Also reused by the
 * direct-script path (see bottom of file) so `bun run src/commands/auth.ts`
 * still works.
 */
/**
 * Parse `auth create` args into `{ name, takesHolders, scopes }`.
 *
 * Exported + pure so the positional-vs-flag logic is unit-testable. Only
 * excludes flag VALUES from the positional search when their flag is
 * present — the pre-v0.41 inline version used `rest[takesIdx + 1]` which
 * resolved to `rest[0]` when `takesIdx === -1`, silently dropping the name on
 * the bare `gbrain auth create <name>` form.
 *
 * --scopes accepts comma- and/or whitespace-separated input (the
 * register-client #3990 normalization precedent). Validation against the
 * allowed scope set happens in create() so the error path exits cleanly.
 */
export function parseAuthCreateArgs(rest: string[]): { name: string; takesHolders?: string[]; scopes?: string[]; minTrust?: TrustTier; error?: string } {
  const takesIdx = rest.indexOf('--takes-holders');
  const takesValue = takesIdx >= 0 ? rest[takesIdx + 1] : undefined;
  // Fail closed on a missing/flag-like value: `--scopes` as the last arg
  // silently minting a grandfathered FULL-ACCESS token is the exact
  // fail-open-by-silent-precedence class the harness parser rejects [X14].
  if (takesIdx >= 0 && (takesValue === undefined || takesValue.startsWith('--'))) {
    return { name: '', error: 'the takes-holders flag requires a value (e.g. world,garry)' };
  }
  const takesHolders = takesValue !== undefined
    ? takesValue.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const scopesIdx = rest.indexOf('--scopes');
  const scopesValue = scopesIdx >= 0 ? rest[scopesIdx + 1] : undefined;
  if (scopesIdx >= 0 && (scopesValue === undefined || scopesValue.startsWith('--'))) {
    return { name: '', error: 'the scopes flag requires a value (e.g. read,write) — omitting it would mint a full-access token' };
  }
  const scopes = scopesValue !== undefined
    ? scopesValue.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    : undefined;
  const minIdx = rest.indexOf('--min-trust');
  const minValue = minIdx >= 0 ? rest[minIdx + 1] : undefined;
  if (minIdx >= 0 && !isTrustTier(minValue)) {
    return { name: '', error: `the min-trust flag requires a tier: ${TRUST_TIERS.join(', ')}` };
  }
  const positional = rest.find(a => !a.startsWith('--') && a !== takesValue && a !== scopesValue && a !== minValue);
  return { name: positional || '', takesHolders, ...(scopes !== undefined ? { scopes } : {}), ...(isTrustTier(minValue) ? { minTrust: minValue } : {}) };
}

const AUTH_USAGE = `GBrain Token Management

Admin dashboard login (running HTTP server):
  For "Give me the GBrain admin login link", use POST /admin/api/issue-magic-link
  with the server bootstrap credential through the host's protected credential flow.
  It returns a five-minute, single-use owner login link. Deliver it privately;
  do not GET the generated link to check it. A static /admin/ URL only opens the login page.
  This does not create an MCP bearer token. See docs/mcp/DEPLOY.md.

Usage:
  gbrain auth create <name> [--takes-holders world,garry,brain] [--scopes read,write] [--min-trust <tier>]
                                                          Create a legacy bearer token. v0.28: --takes-holders
                                                          sets the per-token allow-list for the takes.holder
                                                          field (default: ["world"]). MCP-bound calls to
                                                          takes_list / takes_search / query filter by this.
                                                          --scopes narrows the token to the listed op scopes
                                                          (comma or space separated; omit = full access,
                                                          grandfathered).
                                                          --min-trust sets the token's read floor: reads never
                                                          return rows below that trust tier (${TRUST_TIERS.join(', ')});
                                                          memory_confirm in --scopes lets the token confirm
                                                          memory as you (local CLI only; never via admin API)
  gbrain auth set-min-trust <client|token> <tier|none>    Set or clear the read floor of an OAuth client (id)
                                                          or legacy token (id or name). Local CLI only.
  gbrain auth list                                         List all tokens (id, scopes, usage)
  gbrain auth revoke <name>                                Revoke a legacy token (ALL active rows with that name)
  gbrain auth revoke --id <uuid>                           Revoke exactly one token by id (names are not unique)
  gbrain auth rescope --token <name>|--id <uuid>|--client <client_id>|<name> [options]
                                                          Change a legacy token's or OAuth client's grants in
                                                          place. Only the flags you pass change; the secret is
                                                          unchanged. With no grant flag it prints the stored
                                                          grants. A bare name matching both a token and a
                                                          client refuses; pass --token or --client.
     --sources <id1,id2,...|none>                         Source grant (first = write source; 'none' = deny-all,
                                                          scopes and secret unchanged)
     --read-sources <id1,id2,...>                         Client only: a read set that differs from --sources
     --takes-holders <h1,h2,...|none>                     Takes-holder allow-list (default world; 'none' = deny-all)
     --operations <op1,op2,...|none|all>                  Operation snapshot ('none' = deny-all). Client only:
                                                          'all' = no snapshot: every operation the scopes and the
                                                          surface allow, including ones later upgrades add; clears
                                                          the profile (tokens: --reset-default operations)
     --scopes <read,write,...>                            Replace the scopes
     --reset-default <sources,takes-holders,operations>   Token only: restore the auth create default for those axes
     --refresh-operations [--add <op,...>|--all-new]      Token only: preview operations added since the snapshot;
                                                          widen only by the ones --add names (or all with --all-new)
     --if-version <N>                                     Refuse unless the stored grant revision is N
     --adopt-permissions | --adopt-columns                Token only: resolve grant drift by keeping the permissions
                                                          JSON (an older gbrain's edit) or restoring the columns
     --dry-run / --json                                   Preview without writing / machine-readable output
                                                          (--json also prints refusals as JSON on stdout)
     Client-only flags of rescope-client (--surface, --bound-*, --profile, ...) pass through.
  gbrain auth rescope --migrate-legacy [--dry-run] [--json]
                                                          Write the unified grant columns for every token still on
                                                          the permissions-JSON shape; changes no effective grant
  gbrain auth rescope-token <name>|--id <uuid> [options]  Alias of: auth rescope --token <name> [options]
  gbrain auth permissions <name> set-takes-holders <h1,h2,h3>
                                                          Alias of: auth rescope --token <name> --takes-holders
  gbrain auth register-client <name> [options]             Register an OAuth 2.1 client (v0.26+)
     --grant-types <client_credentials,authorization_code>  (default: client_credentials;
                                                            auto-set to authorization_code,refresh_token
                                                            when --redirect-uri is passed)
     --scopes "<read write admin>"                         (default: read)
     --source <id>                                         (default: default)
     --federated-read <id1,id2,...>                        (default: [source])
     --redirect-uri <https://...>                          (v0.41.3+; repeatable; required for authorization_code)
     --token-endpoint-auth-method <method>                 (v0.41.3+; client_secret_post | client_secret_basic | none;
                                                            'none' = public PKCE-only client, no secret minted)
     --bound-tools <tool1,tool2>                           Bind submit_agent to an allow-list of tools
     --bound-source <id>                                   Bind submit_agent jobs to a source id
     --bound-brain <id>                                    Bind submit_agent jobs to a brain id
     --bound-slug-prefixes <prefix1,prefix2>               Fence ALL direct slug writes (put_page, delete_page,
                                                          tags, links, timeline, revert, raw data) AND
                                                          submit_agent to these prefixes. Each MUST end with
                                                          '/' or '/*' — a boundary-less 'emp-alice' would also
                                                          name 'emp-alice-2/...'. Ops that write by something
                                                          other than a slug (extract_*, forget_fact,
                                                          ontology_propose, sources_*) and POST /ingest become
                                                          unavailable to a bound client. Omit = full-source writes.
     --bound-max-concurrent <n>                            Bound submit_agent concurrency (default: 1)
     --budget-usd-per-day <usd>                            Bound submit_agent daily spend cap
  gbrain auth rescope-client <client_id> [options]        Alias of: auth rescope --client <client_id>, with these
                                                          legacy flags. Change an existing client's source scope
                                                          (e.g. a DCR client stuck on the 'default' source). Only
                                                          the flags you pass change; the other axes are left as-is.
     --source <id>                                        New write source
     --federated-read <id1,id2,...>                       New read-scope source list
     --bound-slug-prefixes <p1,p2|none>                   Replace the slug-prefix write fence ('none' clears it)
     --surface <verbs|starter|full|clear>                 Pin the client's MCP tool surface (operator lock —
                                                          request_tools cannot override; 'clear' removes the pin
                                                          so server/config resolution applies again). Always
                                                          bounded by the server's --surface ceiling.
  gbrain auth clients [--usage] [--days N] [--json]       List OAuth clients with scopes, write source, federated
                                                          reads, tool surface + operation snapshot ('all' = no
                                                          snapshot, includes future operations; re-pin with
                                                          auth rescope --client <id> --operations|--profile). --usage
                                                          joins per-client op-call counts, top ops, and last-seen
                                                          from mcp_request_log (default 30d window; HTTP clients
                                                          only — stdio use is not logged). Automation-shaped
                                                          clients (>90% context_pack/delta) are flagged.
  gbrain auth revoke-client <client_id>                   Hard-delete an OAuth 2.1 client (cascades to tokens + codes)
  gbrain auth local-writer list|register|revoke            Manage durable local CLI/stdio writers (see --help)
  gbrain auth test <url> --token <token>                  Smoke-test a remote MCP server
`;

export async function runAuth(args: string[]): Promise<void> {
  if (args[0] === 'local-writer') {
    const { runPersistenceAdminCli } = await import('./persistence-admin.ts');
    return runPersistenceAdminCli('local-writer', args.slice(1));
  }
  // #4083 follow-up: print usage whenever --help/-h appears ANYWHERE in
  // args, before dispatching to a subcommand. Without this early return,
  // `gbrain auth create foo --help` (or revoke/register-client/... +
  // --help) actually EXECUTES the subcommand instead of showing help,
  // once `auth` joined CLI_ONLY_SELF_HELP and the generic --help
  // short-circuit in cli.ts stopped intercepting it first. Same pattern
  // as sync.ts's own `args.includes('--help') || args.includes('-h')`
  // early-return.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(AUTH_USAGE);
    return;
  }
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'create': {
      // v0.28: optional --takes-holders world,garry,brain (default: world only)
      // #4043: optional --scopes read,write (default: full access, grandfathered)
      const parsed = parseAuthCreateArgs(rest);
      if (parsed.error) {
        console.error(`Error: ${parsed.error}`);
        process.exit(1);
      }
      await create(parsed.name, { takesHolders: parsed.takesHolders, scopes: parsed.scopes, minTrust: parsed.minTrust });
      return;
    }
    case 'set-min-trust': await setMinTrustCmd(rest); return;
    case 'list': await list(); return;
    case 'revoke': {
      if (rest[0] === '--id') { await revokeById(rest[1] || ''); return; }
      await revoke(rest[0]);
      return;
    }
    case 'permissions': {
      // gbrain auth permissions <name> set-takes-holders world,garry
      await permissions(rest[0] || '', rest[1] || '', rest[2]);
      return;
    }
    case 'register-client': await registerClient(rest[0], rest.slice(1)); return;
    case 'rescope-client': await rescopeClient(rest[0], rest.slice(1)); return;
    case 'rescope-token': await rescopeToken(rest); return;
    case 'rescope': await runRescope(rest); return;
    case 'revoke-client': await revokeClient(rest[0]); return;
    case 'clients': await clientsCmd(rest); return;
    case 'test': {
      const tokenIdx = rest.indexOf('--token');
      const url = rest.find(a => !a.startsWith('--') && a !== rest[tokenIdx + 1]);
      const token = tokenIdx >= 0 ? rest[tokenIdx + 1] : '';
      await test(url || '', token || '');
      return;
    }
    default:
      console.log(AUTH_USAGE);
  }
}

// Direct-script entry point — only runs when this file is invoked as the main module
// (e.g. `bun run src/commands/auth.ts ...`). When imported by cli.ts, this block is skipped.
if (import.meta.main) {
  await runAuth(process.argv.slice(2));
}
