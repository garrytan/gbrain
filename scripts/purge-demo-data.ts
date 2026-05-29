import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

type Row = Record<string, unknown>;

type PurgeEngine = {
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

type Args = {
  apply: boolean;
  databasePath: string;
  databaseUrl?: string;
};

function parseArgs(argv: string[]): Args {
  let apply = false;
  let databasePath = join(homedir(), '.cortex', 'brain.pglite');
  let databaseUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--database-path') {
      const next = argv[++i];
      if (!next) throw new Error('--database-path requires a value');
      databasePath = next;
      continue;
    }
    if (arg.startsWith('--database-path=')) {
      databasePath = arg.slice('--database-path='.length);
      continue;
    }
    if (arg === '--database-url') {
      const next = argv[++i];
      if (!next) throw new Error('--database-url requires a value');
      databaseUrl = next;
      continue;
    }
    if (arg.startsWith('--database-url=')) {
      databaseUrl = arg.slice('--database-url='.length);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run scripts/purge-demo-data.ts [--database-path <path> | --database-url <url>] [--apply]

Deletes only Cortex smoke/browser/demo rows produced by local E2E harnesses.
Runs as a dry run unless --apply is provided.
Postgres can also be selected with CORTEX_DATABASE_URL or DATABASE_URL.`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  databaseUrl = databaseUrl || process.env.CORTEX_DATABASE_URL || process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL;
  return { apply, databasePath: resolve(databasePath), databaseUrl };
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function isDemoText(value: unknown): boolean {
  const raw = text(value).toLowerCase();
  return (
    /^cortex smoke\b/.test(raw) ||
    /^cortex browser\b/.test(raw) ||
    /^browser qa\b/.test(raw) ||
    /^browser team brain\b/.test(raw) ||
    /^smoke-[a-z0-9-]+@example\.com$/.test(raw) ||
    /^teammate-[a-z0-9-]+@example\.com$/.test(raw) ||
    /^browser-[a-z0-9-]+@example\.(com|test)$/.test(raw) ||
    /^smoke-[a-z0-9-]+\.example\.com$/.test(raw) ||
    /^browser-[a-z0-9-]+\.example\.(com|test)$/.test(raw) ||
    /^agent-smoke-/.test(raw) ||
    /^agent-browser-/.test(raw)
  );
}

function isDemoId(value: unknown): boolean {
  const raw = text(value).toLowerCase();
  return (
    /^smoke-[a-z0-9-]+$/.test(raw) ||
    /^smoke-skill-[a-z0-9-]+$/.test(raw) ||
    /^browser-[a-z0-9-]+$/.test(raw) ||
    /^browser-skill-[a-z0-9-]+$/.test(raw) ||
    /^evt_cortex_smoke_/.test(raw)
  );
}

async function safeRows(engine: PGLiteEngine, sql: string, params?: unknown[]): Promise<Row[]> {
  try {
    return await engine.executeRaw<Row>(sql, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist|no such table/i.test(message)) return [];
    throw err;
  }
}

async function count(engine: PGLiteEngine, table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const rows = await safeRows(engine, `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (!args.databaseUrl && !existsSync(args.databasePath)) {
    throw new Error(`PGLite database path not found: ${args.databasePath}`);
  }

  const engine: PurgeEngine = args.databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(args.databaseUrl
    ? { engine: 'postgres', database_url: args.databaseUrl, poolSize: 1 }
    : { engine: 'pglite', database_path: args.databasePath });
  try {
    const orgRows = await safeRows(engine, `SELECT id, name, domain FROM saas_organizations ORDER BY created_at DESC`);
    const sourceRows = await safeRows(engine, `SELECT id, name, config FROM sources ORDER BY created_at DESC`);
    const skillRows = await safeRows(engine, `SELECT id, name, owner, description FROM saas_skill_policies ORDER BY created_at DESC`);
    const clientRows = await safeRows(engine, `SELECT client_id, client_name, source_id, federated_read FROM oauth_clients ORDER BY created_at DESC`);

    const orgIds = unique(orgRows
      .filter(row => isDemoText(row.name) || isDemoText(row.domain))
      .map(row => text(row.id)));

    const sourceIds = unique(sourceRows
      .filter(row => isDemoId(row.id) || isDemoText(row.name))
      .map(row => text(row.id)));

    const skillIds = unique(skillRows
      .filter(row => isDemoId(row.id) || isDemoText(row.name) || isDemoText(row.owner) || isDemoText(row.description))
      .map(row => text(row.id)));

    const linkedClientRows = orgIds.length > 0
      ? await safeRows(engine, `
          SELECT oauth_client_id AS client_id FROM saas_org_members WHERE org_id = ANY($1::text[]) AND oauth_client_id IS NOT NULL
          UNION
          SELECT oauth_client_id AS client_id FROM saas_org_invites WHERE org_id = ANY($1::text[]) AND oauth_client_id IS NOT NULL
          UNION
          SELECT client_id FROM saas_org_agent_clients WHERE org_id = ANY($1::text[])
        `, [orgIds])
      : [];

    const clientIds = unique([
      ...linkedClientRows.map(row => text(row.client_id)),
      ...clientRows
        .filter(row => isDemoText(row.client_name) || isDemoId(row.source_id) || text(row.federated_read).toLowerCase().includes('smoke-') || text(row.federated_read).toLowerCase().includes('browser-'))
        .map(row => text(row.client_id)),
    ]);

    const plan = {
      database: args.databaseUrl
        ? { engine: 'postgres', databaseUrl: '[set]' }
        : { engine: 'pglite', databasePath: args.databasePath },
      apply: args.apply,
      candidates: {
        orgIds,
        sourceIds,
        skillIds,
        clientIds,
      },
      before: {
        organizations: await count(engine, 'saas_organizations'),
        sources: await count(engine, 'sources'),
        skills: await count(engine, 'saas_skill_policies'),
        oauthClients: await count(engine, 'oauth_clients'),
        requestLogs: await count(engine, 'mcp_request_log'),
      },
    };

    if (!args.apply) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    await engine.executeRaw('BEGIN');
    try {
      if (clientIds.length > 0) {
        await safeRows(engine, `DELETE FROM oauth_tokens WHERE client_id = ANY($1::text[])`, [clientIds]);
        await safeRows(engine, `DELETE FROM mcp_request_log WHERE token_name = ANY($1::text[]) OR agent_name = ANY($1::text[])`, [clientIds]);
        await safeRows(engine, `DELETE FROM saas_org_agent_clients WHERE client_id = ANY($1::text[])`, [clientIds]);
        await safeRows(engine, `UPDATE saas_org_members SET oauth_client_id = NULL WHERE oauth_client_id = ANY($1::text[])`, [clientIds]);
        await safeRows(engine, `UPDATE saas_org_invites SET oauth_client_id = NULL WHERE oauth_client_id = ANY($1::text[])`, [clientIds]);
        await safeRows(engine, `DELETE FROM oauth_clients WHERE client_id = ANY($1::text[])`, [clientIds]);
      }
      if (orgIds.length > 0) {
        await safeRows(engine, `DELETE FROM saas_billing_events WHERE org_id = ANY($1::text[])`, [orgIds]);
        await safeRows(engine, `DELETE FROM saas_organizations WHERE id = ANY($1::text[])`, [orgIds]);
      }
      if (skillIds.length > 0) {
        await safeRows(engine, `DELETE FROM saas_skill_policies WHERE id = ANY($1::text[])`, [skillIds]);
      }
      if (sourceIds.length > 0) {
        await safeRows(engine, `DELETE FROM oauth_clients WHERE source_id = ANY($1::text[])`, [sourceIds]);
        await safeRows(engine, `DELETE FROM sources WHERE id = ANY($1::text[]) AND id <> 'default'`, [sourceIds]);
      }
      await safeRows(engine, `DELETE FROM mcp_request_log WHERE token_name ILIKE 'agent-smoke-%' OR token_name ILIKE 'agent-browser-%' OR agent_name ILIKE '%smoke%' OR agent_name ILIKE '%browser%'`);
      await safeRows(engine, `DELETE FROM minion_jobs WHERE data::text ILIKE '%smoke-%' OR data::text ILIKE '%browser-%'`);
      await engine.executeRaw('COMMIT');
    } catch (err) {
      await engine.executeRaw('ROLLBACK');
      throw err;
    }

    console.log(JSON.stringify({
      ...plan,
      after: {
        organizations: await count(engine, 'saas_organizations'),
        sources: await count(engine, 'sources'),
        skills: await count(engine, 'saas_skill_policies'),
        oauthClients: await count(engine, 'oauth_clients'),
        requestLogs: await count(engine, 'mcp_request_log'),
      },
    }, null, 2));
  } finally {
    await engine.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
