import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { testBackends } from './test-backends.ts';

export const options = { noEmbed: true, noExtract: true, noSchemaPack: true };
export const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
export const googleConfig = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
export const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };
export const contact = (id: string, name: string) => ({ resourceName: `people/${id}`, names: [{ displayName: name }], emailAddresses: [{ value: `${id}@example.invalid` }] });
export const issueFixture = { number: 1, title: 'Example issue', state: 'open', body: 'A useful synthetic issue body.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [], user: { login: 'example-user' }, html_url: 'https://github.com/acme-example/app/issues/1' };

export function githubFetch(opts: { failDetail?: boolean; failSecondPage?: boolean; deleted?: boolean; calls?: string[] } = {}) {
  return async (url: string) => {
    opts.calls?.push(url);
    const u = new URL(url);
    const path = u.pathname;
    if (path.endsWith('/issues')) {
      if (opts.failSecondPage && u.searchParams.has('page')) return json({ message: 'fixture listing failure' }, 400);
      return json(opts.deleted ? [] : [issueFixture], 200, opts.failSecondPage ? { link: '<https://api.github.com/repos/acme-example/app/issues?page=2>; rel="next"' } : {});
    }
    if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
    if (path.endsWith('/issues/1')) return opts.failDetail ? json({ message: 'fixture detail failure' }, 400) : json(issueFixture);
    if (path === '/repos/acme-example/app') return json({ full_name: 'acme-example/app', private: true, default_branch: 'main' });
    throw new Error('Unexpected external fixture route');
  };
}

export async function sourceCheckpoint(engine: BrainEngine, id: string) {
  return engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint IN (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)", [id]);
}

export function createConnectorFixture() {
  const backends = testBackends();
  const home = mkdtempSync(join(tmpdir(), 'gbrain-connector-parity-'));
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  const env = { GBRAIN_HOME: home, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' };
  const setup = async () => {
    if (backends.includes('pglite')) {
      const lite = new PGLiteEngine();
      await lite.connect({ database_path: join(home, 'database') });
      await lite.initSchema();
      engines.push(lite);
    }
    if (backends.includes('postgres')) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(pg.engine);
      closePostgres = pg.close;
    }
  };
  const teardown = async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  };

  async function source(engine: BrainEngine, config: Record<string, unknown>) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `connector-${randomUUID().slice(0, 8)}`;
    const dir = join(home, id);
    mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, JSON.stringify(config)]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { id, dir };
  }

  async function boundSource(engine: BrainEngine, config: Record<string, unknown>) {
    const f = await source(engine, config);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const binding = await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { ...f, binding };
  }

  async function standaloneConnector(engine: BrainEngine, f: { id: string; dir: string }, sourceConfig: Record<string, unknown>, crash = false, retryFailed = false) {
    let database: GBrainConfig & { poolSize?: number } = { engine: 'pglite', database_path: join(home, 'database') };
    if (engine.kind === 'postgres') {
      const [row] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${row.name}`;
      database = { engine: 'postgres', database_url: url.toString(), poolSize: 4 };
    }
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    let childPid: number | undefined;
    try {
      const child = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'connector-restart.ts')], {
        env: { ...process.env, ...env, GBRAIN_TEST_CONNECTOR_RESTART: JSON.stringify({ database, sourceId: f.id,
          root: f.dir, sourceConfig, body: 'Updated organization after interruption', crash, retryFailed }) }, stdout: 'pipe', stderr: 'pipe',
      });
      childPid = child.pid;
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exitCode };
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    } finally {
      await engine.connect(database);
      if (crash && childPid !== undefined) await engine.executeRaw(`UPDATE gbrain_cycle_locks
        SET acquired_at=now()-interval '2 minutes',last_refreshed_at=now()-interval '1 hour',ttl_expires_at=now()-interval '1 hour'
        WHERE id=$1 AND holder_pid=$2`, [syncLockId(f.id), childPid]);
    }
  }

  return { home, engines, env, backends, setup, teardown, source, boundSource, standaloneConnector };
}
