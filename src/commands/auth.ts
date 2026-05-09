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
 * Both paths require DATABASE_URL or GBRAIN_DATABASE_URL (except `test`,
 * which only hits the remote URL and doesn't need a local DB).
 */
import postgres from 'postgres';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';

function getDatabaseUrl(requireDb: boolean): string | undefined {
  const url = process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL;
  if (!url && requireDb) {
    console.error('Set DATABASE_URL or GBRAIN_DATABASE_URL environment variable.');
    process.exit(1);
  }
  return url;
}

/**
 * Tagged-template SQL surface shared by postgres-js and the PGLite test wrapper
 * in test/auth-grants.test.ts. Mirrors `SqlQuery` from src/core/oauth-provider.ts.
 * Kept local to auth.ts to avoid widening the import surface of that module.
 */
type SqlClient = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Open a postgres-js connection or return the injected sql client used by
 * tests. The injection seam keeps the new grant/revoke/list functions
 * testable against PGLite without spawning a subprocess; production callers
 * (the runAuth dispatcher and the direct-script entry point) pass nothing
 * and get the postgres-js connection plus its end() lifecycle.
 */
function openSql(injected?: SqlClient): { sql: SqlClient; end: () => Promise<void> } {
  if (injected) return { sql: injected, end: async () => {} };
  const conn = postgres(getDatabaseUrl(true)!);
  return { sql: conn as unknown as SqlClient, end: async () => { await conn.end(); } };
}

/**
 * Email validator per spec section 7. Pragmatic, not RFC 5321:
 *   - exactly one '@'
 *   - the part after '@' contains at least one '.'
 *   - total length <= 254
 *   - both local and domain parts non-empty after split
 *
 * We are gating CLI input for an operator-managed grants table, not running
 * an SMTP front door. A typo will fail loudly at the next OIDC sign-in
 * regardless; this check is just to reject obvious garbage.
 */
function validateEmail(email: string): string | null {
  if (typeof email !== 'string') return 'email must be a string';
  if (email.length === 0) return 'email is empty';
  if (email.length > 254) return 'email exceeds 254 characters';
  const parts = email.split('@');
  if (parts.length !== 2) return 'email must contain exactly one "@"';
  const [local, domain] = parts;
  if (!local) return 'email local part is empty';
  if (!domain) return 'email domain part is empty';
  if (!domain.includes('.')) return 'email domain must contain a "."';
  return null;
}

/**
 * Best-effort author attribution for the grants audit column. Reads
 * `git config user.email` from the cwd; falls back to the literal 'cli'
 * when git is missing, when the repo has no user.email, or when the
 * exec throws for any reason. Truncated to 254 chars so a misconfigured
 * git identity cannot blow past the column's email-shape budget.
 */
function detectGrantedBy(): string {
  try {
    const out = execSync('git config user.email', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out && out.length <= 254) return out;
  } catch {
    // git missing or no user.email configured - fall through.
  }
  return 'cli';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'gbrain_' + randomBytes(32).toString('hex');
}

async function create(name: string, opts: { takesHolders?: string[] } = {}) {
  if (!name) { console.error('Usage: auth create <name> [--takes-holders world,garry]'); process.exit(1); }
  const sql = postgres(getDatabaseUrl(true)!);
  const token = generateToken();
  const hash = hashToken(token);

  try {
    // v0.28: persist per-token takes-holder allow-list. Default ['world'] keeps
    // private hunches hidden from MCP-bound tokens.
    const takesHolders = opts.takesHolders && opts.takesHolders.length > 0
      ? opts.takesHolders
      : ['world'];
    const permissions = { takes_holders: takesHolders };
    await sql`
      INSERT INTO access_tokens (name, token_hash, permissions)
      VALUES (${name}, ${hash}, ${sql.json(permissions as Parameters<typeof sql.json>[0])})
    `;
    console.log(`Token created for "${name}" (takes_holders=${JSON.stringify(takesHolders)}):\n`);
    console.log(`  ${token}\n`);
    console.log('Save this token — it will not be shown again.');
    console.log(`Revoke with: bun run src/commands/auth.ts revoke "${name}"`);
    console.log(`Update visibility: bun run src/commands/auth.ts permissions "${name}" set-takes-holders world,garry`);
  } catch (e: any) {
    if (e.code === '23505') {
      console.error(`A token named "${name}" already exists. Revoke it first or use a different name.`);
    } else {
      console.error('Error:', e.message);
    }
    process.exit(1);
  } finally {
    await sql.end();
  }
}

async function permissions(name: string, action: string, value: string | undefined) {
  if (!name || action !== 'set-takes-holders' || !value) {
    console.error('Usage: auth permissions <name> set-takes-holders world,garry,brain');
    process.exit(1);
  }
  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const list = value.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      console.error('takes-holders list cannot be empty (use "world" for default-deny on private)');
      process.exit(1);
    }
    const perms = { takes_holders: list };
    const result = await sql`
      UPDATE access_tokens
        SET permissions = ${sql.json(perms as Parameters<typeof sql.json>[0])}
        WHERE name = ${name}
      RETURNING id
    `;
    if (result.length === 0) {
      console.error(`Token "${name}" not found.`);
      process.exit(1);
    }
    console.log(`Updated "${name}": takes_holders = ${JSON.stringify(list)}`);
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

async function list() {
  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const rows = await sql`
      SELECT name, created_at, last_used_at, revoked_at
      FROM access_tokens
      ORDER BY created_at DESC
    `;
    if (rows.length === 0) {
      console.log('No tokens found. Create one: bun run src/commands/auth.ts create "my-client"');
      return;
    }
    console.log('Name                  Created              Last Used            Status');
    console.log('─'.repeat(80));
    for (const r of rows) {
      const name = (r.name as string).padEnd(20);
      const created = new Date(r.created_at as string).toISOString().slice(0, 19);
      const lastUsed = r.last_used_at ? new Date(r.last_used_at as string).toISOString().slice(0, 19) : 'never'.padEnd(19);
      const status = r.revoked_at ? 'REVOKED' : 'active';
      console.log(`${name}  ${created}  ${lastUsed}  ${status}`);
    }
  } finally {
    await sql.end();
  }
}

async function listClients() {
  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const columns = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'oauth_clients'
    `;
    if (columns.length === 0) {
      // No `oauth_clients` table at all — pre-v0.26 schema or a brain
      // that was never initialised. Friendly exit beats an uncaught
      // 42P01 from the SELECT below.
      console.log('No OAuth clients table on this brain. Run `gbrain init` (and migrations) before registering clients.');
      return;
    }
    const columnNames = new Set(columns.map((row: any) => String(row.column_name)));
    const hasAccessTier = columnNames.has('access_tier');
    const hasDeletedAt = columnNames.has('deleted_at');
    const rows = hasAccessTier && hasDeletedAt
      ? await sql`
        SELECT client_id, client_name, access_tier, scope, grant_types, created_at, deleted_at
        FROM oauth_clients
        ORDER BY created_at DESC
      `
      : hasAccessTier
        ? await sql`
          SELECT client_id, client_name, access_tier, scope, grant_types, created_at, ${null} as deleted_at
          FROM oauth_clients
          ORDER BY created_at DESC
        `
        : hasDeletedAt
          ? await sql`
            SELECT client_id, client_name, ${'Full'} as access_tier, scope, grant_types, created_at, deleted_at
            FROM oauth_clients
            ORDER BY created_at DESC
          `
          : await sql`
            SELECT client_id, client_name, ${'Full'} as access_tier, scope, grant_types, created_at, ${null} as deleted_at
            FROM oauth_clients
            ORDER BY created_at DESC
          `;
    if (rows.length === 0) {
      console.log('No OAuth clients registered. Create one: gbrain auth register-client <name>');
      return;
    }
    console.log('Client ID                  Name                  Tier    Scope          Created              Status');
    console.log('-'.repeat(110));
    for (const r of rows) {
      const id = (r.client_id as string).padEnd(26);
      const name = ((r.client_name as string) || '').padEnd(20);
      const tier = String(r.access_tier ?? 'Full').padEnd(7);
      const scope = ((r.scope as string) || '').padEnd(13);
      const created = new Date(r.created_at as string).toISOString().slice(0, 19);
      const status = r.deleted_at ? 'REVOKED' : 'active';
      console.log(`${id}  ${name}  ${tier}  ${scope}  ${created}  ${status}`);
    }
  } finally {
    await sql.end();
  }
}

async function revoke(name: string) {
  if (!name) { console.error('Usage: auth revoke <name>'); process.exit(1); }
  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const result = await sql`
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = ${name} AND revoked_at IS NULL
    `;
    if (result.count === 0) {
      console.error(`No active token found with name "${name}".`);
      process.exit(1);
    }
    console.log(`Token "${name}" revoked.`);
  } finally {
    await sql.end();
  }
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
  const sql = postgres(getDatabaseUrl(true)!);
  try {
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
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

async function registerClient(name: string, args: string[]) {
  if (!name) { console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--tier <Full|Work|Family|None>]'); process.exit(1); }
  const grantsIdx = args.indexOf('--grant-types');
  const scopesIdx = args.indexOf('--scopes');
  const tierIdx = args.indexOf('--tier');
  const grantTypes = grantsIdx >= 0 && args[grantsIdx + 1]
    ? args[grantsIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : ['client_credentials'];
  const scopes = scopesIdx >= 0 && args[scopesIdx + 1] ? args[scopesIdx + 1] : 'read';
  // Per-client access tier. Default Full preserves the pre-v45 grant
  // for upgrade safety; operators tighten per-client with --tier work
  // (or --tier family) when registering an agent that should not see
  // owner-only content. ACCESS_POLICY.md is the human-readable map of
  // which tier each agent should land in.
  const { parseAccessTier, ACCESS_TIER_DEFAULT } = await import('../core/access-tier.ts');
  let accessTier: import('../core/access-tier.ts').AccessTier;
  if (tierIdx >= 0) {
    const tierVal = args[tierIdx + 1];
    if (tierVal === undefined || tierVal.startsWith('--')) {
      console.error('Error: --tier requires a value (Full|Work|Family|None)');
      process.exit(1);
    }
    try {
      const parsed = parseAccessTier(tierVal);
      if (!parsed) {
        console.error('Error: --tier value is empty');
        process.exit(1);
      }
      accessTier = parsed;
    } catch (e: any) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  } else {
    accessTier = ACCESS_TIER_DEFAULT;
  }

  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
    const provider = new GBrainOAuthProvider({ sql: sql as any });
    const { clientId, clientSecret } = await provider.registerClientManual(
      name, grantTypes, scopes, [], accessTier,
    );
    console.log(`OAuth client registered: "${name}"\n`);
    console.log(`  Client ID:     ${clientId}`);
    console.log(`  Client Secret: ${clientSecret}\n`);
    console.log(`  Grant types: ${grantTypes.join(', ')}`);
    console.log(`  Scopes:      ${scopes}`);
    console.log(`  Access tier: ${accessTier}\n`);
    if (accessTier === 'Full') {
      console.log('NOTE: tier=Full is the default. Pass --tier Work (or Family) to restrict.');
      console.log('See ACCESS_POLICY.md.\n');
    }
    console.log('Save the client secret — it will not be shown again.');
    console.log(`Revoke with: gbrain auth revoke-client "${clientId}"`);
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

async function setTier(clientId: string, tierArg: string) {
  if (!clientId || !tierArg) {
    console.error('Usage: auth set-tier <client_id> <Full|Work|Family|None>');
    process.exit(1);
  }
  const { parseAccessTier } = await import('../core/access-tier.ts');
  let tier: import('../core/access-tier.ts').AccessTier;
  try {
    const parsed = parseAccessTier(tierArg);
    if (!parsed) throw new Error(`tier value "${tierArg}" is empty or unrecognised`);
    tier = parsed;
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
    const provider = new GBrainOAuthProvider({ sql: sql as any });
    const ok = await provider.setClientAccessTier(clientId, tier);
    if (!ok) {
      console.error(`No OAuth client found with id "${clientId}".`);
      process.exit(1);
    }
    console.log(`Updated access_tier for ${clientId} -> ${tier}.`);
    console.log('New requests pick up the new tier immediately; in-flight dispatch finishes under the tier it started with.');
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// v0.32 OIDC end-user identity: oauth_user_grants surface.
//
// The OIDC code path resolves a per-request tier as `min(client_tier,
// user_tier)` where user_tier comes from the row in oauth_user_grants
// keyed by the verified id_token email claim. These three functions are
// the operator-side admin surface for that table; the OIDC verifier and
// the runtime tier-resolution code live in src/core/oidc.ts and
// src/core/oauth-provider.ts (separate agents).
// ---------------------------------------------------------------------------

/**
 * Insert or update a row in oauth_user_grants. Idempotent: re-granting
 * an existing email overwrites the tier and clears `revoked_at`, which
 * un-revokes a previously revoked grant in a single statement. The
 * `granted_by` column is populated from `git config user.email` when
 * available; falls back to the literal 'cli' so the audit row is
 * always non-NULL.
 *
 * Exported for direct testing from test/auth-grants.test.ts; the
 * runAuth dispatcher calls it with no `sqlOverride` and gets the
 * postgres-js connection.
 */
export async function grantUser(
  email: string,
  tierArg: string,
  sqlOverride?: SqlClient,
): Promise<void> {
  if (!email || !tierArg) {
    console.error('Usage: auth grant <email> <Full|Work|Family|None>');
    process.exit(1);
  }

  // Normalize first so the validator and the persisted row see the same shape.
  const normalized = email.trim().toLowerCase();
  const emailError = validateEmail(normalized);
  if (emailError) {
    console.error(`Error: invalid email: ${emailError}`);
    process.exit(1);
  }

  const { parseAccessTier } = await import('../core/access-tier.ts');
  let tier: import('../core/access-tier.ts').AccessTier;
  try {
    const parsed = parseAccessTier(tierArg);
    if (!parsed) {
      console.error('Error: tier value is empty');
      process.exit(1);
    }
    tier = parsed;
  } catch (e: any) {
    // parseAccessTier throws InvalidAccessTierError for typos; surface
    // the message verbatim so the operator sees the allowed set.
    console.error('Error:', e.message);
    process.exit(1);
  }

  const grantedBy = detectGrantedBy();
  const { sql, end } = openSql(sqlOverride);
  try {
    // ON CONFLICT (email) -> overwrite tier, clear revoked_at, refresh
    // granted_at and granted_by. The clear-on-conflict is the un-revoke
    // path; without it a re-grant after revoke-grant would silently
    // remain revoked.
    await sql`
      INSERT INTO oauth_user_grants (email, access_tier, granted_at, granted_by, revoked_at)
      VALUES (${normalized}, ${tier}, now(), ${grantedBy}, NULL)
      ON CONFLICT (email) DO UPDATE
        SET access_tier = EXCLUDED.access_tier,
            granted_at  = EXCLUDED.granted_at,
            granted_by  = EXCLUDED.granted_by,
            revoked_at  = NULL
    `;
    console.log(`Granted ${tier} to ${normalized}`);
    console.log('Takes effect on next OIDC sign-in. The OAuth /authorize flow');
    console.log('looks this up after id_token verification and resolves the');
    console.log('per-request tier as min(client_tier, user_tier).');
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await end();
  }
}

/**
 * Soft-delete a grant by setting `revoked_at = now()`. Mirrors the
 * `oauth_clients.deleted_at` pattern: the row stays in place so audit
 * still resolves email -> tier history; the OIDC tier resolver gates on
 * `revoked_at IS NULL`. Re-granting via `auth grant` clears the
 * revoked_at field (see grantUser).
 *
 * The output explicitly notes that already-issued access_tokens with
 * subject_email retain their tier until expiry - operators reaching for
 * revoke-grant during an incident should also revoke the relevant
 * tokens via `auth revoke-client` or by sweeping oauth_tokens directly.
 */
export async function revokeUserGrant(
  email: string,
  sqlOverride?: SqlClient,
): Promise<void> {
  if (!email) {
    console.error('Usage: auth revoke-grant <email>');
    process.exit(1);
  }
  const normalized = email.trim().toLowerCase();
  // No re-validation here: a malformed email simply won't match any row,
  // which falls through to the "no active grant" branch below. Keeps
  // revoke-grant useful as a cleanup tool for legacy rows that pre-date
  // the validator.

  const { sql, end } = openSql(sqlOverride);
  try {
    const rows = await sql`
      UPDATE oauth_user_grants
        SET revoked_at = now()
        WHERE email = ${normalized} AND revoked_at IS NULL
      RETURNING email
    `;
    if (rows.length === 0) {
      console.error(`No active grant for ${normalized}`);
      process.exit(1);
    }
    console.log(`Revoked grant for ${normalized}`);
    console.log(`Revocation takes effect on next OIDC sign-in. Existing access_tokens with subject_email=${normalized} retain their tier until expiry.`);
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await end();
  }
}

/**
 * List rows in oauth_user_grants. Schema-aware: a brain that has not yet
 * run the v46 migration prints a friendly hint and exits 0 (the table
 * absence is a config state, not an error). Output columns mirror
 * list-clients: ASCII separator, fixed-width columns, REVOKED/active
 * status derived from `revoked_at`. Sort by granted_at DESC so the most
 * recent grants are at the top.
 */
export async function listUserGrants(sqlOverride?: SqlClient): Promise<void> {
  const { sql, end } = openSql(sqlOverride);
  try {
    const columns = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'oauth_user_grants'
    `;
    if (columns.length === 0) {
      // Mirrors listClients: a missing table is a "needs migrate" state,
      // not a hard error. Operators running list-grants on a pre-v46
      // brain shouldn't get a 42P01 trace.
      console.log('No grants table on this brain. Run `gbrain apply-migrations` first.');
      return;
    }
    const rows = await sql`
      SELECT email, access_tier, granted_at, granted_by, revoked_at
      FROM oauth_user_grants
      ORDER BY granted_at DESC
    `;
    if (rows.length === 0) {
      console.log('No user grants. Create one: gbrain auth grant <email> <Full|Work|Family|None>');
      return;
    }
    console.log('Email                                   Tier    Granted At           Granted By                Status');
    console.log('-'.repeat(110));
    for (const r of rows) {
      const email = (String(r.email ?? '')).padEnd(38);
      const tier = String(r.access_tier ?? '').padEnd(7);
      const granted = r.granted_at
        ? new Date(r.granted_at as string).toISOString().slice(0, 19)
        : 'unknown'.padEnd(19);
      const grantedBy = String(r.granted_by ?? '').padEnd(24);
      const status = r.revoked_at ? 'REVOKED' : 'active';
      console.log(`${email}  ${tier}  ${granted}  ${grantedBy}  ${status}`);
    }
  } finally {
    await end();
  }
}

/**
 * Entry point for the `gbrain auth` CLI subcommand. Also reused by the
 * direct-script path (see bottom of file) so `bun run src/commands/auth.ts`
 * still works.
 */
export async function runAuth(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'create': {
      // v0.28: optional --takes-holders world,garry,brain (default: world only)
      const takesIdx = rest.indexOf('--takes-holders');
      const takesHolders = takesIdx >= 0 && rest[takesIdx + 1]
        ? rest[takesIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const positional = rest.find(a => !a.startsWith('--') && a !== rest[takesIdx + 1]);
      await create(positional || '', { takesHolders });
      return;
    }
    case 'list': await list(); return;
    case 'revoke': await revoke(rest[0]); return;
    case 'permissions': {
      // gbrain auth permissions <name> set-takes-holders world,garry
      await permissions(rest[0] || '', rest[1] || '', rest[2]);
      return;
    }
    case 'register-client': await registerClient(rest[0], rest.slice(1)); return;
    case 'list-clients': await listClients(); return;
    case 'revoke-client': await revokeClient(rest[0]); return;
    case 'set-tier': await setTier(rest[0], rest[1]); return;
    case 'grant': await grantUser(rest[0] || '', rest[1] || ''); return;
    case 'revoke-grant': await revokeUserGrant(rest[0] || ''); return;
    case 'list-grants': await listUserGrants(); return;
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
  gbrain auth create <name> [--takes-holders world,garry,brain]
                                                          Create a legacy bearer token. v0.28: --takes-holders
                                                          sets the per-token allow-list for the takes.holder
                                                          field (default: ["world"]). MCP-bound calls to
                                                          takes_list / takes_search / query filter by this.
  gbrain auth list                                         List all tokens
  gbrain auth revoke <name>                                Revoke a legacy token
  gbrain auth permissions <name> set-takes-holders <h1,h2,h3>
                                                          Update visibility for an existing token
  gbrain auth register-client <name> [options]             Register an OAuth 2.1 client (v0.26+)
     --grant-types <client_credentials,authorization_code> (default: client_credentials)
     --scopes "<read write admin>"                         (default: read)
     --tier <Full|Work|Family|None>                        (default: Full; runtime MCP access control)
  gbrain auth list-clients                                List OAuth clients with id, name, access_tier, scope, status
  gbrain auth revoke-client <client_id>                   Hard-delete an OAuth 2.1 client (cascades to tokens + codes)
  gbrain auth set-tier <client_id> <Full|Work|Family|None> Update an existing client's access tier
  gbrain auth grant <email> <Full|Work|Family|None>       v0.32: insert/update an end-user OIDC grant.
                                                          Re-granting an existing email overwrites the
                                                          tier and clears revoked_at.
  gbrain auth revoke-grant <email>                        v0.32: soft-revoke an OIDC end-user grant.
                                                          Existing access_tokens keep their tier until
                                                          expiry; revocation gates the next sign-in.
  gbrain auth list-grants                                 v0.32: list OIDC end-user grants with email,
                                                          tier, granted_at, granted_by, status.
  gbrain auth test <url> --token <token>                  Smoke-test a remote MCP server
`);
  }
}

// Direct-script entry point — only runs when this file is invoked as the main module
// (e.g. `bun run src/commands/auth.ts ...`). When imported by cli.ts, this block is skipped.
if (import.meta.main) {
  await runAuth(process.argv.slice(2));
}
