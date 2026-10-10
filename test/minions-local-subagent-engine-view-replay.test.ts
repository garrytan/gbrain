/**
 * Local-subagent capability vs. read-through engine views (Postgres preadmit cache, own-request memo) and
 * replay of stored local_subagent jobs.
 *
 * Real PGLite throughout. `preadmit_cache` only engages on Postgres, so the "cached admission" tests EMULATE
 * a Postgres read view by overriding `kind` on PGLite only for proxy-construction/refusal checks.
 * No emulated PostgreSQL publication runs here. Native PG commits and replay are in the E2E suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { prepareLocalSubagent } from '../src/core/minions/submission-authority.ts';
import { localSubagentTools } from '../src/core/minions/local-subagent.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalGrant } from '../src/core/persistence/identity.ts';
import { ownRequestAccessible } from '../src/core/persistence/authority.ts';
import { submitPageMutation, preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { preadmitReads, dropPreadmitCache } from '../src/core/persistence/preadmit-cache.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let schemaVersion: string; let home: string; let engine: PGLiteEngine; let other: PGLiteEngine; let queue: MinionQueue;
let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
const sourceId = 'local-child';
const grant: LocalGrant = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };
const ops = ['get_page', 'put_page'];
const prefixes = ['wiki/originals/*'];
const context = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, remote: false,
  sourceId, logger: { info() {}, warn() {}, error() {} } });
const payload = () => ({ source_id: sourceId, prompt: 'bounded engine-view test', allowed_tools: [...ops], allowed_slug_prefixes: [...prefixes] });
const mint = async (data = payload()) => withVerifiedLocalRegistration(engine, registration, () =>
  prepareLocalSubagent(context(), randomUUID(), 'subagent', data, data.allowed_tools, data.allowed_slug_prefixes));
const emulatePostgres = (e: PGLiteEngine) => Object.defineProperty(e, 'kind', { value: 'postgres', configurable: true });
// The engine is shared across the file, so the emulated kind must never outlive its test.
const restoreKind = (e: PGLiteEngine) => Object.defineProperty(e, 'kind', { value: 'pglite', configurable: true });
// GIT_CEILING_DIRECTORIES names the fixture's PARENT (never the cwd itself) so git never finds the live agent home marker.
// GBRAIN_PREADMIT_CACHE stays unset (default-enabled switch; never disable it to hide the issue).
const fixtureEnv = () => ({ GBRAIN_HOME: home, GIT_CEILING_DIRECTORIES: dirname(realpathSync(home)), GBRAIN_PREADMIT_CACHE: undefined });
// Every test body (not just setup) runs with the hermetic env, restored by withEnv even on failure.
const homeTest = (name: string, fn: () => Promise<void>) => test(name, () => withEnv(fixtureEnv(), fn));

// One engine per file (plus a second, real engine for the wrong-engine refusal check); data is wiped per test.
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  other = new PGLiteEngine(); await other.connect({}); await other.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 120_000);
afterAll(async () => {
  try { await engine?.disconnect(); } finally { await other?.disconnect(); }
});
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'local-engine-view-'));
  await withEnv(fixtureEnv(), async () => {
    expect(Bun.spawnSync(['git', '-C', home, 'rev-parse', '--show-toplevel'], { env: process.env }).exitCode).not.toBe(0);
    restoreKind(engine); dropPreadmitCache(engine); resetWriteSwitches();
    await resetPgliteState(engine); await resetPgliteState(other);
    await engine.setConfig('version', schemaVersion); await other.setConfig('version', schemaVersion); // the reset wipes the migration ledger row in config
    queue = new MinionQueue(engine);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    registration = await registerLocalWriter(engine, 'cli', structuredClone(grant));
    await engine.setConfig('embedding_disabled', 'true'); await engine.setConfig('facts.extraction_enabled', 'false');
  });
});
afterEach(() => {
  restoreKind(engine); dropPreadmitCache(engine); rmSync(home, { recursive: true, force: true });
  resetWriteSwitches();
});

async function accepted() {
  const data = payload();
  const privateQueue = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = await queue.add('subagent', data, { queue: privateQueue }, await mint(data));
  const lock = randomUUID();
  expect((await queue.claim(lock, 60_000, privateQueue, ['subagent']))?.id).toBe(job.id);
  const capability = await localSubagentTools(engine, job.id, data);
  expect(capability).toBeTruthy();
  const ctx: OperationContext = { ...context(), remote: true, viaSubagent: true, jobId: job.id, subagentId: job.id,
    allowedSlugPrefixes: [...prefixes], localSubagent: capability };
  return { data, job, lock, ctx };
}
const put = (ctx: OperationContext, slug: string, requestId = randomUUID(), visibility = 'world') =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId,
    content: `---\ntype: note\ntitle: View proof\nvisibility: ${visibility}\n---\n\nA bounded public decision about the engine view fixture. `.repeat(1) } });
const receipt = async (requestId: string) =>
  (await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!;

describe('local-subagent capability keeps its original engine through Postgres read views', () => {
  homeTest('the default preadmit_cache really produces an unregistered-to-capability proxy (premise check)', async () => {
    emulatePostgres(engine);
    const view = await preadmitReads(engine);
    expect(view).not.toBeNull();
    expect(view).not.toBe(engine);
  });

  // Native cached admission through commit and replay is exercised in
  // test/e2e/hermes-local-subagent-postgres.test.ts; never fake the PG publication engine.

  homeTest('receipt access: ownRequestAccessible allows the owning child for a public page and still excludes a private one', async () => {
    const a = await accepted();
    const publicId = randomUUID(); const privateId = randomUUID();
    await put(a.ctx, `wiki/originals/pub-${publicId.slice(0, 8)}`, publicId);
    await put(a.ctx, `wiki/originals/priv-${privateId.slice(0, 8)}`, privateId);
    const pub = await receipt(publicId); const priv = await receipt(privateId);
    expect(await ownRequestAccessible(a.ctx, pub)).toBe(true);
    // The write itself was world-visible; flipping the stored page private must hide the receipt again.
    await engine.executeRaw("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{visibility}','\"private\"') WHERE slug=$1 AND source_id=$2", [priv.slug, sourceId]);
    expect(await ownRequestAccessible(a.ctx, priv)).toBe(false);
    expect(await ownRequestAccessible(a.ctx, pub)).toBe(true);
    // Another principal never sees it.
    expect(await ownRequestAccessible({ ...context(), remote: true, viaSubagent: true, subagentId: a.job.id, allowedSlugPrefixes: prefixes }, pub)).toBe(false);
  });

  homeTest('fake, unregistered, and wrong-engine views still refuse (no global identity relaxation)', async () => {
    emulatePostgres(engine);
    const a = await accepted();
    const fakeProxy = new Proxy(engine, {});
    await expect(put({ ...a.ctx, engine: fakeProxy as unknown as PGLiteEngine }, `wiki/originals/fake-${randomUUID().slice(0, 8)}`)).rejects.toThrow('binding');
    // A real, correctly-built cache view that nothing registered with the capability is still refused when handed in directly.
    const view = (await preadmitReads(engine))!;
    await expect(preparePageAdmission({ ...a.ctx, engine: view }, { operation: 'put_page',
      params: { slug: `wiki/originals/view-${randomUUID().slice(0, 8)}`, content: '---\ntype: note\ntitle: x\n---\n\nbody body body' } })).rejects.toThrow('binding');
    await expect(put({ ...a.ctx, engine: other }, `wiki/originals/other-${randomUUID().slice(0, 8)}`)).rejects.toThrow();
    const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug LIKE 'wiki/originals/fake-%' OR slug LIKE 'wiki/originals/view-%' OR slug LIKE 'wiki/originals/other-%'");
    expect(rows[0]!.n).toBe(0);
  });
});

describe('replay of stored local_subagent jobs', () => {
  const counts = async () => ({
    jobs: (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs'))[0]!.n,
    requests: (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0]!.n,
  });
  for (const terminal of ['completed', 'failed', 'dead'] as const) {
    homeTest(`${terminal} local job: replay refuses with owner-rerun guidance before any new job or mutation`, async () => {
      const a = await accepted();
      if (terminal === 'completed') await queue.completeJob(a.job.id, a.lock, { ok: true });
      else await queue.failJob(a.job.id, a.lock, 'synthetic failure', terminal);
      expect((await queue.getJob(a.job.id))?.status).toBe(terminal);
      const before = await counts();
      const error = await queue.replayJob(a.job.id).then(() => null, e => e);
      expect(error).toMatchObject({ code: 'permission_denied' });
      expect(String(error.message)).toContain('local subagent job');
      expect(String(error.suggestion ?? error.message)).toContain('gbrain hermes maintain');
      expect(String(error.suggestion ?? '')).toContain('--source');
      expect(await counts()).toEqual(before);
      // Overrides are not a back door either.
      await expect(queue.replayJob(a.job.id, { prompt: 'x' })).rejects.toMatchObject({ code: 'permission_denied' });
      expect(await counts()).toEqual(before);
      // The stored descriptor is not an admission token.
      await expect(queue.add('subagent', a.data, {}, { submissionAuthority: (await queue.getJob(a.job.id))!.submission_authority! }))
        .rejects.toThrow('Unsupported submission authority');
      expect(await counts()).toEqual(before);
    });
  }

  homeTest('non-terminal local job is unchanged (null, no error); application job replay still works', async () => {
    const a = await accepted();
    expect(await queue.replayJob(a.job.id)).toBeNull();
    const app = await queue.add('research', { topic: 'AI' }, { priority: 5 });
    await queue.claim('app-lock', 30_000, 'default', ['research']);
    await queue.completeJob(app.id, 'app-lock', { done: true });
    const replay = await queue.replayJob(app.id);
    expect(replay).not.toBeNull();
    expect(replay!.id).not.toBe(app.id);
    expect(replay!.data).toEqual({ topic: 'AI' });
    expect(replay!.status).toBe('waiting');
  });
});
