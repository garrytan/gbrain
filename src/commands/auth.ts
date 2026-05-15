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

async function create(name: string, opts: { takesHolders?: string[] } = {}) {
  if (!name) { console.error('Usage: auth create <name> [--takes-holders world,garry]'); process.exit(1); }
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
      await executeRawJsonb(
        engine,
        `INSERT INTO access_tokens (name, token_hash, permissions)
         VALUES ($1, $2, $3::jsonb)`,
        [name, hash],
        [permissions],
      );
      console.log(`Token created for "${name}" (takes_holders=${JSON.stringify(takesHolders)}):\n`);
      console.log(`  ${token}\n`);
      console.log('Save this token — it will not be shown again.');
      console.log(`Revoke with: gbrain auth revoke "${name}"`);
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
      const result = await executeRawJsonb(
        engine,
        `UPDATE access_tokens
            SET permissions = $2::jsonb
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

async function list() {
  await withConfiguredSql(async (sql) => {
    const rows = await sql`
      SELECT name, created_at, last_used_at, revoked_at
      FROM access_tokens
      ORDER BY created_at DESC
    `;
    if (rows.length === 0) {
      console.log('No tokens found. Create one: gbrain auth create "my-client"');
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
  });
}

async function revoke(name: string) {
  if (!name) { console.error('Usage: auth revoke <name>'); process.exit(1); }
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
    console.log(`Token "${name}" revoked.`);
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

async function registerClient(name: string, args: string[]) {
  if (!name) {
    console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--source SOURCE] [--federated-read SRC1,SRC2,...]');
    process.exit(1);
  }
  const grantsIdx = args.indexOf('--grant-types');
  const scopesIdx = args.indexOf('--scopes');
  const sourceIdx = args.indexOf('--source');
  const federatedIdx = args.indexOf('--federated-read');
  const grantTypes = grantsIdx >= 0 && args[grantsIdx + 1]
    ? args[grantsIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : ['client_credentials'];
  const scopes = scopesIdx >= 0 && args[scopesIdx + 1] ? args[scopesIdx + 1] : 'read';
  // v0.34.1 (#861, D2): --source flag scopes the OAuth client to a single
  // source. Defaults to 'default' to match migration v59's backfill so
  // operators upgrading without changing flags see no behavior change.
  const sourceId = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'default';
  // v0.34.1 (#876): --federated-read accepts a comma-separated source list
  // for federated read scope. When omitted, federated_read defaults to
  // [sourceId] (read scope == write scope, the v0.33 default).
  const federatedRead = federatedIdx >= 0 && args[federatedIdx + 1]
    ? args[federatedIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  try {
    await withConfiguredSql(async (sql) => {
      const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
      const provider = new GBrainOAuthProvider({ sql });
      const { clientId, clientSecret } = await provider.registerClientManual(
        name, grantTypes, scopes, [], sourceId, federatedRead,
      );
      const effectiveFederated = federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];
      console.log(`OAuth client registered: "${name}"\n`);
      console.log(`  Client ID:        ${clientId}`);
      console.log(`  Client Secret:    ${clientSecret}\n`);
      console.log(`  Grant types:      ${grantTypes.join(', ')}`);
      console.log(`  Scopes:           ${scopes}`);
      console.log(`  Write source:     ${sourceId}`);
      console.log(`  Federated reads:  ${effectiveFederated.join(', ')}\n`);
      console.log('Save the client secret — it will not be shown again.');
      console.log(`Revoke with: gbrain auth revoke-client "${clientId}"`);
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
    case 'revoke-client': await revokeClient(rest[0]); return;
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
