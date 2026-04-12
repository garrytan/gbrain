import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import { startMcpServer } from '../mcp/server.ts';
import { startHttpMcpServer, type TokenValidator } from '../mcp/http-server.ts';

/**
 * Create a token validator following established repo patterns:
 * - Postgres: standalone postgres() connection, same as auth.ts (lines 30, 56, 83)
 * - PGLite: (engine as any).db, same as init.ts (line 116)
 */
function createTokenValidator(engine: BrainEngine, config: GBrainConfig): TokenValidator {
  if (config.database_url) {
    let sql: ReturnType<typeof import('postgres').default> | null = null;
    return async (token: string): Promise<string | null> => {
      const hash = createHash('sha256').update(token).digest('hex');
      try {
        if (!sql) {
          const postgres = (await import('postgres')).default;
          sql = postgres(config.database_url!, { max: 2, idle_timeout: 20 });
        }
        const rows = await sql`SELECT name FROM access_tokens WHERE token_hash = ${hash} AND revoked_at IS NULL`;
        if (rows.length === 0) return null;
        const tokenName = rows[0].name as string;
        sql`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${hash}`.catch(() => {});
        return tokenName;
      } catch (e: unknown) {
        process.stderr.write(`[error] Token validation failed: ${e instanceof Error ? e.message : e}\n`);
        return null;
      }
    };
  }

  return async (token: string): Promise<string | null> => {
    const hash = createHash('sha256').update(token).digest('hex');
    try {
      const db = (engine as any).db;
      if (!db) { process.stderr.write('[warn] Token validation: no DB connection\n'); return null; }
      const { rows } = await db.query(
        `SELECT name FROM access_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [hash]
      );
      if (rows.length === 0) return null;
      const tokenName = (rows[0] as { name: string }).name;
      db.query(`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = $1`, [hash]).catch(() => {});
      return tokenName;
    } catch (e: unknown) {
      process.stderr.write(`[error] Token validation failed: ${e instanceof Error ? e.message : e}\n`);
      return null;
    }
  };
}

export async function runServe(engine: BrainEngine, args: string[] = []) {
  if (args.includes('--http')) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8787;
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port. Usage: gbrain serve --http --port 8787');
      process.exit(1);
    }
    const config = loadConfig() || { engine: 'postgres' as const };
    const tokenValidator = args.includes('--auth') ? createTokenValidator(engine, config) : undefined;
    await startHttpMcpServer(engine, { port, tokenValidator });
  } else {
    console.error('Starting GBrain MCP server (stdio)...');
    await startMcpServer(engine);
  }
}
