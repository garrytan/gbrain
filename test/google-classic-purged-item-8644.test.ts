/**
 * #8644: on an unmanaged (classic) brain, a Google item whose page the owner purged keeps arriving unchanged from
 * the provider. The purge leaves a connector page's checkout file (write_through skipped: connector_database), so every
 * later sync failed that item file_database_drift, or purged_content from the import guard after a temporary write
 * once the file was removed, and held it after three runs. It is now skipped before any file is written, the run stays
 * clean, and the page stays purged, as on a managed brain (#6831). A skipped Gmail thread is not run through loop
 * detection or extraction either, so the open loops the purge removed do not come back with the thread's text.
 * #8938: the same holds on a managed source, where the connector session skips the purged render and reports it.
 * Real PGLite and Postgres (when DATABASE_URL is set), the real Google importer and purge, a fake People API.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { unpurgePage } from '../src/core/persistence/page-purge.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { ManagedConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { contact, createConnectorFixture, json, options, settleConnectorWrites, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const SLUG = 'people/alice-example';
const CONFIG = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const ctx = (engine: BrainEngine, sourceId = SOURCE) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });

interface Brain { engine: BrainEngine; root: string; path: string; render: string; sync(): ReturnType<typeof runGoogleSync> }

async function withPurgedPage(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-8644-'));
  try {
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const dir = join(root, 'google');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(CONFIG)]);
        const fetch = withGoogleAccount(async (url: string) => {
          if (new URL(url).pathname === '/v1/people/me/connections') return json({ connections: [
            { ...contact('c1', 'Alice Example'), organizations: [{ name: 'Acme Example' }] }], nextSyncToken: 'token-1' });
          throw new Error(`Unexpected Google fixture route: ${url}`);
        }, CONFIG.g_account);
        const cfg = parseGoogleSourceConfig(CONFIG, dir);
        const sync = () => runGoogleSync(engine, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch);
        expect((await sync()).failedFiles ?? 0).toBe(0);
        const path = join(dir, `${SLUG}.md`);
        const render = readFileSync(path, 'utf8');
        const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
        await submitPageMutation(ctx(engine), { operation: 'delete_page', params: { slug: SLUG, purge: true, expected_revision: snapshot!.revision } });
        expect(await engine.getPage(SLUG, { sourceId: SOURCE })).toBeNull();
        await run({ engine, root, path, render, sync });
      } finally { await close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const holds = (root: string) => ((readGoogleState(join(root, 'google')).item_holds ?? { items: {} }) as { items: Record<string, { code: string; state: string }> }).items;
const pageRows = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, SLUG]))[0]!.n;

for (const backend of testBackends()) describe(`[${backend}] #8644: a purged item on an unmanaged Google source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the unchanged item is skipped on every run while the purge left its file: no failure, no hold, no page', async () => withPurgedPage(databaseUrl, async b => {
    expect(readFileSync(b.path, 'utf8')).toBe(b.render);
    for (let i = 0; i < 3; i++) {
      const result = await b.sync();
      expect(result.failedFiles ?? 0).toBe(0);
      expect(result.status).not.toBe('partial');
    }
    expect(holds(b.root)['contact:people/c1']).toBeUndefined();
    expect(readFileSync(b.path, 'utf8')).toBe(b.render);
    expect(await pageRows(b.engine)).toBe(0);
  }), 180_000);

  test('with the checkout file removed, nothing is written, not even a temporary file', async () => withPurgedPage(databaseUrl, async b => {
    rmSync(b.path);
    for (let i = 0; i < 3; i++) expect((await b.sync()).failedFiles ?? 0).toBe(0);
    expect(holds(b.root)['contact:people/c1']).toBeUndefined();
    expect(existsSync(b.path)).toBe(false);
    expect(existsSync(`${b.path}.tmp`)).toBe(false);
    expect(await pageRows(b.engine)).toBe(0);
  }), 180_000);

  test('after unpurge the item imports again', async () => withPurgedPage(databaseUrl, async b => {
    rmSync(b.path);
    await unpurgePage(ctx(b.engine) as never, { slug: SLUG, source_id: SOURCE });
    expect((await b.sync()).failedFiles ?? 0).toBe(0);
    expect(await pageRows(b.engine)).toBe(1);
    expect(existsSync(b.path)).toBe(true);
  }), 180_000);
});

const THREAD = '17ff00000000b001';
const GMAIL_CONFIG = { ...CONFIG, g_services: 'gmail' };
const b64url = (text: string) => Buffer.from(text, 'utf-8').toString('base64url');

for (const backend of testBackends()) describe(`[${backend}] #8644: a purged Gmail thread on an unmanaged Google source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a change to the purged thread brings back neither its page, its open loop nor its grace hold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-8644-gmail-'));
    try {
      await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
        _resetWriteThroughCacheForTest();
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          const dir = join(root, 'google');
          await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(GMAIL_CONFIG)]);
          const sentAt = Date.now() - 3 * 86_400_000;
          let historyId = '5000';
          let changed: string[] = [];
          const message = { id: '18ff00000000b001', threadId: THREAD, labelIds: ['INBOX'], internalDate: String(sentAt),
            payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
              { name: 'To', value: GMAIL_CONFIG.g_account }, { name: 'Subject', value: 'Contract question' }],
            body: { data: b64url('Could you confirm the acme-example contract terms?') } } };
          const fetch = withGoogleAccount(async (url: string) => {
            const u = new URL(url);
            if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
            if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: GMAIL_CONFIG.g_account, historyId: '5000' });
            if (u.pathname.endsWith('/users/me/messages')) return json({ messages: Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000 <= sentAt
              && sentAt < Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity) * 1000 ? [{ id: message.id, threadId: THREAD }] : [] });
            if (u.pathname.endsWith('/users/me/history')) return json({ historyId, history: u.searchParams.get('startHistoryId') === historyId ? []
              : [{ id: historyId, messages: changed.map(threadId => ({ id: message.id, threadId })) }] });
            if (u.pathname.endsWith(`/users/me/threads/${THREAD}`)) return json({ id: THREAD, messages: [message] });
            throw new Error(`Unexpected Google fixture route: ${url}`);
          }, GMAIL_CONFIG.g_account);
          const cfg = parseGoogleSourceConfig(GMAIL_CONFIG, dir);
          const sync = () => runGoogleSync(engine, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch);
          const loops = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM open_loops WHERE source_id=$1 AND thread_id=$2', [SOURCE, THREAD]))[0]!.n;
          expect((await sync()).failedFiles ?? 0).toBe(0);
          const [page] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [SOURCE]);
          expect(await loops()).toBe(1);
          const snapshot = await engine.readPageSnapshot(page!.slug, { sourceId: SOURCE });
          await submitPageMutation(ctx(engine), { operation: 'delete_page', params: { slug: page!.slug, purge: true, expected_revision: snapshot!.revision } });
          expect(await loops()).toBe(0);
          const statePath = join(dir, '.google-source.json');
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          state.loop_grace_holds = { ...state.loop_grace_holds, [THREAD]: { due_ms: Date.now() + 30 * 86_400_000, slug: page!.slug, rev: null,
            spec: { loopType: 'unanswered_inbound', counterpartyEmail: 'alice@example.invalid', summary: 'Contract question',
              evidence: [{ quote: 'Could you confirm the acme-example contract terms?' }], lastActivityMs: sentAt, openedMs: sentAt } } };
          writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

          historyId = '5010';
          changed = [THREAD];
          const replay = await sync();
          expect(replay.failedFiles ?? 0).toBe(0);
          expect(await loops()).toBe(0);
          expect((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1', [SOURCE])).length).toBe(0);
          expect(readGoogleState(dir).loop_grace_holds?.[THREAD]).toBeUndefined();
        } finally { await close(); }
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);
});

const managed = createConnectorFixture();
describe('#8938: a purged Gmail thread on a managed Google source', () => {
  beforeAll(managed.setup, 120_000);
  afterAll(managed.teardown);

  test('re-delivering the unchanged thread writes no page and no open loop or quote, and skips cleanly', async () => withEnv(managed.env, async () => {
    for (const engine of managed.engines) {
      const f = await managed.source(engine, GMAIL_CONFIG);
      const cfg = parseGoogleSourceConfig(GMAIL_CONFIG, f.dir);
      const sentAt = Date.now() - 3 * 86_400_000;
      let historyId = '5000';
      let changed: string[] = [];
      const message = { id: '18ff00000000b001', threadId: THREAD, labelIds: ['INBOX'], internalDate: String(sentAt),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
          { name: 'To', value: GMAIL_CONFIG.g_account }, { name: 'Subject', value: 'Contract question' }],
        body: { data: b64url('Could you confirm the acme-example contract terms?') } } };
      const fetch = withGoogleAccount(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
        if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: GMAIL_CONFIG.g_account, historyId: '5000' });
        if (u.pathname.endsWith('/users/me/messages')) return json({ messages: Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000 <= sentAt
          && sentAt < Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity) * 1000 ? [{ id: message.id, threadId: THREAD }] : [] });
        if (u.pathname.endsWith('/users/me/history')) return json({ historyId, history: u.searchParams.get('startHistoryId') === historyId ? []
          : [{ id: historyId, messages: changed.map(threadId => ({ id: message.id, threadId })) }] });
        if (u.pathname.endsWith(`/users/me/threads/${THREAD}`)) return json({ id: THREAD, messages: [message] });
        throw new Error(`Unexpected Google fixture route: ${url}`);
      }, GMAIL_CONFIG.g_account);
      const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetch, GMAIL_CONFIG.g_account));
      const loops = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM open_loops WHERE source_id=$1 AND thread_id=$2', [f.id, THREAD]))[0]!.n;
      const quoted = async () => (await engine.executeRaw<{ n: number }>(
        "SELECT count(*)::int AS n FROM open_loops WHERE source_id=$1 AND (summary ILIKE '%contract%' OR evidence::text ILIKE '%acme-example contract%')", [f.id]))[0]!.n;
      const livePages = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id])).map(r => r.slug);

      expect((await run()).status).not.toBe('partial');
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      const [slug] = await livePages();
      expect(slug).toBeDefined();
      expect(await loops()).toBe(1);
      const snapshot = (await engine.readPageSnapshot(slug!, { sourceId: f.id }))!;
      await submitPageMutation(ctx(engine, f.id), { operation: 'delete_page', params: { slug: slug!, purge: true, expected_revision: snapshot.revision } });
      await settleConnectorWrites(engine, f.id);
      expect(await loops()).toBe(0);
      await disposePersistenceConsumer(engine);
      const graceHold = async () => ((await sourceCheckpoint(engine, f.id)) as { completed_keys: { state?: GoogleSourceState }[] }[])[0]?.completed_keys[0]?.state?.loop_grace_holds?.[THREAD];
      const hold = { [THREAD]: { due_ms: Date.now() + 30 * 86_400_000, slug, rev: null, spec: { loopType: 'unanswered_inbound', counterpartyEmail: 'alice@example.invalid',
        summary: 'Contract question', evidence: [{ quote: 'Could you confirm the acme-example contract terms?' }], lastActivityMs: sentAt, openedMs: sentAt } } };
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,state,loop_grace_holds}',
          COALESCE(completed_keys->0->'state'->'loop_grace_holds', '{}'::jsonb) || $2::text::jsonb, true)
        WHERE op='managed-connector' AND fingerprint IN (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)`, [f.id, JSON.stringify(hold)]);
      expect((await graceHold())?.spec?.summary).toBe('Contract question');

      historyId = '5010';
      changed = [THREAD];
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
      let replay;
      try { replay = await run(); } finally { stderr.mockRestore(); }
      expect(replay.status).not.toBe('partial');
      await settleConnectorWrites(engine, f.id).catch(() => {});
      expect(await livePages()).toEqual([]);
      expect(await loops()).toBe(0);
      expect(await quoted()).toBe(0);
      const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
      const state = await readManagedConnectorState(engine, f.id, row!.incarnation);
      expect(state.last_failure).toBeNull();
      expect(state.last_run).toMatchObject({ purged_skipped: 1 });
      await disposePersistenceConsumer(engine);
      expect(await graceHold()).toBeUndefined();

      // A render the session's screen misses is admitted and refused by the pages guard at publication; that skip is
      // reported as purged too, so the thread still yields no loop.
      historyId = '5020';
      const screen = spyOn(ManagedConnectorSync.prototype as unknown as { carriesPurgedPage: () => Promise<boolean> }, 'carriesPurgedPage').mockResolvedValue(false);
      const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try { await run(); } finally { quiet.mockRestore(); screen.mockRestore(); }
      await settleConnectorWrites(engine, f.id).catch(() => {});
      expect(await livePages()).toEqual([]);
      expect(await loops()).toBe(0);
      expect(await quoted()).toBe(0);
      await disposePersistenceConsumer(engine);
    }
  }), 240_000);
});
