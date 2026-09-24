import { beforeAll, afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { cliDiagnostic, fixtureDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { initializeFixtures, fixtures, selectFixtureHost, assertConservation, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { acquireWorktree } from '../../src/core/persistence/ownership.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

const url = process.env.DATABASE_URL;
const oldBinary = process.env.GBRAIN_TEST_OLD_BINARY;
describe.skipIf(!url)('authenticated PostgreSQL HTTP accepted-write liveness', () => {
  let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  let home: string;
  let config: HarnessConfig;
  let env: Record<string, string>;
  let base: string;
  let server: ChildProcess | undefined;
  let restoreOwner = false;
  const clients: Client[] = [];
  const tokens: string[] = [];
  let oauthId: string;
  let oauthSecret: string;
  let stderr = '';
  const content = (text: string) => `---\ntitle: Synthetic note\ntype: note\n---\n\n${text}`;

  function cli(args: string[]): string {
    const result = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { env, encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) throw new Error(cliDiagnostic(args[0], { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }));
    return result.stdout;
  }
  async function start(binary?: string) {
    stderr = '';
    const args = ['serve', '--http', '--surface', 'full', '--bind', '127.0.0.1', '--port', new URL(base).port,
      '--public-url', base, '--suppress-bootstrap-token'];
    server = spawn(binary ?? 'bun', binary ? args : ['--no-env-file', 'run', 'src/cli.ts', ...args],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr?.on('data', chunk => { stderr += String(chunk); });
    await waitFor(async () => {
      if (server?.exitCode != null) throw new Error(fixtureDiagnostic('HTTP owner exited', stderr, tokens));
      try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, { timeoutMs: 30000 });
  }
  async function stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    if (!server || server.exitCode != null || server.signalCode != null) return;
    const child = server;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill(signal);
    });
  }
  async function connect(token: string) {
    const client = new Client({ name: 'synthetic-persistence-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    return { result, body };
  }
  async function receipt(client: Client, id: string) {
    return (await call(client, 'get_write_request', { request_id: id })).body;
  }
  async function committed(client: Client, id: string) {
    let current: any;
    await waitFor(async () => { current = await receipt(client, id); return current.state === 'committed'; }, { timeoutMs: 20000 });
    return current;
  }
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-http-liveness-'));
    pg = await isolatedPersistencePostgres(url!);
    config = { kind: 'postgres', root: home, dataDir: join(home, 'unused'), hostId: randomUUID(), seed: 5406,
      schedules: 0, operations: 0, sourceIds: ['http-source', 'http-other'], principalIds: [randomUUID()] };
    await withEnv({ GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home }, async () => {
      selectFixtureHost(config.hostId);
      await initializeFixtures(pg.engine, config);
    });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: pg.databaseUrl, embedding_disabled: true }));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: pg.databaseUrl, GBRAIN_DATABASE_URL: pg.databaseUrl,
      GBRAIN_ENGINE: 'postgres', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_MCP_FORCE_SURFACE: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_REMOTE_PRIVATE_PAGES: undefined });
    const legacy = cli(['auth', 'create', 'synthetic-http-writer', '--scopes', 'read,write']);
    tokens.push(legacy.match(/gbrain_[a-f0-9]{64}/)![0]);
    await pg.engine.executeRaw("UPDATE access_tokens SET permissions=jsonb_set(COALESCE(permissions,'{}'::jsonb),'{source_id}',to_jsonb($1::text)) WHERE name='synthetic-http-writer'", [config.sourceIds[0]]);
    const oauth = cli(['auth', 'register-client', 'synthetic-oauth-writer', '--grant-types', 'client_credentials',
      '--scopes', 'read write', '--source', config.sourceIds[0]]);
    oauthId = oauth.match(/Client ID:\s+(gbrain_cl_\S+)/)![1];
    oauthSecret = oauth.match(/Client Secret:\s+(gbrain_cs_\S+)/)![1];
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    await start();
    const minted = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: oauthId, client_secret: oauthSecret, scope: 'read write' }) });
    expect(minted.ok).toBe(true);
    tokens.push((await minted.json() as { access_token: string }).access_token);
    await connect(tokens[0]); await connect(tokens[1]);
  }, 120000);
  afterAll(async () => { await stop(); await pg?.close(); if (home) rmSync(home, { recursive: true, force: true }); }, 30000);
  afterEach(async () => {
    if (!restoreOwner) return;
    restoreOwner = false;
    await stop('SIGKILL'); await start(); await connect(tokens[0]); await connect(tokens[1]);
  }, 30000);

  for (const [index, auth] of ['legacy', 'oauth'].entries()) test(`${auth} put_page and remember preserve UUIDs through contention and restart`, async () => {
    const client = clients[index];
    const source = (await fixtures(pg.engine, config))[0];
    const entity = `notes/entity-${auth}`;
    expect((await call(client, 'put_page', { slug: entity, source_id: source.id, content: content('Entity fixture'), request_id: randomUUID() })).result.isError).not.toBe(true);
    const lock = await acquireWorktree(source.binding, 1000);
    expect(lock).not.toBeNull();
    const put = { slug: `notes/queued-${auth}`, source_id: source.id, content: content(`Original ${auth} fixture`), request_id: randomUUID() };
    const memory = { fact: `Synthetic ${auth} durable fact`, provenance: `synthetic fixture ${auth}`, entity, source_id: source.id, request_id: randomUUID() };
    try {
      const pending = await call(client, 'put_page', put);
      expect(pending.result.isError).toBe(true);
      expect(pending.body.write_request.request_id).toBe(put.request_id);
      expect(pending.body.write_request.diagnostic).toBeDefined();
      const remembered = await call(client, 'remember', memory);
      expect(remembered.result.isError).toBe(true);
      expect(remembered.body.protocol_version).toBe(1);
      expect(remembered.body.write_request.request_id).toBe(memory.request_id);
      expect((await receipt(client, memory.request_id)).diagnostic.reason).toBe('waiting_on_earlier_write');
      expect(await pg.engine.readPageSnapshot(put.slug, { sourceId: source.id })).toBeNull();
      expect(await pg.engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [source.id, memory.fact])).toHaveLength(0);
      await pg.engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
        await tx.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '3 minutes' WHERE request_id=$1", [put.request_id]);
      });
      const aged = await receipt(client, put.request_id);
      expect(aged.diagnostic.next_action).toBe('inspect_owner');
      expect(aged.retry_after_ms).toBe(30000);
      expect((await call(client, 'put_page', put)).body.suggestion).toContain('inspect');
      await stop('SIGKILL');
    } finally { await lock!.release(); }
    await start();
    await connect(tokens[0]); await connect(tokens[1]);
    const replacement = clients[index];
    await committed(replacement, put.request_id);
    await committed(replacement, memory.request_id);
    const before = await pg.engine.executeRaw('SELECT key,lifetime_ids,terminal_bytes FROM persistence_counters ORDER BY key');
    const snapshot = await pg.engine.readPageSnapshot(put.slug, { sourceId: source.id });
    expect(snapshot?.page.compiled_truth).toBe(`Original ${auth} fixture`);
    expect(readFileSync(join(source.root, `${put.slug}.md`), 'utf8')).toContain(`Original ${auth} fixture`);
    expect((await call(replacement, 'put_page', put)).body.revision).toBe(snapshot!.revision);
    expect((await call(replacement, 'remember', memory)).body.status).toBe('inserted');
    expect(await pg.engine.executeRaw('SELECT fact,source,source_id FROM facts WHERE fact=$1', [memory.fact])).toEqual([
      { fact: memory.fact, source: memory.provenance, source_id: source.id },
    ]);
    expect((await call(replacement, 'put_page', { ...put, content: content('Changed intent') })).body.error).toBe('idempotency_conflict');
    expect(await pg.engine.executeRaw('SELECT key,lifetime_ids,terminal_bytes FROM persistence_counters ORDER BY key')).toEqual(before);
    await assertConservation(pg.engine);
  }, 90000);

  test('44 synthetic pages over three authenticated clients reconcile exactly', async () => {
    const third = await connect(tokens[0]);
    const writers = [clients[0], clients[1], third];
    const pages = Array.from({ length: 44 }, (_, index) => ({ slug: `notes/import-${index}`, source_id: config.sourceIds[0],
      content: content(`fixture ${index}\n${'synthetic '.repeat(index === 43 ? 24900 : 400 + index * 150).trimEnd()}`), request_id: randomUUID() }));
    await Promise.all(writers.map(async (client, worker) => {
      for (let index = worker; index < pages.length; index += writers.length) {
        const result = await call(client, 'put_page', pages[index]);
        expect(result.body.request_id ?? result.body.write_request?.request_id).toBe(pages[index].request_id);
        const done = await committed(client, pages[index].request_id);
        const snapshot = await pg.engine.readPageSnapshot(pages[index].slug, { sourceId: config.sourceIds[0] });
        expect(snapshot!.revision).toBe(done.revision);
        expect(snapshot!.page.compiled_truth).toBe(pages[index].content.split('---\n\n')[1]);
      }
    }));
    expect(await pg.engine.executeRaw("SELECT count(*)::int AS count FROM pages WHERE source_id=$1 AND slug LIKE 'notes/import-%'", [config.sourceIds[0]])).toEqual([{ count: 44 }]);
    await assertConservation(pg.engine);
  }, 120000);

  test('a lost HTTP acknowledgement preserves accepted identity rather than inventing another write', async () => {
    const client = clients[0];
    const source = (await fixtures(pg.engine, config))[0];
    const lock = await acquireWorktree(source.binding, 1000);
    expect(lock).not.toBeNull();
    const args = { slug: 'notes/lost-acknowledgement', source_id: source.id, content: content('Lost response fixture'), request_id: randomUUID() };
    const abort = new AbortController();
    const reply = client.callTool({ name: 'put_page', arguments: args }, undefined, { signal: abort.signal, timeout: 30000 });
    const rejected = reply.then(() => false, () => true);
    try {
      await waitFor(async () => (await pg.engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [args.request_id])).length === 1);
      abort.abort();
      expect(await rejected).toBe(true);
      expect((await receipt(client, args.request_id)).request_id).toBe(args.request_id);
      expect(await pg.engine.readPageSnapshot(args.slug, { sourceId: source.id })).toBeNull();
    } finally { abort.abort(); await lock!.release(); }
    await committed(client, args.request_id);
    const first = (await call(client, 'put_page', args)).body;
    expect((await call(client, 'put_page', args)).body.revision).toBe(first.revision);
    expect(await pg.engine.executeRaw('SELECT count(*)::int AS count FROM persistence_requests WHERE request_id=$1::uuid', [args.request_id])).toEqual([{ count: 1 }]);
    await assertConservation(pg.engine);
  }, 30000);

  test('the same UUID under authenticated principals retains separate authorized results', async () => {
    const request_id = randomUUID();
    for (let index = 0; index < 2; index++) {
      const args = { request_id, source_id: config.sourceIds[0], slug: `notes/principal-${index}`, content: content(`Principal fixture ${index}`) };
      expect((await call(clients[index], 'put_page', args)).result.isError).not.toBe(true);
      expect((await receipt(clients[index], request_id)).slug).toBe(args.slug);
    }
  });

  test('private targets and changed source identity hide authenticated receipts immediately', async () => {
    const own = { slug: 'notes/visibility-fence', content: content('Synthetic visibility fixture'), request_id: randomUUID() };
    await call(clients[1], 'put_page', own);
    const [page] = await pg.engine.executeRaw<{ id: number; frontmatter: unknown }>('SELECT id,frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [config.sourceIds[0], own.slug]);
    const [source] = await pg.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [config.sourceIds[0]]);
    const change = async (sql: string, params: unknown[]) => pg.engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true),set_config('gbrain.write_sources',$1,true),set_config('gbrain.persistence_protocol','2',true)", [JSON.stringify([config.sourceIds[0]])]);
      await tx.executeRaw(sql, params);
    });
    const hidden = async () => {
      expect(await receipt(clients[1], own.request_id)).toEqual(await receipt(clients[1], randomUUID()));
      const listing = await call(clients[1], 'list_write_requests', { source_id: config.sourceIds[0], limit: 100 });
      expect(JSON.stringify(listing.body)).not.toContain(own.request_id);
    };
    try {
      await change("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{visibility}','\"private\"'::jsonb) WHERE id=$1", [page.id]);
      await hidden();
      await change('UPDATE pages SET frontmatter=$2::jsonb WHERE id=$1', [page.id, JSON.stringify(page.frontmatter)]);
      await change('UPDATE sources SET archived=true WHERE id=$1', [config.sourceIds[0]]);
      await hidden();
      await change('UPDATE sources SET archived=false WHERE id=$1', [config.sourceIds[0]]);
      await change('UPDATE persistence_requests SET source_incarnation=$2::uuid WHERE request_id=$1', [own.request_id, randomUUID()]);
      await hidden();
    } finally {
      await change('UPDATE pages SET frontmatter=$2::jsonb WHERE id=$1', [page.id, JSON.stringify(page.frontmatter)]);
      await change('UPDATE sources SET archived=false WHERE id=$1', [config.sourceIds[0]]);
      await change('UPDATE persistence_requests SET source_incarnation=$2::uuid WHERE request_id=$1', [own.request_id, source.incarnation]);
    }
    expect((await receipt(clients[1], own.request_id)).state).toBe('committed');
  });

  test.skipIf(!oldBinary)('compatible old and new owners drain original UUIDs after quiesced handoffs', async () => {
    restoreOwner = true;
    const source = (await fixtures(pg.engine, config))[0];
    for (const oldFirst of [true, false]) {
      await stop();
      await start(oldFirst ? oldBinary : undefined);
      const producer = await connect(tokens[0]);
      const lock = await acquireWorktree(source.binding, 1000);
      expect(lock).not.toBeNull();
      const args = { slug: `notes/compatible-${oldFirst}`, content: content(`Compatible owner ${oldFirst}`), request_id: randomUUID() };
      try {
        expect((await call(producer, 'put_page', args)).body.write_request.request_id).toBe(args.request_id);
        expect(await pg.engine.readPageSnapshot(args.slug, { sourceId: source.id })).toBeNull();
        await stop();
      } finally { await lock!.release(); }
      await start(oldFirst ? undefined : oldBinary);
      const successor = await connect(tokens[0]);
      const done = await committed(successor, args.request_id);
      expect((await call(successor, 'put_page', args)).body.revision).toBe(done.revision);
      const snapshot = await pg.engine.readPageSnapshot(args.slug, { sourceId: source.id });
      expect(snapshot!.page.compiled_truth).toBe(`Compatible owner ${oldFirst}`);
      expect(snapshot!.revision).toBe(done.revision);
      expect(await pg.engine.executeRaw('SELECT count(*)::int AS count FROM persistence_requests WHERE request_id=$1', [args.request_id])).toEqual([{ count: 1 }]);
      await assertConservation(pg.engine);
    }
    await stop(); await start(); await connect(tokens[0]); await connect(tokens[1]);
    const lock = await acquireWorktree(source.binding, 1000);
    expect(lock).not.toBeNull();
    const request = { slug: 'notes/old-client-new-receipt', content: content('Retained client fixture'), request_id: randomUUID() };
    try {
      expect((await call(clients[1], 'put_page', request)).body.write_request.diagnostic).toBeDefined();
      const clientHome = join(home, 'retained-client');
      mkdirSync(join(clientHome, '.gbrain'), { recursive: true });
      writeFileSync(join(clientHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
        issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: oauthId,
      } }), { mode: 0o600 });
      await pg.engine.transaction(async tx => {
        await waitFor(async () => (await tx.executeRaw(`SELECT id FROM persistence_requests
          WHERE request_id=$1::uuid AND state='queued' FOR SHARE SKIP LOCKED`, [request.request_id])).length === 1,
        { label: 'retained client queued receipt' });
        const result = spawnSync(oldBinary!, ['write-request', request.request_id, '--json'], {
          env: keylessBrainEnv(env, clientHome, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
            GBRAIN_REMOTE_CLIENT_SECRET: oauthSecret }), encoding: 'utf8', timeout: 30000,
        });
        if (result.status !== 0) throw new Error(fixtureDiagnostic('retained HTTP client failed', result.stderr, [...tokens, oauthSecret]));
        expect(JSON.parse(result.stdout)).toMatchObject({ request_id: request.request_id, state: 'queued' });
      });
    } finally { await lock!.release(); }
    await committed(clients[1], request.request_id);
  }, 120000);

  for (const oldFirst of [true, false]) for (const boundary of ['running', 'recovery'] as const) {
    test.skipIf(!oldBinary)(`${oldFirst ? 'old-to-new' : 'new-to-old'} owner handoff retains a real ${boundary} row`, async () => {
      restoreOwner = true;
      const source = (await fixtures(pg.engine, config))[0];
      await stop(); await start(oldFirst ? oldBinary : undefined);
      const producer = await connect(tokens[0]);
      const slug = `notes/retained-${oldFirst}-${boundary}`;
      const initial = await call(producer, 'put_page', { slug, content: content('Before owner handoff'), request_id: randomUUID() });
      expect(initial.result.isError).not.toBe(true);
      const before = (await pg.engine.readPageSnapshot(slug, { sourceId: source.id }))!;
      const path = join(source.root, `${slug}.md`);
      const originalBytes = readFileSync(path);
      const versions = await pg.engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id]);
      const args = { slug, content: content(`After ${oldFirst} ${boundary} handoff`), expected_revision: before.revision, request_id: randomUUID() };
      const native = await acquireWorktree(source.binding, 1000);
      expect(native).not.toBeNull();
      const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let holding: Promise<unknown> | undefined;
      let retained: WriteRequest;
      const read = async () => (await pg.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [args.request_id]))[0];
      try {
        expect((await call(producer, 'put_page', args)).body.write_request.request_id).toBe(args.request_id);
        holding = pg.engine.transaction(async tx => {
          if (boundary === 'running') await tx.executeRaw('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');
          else await tx.lockPageKeys([{ sourceId: source.id, slug }]);
          held.resolve(); await release.promise;
        });
        await Promise.race([held.promise, holding]);
        await native!.release();
        await waitFor(async () => {
          const row = await read();
          return row.state === 'running' && (boundary === 'running' ? row.recovery === null : row.recovery !== null);
        }, { timeoutMs: 10000, label: `actual ${boundary} owner boundary` });
        await stop('SIGKILL');
        retained = await read();
        expect(retained.state).toBe('running');
        expect(retained.execution_token).not.toBeNull();
        expect(retained.publication_started).toBe(false);
        expect(Boolean(retained.recovery)).toBe(boundary === 'recovery');
        expect(Number(retained.recovery_bytes) > 0).toBe(boundary === 'recovery');
        expect(readFileSync(path)).toEqual(originalBytes);
      } finally { release.resolve(); await holding; await native!.release(); }
      const exclusion = await acquireWorktree(source.binding, 1000);
      expect(exclusion).not.toBeNull();
      await exclusion!.release();
      expect((await pg.engine.readPageSnapshot(slug, { sourceId: source.id }))!.revision).toBe(before.revision);
      const counters = await pg.engine.executeRaw('SELECT key,lifetime_ids,terminal_bytes FROM persistence_counters ORDER BY key');
      await assertConservation(pg.engine);
      if (boundary === 'running') await pg.engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
        await tx.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=$1::uuid", [retained.id]);
      });
      await start(oldFirst ? undefined : oldBinary);
      const successor = await connect(tokens[0]);
      const done = await committed(successor, args.request_id);
      await waitFor(async () => {
        const row = await read();
        return row.state === 'committed' && row.recovery === null && Number(row.recovery_bytes) === 0;
      }, { timeoutMs: 5000, label: 'retained owner recovery cleanup' });
      const final = await read();
      expect(final).toMatchObject({ id: retained.id, request_id: args.request_id, digest: retained.digest,
        source_id: source.id, source_incarnation: retained.source_incarnation, state: 'committed', recovery: null });
      expect(Number(final.recovery_bytes)).toBe(0);
      const snapshot = (await pg.engine.readPageSnapshot(slug, { sourceId: source.id }))!;
      expect(snapshot.page.id).toBe(before.page.id);
      expect(snapshot.page.compiled_truth).toBe(`After ${oldFirst} ${boundary} handoff`);
      expect(snapshot.revision).toBe(done.revision);
      expect(readFileSync(path, 'utf8')).toContain(snapshot.page.compiled_truth);
      expect((await call(successor, 'put_page', args)).body.revision).toBe(done.revision);
      expect(await pg.engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [args.request_id])).toEqual([{ id: retained.id }]);
      expect(await pg.engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id])).toHaveLength(versions.length + 1);
      expect(await pg.engine.executeRaw('SELECT key,lifetime_ids,terminal_bytes FROM persistence_counters ORDER BY key')).toEqual(counters);
      await assertConservation(pg.engine);
    }, 90000);
  }

  test('foreign and narrowed OAuth receipts remain opaque without granting helper access', async () => {
    const own = { slug: 'notes/oauth-private-id', content: content('Synthetic scoped fixture'), request_id: randomUUID() };
    await call(clients[1], 'put_page', own);
    const foreign = await receipt(clients[0], own.request_id);
    const missing = await receipt(clients[0], randomUUID());
    expect(foreign).toEqual(missing);
    await pg.engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$2::text[] WHERE client_id=$1', [oauthId, ['put_page', 'remember']]);
    expect((await call(clients[1], 'get_write_request', { request_id: own.request_id })).result.isError).toBe(true);
    expect((await call(clients[1], 'put_page', own)).body.state).toBe('committed');
    await pg.engine.executeRaw('UPDATE oauth_clients SET bound_slug_prefixes=$2::text[] WHERE client_id=$1', [oauthId, ['different-prefix']]);
    expect((await call(clients[1], 'put_page', own)).result.isError).toBe(true);
    await pg.engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [oauthId]);
    await pg.engine.executeRaw("UPDATE access_tokens SET revoked_at=now() WHERE name='synthetic-http-writer'");
    for (const token of tokens) {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'get_write_request', arguments: { request_id: own.request_id } } }) });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(own.request_id);
    }
  });
});
