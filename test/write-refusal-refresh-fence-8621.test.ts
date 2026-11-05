/**
 * #8621: a write refused by a refresh fence (`worktree_refreshing`) was reported as success or as an outage.
 *
 * Protects: `remember` with `items` whose every item a refresh fence refused is an error on every surface (MCP isError,
 * CLI exit 1), never a success envelope; the refusal is a registered retryable code whose fix renders `next: wait` with
 * `retry_after_ms`, through the memory verbs too (frozen `unavailable`, canonical `worktree_refreshing`); an interactive
 * write waits out a short fence (bounded) and commits, past the cap it is refused and nothing is journaled; background
 * writes are not delayed; a database-only (repo-less) source is never fenced.
 * Regression it catches: master returned `{failed: 1}` with isError false and exit 0 (`undefined (fact #undefined)`),
 * rendered the refusal as class server with `fix: gbrain doctor`, and refused every write at once.
 * Seams: the real refresh state machine paused at its drained boundary (`hooks.boundary`); the wait cap test seam.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, setupRefreshFixture, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
afterEach(() => _setRefreshFenceWaitForTests(null));

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const PERSON = '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n';

/** An entity page on the managed source, committed and synced through a completed refresh. */
async function withEntity(f: RefreshFixture): Promise<void> {
  f.push('alpha/people/alice-example.md', PERSON);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
}

/** Runs `fn` while a real refresh of the checkout is paused at its drained boundary; `release` lets it finish. */
async function duringRefresh(f: RefreshFixture, fn: (release: () => void) => Promise<void>) {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
  const refresh = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } } } });
  await drained;
  try { await fn(release); } catch (error) { release(); await refresh.catch(() => undefined); throw error; }
  release();
  return refresh;
}

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>, sourceId = f.alpha) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

test('remember items: a batch the fence refused entirely is an MCP error with a wait fix, not a success envelope', () => each(async f => {
  await withEntity(f);
  _setRefreshFenceWaitForTests(0);
  const result = await duringRefresh(f, async () => {
    const before = await f.requestCount();
    const out = await call(f, 'remember', { items: [{ fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' }] });
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ error: 'unavailable', code: 'worktree_refreshing', retryable: true, detail: 'retry_after_ms=1000' });
    expect(out.body.message).toContain('items[0]');
    expect(out.body.message).toContain('None of the 1 item(s) was saved');
    expect(out.body.fix.next).toBe('wait');
    expect(await f.requestCount()).toBe(before);
  });
  expect((await result).status).toBe('completed');
}), 120_000);

test('remember (single) refused by the fence keeps the frozen unavailable code and carries the canonical wait', () => each(async f => {
  await withEntity(f);
  _setRefreshFenceWaitForTests(0);
  await (await duringRefresh(f, async () => {
    const out = await call(f, 'remember', { fact: 'alice-example likes jazz', entity: 'people/alice-example', provenance: 'test' });
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ error: 'unavailable', code: 'worktree_refreshing', class: 'retryable', retryable: true });
    expect(out.body.fix).toMatchObject({ next: 'wait', argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json', '--brain', 'host'] });
  }));
}), 120_000);

test('put_page past the wait cap is refused retryable with fix.next wait and retry_after_ms, and nothing is journaled', () => each(async f => {
  _setRefreshFenceWaitForTests(400);
  await (await duringRefresh(f, async () => {
    const before = await f.requestCount();
    const started = performance.now();
    const out = await call(f, 'put_page', { slug: 'notes/capped', content: page('Capped', 'refused after the cap') });
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ error: 'worktree_refreshing', code: 'worktree_refreshing', class: 'retryable', retryable: true, detail: 'retry_after_ms=1000' });
    expect(out.body.fix.next).toBe('wait');
    expect(out.body.message).toContain('waited');
    expect(await f.requestCount()).toBe(before);
  }));
}), 120_000);

test('an interactive write waits out a short refresh fence and commits once the refresh finishes', () => each(async f => {
  let write: Promise<Record<string, unknown>> | undefined;
  const refresh = await duringRefresh(f, async release => {
    write = submitPageMutation({ ...f.ctx(f.alpha), admissionOrigin: 'interactive' },
      { operation: 'put_page', params: { slug: 'notes/waited', content: page('Waited', 'written after the refresh') } });
    await new Promise(resolve => setTimeout(resolve, 700));
    release();
  });
  expect((await refresh).status).toBe('completed');
  const written = await write!;
  expect((written.write_request as { state?: string } | undefined)?.state ?? written.state).toBe('committed');
  const [row] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.alpha, 'notes/waited']);
  expect(Number(row!.n)).toBe(1);
}), 120_000);

test('a background write is refused at once (its producer retries), and a database-only source is never fenced', () => each(async f => {
  await (await duringRefresh(f, async () => {
    const started = performance.now();
    const error = await f.put(f.alpha, 'notes/background', page('Background', 'refused')).then(() => null, e => e as { code?: string });
    expect(error?.code).toBe('worktree_refreshing');
    expect(performance.now() - started).toBeLessThan(2000);
    const repoLess = await call(f, 'put_page', { slug: 'notes/repo-less', content: page('Repo-less', 'database only') }, 'default');
    expect(repoLess.isError).toBe(false);
  }));
}), 120_000);

test('CLI: remember --items whose every item the fence refused exits 1; a refused put exits 1 with next wait', async () => {
  if (!backends.includes('pglite')) return;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-8621-'));
  const home = join(dir, 'home');
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfg = { engine: 'pglite' as const, database_path: join(home, '.gbrain', 'brain.pglite') };
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
    const alpha = await withEnv({ GBRAIN_HOME: home }, async () => {
      const engine = await createEngine(cfg);
      await engine.connect(cfg); await engine.initSchema();
      try {
        const f = await setupRefreshFixture(engine, dir);
        await withEntity(f);
        // A refresh left in syncing short of its target fences the checkout for the child processes below.
        const target = f.push('alpha/two.md', page('Alpha two', 'upstream'));
        const [w] = await engine.executeRaw<{ e: string }>('SELECT owner_epoch::text AS e FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
        const [b] = await engine.executeRaw<{ g: string }>('SELECT topology_generation::text AS g FROM persistence_source_bindings WHERE source_id=$1', [f.alpha]);
        await engine.executeRaw(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
          VALUES($1::uuid,$2::text[],gen_random_uuid(),$3,$4,'syncing',$5,$6,'origin/main')`, [f.worktreeId, [f.alpha, f.beta], w!.e, b!.g, f.head(), target]);
        return f.alpha;
      } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    });
    const run = (args: string[], input?: string) => spawnSync('bun', ['run', 'src/cli.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 120_000,
      env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_SKIP_STARTUP_HOOKS: '1' } });
    const batch = run(['remember', '--items', JSON.stringify([{ fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' }]), '--source-id', alpha]);
    expect(batch.status).toBe(1);
    expect(batch.stderr).toContain('worktree_refreshing');
    expect(batch.stdout).not.toContain('undefined');
    const put = run(['put', 'notes/refused', '--source-id', alpha, '--json'], page('Refused', 'body'));
    expect(put.status).toBe(1);
    const env = JSON.parse(put.stdout);
    expect(env).toMatchObject({ code: 'worktree_refreshing', class: 'retryable', retryable: true });
    expect(env.fix.next).toBe('wait');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);
