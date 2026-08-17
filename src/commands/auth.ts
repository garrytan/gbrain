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
import { createHash, randomBytes } from 'crypto';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { assertAllowedScopes } from '../core/scope.ts';
import { isUndefinedColumnError, isUndefinedTableError } from '../core/utils.ts';
import { TOKEN_ID_RE } from '../core/token-mint.ts';
import { normalizeTokenScopes } from '../core/legacy-token-scope.ts';
import { sqlQueryForEngine, executeRawJsonb, type SqlQuery } from '../core/sql-query.ts';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'gbrain_' + randomBytes(32).toString('hex');
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

async function create(name: string, opts: { takesHolders?: string[]; scopes?: string[] } = {}) {
  if (!name) { console.error('Usage: auth create <name> [--takes-holders world,garry] [--scopes read,write]'); process.exit(1); }
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
  const token = generateToken();
  const hash = hashToken(token);

  try {
    await withConfiguredSql(async (_sql, engine) => {
      // v0.28: persist per-token takes-holder allow-list. Default ['world'] keeps
      // private hunches hidden from MCP-bound tokens.
      const takesHolders = opts.takesHolders && opts.takesHolders.length > 0
        ? opts.takesHolders
        : ['world'];
      const permissions = { takes_holders: takesHolders };
      // JSONB write: pass the object via executeRawJsonb with an explicit
      // ::jsonb cast in the SQL string. Both engines round-trip the object
      // through the wire-protocol type oid without the v0.12.0 double-encode
      // bug class (verified by test/e2e/auth-permissions.test.ts:67 on
      // Postgres and test/sql-query.test.ts on PGLite).
      //
      // Scopes (when given) land in the original-schema scopes TEXT[] column
      // via an array literal through a TEXT param — values are allowlisted,
      // so the literal needs no quoting and runs identically on both engines.
      // Omitted → NULL → the historical grandfathered full-access grant.
      if (opts.scopes !== undefined) {
        await executeRawJsonb(
          engine,
          `INSERT INTO access_tokens (name, token_hash, permissions, scopes)
           VALUES ($1, $2, $4::jsonb, $3::text[])`,
          [name, hash, `{${opts.scopes.join(',')}}`],
          [permissions],
        );
      } else {
        await executeRawJsonb(
          engine,
          `INSERT INTO access_tokens (name, token_hash, permissions)
           VALUES ($1, $2, $3::jsonb)`,
          [name, hash],
          [permissions],
        );
      }
      const scopeLine = opts.scopes !== undefined
        ? `scopes=${JSON.stringify(opts.scopes)}`
        : 'scopes=full access (grandfathered — pass --scopes read,write to narrow)';
      console.log(`Token created for "${name}" (takes_holders=${JSON.stringify(takesHolders)}, ${scopeLine}):\n`);
      console.log(`  ${token}\n`);
      console.log('Save this token — it will not be shown again.');
      console.log(`Revoke with: gbrain auth revoke "${name}" (or gbrain auth revoke --id <id> from auth list)`);
      console.log(`Update visibility: gbrain auth permissions "${name}" set-takes-holders world,garry`);
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

async function permissions(name: string, action: string, value: string | undefined) {
  if (!name || action !== 'set-takes-holders' || !value) {
    console.error('Usage: auth permissions <name> set-takes-holders world,garry,brain');
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql, engine) => {
      const list = value.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 0) {
        console.error('takes-holders list cannot be empty (use "world" for default-deny on private)');
        process.exit(1);
      }
      const perms = { takes_holders: list };
      // JSONB UPDATE via executeRawJsonb — same pattern as create() above.
      // MERGE, never whole-object replace: `SET permissions = $2::jsonb`
      // would silently DELETE every other grant key (source_id federation,
      // and any future key) on a routine takes-holders edit — the grant-wipe
      // class the #4043 review caught.
      // The jsonb_typeof guard repairs rows carrying historical double-encode
      // damage (a jsonb string/array scalar): `scalar || object` would produce
      // a jsonb ARRAY and silently strand every grant, so a damaged left
      // operand is reset to '{}' on edit — the old whole-replace semantics for
      // damaged rows, merge semantics for healthy object rows.
      const result = await executeRawJsonb(
        engine,
        `UPDATE access_tokens
            SET permissions = (CASE WHEN jsonb_typeof(permissions) = 'object' THEN permissions ELSE '{}'::jsonb END) || $2::jsonb
            WHERE name = $1
            RETURNING id`,
        [name],
        [perms],
      );
      if (result.length === 0) {
        console.error(`Token "${name}" not found.`);
        process.exit(1);
      }
      console.log(`Updated "${name}": takes_holders = ${JSON.stringify(list)}`);
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
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
  boundSourceId: string | undefined;
  boundBrainId: string | undefined;
  boundSlugPrefixes: string[] | undefined;
  boundMaxConcurrent: number | undefined;
  budgetUsdPerDay: string | undefined;
  tokenTtlSeconds: number | undefined;
}

/** --token-ttl bounds: 1 minute .. 90 days. The SERVER default for CLI-minted
 * access tokens is 3600s (oauth-provider.ts tokenTtl) — NOT 30 days; callers
 * that promise long-lived tokens must write oauth_clients.token_ttl. */
export const TOKEN_TTL_MIN_SECONDS = 60;
export const TOKEN_TTL_MAX_SECONDS = 7_776_000;

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
        if (!/^\d+(?:\.\d{1,2})?$/.test(v)) {
          throw new Error('--budget-usd-per-day must be a non-negative decimal with at most 2 decimal places');
        }
        out.budgetUsdPerDay = v;
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
    name, grantTypes, scopes, redirectUris, sourceId, federatedRead, tokenEndpointAuthMethod, agentBindings,
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
  const usage = 'Usage: auth rescope-client <client_id> [--source SOURCE] [--federated-read SRC1,SRC2,...] [--bound-slug-prefixes P1,P2|none] [--surface verbs|starter|full|clear]';
  if (!clientId) {
    console.error(usage);
    process.exit(1);
  }
  let sourceId: string | undefined;
  let federatedRead: string[] | undefined;
  // v0.42.72.0: tri-state — undefined = untouched, null = clear ('none'),
  // array = replace. Lets roster churn (channel joins/leaves) update the
  // write fence in place instead of register+rotate.
  let boundSlugPrefixes: string[] | null | undefined;
  // WP4: tri-state — undefined = untouched, null = clear ('clear'), value =
  // set + surface_set_by='operator' (the lock request_tools cannot override).
  let surface: 'verbs' | 'starter' | 'full' | null | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Error: ${flag} requires a value`);
      console.error(usage);
      process.exit(1);
    }
    if (flag === '--source') sourceId = value;
    else if (flag === '--federated-read') {
      federatedRead = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (flag === '--bound-slug-prefixes') {
      boundSlugPrefixes = value === 'none'
        ? null
        : value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (flag === '--surface') {
      surface = parseRescopeSurfaceValue(value);
      if (surface === undefined) {
        console.error(`Error: --surface must be verbs | starter | full | clear (got "${value}")`);
        console.error(usage);
        process.exit(1);
      }
    } else {
      console.error(`Error: Unknown flag: ${flag}`);
      console.error(usage);
      process.exit(1);
    }
  }
  if (sourceId === undefined && federatedRead === undefined && boundSlugPrefixes === undefined && surface === undefined) {
    console.error('Error: pass --source, --federated-read, --bound-slug-prefixes, and/or --surface');
    console.error(usage);
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql, engine) => {
      const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
      const provider = new GBrainOAuthProvider({ sql });
      const result = await provider.rescopeClient(clientId, { sourceId, federatedRead, boundSlugPrefixes, surface });
      // WP4 (amendment 32 / ENG-8): every surface mutation writes an audit
      // row (this CLI, the admin endpoint, the request_tools persist).
      if (surface !== undefined) {
        const { writeSurfaceChangeAudit } = await import('../core/surface-audit.ts');
        await writeSurfaceChangeAudit(engine, {
          actor: 'operator',
          client_id: clientId,
          old: result.surfaceOld ?? null,
          new: result.surface ?? null,
          via: 'rescope_cli',
        });
      }
      console.log(`OAuth client rescoped: "${result.clientName}" (${result.clientId})\n`);
      console.log(`  Write source:        ${result.sourceId}`);
      console.log(`  Federated reads:     ${result.federatedRead.join(', ') || '<none>'}`);
      if (result.boundSlugPrefixes !== undefined) {
        console.log(`  Bound slug prefixes: ${result.boundSlugPrefixes?.join(', ') ?? '<none — full-source write authority>'}`);
      }
      if (result.surface !== undefined) {
        console.log(`  Tool surface:        ${result.surface ?? '<cleared — server/config surface applies>'}${result.surface != null ? ' (operator-pinned; request_tools cannot override)' : ''}`);
      }
      console.log('\nTakes effect on the client\'s next request (existing tokens included).');
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
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
    ['surface', 'surface_set_by', 'source_id', 'federated_read']
      .some(col => isUndefinedColumnError(e, col));
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
export function parseAuthCreateArgs(rest: string[]): { name: string; takesHolders?: string[]; scopes?: string[]; error?: string } {
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
  const positional = rest.find(a => !a.startsWith('--') && a !== takesValue && a !== scopesValue);
  return { name: positional || '', takesHolders, ...(scopes !== undefined ? { scopes } : {}) };
}

export async function runAuth(args: string[]): Promise<void> {
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
      await create(parsed.name, { takesHolders: parsed.takesHolders, scopes: parsed.scopes });
      return;
    }
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
      console.log(`GBrain Token Management

Usage:
  gbrain auth create <name> [--takes-holders world,garry,brain] [--scopes read,write]
                                                          Create a legacy bearer token. v0.28: --takes-holders
                                                          sets the per-token allow-list for the takes.holder
                                                          field (default: ["world"]). MCP-bound calls to
                                                          takes_list / takes_search / query filter by this.
                                                          --scopes narrows the token to the listed op scopes
                                                          (comma or space separated; omit = full access,
                                                          grandfathered).
  gbrain auth list                                         List all tokens (id, scopes, usage)
  gbrain auth revoke <name>                                Revoke a legacy token (ALL active rows with that name)
  gbrain auth revoke --id <uuid>                           Revoke exactly one token by id (names are not unique)
  gbrain auth permissions <name> set-takes-holders <h1,h2,h3>
                                                          Update visibility for an existing token
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
  gbrain auth rescope-client <client_id> [options]        Change an existing client's source scope (e.g. a DCR
                                                          client stuck on the 'default' source). Only the flags
                                                          you pass change; the other axes are left as-is.
     --source <id>                                        New write source
     --federated-read <id1,id2,...>                       New read-scope source list
     --bound-slug-prefixes <p1,p2|none>                   Replace the slug-prefix write fence ('none' clears it)
     --surface <verbs|starter|full|clear>                 Pin the client's MCP tool surface (operator lock —
                                                          request_tools cannot override; 'clear' removes the pin
                                                          so server/config resolution applies again). Always
                                                          bounded by the server's --surface ceiling.
  gbrain auth clients [--usage] [--days N] [--json]       List OAuth clients with scopes, write source, federated
                                                          reads + tool surface. --usage
                                                          joins per-client op-call counts, top ops, and last-seen
                                                          from mcp_request_log (default 30d window; HTTP clients
                                                          only — stdio use is not logged). Automation-shaped
                                                          clients (>90% context_pack/delta) are flagged.
  gbrain auth revoke-client <client_id>                   Hard-delete an OAuth 2.1 client (cascades to tokens + codes)
  gbrain auth test <url> --token <token>                  Smoke-test a remote MCP server
`);
  }
}

// Direct-script entry point — only runs when this file is invoked as the main module
// (e.g. `bun run src/commands/auth.ts ...`). When imported by cli.ts, this block is skipped.
if (import.meta.main) {
  await runAuth(process.argv.slice(2));
}
