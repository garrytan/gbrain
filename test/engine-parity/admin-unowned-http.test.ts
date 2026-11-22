/**
 * BrainEngine parity: the serve --http routes the Rust engine answered 503, 500 or 400 on (or answered 200 by swallowing a
 * refused read) while PGLite answered, over HTTP as `buildServeHttpApp` mounts them, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm GET /health answers 200; the owner registers a client-credentials client and a public
 *    authorization-code client, previews a registration (dry run), is refused a second client under a live name (409)
 *    and a client bound to a source that does not exist (400); provisions a harness grant (preview, then real) and
 *    recovers a client's setup; lists API keys with an active and a revoked key; links, lists, refuses a second link of
 *    one id and unlinks a member link; an OAuth client and a legacy key queue an /ingest capture (202) and a
 *    member-bound client is refused (403); a retry of a capture recorded under the pre-v0.60.609.0 key (no slug part)
 *    answers the recorded job for its slug, frees a dead row's key and queues anew, and queues anew for another slug;
 *    the jobs snapshot reads its recent errors and budget owners without a refusal. GET /admin/api/ops is not here: its doctor checks (capacity counters, persistence and checkpoint reads)
 *    still send raw SQL that the doctor lane moves to typed members.
 *    Every answer equals PGLite's once times and generated ids are reduced to their shape.
 *  - Regression: a route handler that reads or writes with raw SQL the Rust store refuses (the route then answers 503,
 *    500 or 400 on a Rust brain, or 200 with a section dropped), or a typed member one engine applies differently.
 *  - Why existing coverage misses it: test/engine-parity/admin-http.test.ts covers the other admin routes; the
 *    registration, grant, key-list, member-link and ingest tests (test/serve-http-*.test.ts,
 *    test/oauth-client-setup.serial.test.ts) run on PGLite only.
 *  - Seam: GBRAIN_HOME through withEnv (credential delivery files live under it). Real engines and the real
 *    `buildServeHttpApp` on a loopback port; rows are written through members and the routes.
 */
import { describe } from 'bun:test';
import type { Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildServeHttpApp } from '../../src/commands/serve-http.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { computeContentHash } from '../../src/core/ingestion/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Generated credential values: client ids, secrets and the setup text that quotes them. */
const GENERATED = new Set(['clientId', 'client_id', 'clientSecret', 'client_secret', 'token', 'id', 'job_id', 'jobId', 'owner_id']);

/** A JSON answer as a caller sees it, with times and generated ids reduced to their shape. */
function shape(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => shape(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  if (typeof value === 'string' && (key.endsWith('_at') || key === 'created' || key === 'generated_at')) return Number.isNaN(Date.parse(value)) ? `bad time: ${value}` : 'time';
  if (GENERATED.has(key) && (typeof value === 'string' || typeof value === 'number')) return typeof value;
  if ((key === 'ts_ms' || key === 'expires_at') && typeof value === 'number') return 'num';
  if (typeof value === 'string' && UUID.test(value)) return 'uuid';
  if (typeof value === 'string') return value.replace(/gbrain_cs_[A-Za-z0-9_-]+/g, '<secret>').replace(/gbrain_cl_[A-Za-z0-9_-]+/g, '<client>').replace(/gbrain_at_[0-9a-f]+/g, '<access token>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
  return value;
}

type Call = (path: string, payload?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown; raw: unknown }>;

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  // The real path: credential delivery files refuse a symlink anywhere in their path (harness/credentials.ts), and on
  // macOS tmpdir() sits behind the /var -> /private/var symlink.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-parity-admin-unowned-')));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** Serves the real app on a loopback port, signs the owner in, and runs `body` with a cookie GET/POST and a bare one. */
async function withAdmin<T>(engine: BrainEngine, body: (call: Call, bare: Call, base: string) => Promise<T>): Promise<T> {
  const app = express();
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const built = await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
    const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: built.bootstrapToken }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    if (login.status !== 200 || !cookie.startsWith('gbrain_admin=')) throw new Error(`login: ${login.status}`);
    const make = (withCookie: boolean): Call => async (path, payload, headers = {}) => {
      const auth: Record<string, string> = withCookie ? { cookie } : {};
      const form = headers['Content-Type'] === 'application/x-www-form-urlencoded';
      const res = await fetch(`${base}${path}`, payload === undefined ? { headers: { ...auth, ...headers } } : {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers },
        body: form ? new URLSearchParams(payload as Record<string, string>) : JSON.stringify(payload),
      });
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: shape(json), raw: json };
    };
    return await body(make(true), make(false), base);
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  }
}

const statuses = (out: Record<string, unknown>) => Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as { status: number }).status]));
const drop = (out: Record<string, { status: number; body: unknown; raw?: unknown }>) =>
  Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { status: v.status, body: v.body }]));

function expectStatuses(out: Record<string, unknown>, want: Record<string, number>): void {
  const got = statuses(out);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`statuses: ${JSON.stringify(got)}: ${JSON.stringify(out).slice(0, 4000)}`);
}

async function seedClient(engine: BrainEngine, clientId: string, secret: string, scope = 'read write'): Promise<void> {
  await engine.insertOauthClient({ client_id: clientId, client_name: clientId, scope, grant_types: ['client_credentials'],
    client_secret_hash: hashToken(secret), client_secret_expires_at: 0, client_id_issued_at: 1_700_000_000,
    source_id: 'default', federated_read: ['default'] });
}

describe('engine parity: the unowned admin and serve routes over HTTP', () => {
  parityTest('GET /health answers 200 on every engine',
    { methods: ['getConfig', 'pingStore'], timeout: 120_000 },
    async (engine: BrainEngine) => withAdmin(engine, async (_call, bare) => {
      const out = { health: await bare('/health') };
      expectStatuses(out, { health: 200 });
      const body = out.health.raw as { status?: string };
      if (body.status !== 'ok') throw new Error(`health: ${JSON.stringify(out)}`);
      return { status: out.health.status, status_field: body.status };
    }));

  parityTest('the owner registers clients, previews one, and is refused a live duplicate name and an unknown source the same way on every engine',
    { methods: ['listOauthClients', 'readOauthClient', 'lockOauthClientName', 'readLiveOauthClients', 'readSourceAttestState'], timeout: 120_000 },
    async (engine: BrainEngine) => inFreshHome(() => withAdmin(engine, async (call) => {
      const out: Record<string, { status: number; body: unknown; raw: unknown }> = {};
      out.cc = await call('/admin/api/register-client', { name: 'parity-cc', scopes: 'read write admin', grantTypes: ['client_credentials'] });
      out.pub = await call('/admin/api/register-client', { name: 'parity-ac', scopes: 'read write', grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: ['http://127.0.0.1:9/cb'], tokenEndpointAuthMethod: 'none' });
      out.preview = await call('/admin/api/register-client', { name: 'parity-preview', scopes: 'read', grantTypes: ['client_credentials'], dryRun: true });
      out.previewDup = await call('/admin/api/register-client', { name: 'parity-cc', scopes: 'read', grantTypes: ['client_credentials'], dryRun: true });
      out.dup = await call('/admin/api/register-client', { name: 'parity-cc', scopes: 'read', grantTypes: ['client_credentials'] });
      out.unknownSource = await call('/admin/api/register-client', { name: 'parity-nowhere', scopes: 'read', grantTypes: ['client_credentials'], source: 'no-such-source' });
      out.clients = await call('/admin/api/agents');
      expectStatuses(out, { cc: 200, pub: 200, preview: 200, previewDup: 409, dup: 409, unknownSource: 400, clients: 200 });
      // Not vacuous: the duplicate names the first client, the preview wrote nothing, and two clients are listed.
      const ccId = (out.cc.raw as { clientId: string }).clientId;
      if ((out.dup.raw as { client_id: string }).client_id !== ccId || (out.previewDup.raw as { client_id: string }).client_id !== ccId) {
        throw new Error(`duplicate: ${JSON.stringify(out)}`);
      }
      const names = ((out.clients.raw as Array<{ name?: string; client_name?: string }>).map(c => c.name ?? c.client_name)).sort();
      if (JSON.stringify(names.filter(n => String(n).startsWith('parity-'))) !== JSON.stringify(['parity-ac', 'parity-cc'])) throw new Error(`clients: ${JSON.stringify(names)}`);
      if ((out.unknownSource.raw as { error: string }).error !== 'unknown_source') throw new Error(`unknown source: ${JSON.stringify(out.unknownSource)}`);
      return drop(out);
    })));

  parityTest('the owner previews and provisions a harness grant and recovers a client setup the same way on every engine',
    { methods: ['readOauthClient', 'readOauthClientForUpdate', 'lockOauthClientName'], timeout: 120_000 },
    async (engine: BrainEngine) => inFreshHome(() => withAdmin(engine, async (call, _bare, base) => {
      const out: Record<string, { status: number; body: unknown; raw: unknown }> = {};
      out.grantPreview = await call('/admin/api/grants', { harness: 'generic', name: 'parity-grant', url: `${base}/mcp`, dryRun: true });
      out.grant = await call('/admin/api/grants', { harness: 'generic', name: 'parity-grant', url: `${base}/mcp` });
      out.grantAgain = await call('/admin/api/grants', { harness: 'generic', name: 'parity-grant', url: `${base}/mcp` });
      out.cc = await call('/admin/api/register-client', { name: 'parity-recover', scopes: 'read write', grantTypes: ['client_credentials'] });
      const clientId = (out.cc.raw as { clientId?: string }).clientId ?? 'missing';
      out.recover = await call('/admin/api/recover-client', { clientId, harness: 'generic' });
      out.recoverUnknown = await call('/admin/api/recover-client', { clientId: 'gbrain_cl_no_such_client', harness: 'generic' });
      const want = statuses(out);
      if (want.grantPreview !== 200 || want.grant !== 200 || want.cc !== 200 || want.recover !== 200) throw new Error(`grant/recover: ${JSON.stringify(out).slice(0, 4000)}`);
      return drop(out);
    })));

  parityTest('the API key list shows an active and a revoked key, newest first, the same way on every engine',
    { methods: ['insertAccessToken', 'listAccessTokenRows', 'readSourceAttestState'], timeout: 120_000 },
    async (engine: BrainEngine) => withAdmin(engine, async (call) => {
      const out: Record<string, { status: number; body: unknown; raw: unknown }> = {};
      out.empty = await call('/admin/api/api-keys');
      out.first = await call('/admin/api/api-keys', { name: 'parity-key-a', scopes: ['read'] });
      await Bun.sleep(5);
      out.second = await call('/admin/api/api-keys', { name: 'parity-key-b', scopes: ['read', 'write'], sources: ['default'] });
      out.unknownSource = await call('/admin/api/api-keys', { name: 'parity-key-c', scopes: ['read'], sources: ['no-such-source'] });
      out.revoke = await call('/admin/api/api-keys/revoke', { id: (out.first.raw as { id: string }).id });
      out.list = await call('/admin/api/api-keys');
      expectStatuses(out, { empty: 200, first: 200, second: 200, unknownSource: 400, revoke: 200, list: 200 });
      const rows = out.list.raw as Array<{ name: string; status: string }>;
      if (JSON.stringify(rows.map(r => [r.name, r.status])) !== JSON.stringify([['parity-key-b', 'active'], ['parity-key-a', 'revoked']])) {
        throw new Error(`key list: ${JSON.stringify(out.list)}`);
      }
      return drop(out);
    }));

  parityTest('the owner links, lists, refuses a second link and unlinks a member link the same way on every engine',
    { methods: ['getConfig', 'readAccessMemberLink', 'insertAccessMemberLink', 'deleteAccessMemberLink', 'listAccessMemberLinks'], timeout: 120_000 },
    async (engine: BrainEngine) => withAdmin(engine, async (call) => {
      const out: Record<string, { status: number; body: unknown; raw: unknown }> = {};
      out.alice = await call('/admin/api/access/members', { action: 'add', id: 'alice-example', name: 'Alice', email: 'alice@example.com' });
      out.charlie = await call('/admin/api/access/members', { action: 'add', id: 'charlie-example', name: 'Charlie' });
      out.empty = await call('/admin/api/access/member-links');
      out.preview = await call('/admin/api/access/member-links', { action: 'link', member: 'alice-example', externalId: 'U0ALICE', dryRun: true });
      out.link = await call('/admin/api/access/member-links', { action: 'link', member: 'alice-example', externalId: 'U0ALICE' });
      out.byEmail = await call('/admin/api/access/member-links', { action: 'link', email: 'alice@example.com', externalId: 'oidc:3f2a:alice-example' });
      out.charlieLink = await call('/admin/api/access/member-links', { action: 'link', member: 'charlie-example', externalId: 'U0CHARLIE' });
      out.again = await call('/admin/api/access/member-links', { action: 'link', member: 'charlie-example', externalId: 'U0ALICE' });
      out.badId = await call('/admin/api/access/member-links', { action: 'link', member: 'alice-example', externalId: 'has space' });
      out.list = await call('/admin/api/access/member-links');
      out.listAlice = await call('/admin/api/access/member-links?member=alice-example');
      out.unlink = await call('/admin/api/access/member-links', { action: 'unlink', externalId: 'U0ALICE' });
      out.unlinkAgain = await call('/admin/api/access/member-links', { action: 'unlink', externalId: 'U0ALICE' });
      out.after = await call('/admin/api/access/member-links');
      expectStatuses(out, { alice: 200, charlie: 200, empty: 200, preview: 200, link: 200, byEmail: 200, charlieLink: 200, again: 400, badId: 400,
        list: 200, listAlice: 200, unlink: 200, unlinkAgain: 400, after: 200 });
      const ids = (k: string) => ((out[k]!.raw as { links: Array<{ external_id: string; member_id: string }> }).links).map(l => `${l.member_id}/${l.external_id}`);
      if (JSON.stringify(ids('list')) !== JSON.stringify(['alice-example/U0ALICE', 'alice-example/oidc:3f2a:alice-example', 'charlie-example/U0CHARLIE'])
        || ids('listAlice').length !== 2 || JSON.stringify(ids('after')) !== JSON.stringify(['alice-example/oidc:3f2a:alice-example', 'charlie-example/U0CHARLIE'])) {
        throw new Error(`links: ${JSON.stringify(out)}`);
      }
      return drop(out);
    }));

  parityTest('an OAuth client and a legacy key queue an /ingest capture and a member-bound client is refused the same way on every engine',
    { methods: ['insertOauthClient', 'admitJob', 'readCredentialMemberId', 'readJobDataByIdempotencyKey'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      await seedClient(engine, 'parity-ingest', 'parity-ingest-secret');
      await seedClient(engine, 'parity-member', 'parity-member-secret');
      await addMember(engine, 'alice-example', { name: 'Alice' });
      await bindCredential(engine, { kind: 'client', id: 'parity-member' }, { member: 'alice-example' });
      const legacy = await mintLegacyToken(engine, { name: 'parity-legacy', scopes: ['read', 'write'], takesHolders: ['world'] });
      return withAdmin(engine, async (_call, bare) => {
        const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
        const token = async (id: string, secret: string) => ((await bare('/token', { grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'read write' }, form)).raw as { access_token?: string }).access_token ?? 'none';
        const ingest = (bearer: string, content: string) => bare('/ingest', { content, title: 'Parity ingest' }, { Authorization: `Bearer ${bearer}` });
        const out: Record<string, { status: number; body: unknown; raw: unknown }> = {};
        const clientToken = await token('parity-ingest', 'parity-ingest-secret');
        out.client = await ingest(clientToken, 'A note about widgets.');
        out.clientAgain = await ingest(clientToken, 'A note about widgets.');
        out.legacy = await ingest(legacy.token, 'A second note about widgets.');
        out.member = await ingest(await token('parity-member', 'parity-member-secret'), 'A member note.');
        expectStatuses(out, { client: 202, clientAgain: 202, legacy: 202, member: 403 });
        // Not vacuous: the repeat answers the same job, and the member refusal names its code.
        if ((out.client.raw as { job_id?: unknown }).job_id !== (out.clientAgain.raw as { job_id?: unknown }).job_id) throw new Error(`repeat: ${JSON.stringify(out)}`);
        if (typeof (out.member.raw as { code?: unknown }).code !== 'string') throw new Error(`member refusal: ${JSON.stringify(out.member)}`);
        return drop(out);
      });
    });

  parityTest('an /ingest retry of a capture recorded under the old key answers the recorded job or frees a dead one the same way on every engine',
    { methods: ['insertOauthClient', 'admitJob', 'claimNextJob', 'completeJob', 'failJob', 'readJobDataByIdempotencyKey', 'coalesceOnIdempotencyKey', 'getJob'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      await seedClient(engine, 'parity-legacy-key', 'parity-legacy-key-secret');
      const queue = new MinionQueue(engine);
      const note = (line: string) => `---\ntype: note\ntitle: Legacy capture\n---\n# Legacy capture\n\n${line}\n`;
      /** A capture as a server before v0.60.609.0 recorded it: its key has no slug part; the job then ended as `how`. */
      const recorded = async (line: string, slug: string, how: 'completed' | 'dead') => {
        const key = `ingest:webhook:parity-legacy-key:default:${computeContentHash(note(line))}`;
        const job = await queue.add('ingest_capture', { slug, sourceId: 'default' }, { idempotency_key: key });
        const claimed = await queue.claim('t:legacy', 30_000, 'default', ['ingest_capture']);
        if (claimed?.id !== job.id) throw new Error(`claim: ${JSON.stringify(claimed)}`);
        if (how === 'completed') await queue.completeJob(job.id, 't:legacy');
        else await queue.failJob(job.id, 't:legacy', 'gone', 'dead');
        return { id: job.id, key };
      };
      const done = await recorded('A completed capture.', 'notes/legacy-done', 'completed');
      const dead = await recorded('A dead capture.', 'notes/legacy-dead', 'dead');
      const moved = await recorded('A capture sent to another slug.', 'notes/legacy-first', 'completed');
      return withAdmin(engine, async (_call, bare, base) => {
        const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
        const token = ((await bare('/token', { grant_type: 'client_credentials', client_id: 'parity-legacy-key', client_secret: 'parity-legacy-key-secret', scope: 'read write' }, form)).raw as { access_token?: string }).access_token!;
        const retry = async (line: string, slug: string) => {
          const res = await fetch(`${base}/ingest`, { method: 'POST', body: note(line),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown', 'X-Gbrain-Slug': slug } });
          const text = await res.text();
          let raw: unknown;
          try { raw = JSON.parse(text); } catch { raw = text; }
          return { status: res.status, raw: raw as { job_id?: number } };
        };
        const out = {
          sameSlug: await retry('A completed capture.', 'notes/legacy-done'),
          deadRow: await retry('A dead capture.', 'notes/legacy-dead'),
          otherSlug: await retry('A capture sent to another slug.', 'notes/legacy-second'),
        };
        expectStatuses(out, { sameSlug: 202, deadRow: 202, otherSlug: 202 });
        const freed = await engine.getJob(dead.id);
        const kept = await engine.getJob(moved.id);
        const data = (row: { data?: unknown } | null) => (typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data) as Record<string, unknown> | undefined;
        /** A job a retry queued anew: a stored row other than the recorded one, waiting, for the slug the retry named. */
        const queuedAnew = async (jobId: unknown, recordedId: number, slug: string) => {
          if (typeof jobId !== 'number' || jobId === recordedId) return false;
          const row = await engine.getJob(jobId);
          return row?.status === 'waiting' && data(row)?.slug === slug;
        };
        const got = {
          // Not vacuous: each retry is compared with the recorded job's id, a fresh job is read back, and the freed key is
          // read back from the row.
          answers: {
            sameSlug: out.sameSlug.raw.job_id === done.id,
            deadRow: await queuedAnew(out.deadRow.raw.job_id, dead.id, 'notes/legacy-dead'),
            otherSlug: await queuedAnew(out.otherSlug.raw.job_id, moved.id, 'notes/legacy-second'),
          },
          freed: { key: freed?.idempotency_key ?? null, releasedKeyKept: data(freed)?.__released_idempotency_key === dead.key, status: freed?.status },
          kept: { keyHeld: kept?.idempotency_key === moved.key, status: kept?.status },
        };
        const want = { answers: { sameSlug: true, deadRow: true, otherSlug: true }, freed: { key: null, releasedKeyKept: true, status: 'dead' },
          kept: { keyHeld: true, status: 'completed' } };
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`legacy retry: ${JSON.stringify({ got, out }).slice(0, 4000)}`);
        return got;
      });
    });

  parityTest('the jobs snapshot reads the recent errors and budget owners without a refusal on every engine',
    { methods: ['admitJob', 'claimNextJob', 'failJob', 'listRecentFailedJobErrors', 'listBudgetOwners'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      const queue = new MinionQueue(engine);
      for (const [name, how, error] of [['parity-a', 'dead', 'prompt is too long'], ['parity-b', 'failed', 'prompt is too long'], ['parity-c', 'dead', 'rate lease "x" full (1/1)']] as const) {
        await queue.add(name, {}, { max_attempts: 1 });
        const job = await queue.claim(`t:${name}`, 30_000, 'default', [name]);
        if (!job) throw new Error(`claim ${name}`);
        await queue.failJob(job.id, `t:${name}`, error, how);
      }
      return withAdmin(engine, async (call) => {
        const watch = await call('/admin/api/jobs/watch');
        if (watch.status !== 200) throw new Error(`watch: ${JSON.stringify(watch).slice(0, 4000)}`);
        const snap = watch.raw as { top_errors: Array<{ count: number }>; budget_owners: unknown[] };
        if (JSON.stringify(snap.top_errors.map(e => e.count)) !== JSON.stringify([2, 1])) throw new Error(`top errors: ${JSON.stringify(watch)}`);
        return { watch: watch.body };
      });
    });
});
