/**
 * gbrain#9227: a write killed at the head of a source's queue, or one whose principal is gone, must not wedge the
 * source. Each case kills a real child process (test/fixtures/stuck-head-worker.ts) with SIGKILL at a fault seam and
 * reads what becomes of the head it left, on PGLite and, with DATABASE_URL, on Postgres:
 *
 * 1. Killed while preparing: the claim is `running`/`preparing` with a 30 s lease and no recovery record.
 * 2. Killed inside the publication transaction of a database-only page: the transaction rolls back and the claim keeps
 *    the publication lease it stamped (`publicationLeaseMs`, 365 s by default) under a dead owner.
 * 3. Killed after the page file was written (a worktree-backed source): the recovery record survives, the file holds the
 *    new bytes and the database rolled back.
 * 4. The submitting OAuth client is revoked while its write is stuck at the head: no other principal can see or
 *    cancel it (control.ts cancelWriteRequest is scoped to the principal).
 *
 * What this file pins: the next write to the source, from a new process, commits the head at once in cases 1, 2 and 4
 * on both engines. On Postgres its one-shot consumer proves a same-host owner dead (#6650); on PGLite it holds the
 * datastore lock, so every claim written before it started is abandoned and its first scan releases them (#9227).
 * Case 3 is recovered at once on both engines (the recovery scan). A revoked principal's write ends
 * `failed`/`permission_denied` when it is next prepared. Meanwhile `gbrain sources writer status`, run from a new
 * process, reports the owner exited (`claim_owner_exited`, `resumes_on_its_own: true`). A live owner keeps its claim: a
 * second PGLite process cannot open the brain at all, and Postgres cannot prove a live owner dead. An owner Postgres
 * cannot prove dead (another boot or pid namespace) still holds the head for the rest of its lease (30 s, or 365 s
 * while publishing); a lapsed lease is modelled by moving `claim_expires_at` into the past, the clock the reclaim reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { readLocalWriter } from '../src/core/persistence/identity.ts';
import type { FaultPoint } from '../src/core/persistence/fault-points.ts';
import type { StuckHeadWorkerConfig } from './fixtures/stuck-head-worker.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;
const FOREIGN_BOOT = '00000000-0000-0000-0000-000000000000';
type Head = { state: string; error_code: string | null; preparation_attempts: number; recovery: boolean; phase: string | null; token: string | null; lease_s: number | null };
type WorkerEvent = { event: 'boundary' | 'done' | 'failure' | 'status'; point?: string; state?: string; code?: string; ms?: number; message?: string; blocker?: Record<string, any> | null };

for (const backend of testBackends()) describe(`[${backend}] a stuck head of a source's write queue (#9227)`, () => {
  let engine: BrainEngine;
  let reopen: () => Promise<void> = async () => {};
  let databaseUrl = '';
  let closePostgres: (() => Promise<void>) | undefined;
  const home = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-stuck-head-${backend}-`)));
  const dataDir = join(home, 'data');
  const repo = join(home, 'repo');
  const env = { GBRAIN_HOME: home };
  const postgres = backend === 'postgres';

  beforeAll(async () => withEnv(env, async () => {
    if (!postgres) {
      reopen = async () => { const opened = new PGLiteEngine(); await opened.connect({ engine: 'pglite', database_path: dataDir }); engine = opened; };
      await reopen();
      await engine.initSchema();
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine; databaseUrl = pg.databaseUrl; closePostgres = pg.close;
    }
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['repo-source', repo]);
    await claimWorktree(engine, 'repo-source', repo);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id) VALUES('client-a','Example client','read write','default')`);
  }), 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  /** Starts one put_page in a child process on this brain and host; `next()` resolves with its next event. */
  function spawnWorker(config: Partial<StuckHeadWorkerConfig> & { slug: string }) {
    const requestId = config.requestId ?? randomUUID();
    const file = join(home, `worker-${requestId}.json`);
    writeFileSync(file, JSON.stringify({ engine: backend, databasePath: dataDir, databaseUrl, sourceId: 'default', content: page(config.slug), requestId, ...config }));
    const child = spawn('bun', [join(import.meta.dir, 'fixtures/stuck-head-worker.ts'), file], { env: { ...process.env, HOME: home, GBRAIN_HOME: home }, stdio: [config.hold ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '', seen = 0;
    const waiters: Array<() => void> = [];
    child.stderr!.on('data', chunk => { err += chunk; });
    child.stdout!.on('data', chunk => { out += chunk; waiters.splice(0).forEach(wake => wake()); });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let done = false;
    void exited.then(() => setTimeout(() => { done = true; waiters.splice(0).forEach(wake => wake()); }, 100));
    const next = async (): Promise<WorkerEvent> => {
      for (;;) {
        const lines = out.split('\n').filter(text => text.startsWith('{') && text.endsWith('}'));
        if (lines.length > seen) return JSON.parse(lines[seen++]!);
        if (done) throw new Error(`worker exited without an event: ${out}${err.slice(-2000)}`);
        await new Promise<void>(wake => waiters.push(wake));
      }
    };
    return { child, exited, next };
  }
  /** Runs one put_page in a child process; with a seam, SIGKILLs it there. PGLite is closed meanwhile (one process at a time). */
  async function worker(config: Partial<StuckHeadWorkerConfig> & { slug: string }): Promise<WorkerEvent> {
    await disposePersistenceConsumer(engine);
    if (!postgres) await engine.disconnect();
    try {
      const { child, exited, next } = spawnWorker(config);
      const event = await next();
      if (event.event === 'boundary') child.kill('SIGKILL');
      await exited;
      return event;
    } finally {
      if (!postgres) await withEnv(env, reopen);
    }
  }
  const killAt = (point: FaultPoint, config: Partial<StuckHeadWorkerConfig> & { slug: string; requestId: string }) =>
    worker({ ...config, point }).then(event => expect(event).toEqual({ event: 'boundary', point }));
  const head = async (requestId: string): Promise<Head> => (await engine.executeRaw<Head>(`SELECT state,error_code,preparation_attempts,recovery IS NOT NULL AS recovery,
    claim_phase->>'phase' AS phase,execution_token::text AS token,round(EXTRACT(EPOCH FROM claim_expires_at-updated_at))::int AS lease_s
    FROM persistence_requests WHERE request_id=$1::uuid`, [requestId]))[0]!;
  /** The request's `gbrain sources writer status` row as a new process on this host reads it. */
  const blocker = async (source: string, requestId: string) => (await worker({ slug: 'unused', sourceId: source, requestId, status: true })).blocker!;
  const lapse = (requestId: string) => engine.executeRaw(`UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE request_id=$1::uuid AND state='running'`, [requestId]);

  /**
   * The head after the kill, then what a later write to the same source from a new process sees. Postgres: it proves the
   * owner dead and the head and the write both commit at once. PGLite: the write waits behind the head until its lease lapses.
   */
  async function laterWrites(source: string, stuck: string, slug: string): Promise<Head> {
    const later = await worker({ slug, sourceId: source });
    expect(later).toMatchObject({ event: 'done', state: 'committed' });
    expect(later.ms!).toBeLessThan(10_000);
    return head(stuck);
  }

  test('killed while preparing: a 30 s claim under a dead owner; writer status reports the owner exited; the next write commits the head at once', async () => {
    const stuck = randomUUID();
    await killAt('consumer:preparing', { slug: 'notes/killed-preparing', requestId: stuck });
    expect(await head(stuck)).toMatchObject({ state: 'running', phase: 'preparing', recovery: false, preparation_attempts: 0, lease_s: 30 });
    const status = await blocker('default', stuck);
    expect(status).toMatchObject({ state: 'running', claim: { phase: 'preparing', owner_exited: true, resumes_on_its_own: true, owner_live: false, stall: null, next: { code: 'claim_owner_exited', fix: { next: 'run' } } } });
    expect(await laterWrites('default', stuck, 'notes/after-preparing')).toMatchObject({ state: 'committed', recovery: false });
  }, 120_000);

  test('killed inside the publication transaction of a database-only page: a 365 s lease under a dead owner; the next write commits the head at once', async () => {
    const stuck = randomUUID();
    await killAt('publication:before_commit', { slug: 'notes/killed-publishing', requestId: stuck });
    expect(await head(stuck)).toMatchObject({ state: 'running', phase: 'publishing', recovery: false, lease_s: 365 });
    expect(await blocker('default', stuck)).toMatchObject({ claim: { phase: 'publishing', owner_exited: true, resumes_on_its_own: true, owner_live: false, next: { code: 'claim_owner_exited' } } });
    // The page lock the killed transaction held ended with it; the claim is a row, not a lock. Extract's derived-link
    // replacement (derived-links.ts) takes this same lock and gets it at once while the head is still stuck.
    const started = performance.now();
    await engine.transaction(tx => tx.lockPageKeys([{ sourceId: 'default', slug: 'notes/killed-publishing' }]));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await head(stuck)).toMatchObject({ state: 'running' });
    expect(await laterWrites('default', stuck, 'notes/after-publishing')).toMatchObject({ state: 'committed' });
  }, 120_000);

  test('killed after writing the page file: the recovery record is finished at once on both engines and the head commits', async () => {
    expect(await worker({ slug: 'notes/prior', sourceId: 'repo-source' })).toMatchObject({ event: 'done', state: 'committed' });
    const stuck = randomUUID();
    await killAt('publication:after_publication', { slug: 'notes/killed-after-file', requestId: stuck, sourceId: 'repo-source' });
    expect(await head(stuck)).toMatchObject({ state: 'running', phase: 'publishing', recovery: true });
    expect(readFileSync(join(repo, 'notes/killed-after-file.md'), 'utf8')).toContain('Body of notes/killed-after-file.');
    const later = await worker({ slug: 'notes/after-file', sourceId: 'repo-source' });
    expect(later).toMatchObject({ event: 'done', state: 'committed' });
    expect(later.ms!).toBeLessThan(10_000);
    expect(await head(stuck)).toMatchObject({ state: 'committed', recovery: false });
    expect(readFileSync(join(repo, 'notes/killed-after-file.md'), 'utf8')).toContain('Body of notes/killed-after-file.');
  }, 120_000);

  test('a revoked OAuth client\'s stuck write: no other principal can cancel it; it ends failed permission_denied when next prepared', async () => {
    const stuck = randomUUID();
    await killAt('consumer:preparing', { slug: 'notes/revoked-client', requestId: stuck,
      auth: { token: 'synthetic-token', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, sourceId: 'default', scopes: ['read', 'write'] } });
    await engine.executeRaw(`UPDATE oauth_clients SET deleted_at=now() WHERE client_id='client-a'`);
    const local = await withEnv(env, () => readLocalWriter(engine, 'cli'));
    expect(await cancelWriteRequest(engine, { kind: 'local_cli', id: local.id }, stuck)).toBeNull();
    expect(await head(stuck)).toMatchObject({ state: 'running', phase: 'preparing' });
    expect(await laterWrites('default', stuck, 'notes/after-revoked')).toMatchObject({ state: 'failed', error_code: 'permission_denied' });
  }, 120_000);

  test('a live owner keeps its claim: a process that cannot open the brain (PGLite) or cannot prove the owner dead (Postgres) never releases it', async () => {
    await disposePersistenceConsumer(engine);
    if (!postgres) await engine.disconnect();
    let owner: ReturnType<typeof spawnWorker> | undefined;
    try {
      const live = randomUUID();
      owner = spawnWorker({ slug: 'notes/live-owner', requestId: live, point: 'consumer:preparing', hold: true });
      expect(await owner.next()).toEqual({ event: 'boundary', point: 'consumer:preparing' });
      const before = postgres ? await head(live) : null;
      // A later write from another process: on PGLite it cannot take the datastore lock, so it runs no statement at all.
      const later = spawnWorker({ slug: 'notes/behind-live-owner', waitMs: 3_000 });
      const blocked = await later.next();
      await later.exited;
      expect(blocked.event).toBe('failure');
      if (postgres) {
        expect(blocked.code).toBe('write_pending');
        expect(await head(live)).toMatchObject({ state: 'running', phase: 'preparing', token: before!.token });
      } else expect(blocked.code).toBe('pglite_busy');
      expect(await owner.next()).toMatchObject({ event: 'failure', code: 'write_pending' });
      owner.child.stdin!.write('go\n');
      // The owner's own 30 s foreground budget may have cut the held preparation and started it again; either way it commits.
      let settled = await owner.next();
      while (settled.event === 'boundary') settled = await owner.next();
      expect(settled).toMatchObject({ event: 'done', state: 'committed' });
      await owner.exited;
    } finally {
      owner?.child.kill('SIGKILL');
      await owner?.exited;
      if (!postgres) await withEnv(env, reopen);
    }
  }, 120_000);

  if (postgres) test('an owner Postgres cannot prove dead (another boot) holds the head until its lease lapses, then the head commits', async () => {
    const stuck = randomUUID();
    await killAt('consumer:preparing', { slug: 'notes/foreign-owner', requestId: stuck });
    // Every claim the killed process held (its request and any effect it was draining) reads as another boot's.
    const [{ pid }] = await engine.executeRaw<{ pid: string }>(`SELECT claim_phase->'owner'->>'pid' AS pid FROM persistence_requests WHERE request_id=$1::uuid`, [stuck]);
    await engine.executeRaw(`UPDATE persistence_requests SET claim_phase=jsonb_set(claim_phase,'{owner,boot_id}',to_jsonb($2::text)) WHERE claim_phase->'owner'->>'pid'=$1`, [pid, FOREIGN_BOOT]);
    await engine.executeRaw(`UPDATE persistence_effects SET claim_owner=jsonb_set(claim_owner,'{owner,boot_id}',to_jsonb($2::text)) WHERE claim_owner->'owner'->>'pid'=$1`, [pid, FOREIGN_BOOT]);
    const before = await head(stuck);
    expect(before).toMatchObject({ state: 'running', phase: 'preparing', lease_s: 30 });
    const status = await blocker('default', stuck);
    expect(status.claim).toMatchObject({ resumes_on_its_own: false, next: { code: 'claim_running' } });
    expect(status.claim.owner_exited).toBeUndefined();
    expect(await worker({ slug: 'notes/behind-foreign-owner', waitMs: 3_000 })).toMatchObject({ event: 'failure', code: 'write_pending' });
    expect(await head(stuck)).toMatchObject({ state: 'running', token: before.token });
    await lapse(stuck);
    expect(await worker({ slug: 'notes/after-foreign-owner' })).toMatchObject({ event: 'done', state: 'committed' });
    expect(await head(stuck)).toMatchObject({ state: 'committed' });
  }, 120_000);
});
