/**
 * #9011: on a managed Google source, a purged Gmail thread whose import misses the session's purge screen and is still
 * pending when `importMarkdown` returns ran loop detection and wrote an open loop with the thread's subject and evidence
 * quote. The pages guard then refused the write as purged content from the pending path, but nothing removed what
 * detection wrote (`open_loops.page_slug` has no foreign key), so the subject and quote stayed across later runs.
 * Real PGLite and Postgres (when DATABASE_URL is set), the real Google importer, purge and connector session.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { CONNECTOR_WAIT_BUDGET_MS, ManagedConnectorSync, connectorWaitBudget } from '../src/core/persistence/connector-sync.ts';
import { createConnectorFixture, json, options, settleConnectorWrites, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const THREAD = '17ff00000000c011';
const MESSAGE = '18ff00000000c011';
const SUBJECT = 'Contract question';
const QUOTE = 'Could you confirm the acme-example contract terms?';
const CONFIG = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const DAY_MS = 86_400_000;
const SECOND_MS = 1000;
const SENT_DAYS_AGO = 3;
const NO_ITEM_WAIT_MS = 0;
const LATER_RUNS = 2;
const TEST_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = 120_000;
const b64url = (text: string) => Buffer.from(text, 'utf-8').toString('base64url');
const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });

const managed = createConnectorFixture();
describe('#9011: a purged Gmail thread refused at publication after a pending import', () => {
  beforeAll(managed.setup, SETUP_TIMEOUT_MS);
  afterAll(managed.teardown);

  test('leaves no open loop with its subject or evidence quote once the pending refusal resolves', async () => withEnv(managed.env, async () => {
    for (const engine of managed.engines) {
      const f = await managed.source(engine, CONFIG);
      const cfg = parseGoogleSourceConfig(CONFIG, f.dir);
      const sentAt = Date.now() - SENT_DAYS_AGO * DAY_MS;
      let historyId = '5000';
      let changed: string[] = [];
      const message = { id: MESSAGE, threadId: THREAD, labelIds: ['INBOX'], internalDate: String(sentAt),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
          { name: 'To', value: CONFIG.g_account }, { name: 'Subject', value: SUBJECT }],
        body: { data: b64url(QUOTE) } } };
      const fetch = withGoogleAccount(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
        if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: CONFIG.g_account, historyId: '5000' });
        if (u.pathname.endsWith('/users/me/messages')) return json({ messages: Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 0) * SECOND_MS <= sentAt
          && sentAt < Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity) * SECOND_MS ? [{ id: MESSAGE, threadId: THREAD }] : [] });
        if (u.pathname.endsWith('/users/me/history')) return json({ historyId, history: u.searchParams.get('startHistoryId') === historyId ? []
          : [{ id: historyId, messages: changed.map(threadId => ({ id: MESSAGE, threadId })) }] });
        if (u.pathname.endsWith(`/users/me/threads/${THREAD}`)) return json({ id: THREAD, messages: [message] });
        throw new Error(`Unexpected Google fixture route: ${url}`);
      }, CONFIG.g_account);
      const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetch, CONFIG.g_account));
      const subjectLoops = async () => (await engine.executeRaw<{ n: number }>(
        'SELECT count(*)::int AS n FROM open_loops WHERE source_id=$1 AND (thread_id=$2 OR summary ILIKE $3)', [f.id, THREAD, `%${SUBJECT}%`]))[0]!.n;
      const quotedLoops = async () => (await engine.executeRaw<{ n: number }>(
        'SELECT count(*)::int AS n FROM open_loops WHERE source_id=$1 AND evidence::text ILIKE $2', [f.id, `%${QUOTE}%`]))[0]!.n;
      const livePages = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id])).map(r => r.slug);

      expect((await run()).status).not.toBe('partial');
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      const [slug] = await livePages();
      expect(slug).toBeDefined();
      expect(await subjectLoops()).toBe(1);
      const [{ row: loopRow }] = await engine.executeRaw<{ row: string }>('SELECT to_jsonb(o)::text AS row FROM open_loops o WHERE source_id=$1', [f.id]) as [{ row: string }];
      // A refusal naming a slug whose page is live keeps that page's loops.
      const live = spyOn(ManagedConnectorSync.prototype, 'refusedPurgedSlugs').mockReturnValue([slug!]);
      try { await run(); } finally { live.mockRestore(); }
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      expect(await subjectLoops()).toBe(1);
      const snapshot = (await engine.readPageSnapshot(slug!, { sourceId: f.id }))!;
      await submitPageMutation(ctx(engine, f.id), { operation: 'delete_page', params: { slug: slug!, purge: true, expected_revision: snapshot.revision } });
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      expect(await subjectLoops()).toBe(0);

      // The thread is listed again; the session's screen misses it and the item wait is over before the owner publishes,
      // so the import returns pending and loop detection runs. The owner then refuses it as purged content.
      historyId = '5010';
      changed = [THREAD];
      const screen = spyOn(ManagedConnectorSync.prototype as unknown as { carriesPurgedPage: () => Promise<boolean> }, 'carriesPurgedPage').mockResolvedValue(false);
      const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        connectorWaitBudget.ms = NO_ITEM_WAIT_MS;
        try { await run(); } finally { connectorWaitBudget.ms = CONNECTOR_WAIT_BUDGET_MS; }
        await settleConnectorWrites(engine, f.id).catch(() => {});
        await disposePersistenceConsumer(engine);
        expect(await livePages()).toEqual([]);
        // Later runs resolve the refused receipt from the pending set.
        for (let i = 0; i < LATER_RUNS; i++) {
          await run();
          await settleConnectorWrites(engine, f.id).catch(() => {});
          await disposePersistenceConsumer(engine);
        }
      } finally { quiet.mockRestore(); screen.mockRestore(); }
      expect(await livePages()).toEqual([]);
      const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
      const state = await readManagedConnectorState(engine, f.id, row!.incarnation);
      expect(state.purged_items?.filter(item => item.request_id !== null).map(item => item.slug)).toContain(slug!);
      expect(await subjectLoops()).toBe(0);
      expect(await quotedLoops()).toBe(0);

      // A loop left by a refusal that resolved after its run's cleanup goes on a later run, from the recorded refusal.
      await engine.executeRaw('INSERT INTO open_loops SELECT * FROM jsonb_populate_record(NULL::open_loops, $1::text::jsonb)', [loopRow]);
      expect(await subjectLoops()).toBe(1);
      await run();
      await settleConnectorWrites(engine, f.id).catch(() => {});
      await disposePersistenceConsumer(engine);
      expect(await subjectLoops()).toBe(0);
    }
  }), TEST_TIMEOUT_MS);
});
