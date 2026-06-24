#!/usr/bin/env bun
/**
 * MBrain token management — standalone script, no mbrain CLI dependency.
 *
 * Usage:
 *   DATABASE_URL=... bun run src/commands/auth.ts create "claude-desktop" --scope canonical_write
 *   DATABASE_URL=... bun run src/commands/auth.ts list
 *   DATABASE_URL=... bun run src/commands/auth.ts revoke "claude-desktop"
 *   DATABASE_URL=... bun run src/commands/auth.ts test <url> --token <token>
 */
import postgres from 'postgres';
import { createHash, randomBytes } from 'crypto';

const MANUAL_TOKEN_SCOPES = new Set(['mcp', 'canonical_write', 'raw_source']);
const DATABASE_URL = process.env.DATABASE_URL || process.env.MBRAIN_DATABASE_URL;
if (!DATABASE_URL && process.argv[2] !== 'test') {
  console.error('Set DATABASE_URL or MBRAIN_DATABASE_URL environment variable.');
  process.exit(1);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'mbrain_' + randomBytes(32).toString('hex');
}

async function create(name: string, scopes: string[] = ['mcp']) {
  if (!name) { console.error('Usage: auth create <name>'); process.exit(1); }
  const sql = postgres(DATABASE_URL!);
  const token = generateToken();
  const hash = hashToken(token);

  try {
    await sql`
      INSERT INTO access_tokens (name, token_hash, scopes)
      VALUES (${name}, ${hash}, ${scopes})
    `;
    console.log(`Token created for "${name}":\n`);
    console.log(`  ${token}\n`);
    console.log(`Scopes: ${scopes.join(', ')}`);
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
  const sql = postgres(DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT name, created_at, last_used_at, revoked_at, scopes
      FROM access_tokens
      ORDER BY created_at DESC
    `;
    if (rows.length === 0) {
      console.log('No tokens found. Create one: bun run src/commands/auth.ts create "my-client"');
      return;
    }
    console.log('Name                  Created              Last Used            Status   Scopes');
    console.log('─'.repeat(100));
    for (const r of rows) {
      const name = (r.name as string).padEnd(20);
      const created = new Date(r.created_at as string).toISOString().slice(0, 19);
      const lastUsed = r.last_used_at ? new Date(r.last_used_at as string).toISOString().slice(0, 19) : 'never'.padEnd(19);
      const status = r.revoked_at ? 'REVOKED' : 'active';
      const scopes = Array.isArray(r.scopes) ? r.scopes.join(',') : 'mcp';
      console.log(`${name}  ${created}  ${lastUsed}  ${status.padEnd(7)}  ${scopes}`);
    }
  } finally {
    await sql.end();
  }
}

async function revoke(name: string) {
  if (!name) { console.error('Usage: auth revoke <name>'); process.exit(1); }
  const sql = postgres(DATABASE_URL!);
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
          clientInfo: { name: 'mbrain-smoke-test', version: '1.0' },
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

// CLI dispatch
function parseCreateArgs(args: string[]): { name: string; scopes: string[] } {
  const scopes = new Set<string>(['mcp']);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--scope' || arg === '--scopes') {
      for (const scope of parseScopeList(args[++index] ?? '')) scopes.add(scope);
      continue;
    }
    if (arg.startsWith('--scope=')) {
      for (const scope of parseScopeList(arg.slice('--scope='.length))) scopes.add(scope);
      continue;
    }
    if (arg.startsWith('--scopes=')) {
      for (const scope of parseScopeList(arg.slice('--scopes='.length))) scopes.add(scope);
      continue;
    }
    positional.push(arg);
  }
  const invalidScopes = [...scopes].filter(scope => !MANUAL_TOKEN_SCOPES.has(scope));
  if (invalidScopes.length > 0) {
    console.error(`Unsupported scope(s): ${invalidScopes.join(', ')}`);
    console.error(`Allowed scopes: ${[...MANUAL_TOKEN_SCOPES].join(', ')}`);
    process.exit(1);
  }
  return { name: positional[0] ?? '', scopes: [...scopes] };
}

function parseScopeList(raw: string): string[] {
  return raw.split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'create': {
    const parsed = parseCreateArgs(args);
    await create(parsed.name, parsed.scopes);
    break;
  }
  case 'list': await list(); break;
  case 'revoke': await revoke(args[0]); break;
  case 'test': {
    const tokenIdx = args.indexOf('--token');
    const url = args.find(a => !a.startsWith('--') && a !== args[tokenIdx + 1]);
    const token = tokenIdx >= 0 ? args[tokenIdx + 1] : '';
    await test(url || '', token || '');
    break;
  }
  default:
    console.log(`MBrain Token Management

Usage:
  bun run src/commands/auth.ts create <name> [--scope canonical_write] [--scope raw_source]
                                                    Create a new access token
  bun run src/commands/auth.ts list               List all tokens
  bun run src/commands/auth.ts revoke <name>       Revoke a token
  bun run src/commands/auth.ts test <url> --token <token>  Smoke test a remote MCP server
`);
}
