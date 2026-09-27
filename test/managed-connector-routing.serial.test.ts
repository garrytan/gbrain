import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { APPLICATION_AUTHORITY, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const directory = mkdtempSync(join(tmpdir(), 'gbrain-connector-routing-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const googleConfig = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_ROUTING_TEST_TOKEN' };
const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_ROUTING_TEST_TOKEN' };
const issue = { number: 1, title: 'Routing example', state: 'open', body: 'A durable connector routing example.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [], user: { login: 'example-user' }, html_url: 'https://github.com/acme-example/app/issues/1' };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

for (const kind of ['google', 'github']) for (const caller of ['explicit', 'job']) for (const boundary of ['entry', 'source-read']) {
  test(`${kind} connector preserves ${caller} cancellation at ${boundary} without publishing`, async () => {
    for (const engine of engines) {
      const home = join(directory, randomUUID()); mkdirSync(home, { recursive: true });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' }, async () => {
        const sourceId = `cancel-${randomUUID()}`, root = join(home, 'uncreated');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
          [sourceId, root, JSON.stringify(kind === 'google' ? googleConfig : githubConfig)]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const before = await engine.executeRaw('SELECT * FROM sources WHERE id=$1', [sourceId]);
        const checkpoints = await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint');
        const effects = await engine.executeRaw('SELECT id,state FROM persistence_effects ORDER BY id');
        const controller = new AbortController();
        const reason = new Error('connector fixture cancelled');
        const execute = engine.executeRaw;
        let reached = boundary === 'entry', calls = 0;
        const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async () => {
          calls++; throw new Error('Unexpected connector fixture network call');
        }) as unknown as typeof fetch);
        if (boundary === 'entry') controller.abort(reason);
        else engine.executeRaw = async function(this: BrainEngine, sql, params) {
          const rows = await execute.call(this, sql, params);
          if (sql === 'SELECT local_path,config FROM sources WHERE id=$1' && params?.[0] === sourceId) {
            reached = true; controller.abort(reason);
          }
          return rows;
        } as BrainEngine['executeRaw'];
        try {
          const run = () => performSync(engine, { sourceId, ...(caller === 'explicit' ? { signal: controller.signal } : {}) });
          await expect(caller === 'job' ? withSubmissionAuthority(APPLICATION_AUTHORITY, run, controller.signal) : run())
            .rejects.toMatchObject({ name: caller === 'job' ? 'AbortError' : 'Error', message: reason.message });
          expect(reached).toBe(true);
          expect(calls).toBe(0);
          expect(existsSync(root)).toBe(false);
          expect(await engine.executeRaw('SELECT * FROM sources WHERE id=$1', [sourceId])).toEqual(before);
          expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [sourceId])).toHaveLength(0);
          expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toHaveLength(0);
          expect(await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(checkpoints);
          expect(await engine.executeRaw('SELECT id,state FROM persistence_effects ORDER BY id')).toEqual(effects);
        } finally { engine.executeRaw = execute; fetcher.mockRestore(); }
      });
    }
  }, 120_000);
}

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(directory, { recursive: true, force: true });
});

test('deliberate activation and public sync route unbound API sources without creating Git ownership', async () => {
  for (const engine of engines) {
    const home = join(directory, randomUUID()); mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host', CONNECTOR_ROUTING_TEST_TOKEN: 'synthetic-fixture-token' }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sources = [];
      for (const config of [googleConfig, githubConfig]) {
        const id = `route-${config.kind}-${randomUUID().slice(0, 8)}`, root = join(home, id);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config)]);
        sources.push({ id, root, config });
      }
      const status = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
      for (const source of sources) expect(status.onboarding.sources).toContainEqual(expect.objectContaining({ source_id: source.id, state: 'connector_database' }));
      const reviewed = await reviewedWriterIntent(engine, 'writer_activate');
      await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{kind}','\"git\"'::jsonb) WHERE id=$1", [sources[0].id]);
      await expect(runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...reviewed })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
      await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{kind}','\"google\"'::jsonb) WHERE id=$1", [sources[0].id]);
      const activation = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') }) as any;
      expect(activation).toMatchObject({ activated: true, filesystem_sources: 0 });
      let calls = 0;
      const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
        calls++;
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
        if (url.pathname.endsWith('/people/me/connections')) return json({ connections: [{ resourceName: 'people/routing', names: [{ displayName: 'Connector Example' }], emailAddresses: [{ value: 'connector@example.invalid' }] }], nextSyncToken: 'routing-contacts' });
        if (url.pathname.endsWith('/issues')) return json([issue]);
        if (url.pathname.endsWith('/pulls') || url.pathname.endsWith('/comments')) return json([]);
        if (url.pathname.endsWith('/issues/1')) return json(issue);
        if (url.pathname === '/repos/acme-example/app') return json({ full_name: 'acme-example/app', private: true, default_branch: 'main' });
        throw new Error('Unexpected network route in connector fixture');
      }) as typeof fetch);
      try {
        for (const source of sources) {
          const options = { sourceId: source.id, noEmbed: true, noExtract: true, noSchemaPack: true };
          const result = await performSync(engine, options);
          const pages = source.config.kind === 'github' ? 2 : 1;
          expect(result.status).not.toBe('partial'); expect(result.added).toBe(pages);
          expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [source.id])).toHaveLength(pages);
          expect(await engine.executeRaw('SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1', [source.id])).toHaveLength(0);
          expect(existsSync(source.root)).toBe(false);
          await disposePersistenceConsumer(engine);
          expect((await performSync(engine, options)).added).toBe(0);
        }
        expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync'")).toHaveLength(0);
        const before = calls;
        await expect(performSync(engine, { sourceId: sources[0].id, signal: AbortSignal.abort(new Error('fixture cancelled')) })).rejects.toThrow('fixture cancelled');
        await expect(performSync(engine, { sourceId: sources[0].id, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } })).rejects.toThrow('github-kind');
        expect(calls).toBe(before);
      } finally { fetcher.mockRestore(); await disposePersistenceConsumer(engine); }
    });
  }
}, 120_000);
