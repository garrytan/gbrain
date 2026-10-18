/**
 * O-CEO-13: the bounded changed-contract conformance gate for fix wave 8.
 * The same cases run on PGLite (test/write-contract-conformance.test.ts) and
 * Postgres (test/e2e/write-contract-conformance.test.ts), each over stdio
 * dispatch and the real HTTP MCP transport. Only the contract surfaces this
 * wave changes are covered; the full every-op suite is a Foundations 2 TODO.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall, requestLogStatusForResult, type ToolResult } from '../../src/mcp/dispatch.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { VERB_NAMES } from '../../src/core/verbs.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../../src/core/grants/legacy-token.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { PROVIDER_ENV_KEYS } from '../helpers/provider-env.ts';
import { withEnv } from '../helpers/with-env.ts';

interface Reply { isError: boolean; body: Record<string, any>; status: string; }
interface Transport {
  name: 'stdio' | 'http';
  call(tool: string, args: Record<string, unknown>, opts?: { surface?: 'verbs'; abortAfterMs?: number }): Promise<Reply>;
  revoke(): Promise<void>;
  /** HTTP only: the legacy bearer token's name, for `auth rescope-token`. */
  tokenName?: string;
}
interface Fixture { engine: BrainEngine; transports: () => Promise<Transport[]>; }

const OPERATIONS = ['get_page', 'put_page', 'edit_page', 'get_write_request', 'remember', 'recall', 'find_orphans'];
const page = (body: string) => `---\ntitle: Conformance example\ntype: note\n---\n\n${body}\n`;
const reply = (result: ToolResult): Reply => ({ isError: result.isError === true, body: JSON.parse(result.content[0]!.text), status: requestLogStatusForResult(result) });

async function withFixture(databaseUrl: string | undefined, run: (fixture: Fixture) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gb-write-contract-'));
  try {
    await withEnv({ ...Object.fromEntries(PROVIDER_ENV_KEYS.map(key => [key, undefined])), HOME: join(dir, 'home'), GBRAIN_HOME: join(dir, 'home'),
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(databaseUrl);
      const engine = isolated.engine;
      const clients: Client[] = [];
      const servers: Array<Awaited<ReturnType<typeof startHttpTransport>>> = [];
      try {
        const root = join(dir, 'content'); mkdirSync(root, { recursive: true });
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        const limiters = () => ({ ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
          token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) });
        const full = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: limiters() });
        const verbs = await startHttpTransport({ port: 0, engine, surface: 'verbs', limiters: limiters() });
        servers.push(full, verbs);
        const transports = async (): Promise<Transport[]> => {
          const registration: LocalRegistration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
          const stdio: Transport = {
            name: 'stdio',
            call: async (tool, args, opts = {}) => {
              const pending = withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, tool, args, {
                remote: true, transport: 'stdio', sourceId: 'default', config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} },
                ...(opts.surface ? { surface: opts.surface, allowedOps: new Set(VERB_NAMES) } : {}),
              }));
              if (opts.abortAfterMs !== undefined) { void pending.catch(() => {}); throw new Error('response dropped'); }
              return reply(await pending);
            },
            revoke: async () => { await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]); },
          };
          const id = randomUUID(), token = `fixture-${randomUUID()}`, tokenName = `conformance-${id.slice(0, 8)}`;
          await engine.executeRaw(`INSERT INTO access_tokens(id,name,token_hash,scopes,permissions) VALUES($1::uuid,$2,$3,$4::text[],$5::text::jsonb)`,
            [id, tokenName, createHash('sha256').update(token).digest('hex'), ['read', 'write'],
              JSON.stringify({ source_id: 'default', allowed_operations: OPERATIONS })]);
          const connect = async (server: typeof full) => {
            const client = new Client({ name: 'write-contract-conformance', version: '1' }, { capabilities: {} });
            clients.push(client);
            // `Connection: close`: each HTTP call opens its own socket. The clients
            // connect before the stdio arm, so a pooled socket would sit idle past
            // the server's 10 s idle timeout (Bun.serve default, swept every 4 s);
            // Bun's fetch keeps pooled sockets for 5 minutes, cannot see that
            // timeout and never retries a POST, so a call issued as the sweep
            // closes the socket fails with ECONNRESET on a slow shard.
            await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
              requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } } }), { signal: AbortSignal.timeout(30_000) });
            return client;
          };
          const fullClient = await connect(full), verbsClient = await connect(verbs);
          const http: Transport = {
            name: 'http',
            tokenName,
            call: async (tool, args, opts = {}) => {
              const client = opts.surface ? verbsClient : fullClient;
              const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: opts.abortAfterMs ?? 30_000 });
              return reply(result as ToolResult);
            },
            revoke: async () => { await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1::uuid', [id]); },
          };
          return [stdio, http];
        };
        await run({ engine, transports });
      } finally {
        await Promise.all(clients.map(client => client.close().catch(() => {})));
        for (const server of servers) server.stop(true);
        await disposePersistenceConsumer(engine);
        await isolated.close();
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function hold(engine: BrainEngine) {
  const binding = await getWorktreeBinding(engine, 'default');
  // The consumer can still hold the worktree lock for a moment after the
  // previous write settled (post-publication effects), so wait for it.
  const lock = await acquireWorktree(binding!, 15_000);
  if (!lock) throw new Error('worktree lock unavailable');
  return lock;
}
async function settled(engine: BrainEngine, requestId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [row] = await engine.executeRaw<{ state: string; error_code: string | null }>(
      'SELECT state, error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    if (row && ['committed', 'conflict', 'failed', 'cancelled'].includes(row.state)) return row;
    if (Date.now() > deadline) throw new Error(`request ${requestId} did not settle: ${JSON.stringify(row)}`);
    await Bun.sleep(50);
  }
}
async function revision(transport: Transport, slug: string) {
  const read = await transport.call('get_page', { slug, include_content: true });
  expect(read.isError).toBe(false);
  return read.body as { revision: string; content: string };
}

export function writeContractConformanceCases(databaseUrl?: string) {
  const engineName = databaseUrl ? 'postgres' : 'pglite';
  describe(`write contract conformance (${engineName})`, () => {
    test('accepted → committed, and accepted → failed, over stdio and HTTP', async () => {
      await withFixture(databaseUrl, async ({ engine, transports }) => {
        for (const transport of await transports()) {
          const slug = `notes/${transport.name}-accepted`;
          const created = await transport.call('put_page', { slug, content: page('Created.'), request_id: randomUUID() });
          expect({ transport: transport.name, created }).toMatchObject({ created: { isError: false, status: 'success' } });
          const current = await revision(transport, slug);
          const commit = { slug, content: page('Committed later.'), expected_revision: current.revision, request_id: randomUUID() };
          let lock = await hold(engine);
          const pending = await transport.call('put_page', commit);
          await lock.release();
          expect({ transport: transport.name, pending }).toMatchObject({ pending: { isError: true, status: 'accepted_pending',
            body: { error: 'write_pending', write_request: { request_id: commit.request_id } } } });
          expect((await settled(engine, commit.request_id)).state).toBe('committed');
          const replayed = await transport.call('put_page', commit);
          expect({ transport: transport.name, replayed }).toMatchObject({ replayed: { isError: false, status: 'success', body: { state: 'committed' } } });

          const fresh = await revision(transport, slug);
          const doomed = { slug, content: page('Never published.'), expected_revision: fresh.revision, request_id: randomUUID() };
          lock = await hold(engine);
          const accepted = await transport.call('put_page', doomed);
          expect(accepted.status).toBe('accepted_pending');
          await engine.executeRaw("UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE slug=$1 AND source_id='default'", [slug]);
          await lock.release();
          expect(await settled(engine, doomed.request_id)).toMatchObject({ state: 'conflict' });
          const failed = await transport.call('put_page', doomed);
          expect({ transport: transport.name, failed }).toMatchObject({ failed: { isError: true, status: 'error', body: { write_request: { state: 'conflict' } } } });
          expect((await revision(transport, slug)).content).not.toContain('Never published.');
        }
      });
    }, 180_000);

    test('a lost response is recovered by replaying the same request_id, including on the verbs-only surface', async () => {
      await withFixture(databaseUrl, async ({ engine, transports }) => {
        for (const transport of await transports()) {
          const write = { slug: `notes/${transport.name}-lost`, content: page('Delivered once.'), request_id: randomUUID() };
          const lock = await hold(engine);
          await expect(transport.call('put_page', write, { abortAfterMs: 200 })).rejects.toThrow();
          await lock.release();
          expect((await settled(engine, write.request_id)).state).toBe('committed');
          const replayed = await transport.call('put_page', write);
          expect({ transport: transport.name, replayed }).toMatchObject({ replayed: { isError: false, body: { state: 'committed', request_id: write.request_id } } });
          const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [write.request_id]);
          expect(n).toBe(1);

          const remember = { fact: `Conformance replay fact ${transport.name}`, provenance: 'conformance-test', request_id: randomUUID() };
          const first = await transport.call('remember', remember, { surface: 'verbs' });
          expect({ transport: transport.name, first }).toMatchObject({ first: { isError: false } });
          const again = await transport.call('remember', remember, { surface: 'verbs' });
          expect(again.body).toEqual(first.body);
          const [{ facts }] = await engine.executeRaw<{ facts: number }>('SELECT count(*)::int AS facts FROM facts WHERE fact=$1', [remember.fact]);
          expect(facts).toBe(1);
        }
      });
    }, 180_000);

    test('edit_page refuses a stale revision with the current one over stdio and HTTP', async () => {
      await withFixture(databaseUrl, async ({ transports }) => {
        for (const transport of await transports()) {
          const slug = `notes/${transport.name}-edit`;
          expect((await transport.call('put_page', { slug, content: page('Alpha line.'), request_id: randomUUID() })).isError).toBe(false);
          const stale = (await revision(transport, slug)).revision;
          const edited = await transport.call('edit_page', { slug, expected_revision: stale, edits: [{ old_text: 'Alpha line.', new_text: 'Beta line.' }], request_id: randomUUID() });
          expect({ transport: transport.name, edited }).toMatchObject({ edited: { isError: false, body: { state: 'committed' } } });
          const current = (await revision(transport, slug)).revision;
          const conflict = await transport.call('edit_page', { slug, expected_revision: stale, edits: [{ old_text: 'Beta line.', new_text: 'Gamma line.' }], request_id: randomUUID() });
          expect({ transport: transport.name, conflict }).toMatchObject({ conflict: { isError: true, body: { error: 'revision_conflict', detail: `current_revision=${current}` } } });
        }
      });
    }, 180_000);

    test('a grant revoked between acceptance and publication is refused at publication', async () => {
      await withFixture(databaseUrl, async ({ engine, transports }) => {
        for (const transport of await transports()) {
          const write = { slug: `notes/${transport.name}-revoked`, content: page('Must not publish.'), request_id: randomUUID() };
          const lock = await hold(engine);
          const accepted = await transport.call('put_page', write);
          expect({ transport: transport.name, status: accepted.status }).toMatchObject({ status: 'accepted_pending' });
          await transport.revoke();
          await lock.release();
          expect(await settled(engine, write.request_id)).toMatchObject({ state: 'failed', error_code: 'permission_denied' });
          expect(await engine.getPage(write.slug, { sourceId: 'default' })).toBeNull();
        }
      });
    }, 180_000);

    test('find_orphans source filter stays inside the caller grant over stdio and HTTP (#5891)', async () => {
      await withFixture(databaseUrl, async ({ engine, transports }) => {
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other-example','other-example') ON CONFLICT DO NOTHING");
        await engine.putPage('people/other-orphan', { type: 'person', title: 'Other orphan', compiled_truth: 'Alone in another source.' }, { sourceId: 'other-example' });
        for (const transport of await transports()) {
          const slug = `people/${transport.name}-orphan`;
          expect((await transport.call('put_page', { slug, content: `---\ntitle: Orphan\ntype: person\n---\n\nAlone.\n`, request_id: randomUUID() })).isError).toBe(false);
          const own = await transport.call('find_orphans', { source_id: 'default', limit: 1000 });
          expect({ transport: transport.name, isError: own.isError }).toEqual({ transport: transport.name, isError: false });
          const rows = own.body.orphans as Array<{ slug: string; source_id: string }>;
          expect(rows.map(row => row.slug)).toContain(slug);
          expect(rows.every(row => row.source_id === 'default')).toBe(true);
          const other = await transport.call('find_orphans', { source_id: 'other-example' });
          expect({ transport: transport.name, other }).toMatchObject({ other: { isError: true, body: { error: 'not_found' } } });
          const unfiltered = await transport.call('find_orphans', { limit: 1000 });
          expect((unfiltered.body.orphans as Array<{ source_id: string }>).some(row => row.source_id === 'other-example')).toBe(false);
        }
      });
    }, 180_000);
    test('auth rescope-token: explicit empty allowed_operations, sources and takes holders deny all over HTTP; reset restores the default', async () => {
      await withFixture(databaseUrl, async ({ engine, transports }) => {
        const http = (await transports()).find(transport => transport.name === 'http')!;
        const rescope = (...args: string[]) => rescopeLegacyToken(engine, parseRescopeTokenArgs([http.tokenName!, ...args]));
        const slug = 'notes/http-rescope';
        expect((await http.call('put_page', { slug, content: page('Rescope probe.'), request_id: randomUUID() })).isError).toBe(false);
        const stored = await engine.getPage(slug, { sourceId: 'default' });
        await engine.addTakesBatch([{ page_id: stored!.id, row_num: 1, claim: 'Conformance world take', kind: 'take', holder: 'world', weight: 0.5 }]);
        await rescope('--operations', [...OPERATIONS, 'takes_list'].join(','));
        const worldTakes = async () => {
          const listed = await http.call('takes_list', { page_slug: slug });
          expect(listed.isError).toBe(false);
          return (listed.body as unknown as Array<{ claim: string }>).map(take => take.claim);
        };
        expect(await worldTakes()).toEqual(['Conformance world take']);

        await rescope('--takes-holders', 'none');
        expect(await worldTakes()).toEqual([]);
        await rescope('--reset-default', 'takes-holders');
        expect(await worldTakes()).toEqual(['Conformance world take']);

        await rescope('--operations', 'none');
        const noOps = await http.call('get_page', { slug });
        expect(noOps).toMatchObject({ isError: true, body: { error: 'permission_denied', detail: 'fence=operation_grant' } });
        await rescope('--reset-default', 'operations');
        expect((await http.call('get_page', { slug })).isError).toBe(false);

        await rescope('--sources', 'none');
        const noSource = await http.call('get_page', { slug });
        expect(noSource).toMatchObject({ isError: true, body: { error: 'permission_denied', detail: 'fence=no_source_grant' } });
        const write = { slug: 'notes/http-rescope-denied', content: page('Must not land.'), request_id: randomUUID() };
        expect(await http.call('put_page', write)).toMatchObject({ isError: true, body: { error: 'permission_denied', detail: 'fence=no_source_grant' } });
        expect(await engine.getPage(write.slug, { sourceId: 'default' })).toBeNull();
        await rescope('--reset-default', 'sources');
        expect((await http.call('get_page', { slug })).isError).toBe(false);
      });
    }, 180_000);
  });
}
