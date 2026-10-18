/**
 * #6831: a purged connector item is skipped per item, and a source whose runs keep dying says so.
 *
 * A weekly calendar series keeps listing an occurrence the owner purged (the series is still on the
 * calendar). Before the fix the pages guard's `purged_content` refusal of that one occurrence ended
 * the whole managed sync, every later sync died the same way, and nothing else from the account
 * (contacts, the series' other occurrences, Gmail) was imported. `sync status`, `sources status` and
 * doctor all read the source as healthy.
 *
 * PGLite here; PostgreSQL through test/e2e/connector-purged-item-6831.test.ts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { calendarRelPath } from '../src/core/google/google-render.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { unpurgePage } from '../src/core/persistence/page-purge.ts';
import { CONNECTOR_WAIT_BUDGET_MS, connectorWaitBudget, withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { CONNECTOR_STOPPED_RUNS, readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { connectorStatusLines, readConnectorSourceStatuses } from '../src/core/persistence/connector-status.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { opError } from '../src/core/ops/contract.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { contact, createConnectorFixture, json, options, settleConnectorWrites, withGoogleAccount, withPausedOwnerBudget } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const account = 'owner@example.invalid';
const config = { kind: 'google', g_account: account, g_services: 'calendar,contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
const DAY = 86_400_000;
/** Occurrence `n` of a synthetic weekly series, `n` weeks from a fixed start inside the 60-day horizon. */
const base = Math.floor(Date.now() / DAY) * DAY + 2 * DAY + 17 * 3_600_000;
const occurrence = (n: number) => {
  const start = new Date(base + 7 * n * DAY).toISOString();
  return { id: `weeklyseries0001_${start.slice(0, 10).replace(/-/g, '')}`, recurringEventId: 'weeklyseries0001', status: 'confirmed',
    summary: 'Synthetic weekly review', start: { dateTime: start }, end: { dateTime: new Date(base + 7 * n * DAY + 3_600_000).toISOString() },
    organizer: { email: account }, attendees: [{ email: account, self: true, responseStatus: 'accepted' }] };
};
const occurrenceSlug = (n: number) => {
  const ev = occurrence(n);
  return slugifyPath(calendarRelPath({ id: ev.id, startIso: ev.start.dateTime, summary: ev.summary } as never));
};

async function liveSlugs(engine: BrainEngine, sourceId: string): Promise<string[]> {
  return (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId])).map(r => r.slug);
}
async function connectorState(engine: BrainEngine, sourceId: string) {
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
  return readManagedConnectorState(engine, sourceId, row.incarnation);
}

test('#6831: a purged recurring occurrence is skipped per item; the rest of the run imports, later runs keep going, and it stays purged', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const fx = { events: [occurrence(0), occurrence(1)], contacts: [contact('first', 'First Example')] };
    const fetcher = async (url: string) => {
      if (url.includes('/calendars/')) return json({ items: fx.events, nextSyncToken: `calendar-${fx.events.length}` });
      if (url.includes('/people/me/connections')) return json({ connections: fx.contacts, nextSyncToken: `contacts-${fx.contacts.length}` });
      throw new Error(`Unexpected fixture route ${url}`);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher, account));
    expect((await run()).added).toBe(3);
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);

    // The owner purges occurrence 1; the series stays on the calendar, so the next listing names it again.
    const purged = (await engine.readPageSnapshot(occurrenceSlug(1), { sourceId: f.id }))!;
    await submitPageMutation(ctx(engine, f.id), { operation: 'delete_page', params: { slug: occurrenceSlug(1), purge: true, expected_revision: purged.revision } });
    await settleConnectorWrites(engine, f.id);
    expect(await liveSlugs(engine, f.id)).not.toContain(occurrenceSlug(1));

    fx.events = [occurrence(0), occurrence(1), occurrence(2)];
    fx.contacts = [contact('first', 'First Example'), contact('second', 'Second Example')];
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let second;
    try { second = await run(); } finally { stderr.mockRestore(); }
    expect(second.status).not.toBe('partial');
    await settleConnectorWrites(engine, f.id).catch(() => {});
    const slugs = await liveSlugs(engine, f.id);
    expect(slugs).toContain(occurrenceSlug(2));
    expect(slugs).toContain('people/second-example');
    expect(slugs).not.toContain(occurrenceSlug(1));
    const state = await connectorState(engine, f.id);
    expect(state.last_failure).toBeNull();
    expect(state.last_run).toMatchObject({ purged_skipped: 1 });
    expect(state.purged_items?.map(item => item.slug)).toEqual([occurrenceSlug(1)]);
    expect(state.pending).toEqual([]);
    // The cursor advanced past the skipped item: the run saved its new calendar and contacts tokens.
    const [checkpoint] = await engine.executeRaw<{ state: { calendar_sync_token?: string; contacts_sync_token?: string } }>(
      "SELECT completed_keys->0->'state' AS state FROM op_checkpoints WHERE op='managed-connector' AND fingerprint IN (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)", [f.id]);
    expect(checkpoint.state.calendar_sync_token).toBe('calendar-3');
    const status = (await readConnectorSourceStatuses(engine, [f.id])).get(f.id)!;
    expect(status.stopped).toBe(false);
    const lines = connectorStatusLines(f.id, status).join('\n');
    expect(lines).toContain('1 skipped as purged content');
    expect(lines).toContain(`1 item(s) recently skipped as purged content`);
    expect(lines).toContain(occurrenceSlug(1));
    await disposePersistenceConsumer(engine);

    // Every later run keeps going and keeps the purge: the refused receipt is replayed, never re-admitted.
    fx.events = [occurrence(0), occurrence(1), occurrence(2), occurrence(3)];
    const admissions = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2", [f.id, occurrenceSlug(1)]))[0].n;
    const before = await admissions();
    const stderr2 = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { expect((await run()).status).not.toBe('partial'); } finally { stderr2.mockRestore(); }
    await settleConnectorWrites(engine, f.id).catch(() => {});
    expect(await admissions()).toBe(before);
    expect(await liveSlugs(engine, f.id)).toContain(occurrenceSlug(3));
    expect(await liveSlugs(engine, f.id)).not.toContain(occurrenceSlug(1));
    expect((await connectorState(engine, f.id)).last_failure).toBeNull();
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test('#6831: a purge that lands after the run started is refused by the pages guard at publication, and that refusal is skipped per item too', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const page = (n: number) => `---\ntype: note\ntitle: Synthetic connector item ${n}\n---\n# Synthetic connector item ${n}\n\nBody ${n}.\n`;
    // The first run also saves a cursor, so the second run's import of the same bytes is a new request, not a replay.
    await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => { await managed!.importMarkdown('notes/item-1.md', page(1)); await managed!.saveState({ first: true }); });
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const results = await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => {
        // The session read "no tombstones" at load, so only the guard can refuse item 1 now.
        const before = (await engine.readPageSnapshot('notes/item-1', { sourceId: f.id }))!;
        await submitPageMutation(ctx(engine, f.id), { operation: 'delete_page', params: { slug: 'notes/item-1', purge: true, expected_revision: before.revision } });
        await settleConnectorWrites(engine, f.id);
        return [await managed!.importMarkdown('notes/item-1.md', page(1)), await managed!.importMarkdown('notes/item-2.md', page(2))];
      });
      expect(results.map(r => r.status)).toEqual(['skipped', 'imported']);
    } finally { stderr.mockRestore(); }
    await settleConnectorWrites(engine, f.id).catch(() => {});
    expect(await liveSlugs(engine, f.id)).toEqual(['notes/item-2']);
    const state = await connectorState(engine, f.id);
    expect(state.last_failure).toBeNull();
    expect(state.last_run).toMatchObject({ purged_skipped: 1 });
    expect(state.purged_items).toEqual([expect.objectContaining({ slug: 'notes/item-1', request_id: expect.any(String) })]);
    const [refused] = await engine.executeRaw<{ state: string; error_code: string }>('SELECT state,error_code FROM persistence_requests WHERE request_id=$1::uuid', [state.purged_items?.[0]?.request_id]);
    expect(refused).toEqual({ state: 'failed', error_code: 'purged_content' });
    expect(state.pending).toEqual([]);
    await disposePersistenceConsumer(engine);

    // The refusing run saved no cursor, so the next runs replay the same refused receipt. While the tombstone stands it
    // stays skipped, under --retry-failed too, and nothing is admitted again.
    const admissions = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2', [f.id, 'notes/item-1']))[0].n;
    const before = await admissions();
    const replay = (opts: typeof options & { retryFailed?: boolean }) => withConnectorSync(engine, f.id, 'google', cfg, opts, async managed => managed!.importMarkdown('notes/item-1.md', page(1)));
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect((await replay({ ...options, retryFailed: true })).status).toBe('skipped');
      expect(await admissions()).toBe(before);
      // Once the owner clears the tombstone, the replayed refusal is retried and the item comes back.
      await unpurgePage(ctx(engine, f.id), { slug: 'notes/item-1', source_id: f.id });
      expect((await replay(options)).status).toBe('imported');
    } finally { quiet.mockRestore(); }
    await settleConnectorWrites(engine, f.id).catch(() => {});
    expect(await liveSlugs(engine, f.id)).toEqual(['notes/item-1', 'notes/item-2']);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

test('#6831: an item that was pending when the run counted it and is then refused as purged content is counted as skipped, not imported', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const page = (body: string) => `---\ntype: note\ntitle: Synthetic pending item\n---\n# Synthetic pending item\n\n${body}\n`;
    await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => { await managed!.importMarkdown('notes/item-1.md', page('First.')); await managed!.saveState({ first: true }); });
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    const binding = f.binding;
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let counts;
    try {
      counts = await withPausedOwnerBudget(() => withConnectorSync(engine, f.id, 'google', cfg, options, async managed => {
        const imported = await managed!.importMarkdown('notes/item-1.md', page('Second.'));
        expect(imported.status).toBe('imported');
        expect(managed!.counts.updated).toBe(1);
        // The owner refuses the pending update at publication: the page was purged meanwhile.
        await engine.executeRaw("UPDATE persistence_requests SET state='failed', error_code='purged_content', error_message='this page content was purged from this source and cannot be saved again' WHERE source_id=$1 AND state NOT IN ('committed','failed')", [f.id]);
        // The owner resumes, so the cursor can commit on the production budget.
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
        connectorWaitBudget.ms = CONNECTOR_WAIT_BUDGET_MS;
        await managed!.saveState({ second: true });
        return { ...managed!.counts };
      }));
    } finally {
      quiet.mockRestore();
      await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
    }
    expect(counts).toMatchObject({ created: 0, updated: 0, purged_skipped: 1 });
    const state = await connectorState(engine, f.id);
    expect(state.last_run).toMatchObject({ purged_skipped: 1 });
    expect(state.purged_items?.map(item => item.slug)).toEqual(['notes/item-1']);
    expect(state.pending).toEqual([]);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

test('#6831: a connector source whose runs keep ending on an error reads as stopped in sources status, sync status and doctor; a clean run clears it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const failing = () => withConnectorSync(engine, f.id, 'google', cfg, options, async () => {
      throw opError('invalid_fence', 'synthetic refusal of one connector item', 'Read the receipt.');
    });
    for (let n = 1; n <= CONNECTOR_STOPPED_RUNS; n++) {
      await expect(failing()).rejects.toMatchObject({ code: 'invalid_fence' });
      const status = (await readConnectorSourceStatuses(engine, [f.id])).get(f.id)!;
      expect(status.last_failure).toMatchObject({ code: 'invalid_fence', consecutive: n, message: 'synthetic refusal of one connector item' });
      expect(status.stopped).toBe(n >= CONNECTOR_STOPPED_RUNS);
    }
    const lines = connectorStatusLines(f.id, (await readConnectorSourceStatuses(engine, [f.id])).get(f.id)!).join('\n');
    expect(lines).toContain(`STOPPED: the last ${CONNECTOR_STOPPED_RUNS} connector syncs ended on invalid_fence`);
    const sync = await readSyncStatus(engine, f.id);
    expect(sync.connector_last_error).toMatchObject({ code: 'invalid_fence', consecutive: CONNECTOR_STOPPED_RUNS, stopped: true });
    expect(sync.last_error).toBeNull();
    expect(sync.connector_last_error?.fix.argv).toEqual(['gbrain', 'sources', 'status', f.id, '--json']);
    expect(sync.next?.argv).not.toEqual(['gbrain', 'sources', 'status', f.id, '--json']);
    // A recent last_sync_at no longer hides the stop.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1', [f.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const doctor = await checkSyncFreshness(engine);
    expect(doctor.status).not.toBe('ok');
    expect(doctor.message).toContain(`Source '${f.id}' is STOPPED: its last ${CONNECTOR_STOPPED_RUNS} connector syncs ended on invalid_fence`);

    // A credential failure that ends the run counts too.
    await expect(withConnectorSync(engine, f.id, 'google', cfg, options, async () => { throw new CredentialError('scope_missing', undefined, 'services without grant: calendar'); }))
      .rejects.toMatchObject({ code: 'scope_missing' });
    expect((await connectorState(engine, f.id)).last_failure).toMatchObject({ code: 'scope_missing', consecutive: CONNECTOR_STOPPED_RUNS + 1 });

    // Any other error that ends the run counts too (a missing token is a plain Error).
    await expect(withConnectorSync(engine, f.id, 'google', cfg, options, async () => { throw new Error('No token in CONNECTOR_TEST_TOKEN'); }))
      .rejects.toThrow('No token');
    expect((await connectorState(engine, f.id)).last_failure).toMatchObject({ code: 'connector_error', message: 'No token in CONNECTOR_TEST_TOKEN', consecutive: CONNECTOR_STOPPED_RUNS + 2 });
    // A run its caller cancelled is not a failure of the source, and a partial run (no cursor saved) proves no recovery.
    const cancel = new AbortController();
    await expect(withConnectorSync(engine, f.id, 'google', cfg, { ...options, signal: cancel.signal }, async () => { cancel.abort(); throw new Error('cancelled by caller'); }))
      .rejects.toThrow('cancelled by caller');
    await withConnectorSync(engine, f.id, 'google', cfg, options, async () => undefined);
    expect((await connectorState(engine, f.id)).last_failure).toMatchObject({ code: 'connector_error', consecutive: CONNECTOR_STOPPED_RUNS + 2 });
    expect((await readSyncStatus(engine, f.id)).connector_last_error).toMatchObject({ stopped: true });

    // A run that completes (its cursor saved) clears the record.
    await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => { await managed!.saveState({ recovered: true }); });
    expect((await connectorState(engine, f.id)).last_failure).toBeNull();
    expect((await readSyncStatus(engine, f.id)).connector_last_error).toBeNull();
    expect((await checkSyncFreshness(engine)).message).not.toContain(`Source '${f.id}' is STOPPED`);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [f.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}), 120_000);
