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
import { createHash, createHmac, randomBytes } from 'crypto';

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

function signJwtHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${h}.${p}`;
  const s = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${s}`;
}

function jwtTtlSeconds(): number {
  const raw = process.env.GBRAIN_JWT_TTL_SECONDS;
  if (!raw) return 60 * 60 * 24 * 90;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 24 * 90;
}

async function createJwt(name: string) {
  if (!name) { console.error('Usage: auth create <name>'); process.exit(1); }
  const secret = process.env.GBRAIN_JWT_SECRET;
  if (!secret) {
    console.error('GBRAIN_JWT_SECRET is required for JWT creation.');
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = jwtTtlSeconds();
  const jti = randomBytes(16).toString('hex');
  const payload: Record<string, unknown> = { sub: name, name, jti, iat: now, exp: now + ttl };
  if (process.env.GBRAIN_JWT_ISSUER) payload.iss = process.env.GBRAIN_JWT_ISSUER;
  if (process.env.GBRAIN_JWT_AUDIENCE) payload.aud = process.env.GBRAIN_JWT_AUDIENCE;

  const token = signJwtHs256(payload, secret);
  console.log(`JWT created for "${name}":\n`);
  console.log(`  ${token}\n`);
  console.log(`Expires at: ${new Date((now + ttl) * 1000).toISOString()}`);
  console.log('Stateless JWT mode: revoke/list do not track this token unless you also use legacy tokens.');
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

async function createLegacy(name: string) {
  await create(name);
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

/**
 * Entry point for the `gbrain auth` CLI subcommand. Also reused by the
 * direct-script path (see bottom of file) so `bun run src/commands/auth.ts`
 * still works.
 */
export async function runAuth(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'create': {
      if (process.env.GBRAIN_JWT_SECRET) await createJwt(rest[0]);
      else await createLegacy(rest[0]);
      return;
    }
    case 'create-jwt': await createJwt(rest[0]); return;
    case 'create-legacy': await createLegacy(rest[0]); return;
    case 'list': await list(); return;
    case 'revoke': await revoke(rest[0]); return;
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
  gbrain auth create <name>           Create JWT if GBRAIN_JWT_SECRET is set, else legacy token
  gbrain auth create-jwt <name>       Force-create a JWT access token
  gbrain auth create-legacy <name>    Force-create a DB-backed legacy token
  gbrain auth list                    List all tokens
  gbrain auth revoke <name>           Revoke a token
  gbrain auth test <url> --token <t>  Smoke-test a remote MCP server
`);
  }
}

// Direct-script entry point — only runs when this file is invoked as the main module
// (e.g. `bun run src/commands/auth.ts ...`). When imported by cli.ts, this block is skipped.
if (import.meta.main) {
  await runAuth(process.argv.slice(2));
}
