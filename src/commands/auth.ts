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

function getDatabaseUrl(requireDb: boolean): string | undefined {
  const url = process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL;
  if (!url && requireDb) {
    console.error('Set DATABASE_URL or GBRAIN_DATABASE_URL environment variable.');
    process.exit(1);
  }
  return url;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'gbrain_' + randomBytes(32).toString('hex');
}

async function create(name: string) {
  if (!name) { console.error('Usage: auth create <name>'); process.exit(1); }
  const sql = postgres(getDatabaseUrl(true)!);
  const token = generateToken();
  const hash = hashToken(token);

  try {
    await sql`
      INSERT INTO access_tokens (name, token_hash)
      VALUES (${name}, ${hash})
    `;
    console.log(`Token created for "${name}":\n`);
    console.log(`  ${token}\n`);
    console.log('Save this token — it will not be shown again.');
    console.log(`Revoke with: bun run src/commands/auth.ts revoke "${name}"`);
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
  if (!name) { console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S]'); process.exit(1); }
  const grantsIdx = args.indexOf('--grant-types');
  const scopesIdx = args.indexOf('--scopes');
  const grantTypes = grantsIdx >= 0 && args[grantsIdx + 1]
    ? args[grantsIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : ['client_credentials'];
  const scopes = scopesIdx >= 0 && args[scopesIdx + 1] ? args[scopesIdx + 1] : 'read';

  const sql = postgres(getDatabaseUrl(true)!);
  try {
    const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
    const provider = new GBrainOAuthProvider({ sql: sql as any });
    const { clientId, clientSecret } = await provider.registerClientManual(
      name, grantTypes, scopes, [],
    );
    console.log(`OAuth client registered: "${name}"\n`);
    console.log(`  Client ID:     ${clientId}`);
    console.log(`  Client Secret: ${clientSecret}\n`);
    console.log(`  Grant types: ${grantTypes.join(', ')}`);
    console.log(`  Scopes:      ${scopes}\n`);
    console.log('Save the client secret — it will not be shown again.');
    console.log(`Revoke with: gbrain auth revoke-client "${clientId}"`);
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sql.end();
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
    case 'create': await create(rest[0]); return;
    case 'list': await list(); return;
    case 'revoke': await revoke(rest[0]); return;
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
  gbrain auth create <name>                                Create a legacy bearer token
  gbrain auth list                                         List all tokens
  gbrain auth revoke <name>                                Revoke a legacy token
  gbrain auth register-client <name> [options]            Register an OAuth 2.1 client
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
