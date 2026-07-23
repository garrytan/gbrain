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
import { pgArray } from '../core/oauth-provider.ts';
import { assertValidSourceId } from '../core/source-id.ts';

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

/**
 * `gbrain auth list-clients [--json]` — read surface for OAuth 2.1 clients.
 *
 * The existing `gbrain auth list` shows LEGACY bearer tokens from
 * `access_tokens`; this is the parallel for v0.26+ OAuth clients. Separate
 * commands rather than merged output because the two models have different
 * field sets (legacy: lifecycle dates; OAuth: scopes + source_id +
 * federated_read).
 *
 * Human output is card-style (multi-line per client) instead of a fixed-
 * width table — federated_read can hold many ids per client and a wide
 * single-line layout truncates / wraps badly on terminals < 200 cols.
 * JSON output uses a `schema_version: 1` envelope; additive only.
 */
async function listClients(args: string[]) {
  const json = args.includes('--json');
  const includeDeleted = args.includes('--include-deleted');
  await withConfiguredSql(async (sql) => {
    // Codex finding #2 (medium): default-hide soft-deleted clients so admin
    // soft-deletes are honored by the CLI surface. Opt-in via flag.
    const rows = includeDeleted
      ? await sql`
          SELECT client_id, client_name, scope, source_id, federated_read,
                 grant_types, created_at, deleted_at
          FROM oauth_clients
          ORDER BY client_name
        `
      : await sql`
          SELECT client_id, client_name, scope, source_id, federated_read,
                 grant_types, created_at, deleted_at
          FROM oauth_clients
          WHERE deleted_at IS NULL
          ORDER BY client_name
        `;
    if (json) {
      const clients = rows.map((r) => ({
        client_id: String(r.client_id),
        client_name: String(r.client_name),
        scope: r.scope == null ? null : String(r.scope),
        source_id: r.source_id == null ? null : String(r.source_id),
        federated_read: Array.isArray(r.federated_read)
          ? (r.federated_read as string[]).map(String)
          : [],
        grant_types: Array.isArray(r.grant_types)
          ? (r.grant_types as string[]).map(String)
          : [],
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : r.created_at == null
              ? null
              : String(r.created_at),
        deleted_at:
          r.deleted_at instanceof Date
            ? r.deleted_at.toISOString()
            : r.deleted_at == null
              ? null
              : String(r.deleted_at),
      }));
      process.stdout.write(JSON.stringify({ schema_version: 1, clients }, null, 2) + '\n');
      return;
    }
    if (rows.length === 0) {
      console.log(
        includeDeleted
          ? 'No OAuth clients found (including deleted). Register one: gbrain auth register-client <name>'
          : 'No active OAuth clients found. Register one: gbrain auth register-client <name>'
            + '\n(Use --include-deleted to also show soft-deleted clients.)',
      );
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const fed = Array.isArray(r.federated_read)
        ? (r.federated_read as string[]).map(String)
        : [];
      const grants = Array.isArray(r.grant_types)
        ? (r.grant_types as string[]).map(String)
        : [];
      const deletedAt = r.deleted_at;
      const status = deletedAt == null
        ? ''
        : ` [SOFT-DELETED ${deletedAt instanceof Date ? deletedAt.toISOString() : String(deletedAt)}]`;
      console.log(`${sanitizeForTerminal(String(r.client_name))}${status}`);
      console.log(`  client_id:    ${sanitizeForTerminal(String(r.client_id))}`);
      console.log(`  scope:        ${r.scope == null ? '(none)' : sanitizeForTerminal(String(r.scope))}`);
      console.log(`  grant types:  ${grants.length ? sanitizeForTerminal(grants.join(', ')) : '(none)'}`);
      console.log(`  write source: ${r.source_id == null ? '(none)' : sanitizeForTerminal(String(r.source_id))}`);
      console.log(`  federated:    ${fed.length ? sanitizeForTerminal(fed.join(', ')) : '(empty)'}`);
      if (i < rows.length - 1) console.log('');
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

/**
 * Strip ANSI escapes + C0/C1 control characters from a string before
 * printing it to the operator's terminal. Defense for the
 * codex-flagged terminal-control-injection class: a client_name or
 * source_id registered via DCR with `\x1b[2J` (clear-screen) or
 * `\x1b]0;TITLE\x07` (OSC title-change) would poison
 * `gbrain auth list-clients` output otherwise.
 *
 * Replaces unsafe bytes with their `\xNN` hex escape so the operator
 * sees that something weird is in the field, instead of silent
 * mutilation. Tab and newline are preserved as-is so legitimate
 * multi-line values render.
 */
export function sanitizeForTerminal(s: string): string {
  // ALL C0/C1 controls + DEL get escaped. Codex re-review caught that
  // preserving `\n` lets a DCR-registered client_name spoof additional
  // human-output lines in list-clients (a real attack — newline in the
  // name visually adds a fake row to the operator's terminal). Tab is
  // also escaped for the same reason — field-separator spoofing.
  // C0: 0x00-0x1F. DEL: 0x7F. C1: 0x80-0x9F.
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (ch) =>
    `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

export interface ResolvedClient {
  client_id: string;
  client_name: string;
  source_id: string | null;
  federated_read: string[];
  deleted_at: Date | string | null;
}

export type FederatedReadOutcome =
  | { kind: 'noop'; reason: 'already-granted' | 'not-present' | 'same-list'; client: ResolvedClient; current: string[] }
  | { kind: 'updated'; client: ResolvedClient; before: string[]; after: string[] };

/**
 * Resolve an OAuth client by client_id (exact) or client_name (unique).
 * Errors on no-match and on ambiguous client_name (>1 row). client_id
 * takes precedence — if a long hash is passed and matches, returns
 * immediately without ever querying by name.
 *
 * Legacy bearer tokens in `access_tokens` are NOT searched. Federated read
 * scope is an OAuth-client concept (oauth_clients.federated_read column);
 * legacy bearers have no source scope.
 */
/**
 * Resolve an OAuth client. Codex finding #2 (medium): default-hide
 * soft-deleted clients so admin-soft-deleted rows aren't mutated by the
 * CLI. The `includeDeleted` opt is reserved for future read-side surfaces;
 * grant/revoke/set ALWAYS filter active rows only.
 */
export async function resolveClient(
  sql: SqlQuery,
  nameOrId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<ResolvedClient> {
  const allowDeleted = opts.includeDeleted === true;
  const byId = allowDeleted
    ? await sql`
        SELECT client_id, client_name, source_id, federated_read, deleted_at
        FROM oauth_clients WHERE client_id = ${nameOrId} LIMIT 1
      `
    : await sql`
        SELECT client_id, client_name, source_id, federated_read, deleted_at
        FROM oauth_clients WHERE client_id = ${nameOrId} AND deleted_at IS NULL LIMIT 1
      `;
  if (byId.length === 1) return normalizeClientRow(byId[0]);
  const byName = allowDeleted
    ? await sql`
        SELECT client_id, client_name, source_id, federated_read, deleted_at
        FROM oauth_clients WHERE client_name = ${nameOrId}
      `
    : await sql`
        SELECT client_id, client_name, source_id, federated_read, deleted_at
        FROM oauth_clients WHERE client_name = ${nameOrId} AND deleted_at IS NULL
      `;
  if (byName.length === 0) {
    throw new Error(
      `No active OAuth client found with name or id "${nameOrId}". ` +
        `Run \`gbrain auth register-client <name>\` to create one, ` +
        `or \`gbrain auth list-clients\` to see what exists. ` +
        `(Soft-deleted clients are hidden by default.)`,
    );
  }
  if (byName.length > 1) {
    const ids = byName.map((r) => `  ${String(r.client_id)}`).join('\n');
    throw new Error(
      `Multiple active OAuth clients named "${nameOrId}". Pass the full client_id instead:\n${ids}`,
    );
  }
  return normalizeClientRow(byName[0]);
}

function normalizeClientRow(row: Record<string, unknown>): ResolvedClient {
  const fed = row.federated_read;
  return {
    client_id: String(row.client_id),
    client_name: String(row.client_name),
    source_id: row.source_id == null ? null : String(row.source_id),
    federated_read: Array.isArray(fed) ? (fed as string[]).map(String) : [],
    deleted_at: row.deleted_at == null
      ? null
      : (row.deleted_at as Date | string),
  };
}

/**
 * Validate the source_id shape AND DB existence. Codex finding #3 (medium):
 * a manually-INSERTed source row with weird chars (e.g. comma, quote)
 * would otherwise land in oauth_clients.federated_read as a never-deletable
 * malformed entry. Fail at the boundary before the existence query so
 * malformed input gets the validator's hint, not a "does not exist" hint
 * pointing at a non-creatable id.
 */
export async function assertSourceExists(sql: SqlQuery, sourceId: string): Promise<void> {
  assertValidSourceId(sourceId);
  const rows = await sql`SELECT id FROM sources WHERE id = ${sourceId} LIMIT 1`;
  if (rows.length === 0) {
    throw new Error(
      `Source "${sourceId}" does not exist. Run \`gbrain sources list\` to see registered sources, ` +
        `or \`gbrain sources add ${sourceId}\` to create it.`,
    );
  }
}

/**
 * Atomic append: array_append + NOT-ANY guard so the row-lock fully
 * serializes concurrent grant/revoke against the same client. Codex
 * finding #1 (HIGH): the previous read-modify-write shape allowed a
 * concurrent revoke to be silently UNDONE by a racing grant.
 *
 * Returns the post-write federated_read array, or null when no rows
 * matched (already-granted, soft-deleted, or missing client). Callers
 * disambiguate via prior resolveClient + includes() check.
 *
 * `WHERE deleted_at IS NULL` is part of the atomic guard so a client
 * soft-deleted between resolveClient and the UPDATE can't be mutated.
 */
async function appendFederatedReadAtomic(
  sql: SqlQuery,
  clientId: string,
  sourceId: string,
): Promise<string[] | null> {
  const rows = await sql`
    UPDATE oauth_clients
    SET federated_read = array_append(federated_read, ${sourceId})
    WHERE client_id = ${clientId}
      AND deleted_at IS NULL
      AND NOT (${sourceId} = ANY(federated_read))
    RETURNING federated_read
  `;
  if (rows.length === 0) return null;
  const fed = rows[0].federated_read;
  return Array.isArray(fed) ? (fed as string[]).map(String) : [];
}

/**
 * Atomic remove: array_remove + ANY guard. Same race-correctness story
 * as appendFederatedReadAtomic. Returns post-write array or null.
 */
async function removeFederatedReadAtomic(
  sql: SqlQuery,
  clientId: string,
  sourceId: string,
): Promise<string[] | null> {
  const rows = await sql`
    UPDATE oauth_clients
    SET federated_read = array_remove(federated_read, ${sourceId})
    WHERE client_id = ${clientId}
      AND deleted_at IS NULL
      AND ${sourceId} = ANY(federated_read)
    RETURNING federated_read
  `;
  if (rows.length === 0) return null;
  const fed = rows[0].federated_read;
  return Array.isArray(fed) ? (fed as string[]).map(String) : [];
}

/**
 * Wholesale array overwrite for `set-federated-read`. Honors the
 * deleted_at filter. Last-writer-wins semantics under concurrent
 * `set` calls is acceptable — the user is asserting "this exact list"
 * intent; concurrent set+set just means whichever ran second wins.
 * Concurrent set+grant or set+revoke is also last-writer-wins, which
 * is the documented contract for `set`.
 */
async function replaceFederatedReadAtomic(
  sql: SqlQuery,
  clientId: string,
  next: string[],
): Promise<string[] | null> {
  // TEXT[] binding via pgArray() string-literal escaping (see helper
  // for the security note). Our narrow SqlQuery surface
  // (src/core/sql-query.ts) doesn't bind JS arrays directly.
  const literal = pgArray(next);
  const rows = await sql`
    UPDATE oauth_clients
    SET federated_read = ${literal}
    WHERE client_id = ${clientId}
      AND deleted_at IS NULL
    RETURNING federated_read
  `;
  if (rows.length === 0) return null;
  const fed = rows[0].federated_read;
  return Array.isArray(fed) ? (fed as string[]).map(String) : [];
}

/**
 * Pure helper: dedupe a comma-separated source-id list while preserving
 * insertion order. Empty input → empty array. Exported so the CLI parser
 * and tests share one normalizer.
 */
export function parseSourceCsv(csv: string): string[] {
  const requested = csv.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of requested) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export interface FederatedReadOpts {
  /** When true, compute the outcome but skip the persisting UPDATE. */
  dryRun?: boolean;
}

/**
 * Core: append a source to the client's federated_read.
 *
 * Atomicity contract (Codex finding #1, HIGH):
 *   The actual write goes through `appendFederatedReadAtomic` which
 *   serializes at the row-lock so concurrent grant/revoke against the
 *   same client cannot lose updates. The race vector that previously
 *   silently restored revoked access is closed: under two operators
 *   racing `revoke-read sensitive` + `grant-read harmless`, postgres
 *   serializes the two UPDATEs and BOTH ops apply (sensitive removed,
 *   harmless added), instead of one clobbering the other.
 *
 * The reported `before` is the snapshot at resolveClient time, which
 * may be stale relative to a concurrent racer. The `after` reflects
 * the post-UPDATE state from RETURNING (always fresh).
 */
export async function grantReadCore(
  sql: SqlQuery,
  nameOrId: string,
  sourceId: string,
  opts: FederatedReadOpts = {},
): Promise<FederatedReadOutcome> {
  const client = await resolveClient(sql, nameOrId);
  await assertSourceExists(sql, sourceId);
  if (client.federated_read.includes(sourceId)) {
    return { kind: 'noop', reason: 'already-granted', client, current: client.federated_read };
  }
  if (opts.dryRun) {
    // Compute the would-be result without touching the row. Last-known
    // snapshot is best-effort under concurrent writes.
    const projected = [...client.federated_read, sourceId];
    return { kind: 'updated', client, before: client.federated_read, after: projected };
  }
  const after = await appendFederatedReadAtomic(sql, client.client_id, sourceId);
  if (after === null) {
    // Two equivalent failure modes: (a) racing grant-read already added
    // the source and the NOT-ANY guard suppressed our UPDATE, or
    // (b) the client was soft-deleted between resolveClient and UPDATE.
    // (a) is the more common path. Re-resolve to confirm + report.
    const reresolved = await resolveClient(sql, client.client_id, { includeDeleted: true });
    if (reresolved.deleted_at != null) {
      throw new Error(`Client "${client.client_name}" was soft-deleted before write could land.`);
    }
    return { kind: 'noop', reason: 'already-granted', client: reresolved, current: reresolved.federated_read };
  }
  return { kind: 'updated', client, before: client.federated_read, after };
}

/**
 * Core: remove a source from the client's federated_read. Atomic via
 * array_remove + ANY-guard. Same race-correctness rationale as
 * grantReadCore — concurrent ops serialize at the row lock.
 */
export async function revokeReadCore(
  sql: SqlQuery,
  nameOrId: string,
  sourceId: string,
  opts: FederatedReadOpts = {},
): Promise<FederatedReadOutcome> {
  const client = await resolveClient(sql, nameOrId);
  if (!client.federated_read.includes(sourceId)) {
    return { kind: 'noop', reason: 'not-present', client, current: client.federated_read };
  }
  if (opts.dryRun) {
    const projected = client.federated_read.filter((s) => s !== sourceId);
    return { kind: 'updated', client, before: client.federated_read, after: projected };
  }
  const after = await removeFederatedReadAtomic(sql, client.client_id, sourceId);
  if (after === null) {
    // Same disambiguation as grant: either a concurrent revoke already
    // removed the source (most common) or the client was soft-deleted.
    const reresolved = await resolveClient(sql, client.client_id, { includeDeleted: true });
    if (reresolved.deleted_at != null) {
      throw new Error(`Client "${client.client_name}" was soft-deleted before write could land.`);
    }
    return { kind: 'noop', reason: 'not-present', client: reresolved, current: reresolved.federated_read };
  }
  return { kind: 'updated', client, before: client.federated_read, after };
}

/**
 * Core: replace the whole federated_read list. Idempotent on same list.
 *
 * Race semantics: wholesale-overwrite + deleted_at guard. Concurrent
 * set+set is last-writer-wins (documented contract for `set` — the
 * operator is asserting the exact list). Concurrent set+grant or
 * set+revoke is also last-writer-wins. If a strict-merge semantics is
 * needed, use grant-read / revoke-read individually.
 */
export async function setFederatedReadCore(
  sql: SqlQuery,
  nameOrId: string,
  sourceCsv: string,
  opts: FederatedReadOpts = {},
): Promise<FederatedReadOutcome> {
  const next = parseSourceCsv(sourceCsv);
  const client = await resolveClient(sql, nameOrId);
  for (const s of next) {
    await assertSourceExists(sql, s);
  }
  const prev = client.federated_read;
  const same = prev.length === next.length && prev.every((v, i) => v === next[i]);
  if (same) {
    return { kind: 'noop', reason: 'same-list', client, current: prev };
  }
  if (opts.dryRun) {
    return { kind: 'updated', client, before: prev, after: next };
  }
  const after = await replaceFederatedReadAtomic(sql, client.client_id, next);
  if (after === null) {
    throw new Error(`Client "${client.client_name}" was soft-deleted before write could land.`);
  }
  return { kind: 'updated', client, before: prev, after };
}

function printOutcome(
  verb: 'grant' | 'revoke' | 'set',
  sourceArg: string,
  outcome: FederatedReadOutcome,
  dryRun: boolean,
): void {
  // Terminal-injection defense (Codex finding #5, low): a client_name
  // registered via DCR with ANSI escapes or control chars would
  // otherwise poison this output. Sanitize ALL strings that round-trip
  // from the DB before printing.
  const s = sanitizeForTerminal;
  const prefix = dryRun ? '[dry-run] ' : '';
  if (outcome.kind === 'noop') {
    const name = s(outcome.client.client_name);
    if (outcome.reason === 'already-granted') {
      console.log(`${prefix}No change: "${name}" already reads "${s(sourceArg)}".`);
    } else if (outcome.reason === 'not-present') {
      console.log(`${prefix}No change: "${name}" did not read "${s(sourceArg)}".`);
    } else {
      console.log(`${prefix}No change: "${name}" federated_read already matches.`);
    }
    console.log(`  federated_read: ${outcome.current.map(s).join(', ') || '(empty)'}`);
    return;
  }
  const { client, before, after } = outcome;
  const name = s(client.client_name);
  const wouldOrDid = dryRun ? 'Would' : 'Did';
  if (verb === 'grant') {
    console.log(`${prefix}${wouldOrDid} grant: "${name}" can now read "${s(sourceArg)}".`);
    console.log(`  federated_read: ${after.map(s).join(', ')}`);
  } else if (verb === 'revoke') {
    console.log(`${prefix}${wouldOrDid} revoke: "${name}" no longer reads "${s(sourceArg)}".`);
    console.log(`  federated_read: ${after.map(s).join(', ') || '(empty — client has no federated reads)'}`);
  } else {
    console.log(`${prefix}${wouldOrDid} update "${name}" federated_read:`);
    console.log(`  before: ${before.map(s).join(', ') || '(empty)'}`);
    console.log(`  after:  ${after.map(s).join(', ') || '(empty)'}`);
  }
  if (after.length === 0) {
    console.log(
      'Warning: client now reads no sources via federation. Queries through this ' +
        'client will only see content scoped explicitly via its write source.',
    );
  }
}

/**
 * Strip `--dry-run` from a positional-arg list. Returns the filtered list
 * plus the flag value. Kept positional-tolerant — the existing
 * `auth grant-read alice source` shape MUST keep working, AND
 * `auth grant-read alice source --dry-run` AND `auth grant-read --dry-run alice source`.
 */
export function extractDryRun(args: string[]): { dryRun: boolean; rest: string[] } {
  let dryRun = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    rest.push(a);
  }
  return { dryRun, rest };
}

async function grantRead(args: string[]): Promise<void> {
  const { dryRun, rest } = extractDryRun(args);
  const [nameOrId, sourceId] = rest;
  if (!nameOrId || !sourceId) {
    console.error('Usage: gbrain auth grant-read <client-name-or-id> <source-id> [--dry-run]');
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql) => {
      const outcome = await grantReadCore(sql, nameOrId, sourceId, { dryRun });
      printOutcome('grant', sourceId, outcome, dryRun);
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

async function revokeRead(args: string[]): Promise<void> {
  const { dryRun, rest } = extractDryRun(args);
  const [nameOrId, sourceId] = rest;
  if (!nameOrId || !sourceId) {
    console.error('Usage: gbrain auth revoke-read <client-name-or-id> <source-id> [--dry-run]');
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql) => {
      const outcome = await revokeReadCore(sql, nameOrId, sourceId, { dryRun });
      printOutcome('revoke', sourceId, outcome, dryRun);
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

async function setFederatedRead(args: string[]): Promise<void> {
  const { dryRun, rest } = extractDryRun(args);
  const [nameOrId, sourceCsv] = rest;
  if (!nameOrId || sourceCsv === undefined) {
    console.error(
      'Usage: gbrain auth set-federated-read <client-name-or-id> <source-id1,source-id2,...> [--dry-run]',
    );
    console.error('Pass an empty string ("") to clear all federated reads.');
    process.exit(1);
  }
  try {
    await withConfiguredSql(async (sql) => {
      const outcome = await setFederatedReadCore(sql, nameOrId, sourceCsv, { dryRun });
      printOutcome('set', sourceCsv, outcome, dryRun);
    });
  } catch (e: any) {
    console.error('Error:', e.message);
    process.exit(1);
  }
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
      console.log(`OAuth client revoked: "${sanitizeForTerminal(String(rows[0].client_name))}" (${clientId})`);
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
interface RegisterClientArgs {
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
      case '--scopes': out.scopes = requireValue(); i += 2; break;
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
  // Codex re-review (medium): validate source_id shape at the CLI boundary
  // so register-client can't seed malformed entries into source_id /
  // federated_read that subsequent grant/revoke/set commands can't manage.
  assertValidSourceId(out.sourceId);
  if (out.federatedRead) {
    for (const s of out.federatedRead) {
      assertValidSourceId(s);
    }
  }
  return out;
}

async function registerClient(name: string, args: string[]) {
  if (!name) {
    console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--source SOURCE] [--federated-read SRC1,SRC2,...] [--redirect-uri URI ...] [--token-endpoint-auth-method client_secret_post|client_secret_basic|none] [--bound-tools T1,T2] [--bound-source SOURCE] [--bound-brain BRAIN] [--bound-slug-prefixes P1,P2] [--bound-max-concurrent N] [--budget-usd-per-day USD]');
    process.exit(1);
  }
  let parsed: RegisterClientArgs;
  try {
    parsed = parseRegisterClientArgs(args);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    console.error('Usage: auth register-client <name> [--grant-types G] [--scopes S] [--source SOURCE] [--federated-read SRC1,SRC2,...] [--redirect-uri URI ...] [--token-endpoint-auth-method client_secret_post|client_secret_basic|none] [--bound-tools T1,T2] [--bound-source SOURCE] [--bound-brain BRAIN] [--bound-slug-prefixes P1,P2] [--bound-max-concurrent N] [--budget-usd-per-day USD]');
    process.exit(1);
  }
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

  try {
    await withConfiguredSql(async (sql) => {
      const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
      const provider = new GBrainOAuthProvider({ sql });
      const { clientId, clientSecret } = await provider.registerClientManual(
        name, grantTypes, scopes, redirectUris, sourceId, federatedRead, tokenEndpointAuthMethod, agentBindings,
      );
      const effectiveFederated = federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];
      const effectiveAuthMethod = tokenEndpointAuthMethod || 'client_secret_post';
      console.log(`OAuth client registered: "${name}"\n`);
      console.log(`  Client ID:           ${clientId}`);
      if (clientSecret) {
        console.log(`  Client Secret:       ${clientSecret}\n`);
      } else {
        console.log(`  Client Secret:       <public client — none issued>\n`);
      }
      console.log(`  Grant types:         ${grantTypes.join(', ')}`);
      console.log(`  Scopes:              ${scopes}`);
      console.log(`  Token auth method:   ${effectiveAuthMethod}`);
      if (redirectUris.length > 0) {
        console.log(`  Redirect URIs:       ${redirectUris.join(', ')}`);
      }
      console.log(`  Write source:        ${sourceId}`);
      console.log(`  Federated reads:     ${effectiveFederated.join(', ')}`);
      if (agentBindings) {
        console.log(`  Bound tools:         ${(parsed.boundTools ?? []).join(', ') || '<none>'}`);
        console.log(`  Bound source:        ${parsed.boundSourceId ?? '<none>'}`);
        console.log(`  Bound brain:         ${parsed.boundBrainId ?? '<none>'}`);
        console.log(`  Bound slug prefixes:${parsed.boundSlugPrefixes ? ' ' + parsed.boundSlugPrefixes.join(', ') : ' <none>'}`);
        console.log(`  Max concurrency:     ${parsed.boundMaxConcurrent ?? 1}`);
        console.log(`  Daily budget USD:    ${parsed.budgetUsdPerDay ?? '<none>'}`);
      }
      console.log('');
      if (clientSecret) {
        console.log('Save the client secret — it will not be shown again.');
      } else {
        console.log('Public client (PKCE-only) — no secret needed.');
      }
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
/**
 * Parse `auth create` args into `{ name, takesHolders }`.
 *
 * Exported + pure so the positional-vs-flag logic is unit-testable. Only
 * excludes the --takes-holders VALUE from the positional search when the flag
 * is present — the pre-v0.41 inline version used `rest[takesIdx + 1]` which
 * resolved to `rest[0]` when `takesIdx === -1`, silently dropping the name on
 * the bare `gbrain auth create <name>` form.
 */
export function parseAuthCreateArgs(rest: string[]): { name: string; takesHolders?: string[] } {
  const takesIdx = rest.indexOf('--takes-holders');
  const takesHolders = takesIdx >= 0 && rest[takesIdx + 1]
    ? rest[takesIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const takesValue = takesIdx >= 0 ? rest[takesIdx + 1] : undefined;
  const positional = rest.find(a => !a.startsWith('--') && a !== takesValue);
  return { name: positional || '', takesHolders };
}

export async function runAuth(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'create': {
      // v0.28: optional --takes-holders world,garry,brain (default: world only)
      const parsed = parseAuthCreateArgs(rest);
      await create(parsed.name, { takesHolders: parsed.takesHolders });
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
    case 'list-clients': await listClients(rest); return;
    case 'grant-read': await grantRead(rest); return;
    case 'revoke-read': await revokeRead(rest); return;
    case 'set-federated-read': await setFederatedRead(rest); return;
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
     --bound-slug-prefixes <prefix1,prefix2>               Bind submit_agent writes to slug prefixes
     --bound-max-concurrent <n>                            Bound submit_agent concurrency (default: 1)
     --budget-usd-per-day <usd>                            Bound submit_agent daily spend cap
  gbrain auth revoke-client <client_id>                   Hard-delete an OAuth 2.1 client (cascades to tokens + codes)
  gbrain auth list-clients [--json]                       List OAuth 2.1 clients with scope + write source + federated_read.
  gbrain auth grant-read <name|client_id> <source-id> [--dry-run]
                                                          Add a source to the client's federated_read list (idempotent).
  gbrain auth revoke-read <name|client_id> <source-id> [--dry-run]
                                                          Remove a source from the client's federated_read list (idempotent).
  gbrain auth set-federated-read <name|client_id> "<id1,id2,...>" [--dry-run]
                                                          Replace the client's whole federated_read list. Pass "" to clear.
  gbrain auth test <url> --token <token>                  Smoke-test a remote MCP server
`);
  }
}

// Direct-script entry point — only runs when this file is invoked as the main module
// (e.g. `bun run src/commands/auth.ts ...`). When imported by cli.ts, this block is skipped.
if (import.meta.main) {
  await runAuth(process.argv.slice(2));
}
