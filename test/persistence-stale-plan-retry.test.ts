/**
 * GST-2314: a migration that adds a `persistence_requests` column under a running writer must not fail accepted writes.
 * Inside a publication transaction, a prepared `SELECT *` whose plan was cached before the column existed fails with
 * 0A000 ("cached plan must not change result type"); the transaction rolls back and nothing is committed.
 * 1. Protects: after `ALTER TABLE persistence_requests ADD COLUMN`, every put_page on a pool of 3 publishes, with no
 *    request charged more stale-plan interruptions than `persistence.max_transient_retries` allows, and no caller
 *    refused at admission.
 * 2. Fails when: the stale-plan error is not a transient interruption (the write ends failed/storage_error, never
 *    claimed again) or admission does not re-run it (the caller gets internal_error).
 * 3. Real seams: the serve --http token verifier, MCP dispatch, admission, the resident consumer and publication.
 * The worktree-backed arm takes the recovery route (the request holds a recovery record): every page's file lands
 * once, with one Git commit per page, so a stale plan never publishes a page twice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { withEnv } from './helpers/with-env.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const note = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Body of ' + title + '.'].join('\n');
const MAX_TRANSIENT_RETRIES = 5;
type Settled = { request_id: string; state: string; error_code: string | null; transient_interruptions: number };
async function settle(engine: BrainEngine, ids: string[]): Promise<Settled[]> {
  const read = () => engine.executeRaw<Settled>(
    'SELECT request_id::text, state, error_code, transient_interruptions FROM persistence_requests WHERE request_id = ANY($1::uuid[]) ORDER BY request_id', [ids]);
  let rows = await read();
  for (const until = Date.now() + 120_000; Date.now() < until && rows.some(r => r.state !== 'committed' && r.state !== 'failed'); rows = await read()) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return rows;
}
/**
 * Runs `pass` until `done()` or `ms` elapse, yielding to timers after each pass. PGLite queries settle as microtasks and
 * `git log` runs synchronously, so a loop without that yield starves the resident consumer: its effect pass, parked on a
 * lock-poll timer while it holds git claims, never resumes, and the claims sit out their 2-minute lease.
 */
async function untilDone(pass: () => Promise<unknown>, done: () => boolean, ms: number): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until && !done();) {
    await pass();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

for (const kind of testBackends()) {
  describe('accepted writes after a migration adds a persistence_requests column (' + kind + ')', () => {
    const POOL = kind === 'postgres' ? 3 : 1;
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', POOL));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 240_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); _resetWriteThroughCacheForTest(); await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-stale-plan-' + kind + '-'));

    test('every put_page after the column is added publishes within the transient retry limit', async () => {
      const minted = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      let n = 0;
      const put = async () => {
        const slug = 'notes/stale-plan-' + (n++);
        const requestId = randomUUID();
        const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
        const out = await dispatchToolCall(engine, 'put_page', { slug, content: note(slug), request_id: requestId },
          { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        return { requestId, code: out.isError === true ? String(JSON.parse(text).code) : 'ok' };
      };
      const warm = [];
      for (let i = 0; i < 4; i++) warm.push(await put());
      warm.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(warm.map(w => w.code)).toEqual(warm.map(() => 'ok'));

      await engine.executeRaw('ALTER TABLE persistence_requests ADD COLUMN probe_added_column TEXT');
      const after = [];
      for (let i = 0; i < 6; i++) after.push(await put());
      after.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(after.map(a => a.code).filter(code => code !== 'ok' && code !== 'write_pending')).toEqual([]);

      const ids = after.map(a => a.requestId);
      const settled = async () => engine.executeRaw<{ state: string; error_code: string | null; transient_interruptions: number }>(
        'SELECT state, error_code, transient_interruptions FROM persistence_requests WHERE request_id = ANY($1::uuid[])', [ids]);
      let rows = await settled();
      for (const until = Date.now() + 120_000; Date.now() < until && rows.some(r => r.state !== 'committed' && r.state !== 'failed'); rows = await settled()) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(rows.map(r => r.state + (r.error_code ? '/' + r.error_code : ''))).toEqual(ids.map(() => 'committed'));
      expect(Math.max(...rows.map(r => r.transient_interruptions))).toBeLessThanOrEqual(MAX_TRANSIENT_RETRIES);
    }, 300_000);

    test('on a worktree-backed source every page is published once, with one commit, after the column is added', async () => {
      const brainDir = mkdtempSync(join(home, 'brain-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', brainDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      writeFileSync(join(brainDir, 'seed.md'), 'seed\n');
      durableGitRepo(brainDir, ['seed.md']);
      const sourceId = 'wt-' + randomUUID().slice(0, 8);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, brainDir]);
      await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, brainDir));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      _resetWriteThroughCacheForTest();
      const ctx = { engine, config: { engine: kind, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} },
        dryRun: false, remote: false, sourceId } as unknown as OperationContext;
      const putPage = operations.find(o => o.name === 'put_page')!;
      let n = 0;
      const put = async () => {
        const slug = 'wt/stale-plan-' + (n++);
        const requestId = randomUUID();
        const out = await withEnv({ GBRAIN_HOME: home }, () => putPage.handler(ctx, { slug, content: note(slug), request_id: requestId, wait_ms: 20_000 }))
          .then(result => String((result as { state?: string }).state), (error: { code?: string }) => String(error.code));
        return { slug, requestId, out };
      };
      const warm = [];
      for (let i = 0; i < 4; i++) warm.push(await put());
      warm.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(warm.map(w => w.out)).toEqual(warm.map(() => 'committed'));

      await engine.executeRaw('ALTER TABLE persistence_requests ADD COLUMN probe_added_worktree_column TEXT');
      const after = [];
      for (let i = 0; i < 6; i++) after.push(await put());
      after.push(...await Promise.all(Array.from({ length: POOL }, () => put())));
      expect(after.map(a => a.out).filter(out => out !== 'committed' && out !== 'write_pending')).toEqual([]);

      const rows = await settle(engine, after.map(a => a.requestId));
      expect(rows.map(r => r.state + (r.error_code ? '/' + r.error_code : ''))).toEqual(after.map(() => 'committed'));
      expect(Math.max(...rows.map(r => r.transient_interruptions))).toBeLessThanOrEqual(MAX_TRANSIENT_RETRIES);

      const pages = [...warm, ...after];
      expect(readdirSync(join(brainDir, 'wt')).sort()).toEqual(pages.map(p => p.slug.slice(3) + '.md').sort());
      for (const p of pages) expect(readFileSync(join(brainDir, p.slug + '.md'), 'utf8')).toContain('Body of ' + p.slug + '.');
      const commits = () => pages.map(p => git('log', '--format=%H', '--', p.slug + '.md').split('\n').filter(Boolean).length);
      const effects = () => withEnv({ GBRAIN_HOME: home }, () => runPersistenceEffects(engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 50 }));
      await untilDone(effects, () => commits().every(c => c >= 1), 120_000);
      await effects();
      expect(commits()).toEqual(pages.map(() => 1));
    }, 300_000);

    test('the commit wait yields to timers between effect passes, so a timer-parked pass can resume (GST-2314 forced probe)', async () => {
      let resumed = false;
      setTimeout(() => { resumed = true; }, 25);
      await untilDone(() => withEnv({ GBRAIN_HOME: home }, () => runPersistenceEffects(engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 50 })),
        () => resumed, 10_000);
      expect(resumed).toBe(true);
    }, 60_000);
  });
}
