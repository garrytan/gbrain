/**
 * Fix wave 4 lane B: connector data safety on managed and unmanaged brains,
 * PGLite here and PostgreSQL through test/e2e/connector-holds.test.ts.
 *  - #5752: an emoji at the Gmail body cap imports, and a re-run admits nothing.
 *  - connector item holds on Gmail and GitHub (#5752, #5740).
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { readAllSourceHolds } from '../src/core/connectors/item-holds-store.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { createConnectorFixture, options, sourceCheckpoint, sourceCursor, withGoogleAccount } from './helpers/connector-fixture.ts';
import { HOLD_CAP } from '../src/core/connectors/item-holds.ts';
import { addThread, fakeGitHub, fakeGmail, githubHoldsFetch, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const account = 'reader@example.com';
/** Synthetic Gmail thread ids (hex, like Gmail's). */
const thread = (suffix: string) => `a1b2c3d4e5f6${suffix}`;
const gmailConfig = { kind: 'google', g_account: account, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

async function gmailSource(engine: BrainEngine, managed: boolean) {
  const f = await source(engine, gmailConfig);
  if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  return { ...f, cfg: parseGoogleSourceConfig(gmailConfig, f.dir) };
}

async function lastRun(engine: BrainEngine, id: string) {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  return (await readManagedConnectorState(engine, id, row.incarnation)).last_run;
}

test('#5752: an emoji straddling the Gmail body cap imports, and the next run admits nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await gmailSource(engine, true);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60001', Date.now() - 3_600_000, 'x'.repeat(7_999) + '\u{1F600}' + 'y'.repeat(40));
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    const first = await run();
    expect(first).toMatchObject({ added: 1 });
    const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1', [f.id]);
    expect(page.compiled_truth.isWellFormed()).toBe(true);
    expect(page.compiled_truth).toContain('x'.repeat(7_999));
    await disposePersistenceConsumer(engine);
    const second = await run();
    expect(second).toMatchObject({ added: 0, modified: 0 });
    expect(await lastRun(engine, f.id)).toMatchObject({ page_admissions: 0 });
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };
const issueAt = (n: number) => `2026-02-0${n}T00:00:00Z`;

async function githubSource(engine: BrainEngine, managed: boolean) {
  const f = await source(engine, githubConfig);
  if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  return { ...f, cfg: parseGitHubSourceConfig(githubConfig, f.dir) };
}

async function sourceHolds(engine: BrainEngine, id: string) {
  return (await readAllSourceHolds(engine, { sourceIds: [id] }))[0]?.held ?? [];
}

test('#5740: a GitHub item failing 3 runs is held, the watermark advances past it, and retry-held clears it on recovery', async () => withEnv(env, async () => {
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await githubSource(engine, managed);
    const fx = fakeGitHub();
    fx.issues = [1, 2, 3].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    fx.failDetail.set(2, 422);
    const run = (extra: Record<string, unknown> = {}) => runGitHubSync(engine, f.id, f.cfg, { ...options, ...extra }, githubHoldsFetch(fx));
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 1; i <= 3; i++) {
        const result = await run();
        expect(result.status).toBe('partial');
        await disposePersistenceConsumer(engine);
      }
      const held = await sourceHolds(engine, f.id);
      expect(held.map(h => ({ key: h.key, code: h.code, class: h.class, title: h.meta.title }))).toEqual([
        { key: 'acme-example/app#2', code: 'http_4xx', class: 'content', title: 'Synthetic issue 2' }]);
      // Run 4 skips the held item, so the sweep completes and the cursor moves past it.
      const fourth = await run();
      expect(fourth.status).not.toBe('partial');
      expect(fourth.connectorHolds).toEqual({ held: 1, newly_held: 0, retry_command: `gbrain sources retry-held ${f.id}`, status_command: `gbrain sources status ${f.id}` });
      await disposePersistenceConsumer(engine);
      fx.since.length = 0;
      await run();
      expect(fx.since).toEqual([issueAt(3)]);
      const [row] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
      expect(row.last_sync_at).not.toBeNull();
      await disposePersistenceConsumer(engine);
      // The provider recovers; retry-held re-attempts the held item on the next run and success clears it.
      fx.failDetail.delete(2);
      const retry = await retryHeld(engine, f.id);
      expect(retry.items).toEqual([expect.objectContaining({ key: 'acme-example/app#2', action: 'retry_scheduled' })]);
      fx.detailFetches.length = 0;
      await run();
      expect(fx.detailFetches).toContain(2);
      expect(await sourceHolds(engine, f.id)).toEqual([]);
      await disposePersistenceConsumer(engine);
    } finally { errors.mockRestore(); }
  }
}), 180_000);

async function waiting(engine: BrainEngine, sourceId: string, remote = false) {
  const { handleToolCall } = await import('../src/mcp/server.ts');
  return await handleToolCall(engine, 'open_loops', { group_by: 'counterparty', source_id: sourceId }, remote
    ? { remote: true, sourceId, auth: { allowedSources: [sourceId] } } as never : { sourceId }) as Record<string, any>;
}

test('Gmail holds (managed and unmanaged): held after 3 runs, the floor passes it, sources status, doctor and waiting show it, retry-held clears it', async () => withEnv(env, async () => {
  const { readConnectorSourceStatuses, connectorStatusLines } = await import('../src/core/persistence/connector-status.ts');
  const { connectorHeldItemsCheck } = await import('../src/commands/doctor/checks/connector-holds.ts');
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await gmailSource(engine, managed);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60101', Date.now() - 2 * 3_600_000);
    addThread(fx, 'a1b2c3d4e5f60202', Date.now() - 3 * 3_600_000);
    fx.failThreads.set('a1b2c3d4e5f60202', 400);
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 1; i <= 3; i++) {
      expect((await run()).status).toBe('partial');
      await disposePersistenceConsumer(engine);
    }
    const [held] = await sourceHolds(engine, f.id);
    expect(held).toMatchObject({ key: thread('0202'), state: 'held', code: 'http_4xx', class: 'content', attempts: 3,
      meta: { sender: null, subject: null, upstream_at: null } });
    // Run 4 skips the held thread; the backfill finishes around it and the source is fresh.
    fx.fetched.length = 0;
    const fourth = await run();
    expect(fourth.status).not.toBe('partial');
    expect(fourth.connectorHolds).toMatchObject({ held: 1 });
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    const [src] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(src.last_sync_at).not.toBeNull();
    const status = (await readConnectorSourceStatuses(engine)).get(f.id)!;
    expect(status.held.map(h => h.key)).toEqual(['a1b2c3d4e5f60202']);
    const lines = connectorStatusLines(f.id, status).join('\n');
    expect(lines).toContain('1 held item(s)');
    expect(lines).toContain(`gbrain sources retry-held ${f.id}`);
    const doctor = await connectorHeldItemsCheck(engine);
    expect(doctor).toMatchObject({ name: 'connector_held_items', status: 'warn' });
    expect(doctor.details?.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: f.id, held: 1 })]));
    // Unknown upstream date counts as inside the window: coverage is partial, and the empty answer says so.
    const answer = await waiting(engine, f.id);
    expect(answer.completeness).toBe('partial');
    expect(answer.held).toEqual([expect.objectContaining({ key: thread('0202'), retry_command: `gbrain sources retry-held ${f.id}` })]);
    expect(answer.text).toContain('No open loops found, but coverage is partial: 1 held item(s)');
    expect(answer.text).not.toContain('You are clean');
    // retry-held: --dry-run changes nothing; the real request survives until the next sync, which re-attempts and clears it.
    expect((await retryHeld(engine, f.id, { dryRun: true })).items).toEqual([expect.objectContaining({ action: 'would_retry' })]);
    fx.failThreads.delete('a1b2c3d4e5f60202');
    fx.fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    expect((await run()).status).not.toBe('partial');
    expect(fx.fetched).toContain('a1b2c3d4e5f60202');
    await disposePersistenceConsumer(engine);
    expect(await sourceHolds(engine, f.id)).toEqual([]);
    expect((await waiting(engine, f.id)).completeness).toBe('complete');
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='connector-hold-retry'")).toEqual([]);
    expect((await retryHeld(engine, f.id)).next_action).toBe(`No held items for ${f.id}.`);
  }
}), 240_000);

test('a lone surrogate in a Gmail identity field refuses with invalid_connector_text and is held after 3 runs; prose is sanitized', async () => withEnv(env, async () => {
  for (const engine of engines) for (const managed of [false, true]) {
    const f = await gmailSource(engine, managed);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60303', Date.now() - 3_600_000, 'Prose with a lone \uD83D surrogate.', 'Subject \uDE00 lone');
    addThread(fx, 'a1b2c3d4e5f60404', Date.now() - 2 * 3_600_000);
    fx.threads.get('a1b2c3d4e5f60404')!.messages[0].id = 'bad\uD800id';
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 1; i <= 3; i++) {
      expect((await run()).status).toBe('partial');
      await disposePersistenceConsumer(engine);
    }
    const [held] = await sourceHolds(engine, f.id);
    expect(held).toMatchObject({ key: thread('0404'), code: 'invalid_connector_text', class: 'content', meta: { subject: 'Subject a1b2c3d4e5f60404' } });
    const pages = await engine.executeRaw<{ compiled_truth: string; title: string }>('SELECT compiled_truth,title FROM pages WHERE source_id=$1', [f.id]);
    expect(pages).toHaveLength(1);
    expect(pages[0].compiled_truth.isWellFormed()).toBe(true);
    expect(pages[0].title.isWellFormed()).toBe(true);
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test('legacy gmail_fail_counts carry over once as held items with unknown metadata (unmanaged)', async () => withEnv(env, async () => {
  const { writeFileSync } = await import('node:fs');
  const { googleStateFile, readGoogleState } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, false);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60505', Date.now() - 3_600_000);
    writeFileSync(googleStateFile(f.dir), JSON.stringify({ gmail_history_id: null, gmail_backfill_floor_ms: null, gmail_backfill_done: false, gmail_newest_ms: null,
      calendar_sync_token: null, contacts_sync_token: null, last_full_at: null, gmail_fail_counts: { a1b2c3d4e5f60505: 3 } }));
    await runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    expect(fx.fetched).not.toContain('a1b2c3d4e5f60505');
    expect(readGoogleState(f.dir).gmail_fail_counts).toBeUndefined();
    expect(await sourceHolds(engine, f.id)).toEqual([expect.objectContaining({ key: thread('0505'), legacy: true, code: 'legacy_poison',
      meta: { sender: null, subject: null, title: null, upstream_at: null } })]);
    expect((await waiting(engine, f.id)).completeness).toBe('partial');
  }
}), 120_000);

const faultEngines = new WeakSet<BrainEngine>();
async function pageFault(engine: BrainEngine, sourceId: string, slug: string | null) {
  if (!faultEngines.has(engine)) {
    await engine.executeRaw('CREATE TABLE IF NOT EXISTS connector_hold_faults(source_id text PRIMARY KEY, slug text)');
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION connector_hold_page_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM connector_hold_faults f WHERE f.source_id=NEW.source_id AND f.slug=NEW.slug) THEN
        RAISE EXCEPTION 'Synthetic connector page storage failure' USING ERRCODE='58030';
      END IF;
      RETURN NEW;
    END $$`);
    await engine.executeRaw('DROP TRIGGER IF EXISTS connector_hold_page_fault ON pages');
    await engine.executeRaw('CREATE TRIGGER connector_hold_page_fault BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION connector_hold_page_fault()');
    faultEngines.add(engine);
  }
  await engine.executeRaw('DELETE FROM connector_hold_faults WHERE source_id=$1', [sourceId]);
  if (slug) await engine.executeRaw('INSERT INTO connector_hold_faults(source_id,slug) VALUES($1,$2)', [sourceId, slug]);
}

test('managed abort path: a failing page write is counted by a holds-only publication, held on the third run, and a retry-held pointer is consumed once', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await githubSource(engine, true);
    const fx = fakeGitHub();
    fx.issues = [1, 2].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    const run = () => runGitHubSync(engine, f.id, f.cfg, options, githubHoldsFetch(fx));
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    const cursor = await sourceCursor(engine, f.id);
    fx.issues[1] = { ...fx.issues[1], body: 'Body 2 edited upstream', updated_at: issueAt(5) };
    await pageFault(engine, f.id, 'gh/acme-example/app/2');
    for (let i = 1; i <= 3; i++) {
      await expect(run()).rejects.toMatchObject({ code: 'storage_error' });
      await disposePersistenceConsumer(engine);
      // The abort path publishes the count; the cursor never moves past the uncommitted receipt.
      expect(await sourceCursor(engine, f.id)).toEqual(cursor);
      const [record] = Object.values(((await sourceCheckpoint(engine, f.id))[0] as any).completed_keys[0].state.item_holds.items) as any[];
      expect(record).toMatchObject({ key: 'acme-example/app#2', attempts: i, state: i < 3 ? 'failing' : 'held', code: 'storage_error' });
    }
    // Run 4 skips the held item and completes.
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    // A retry-held re-attempt that fails again is consumed: the next sync skips the item instead of aborting again.
    await retryHeld(engine, f.id);
    await expect(run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    const [held] = await sourceHolds(engine, f.id);
    expect(held.request_id).toBeTruthy();
    await pageFault(engine, f.id, null);
    const [failed] = await engine.executeRaw<{ intent: Record<string, unknown> }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [held.request_id]);
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    const [pointer] = await engine.executeRaw<{ completed_keys: Array<Record<string, unknown>> }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'retryOf'=$1", [held.request_id]);
    expect(pointer.completed_keys[0]).toMatchObject({ pending: true, retryOf: held.request_id });
    // The pointer is durable: a fresh session admits the held write under the pointer's new identity, once.
    const { beginConnectorSync } = await import('../src/core/persistence/connector-sync.ts');
    for (let i = 0; i < 2; i++) {
      const session = (await beginConnectorSync(engine, f.id, 'github', f.cfg, options))!;
      await session.importMarkdown(failed.intent.sourcePath as string, failed.intent.content as string);
      await disposePersistenceConsumer(engine);
    }
    const retries = await engine.executeRaw<{ state: string; request_id: string }>("SELECT state,request_id::text FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, held.request_id]);
    expect(retries).toEqual([{ state: 'committed', request_id: pointer.completed_keys[0].requestId as string }]);
    const [consumed] = await engine.executeRaw<{ completed_keys: Array<Record<string, unknown>> }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'retryOf'=$1", [held.request_id]);
    expect(consumed.completed_keys[0].pending).toBeUndefined();
  }
}), 240_000);

test('managed abort path: a stolen lease records nothing and leaves the cursor unmoved', async () => withEnv(env, async () => {
  const { syncLockId } = await import('../src/core/db-lock.ts');
  for (const engine of engines) {
    const f = await githubSource(engine, true);
    const fx = fakeGitHub();
    fx.issues = [1, 2].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    const run = () => runGitHubSync(engine, f.id, f.cfg, options, githubHoldsFetch(fx));
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    const checkpoint = await sourceCheckpoint(engine, f.id);
    fx.issues[1] = { ...fx.issues[1], body: 'Body 2 edited upstream', updated_at: issueAt(5) };
    await pageFault(engine, f.id, 'gh/acme-example/app/2');
    const fetchImpl = githubHoldsFetch(fx);
    const stealing = async (url: string) => {
      if (new URL(url).pathname.endsWith('/issues/2')) {
        await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [syncLockId(f.id)]);
      }
      return fetchImpl(url);
    };
    await runGitHubSync(engine, f.id, f.cfg, options, stealing).then(r => expect(r.status).toBe('partial'), (e: Error) => expect(e.name).toMatch(/LockStolenError|AbortError|OperationError/));
    await disposePersistenceConsumer(engine);
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(f.id)]);
    await pageFault(engine, f.id, null);
  }
}), 240_000);

test('checkpointBefore refuses the stale publication in both completion orders of a holds-only and a cursor checkpoint', async () => withEnv(env, async () => {
  const { beginConnectorSync } = await import('../src/core/persistence/connector-sync.ts');
  const empty = { last_sweep_at: null, repos: [] };
  const holds = { version: 1, items: { 'acme-example/app#9': { key: 'acme-example/app#9', state: 'failing', attempts: 1 } } };
  for (const engine of engines) for (const order of ['holds_first', 'cursor_first'] as const) {
    const f = await githubSource(engine, true);
    const seed = (await beginConnectorSync(engine, f.id, 'github', f.cfg, options))!;
    await seed.saveState({ ...empty, last_sweep_at: issueAt(1) });
    await disposePersistenceConsumer(engine);
    const aborting = (await beginConnectorSync(engine, f.id, 'github', f.cfg, options))!;
    const midRun = (await beginConnectorSync(engine, f.id, 'github', f.cfg, options))!;
    const cursorSave = () => midRun.saveState({ ...empty, last_sweep_at: issueAt(3) });
    if (order === 'holds_first') {
      expect(await aborting.publishHolds(empty, holds)).toBe(true);
      await expect(cursorSave()).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await sourceCursor(engine, f.id)).toEqual([[{ state: { ...empty, last_sweep_at: issueAt(1) } }]]);
    } else {
      await cursorSave();
      // The stale holds publication is refused and records nothing; the item is counted again next run.
      expect(await aborting.publishHolds(empty, holds)).toBe(false);
      expect(await sourceCursor(engine, f.id)).toEqual([[{ state: { ...empty, last_sweep_at: issueAt(3) } }]]);
      expect(JSON.stringify(await sourceCheckpoint(engine, f.id))).not.toContain('acme-example/app#9');
    }
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test(`connector_holds_exhausted: a run that would hold a ${HOLD_CAP + 1}st item refuses and leaves the cursor`, async () => withEnv(env, async () => {
  const { gitHubStateFile } = await import('../src/core/github-source.ts');
  const { writeFileSync, readFileSync } = await import('node:fs');
  for (const engine of engines) {
    const f = await githubSource(engine, false);
    const now = new Date().toISOString();
    const record = (key: string, state: string, attempts: number) => ({ key, state, code: 'http_4xx', class: 'content', message: 'x', upstream_version: issueAt(2),
      first_failed_at: now, last_failed_at: now, attempts, held_at: state === 'held' ? now : null, next_attempt_at: null, reconsiderations: 0,
      meta: { sender: null, subject: null, title: null, upstream_at: null }, slug: null, request_id: null, ref: 'issue', legacy: false });
    const items: Record<string, unknown> = {};
    for (let i = 0; i < HOLD_CAP; i++) items[`other-example/repo#${i}`] = record(`other-example/repo#${i}`, 'held', 3);
    items['acme-example/app#2'] = record('acme-example/app#2', 'failing', 2);
    const before = JSON.stringify({ last_sweep_at: null, repos: [], item_holds: { version: 1, items } });
    writeFileSync(gitHubStateFile(f.dir), before);
    const fx = fakeGitHub();
    fx.issues = [1, 2].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    fx.failDetail.set(2, 422);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runGitHubSync(engine, f.id, f.cfg, options, githubHoldsFetch(fx))).rejects.toMatchObject({ code: 'connector_holds_exhausted',
        suggestion: expect.stringContaining(`gbrain sources retry-held ${f.id}`) });
    } finally { errors.mockRestore(); }
    expect(readFileSync(gitHubStateFile(f.dir), 'utf8')).toBe(before);
  }
}), 120_000);

test('#5581: a delta over the pending cap drains in bounded history batches across a crash and loses no older thread', async () => withEnv(env, async () => {
  const { gmailPendingCap, readGoogleState } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, false);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60600', Date.now() - 5 * 3_600_000);
    const run = (signal?: AbortSignal) => runGoogleSync(engine, f.id, f.cfg, { ...options, ...(signal ? { signal } : {}) }, withGoogleAccount(gmailFetch(fx), account));
    await run();
    expect(readGoogleState(f.dir)).toMatchObject({ gmail_history_id: '100', gmail_backfill_done: true });
    gmailPendingCap.ids = 3;
    try {
      // Five changed threads, all older than the newest imported mail: a date-window scan would miss them.
      const flagged = Array.from({ length: 5 }, (_, i) => `a1b2c3d4e5f6070${i}`);
      flagged.forEach((id, i) => addThread(fx, id, Date.now() - (20 + i) * 86_400_000));
      fx.history = flagged;
      fx.historyResponseId = '200';
      // Crash after two fetches: the anchor moves only to the last history record whose threads are landed or parked.
      const controller = new AbortController();
      fx.onThreadFetch = () => { if (fx.fetched.length >= 2) controller.abort(); };
      fx.fetched.length = 0;
      await run(controller.signal);
      let state = readGoogleState(f.dir);
      expect(state.gmail_history_id).toBe('103');
      expect(state.gmail_pending_thread_ids).toEqual([flagged[2]]);
      fx.onThreadFetch = undefined;
      expect((await run()).status).not.toBe('partial');
      state = readGoogleState(f.dir);
      expect(state).toMatchObject({ gmail_history_id: '200', gmail_pending_thread_ids: [] });
      const pages = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'emails/%'", [f.id]);
      expect(pages[0].n).toBe(6);
    } finally { gmailPendingCap.ids = 1_000; }
  }
}), 120_000);

test('a parked held Gmail thread flagged again by fresh history is re-attempted as an upstream change', async () => withEnv(env, async () => {
  const { readGoogleState } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, false);
    const fx = fakeGmail(account);
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    await run();
    addThread(fx, 'a1b2c3d4e5f60900', Date.now() - 3_600_000);
    fx.failThreads.set('a1b2c3d4e5f60900', 400);
    fx.history = ['a1b2c3d4e5f60900'];
    fx.historyResponseId = '150';
    for (let i = 0; i < 3; i++) await run();
    expect(readGoogleState(f.dir).gmail_pending_thread_ids).toEqual(['a1b2c3d4e5f60900']);
    expect((await sourceHolds(engine, f.id)).map(h => h.key)).toEqual(['a1b2c3d4e5f60900']);
    // It changes upstream and the provider recovers: the fresh listing re-admits it despite the hold.
    fx.failThreads.delete('a1b2c3d4e5f60900');
    fx.history = ['a1b2c3d4e5f60900', 'a1b2c3d4e5f60900'];
    fx.historyResponseId = '160';
    fx.fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fx.fetched).toContain('a1b2c3d4e5f60900');
    expect(await sourceHolds(engine, f.id)).toEqual([]);
  }
}), 120_000);

test('waiting reports partial coverage when the hold state cannot be read', async () => withEnv(env, async () => {
  const { writeFileSync } = await import('node:fs');
  const { googleStateFile } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, false);
    await engine.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1', [f.id]);
    writeFileSync(googleStateFile(f.dir), '{not json');
    const answer = await waiting(engine, f.id);
    expect(answer.completeness).toBe('partial');
    expect(answer.text).toContain('coverage is partial');
    expect(answer.text).not.toContain('You are clean');
  }
}), 120_000);

test('a facts fence below the timeline sentinel of a connector page refuses the re-render with connector_fence_below_timeline; connector-fences repairs it', async () => withEnv(env, async () => {
  const { resolveRepairScope, runRepair } = await import('../src/core/repair/core.ts');
  const { connectorFencesRepair } = await import('../src/core/repair/connector-fences.ts');
  const fence = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
    + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
    + '| 1 | Ships weekly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n<!--- gbrain:facts:end -->';
  for (const engine of engines) {
    const f = await githubSource(engine, true);
    const fx = fakeGitHub();
    fx.issues = [{ number: 1, title: 'Synthetic issue 1', body: 'Body 1', updated_at: issueAt(1) }];
    const run = () => runGitHubSync(engine, f.id, f.cfg, options, githubHoldsFetch(fx));
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`UPDATE pages SET timeline=COALESCE(timeline,'') || $2 WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id, `\n\n${fence}\n`]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    fx.issues[0] = { ...fx.issues[0], body: 'Body 1 edited upstream', updated_at: issueAt(4) };
    await expect(run()).rejects.toMatchObject({ code: 'connector_fence_below_timeline',
      suggestion: expect.stringContaining(`gbrain repair connector-fences --source ${f.id}`) });
    await disposePersistenceConsumer(engine);
    const [stored] = await engine.executeRaw<{ timeline: string; compiled_truth: string }>(`SELECT timeline,compiled_truth FROM pages WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id]);
    expect(stored.timeline).toContain('Ships weekly');
    const ctx = { engine, config: { engine: engine.kind }, remote: false, logger: console } as never;
    const scope = await resolveRepairScope(engine, f.id);
    expect((await runRepair(ctx, connectorFencesRepair, scope, { apply: false })).affected).toBe(1);
    expect((await runRepair(ctx, connectorFencesRepair, scope, { apply: true })).applied).toBe(1);
    await disposePersistenceConsumer(engine);
    const [moved] = await engine.executeRaw<{ timeline: string; compiled_truth: string }>(`SELECT timeline,compiled_truth FROM pages WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id]);
    expect(moved.compiled_truth).toContain('Ships weekly');
    expect(moved.timeline ?? '').not.toContain('gbrain:facts');
    // The re-render now carries the fence verbatim.
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    const [rendered] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id]);
    expect(rendered.compiled_truth).toContain('Body 1 edited upstream');
    expect(rendered.compiled_truth).toContain('Ships weekly');
  }
}), 240_000);

test('a due transient reconsideration of a managed held write is admitted under a new request identity', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await githubSource(engine, true);
    const fx = fakeGitHub();
    fx.issues = [1, 2].map(n => ({ number: n, title: `Synthetic issue ${n}`, body: `Body ${n}`, updated_at: issueAt(n) }));
    const run = () => runGitHubSync(engine, f.id, f.cfg, options, githubHoldsFetch(fx));
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    fx.issues[1] = { ...fx.issues[1], body: 'Body 2 edited upstream', updated_at: issueAt(5) };
    await pageFault(engine, f.id, 'gh/acme-example/app/2');
    for (let i = 0; i < 3; i++) { await expect(run()).rejects.toMatchObject({ code: 'storage_error' }); await disposePersistenceConsumer(engine); }
    const [held] = await sourceHolds(engine, f.id);
    expect(held).toMatchObject({ class: 'transient', state: 'held' });
    // Storage recovers and the reconsideration falls due.
    await pageFault(engine, f.id, null);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,state,item_holds,items,acme-example/app#2,next_attempt_at}','"2000-01-01T00:00:00.000Z"')
      WHERE op='managed-connector' AND completed_keys->0->'state'->'item_holds'->'items' ? 'acme-example/app#2'`);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    expect(await sourceHolds(engine, f.id)).toEqual([]);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='gh/acme-example/app/2'`, [f.id]);
    expect(page.compiled_truth).toContain('Body 2 edited upstream');
  }
}), 240_000);

test('Codex cycle 2: --full re-attempts held Gmail threads the cursor already passed; unrelated mail never resets a count', async () => withEnv(env, async () => {
  for (const engine of engines) {
    // (a) --full: a held backfill thread behind the floor is re-attempted and imported.
    const f = await gmailSource(engine, false);
    const fx = fakeGmail(account);
    addThread(fx, thread('1001'), Date.now() - 2 * 3_600_000);
    fx.failThreads.set(thread('1001'), 400);
    const run = (extra: Record<string, unknown> = {}) => runGoogleSync(engine, f.id, f.cfg, { ...options, ...extra }, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 0; i < 4; i++) await run();
    expect((await sourceHolds(engine, f.id)).map(h => h.key)).toEqual([thread('1001')]);
    fx.failThreads.delete(thread('1001'));
    fx.fetched.length = 0;
    await run({ full: true });
    expect(fx.fetched).toContain(thread('1001'));
    expect(await sourceHolds(engine, f.id)).toEqual([]);
    // (b) a delta thread that keeps failing reaches its hold while unrelated threads keep arriving.
    const g = await gmailSource(engine, false);
    const gx = fakeGmail(account);
    const runG = () => runGoogleSync(engine, g.id, g.cfg, options, withGoogleAccount(gmailFetch(gx), account));
    await runG();
    addThread(gx, thread('2001'), Date.now() - 3_600_000);
    gx.failThreads.set(thread('2001'), 400);
    gx.history = [thread('2001')];
    for (let i = 0; i < 3; i++) {
      const other = thread(`30${i}0`);
      addThread(gx, other, Date.now() - 60_000);
      gx.history = [thread('2001'), ...gx.history.slice(1), other];
      gx.historyResponseId = String(200 + i);
      await runG();
    }
    expect((await sourceHolds(engine, g.id)).map(h => h.key)).toEqual([thread('2001')]);
  }
}), 120_000);

test('Codex cycle 2: a bounded batch of deleted threads still advances the managed anchor, and a full pending set is not current', async () => withEnv(env, async () => {
  const { gmailPendingCap, readGoogleState } = await import('../src/core/google/google-source.ts');
  for (const engine of engines) {
    const f = await gmailSource(engine, true);
    const fx = fakeGmail(account);
    const run = () => runGoogleSync(engine, f.id, f.cfg, options, withGoogleAccount(gmailFetch(fx), account));
    await run();
    await disposePersistenceConsumer(engine);
    gmailPendingCap.ids = 3;
    try {
      // Three deleted threads (404), then two real ones.
      fx.history = [thread('4001'), thread('4002'), thread('4003'), thread('4004'), thread('4005')];
      addThread(fx, thread('4004'), Date.now() - 60_000);
      addThread(fx, thread('4005'), Date.now() - 60_000);
      fx.historyResponseId = '300';
      await run();
      await disposePersistenceConsumer(engine);
      const cursor = (await sourceCheckpoint(engine, f.id) as any[])[0].completed_keys[0].state;
      expect(cursor.gmail_history_id).toBe('103');
      await run();
      await disposePersistenceConsumer(engine);
      const pages = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'emails/%'", [f.id]);
      expect(pages[0].n).toBe(2);
    } finally { gmailPendingCap.ids = 1_000; }
    // Unmanaged: a pending set at the cap drains without listing history, so the run is not current.
    const u = await gmailSource(engine, false);
    const ux = fakeGmail(account);
    const runU = () => runGoogleSync(engine, u.id, u.cfg, options, withGoogleAccount(gmailFetch(ux), account));
    await runU();
    const { writeFileSync } = await import('node:fs');
    const { googleStateFile } = await import('../src/core/google/google-source.ts');
    gmailPendingCap.ids = 2;
    try {
      addThread(ux, thread('5001'), Date.now() - 60_000);
      addThread(ux, thread('5002'), Date.now() - 60_000);
      addThread(ux, thread('5003'), Date.now() - 30_000);
      writeFileSync(googleStateFile(u.dir), JSON.stringify({ ...readGoogleState(u.dir), gmail_pending_thread_ids: [thread('5001'), thread('5002')] }));
      ux.history = [thread('5003')];
      ux.historyResponseId = '400';
      await engine.executeRaw("UPDATE sources SET last_sync_at='2000-01-01T00:00:00Z' WHERE id=$1", [u.id]);
      ux.fetched.length = 0;
      await runU();
      expect(ux.fetched).not.toContain(thread('5003'));
      const [row] = await engine.executeRaw<{ last_sync_at: string }>('SELECT last_sync_at::text FROM sources WHERE id=$1', [u.id]);
      expect(row.last_sync_at.startsWith('2000-01-01')).toBe(true);
      await runU();
      expect(ux.fetched).toContain(thread('5003'));
    } finally { gmailPendingCap.ids = 1_000; }
  }
}), 120_000);
