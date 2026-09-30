/**
 * Fix wave 4 cross-lane scenario gate, PGLite here and PostgreSQL through
 * test/e2e/fix-wave-4-integration.test.ts.
 *
 * Authoring gate. (1) Protects the seams between the five lanes: request
 * indexes and the #5751 working-tree waiver (Lane A), connector item holds,
 * fence refusals and the dispatch gate (Lane B), managed legacy-migration
 * adoption (Lane C), deactivate and the new lifecycle repairs (Lane D), and
 * the attendance marker's schema (Lane E). (2) Fails when one lane's contract
 * breaks another's: an upgrade that leaves the checkpoint on an unindexed scan,
 * a v0.32.2 adoption that a connector re-render refuses or re-admits, a
 * deactivate that closes the connector dispatch gate or leaves a held item
 * skipped, a new repair kind that the remediation run cannot reach. (3) Each
 * lane's own suite covers its path alone; none runs two lanes' code on one
 * brain. (4) No production seam: every step goes through the real migration,
 * sync, connector, repair, doctor and administration entry points; only the
 * providers behind `fetch` are simulated.
 *
 * The remaining plan scenarios run in the lane suites on this integrated
 * branch: #5693 lease x chain x upgrade in the migration-chain tests (the
 * real `gbrain apply-migrations` child runs under Lane D's orchestration
 * lock); holds x #5581 checkpoint x abort and holds x waiting in
 * test/connector-holds.test.ts; the query prefix x MCP cache in
 * test/embedding-query-prefix.test.ts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';
import { runMigrations, LATEST_VERSION } from '../src/core/migrate.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { requestIndexesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { __testing as v0_32_2 } from '../src/commands/migrations/v0_32_2.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { attemptedConnectorSourceIds } from '../src/core/persistence/connector-state.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { readAllSourceHolds } from '../src/core/connectors/item-holds-store.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { planRepairSteps } from '../src/core/remediation/repairs.ts';
import { runRemediate } from '../src/commands/doctor/remediate.ts';
import { REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { capture } from './helpers/wave-scenarios.ts';
import { createConnectorFixture, contact, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { addThread, fakeGmail, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const fixture = createConnectorFixture();
const { engines, env, source, home } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const withPersistenceOff = async <T>(engine: BrainEngine, run: () => Promise<T>) => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
};
const pageAdmissions = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' LIKE '%\\_import' ESCAPE '\\'", [sourceId]))[0].n;

test('X1: an upgrade from v178 builds the request indexes; managed working-tree syncs of legacy files then admit nothing and every checkpoint commits', async () => withEnv(env, async () => {
  for (const engine of engines) {
    // The pre-wave brain: schema v178, no request indexes, legacy pages written classically before activation.
    await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_run_open');
    await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_run_committed');
    await engine.setConfig('version', '178');
    expect(await runMigrations(engine)).toEqual({ applied: LATEST_VERSION - 178, current: LATEST_VERSION });
    expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
    expect((await requestIndexesCheck(engine)).status).toBe('ok');

    const id = `x1-${randomUUID().slice(0, 8)}`, root = join(home, id);
    mkdirSync(root); git(root, 'init', '-q');
    writeFileSync(join(root, 'seed.md'), '---\ntitle: seed\n---\nThe committed file.\n');
    git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
    const legacy = Buffer.from('---\ntitle:   "Hand Formatted"\ntags: [b, a]\n---\n\nA hand formatted legacy note.   \n\n\n');
    await withPersistenceOff(engine, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
      writeFileSync(join(root, 'hand.md'), legacy);
      await importFromContent(engine, 'hand', legacy.toString('utf8'), { sourceId: id, noEmbed: true, sourcePath: 'hand.md' });
      await claimWorktree(engine, id, root);
    });
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true, workingTree: true, explicitProcessing: [] };
    for (let run = 0; run < 3; run++) {
      const result = await performManagedSync(engine, opts);
      await disposePersistenceConsumer(engine);
      expect(['first_sync', 'synced']).toContain(result.status);
      expect(result.failureCodes ?? []).toEqual([]);
    }
    const imports = await engine.executeRaw<{ slug: string }>("SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [id]);
    expect(imports.map(row => row.slug)).toEqual(['seed']);
    expect(await engine.executeRaw("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint' AND state<>'committed'", [id])).toEqual([]);
  }
}), 240_000);

/** A People listing with a stable sync token. */
const people = (list: () => Array<Record<string, unknown>>) => async (url: string) => {
  if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
  return json({ connections: new URL(url).searchParams.has('syncToken') ? [] : list(), nextSyncToken: 'contacts-stable' });
};
const googleContacts = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

test('X4: the v0.32.2 facts adoption on a connector page publishes above the timeline; connector re-renders carry the fence without a refusal and converge', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleContacts);
    const cfg = parseGoogleSourceConfig(googleContacts, f.dir);
    const fetcher = withGoogleAccount(people(() => [contact('adopt', 'Adopt Example')]));
    await runGoogleSync(engine, f.id, cfg, options, fetcher);
    await disposePersistenceConsumer(engine);
    const slug = 'people/adopt-example';
    expect(await engine.getPage(slug, { sourceId: f.id })).not.toBeNull();
    // A legacy (pre-v0.32.2) fact about the connector's page, unfenced, as an old binary wrote it.
    const [{ id: factId }] = await withPersistenceOff(engine, () => engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, source, confidence)
       VALUES ($1, $2, 'Adopt example prefers email', 'fact', 'world', 'high', 'from a call', '2026-02-03T00:00:00Z', 'mcp:put_page', 0.9) RETURNING id`, [f.id, slug]));

    const phase = await v0_32_2.phaseBFenceFacts(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
    await disposePersistenceConsumer(engine);
    expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
    const [row] = await engine.executeRaw<{ row_num: number | null; expired_at: string | null }>('SELECT row_num, expired_at FROM facts WHERE id=$1', [factId]);
    expect(row).toEqual({ row_num: 1, expired_at: null });
    const adopted = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(parseFactsFence(adopted.page.compiled_truth).facts.map(fact => fact.claim)).toEqual(['Adopt example prefers email']);

    // Full re-walks, so the connector really re-renders the adopted page. Lane B's re-render carries the fence (no
    // connector_fence_below_timeline) byte for byte. The first re-render takes one admission back from the maintenance
    // writer; after it Lane A's kernel sees nothing to publish, so re-renders converge instead of re-admitting every run.
    const rewalk = async () => { const result = await runGoogleSync(engine, f.id, cfg, { ...options, resetCheckpoint: true }, fetcher);
      await disposePersistenceConsumer(engine); return result; };
    expect((await rewalk()).status).not.toBe('partial');
    const rendered = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!.page.compiled_truth;
    expect(rendered).toBe(adopted.page.compiled_truth);
    const settled = await pageAdmissions(engine, f.id);
    expect((await rewalk()).status).not.toBe('partial');
    expect(await pageAdmissions(engine, f.id)).toBe(settled);
    expect(parseFactsFence((await engine.readPageSnapshot(slug, { sourceId: f.id }))!.page.compiled_truth).facts.map(fact => fact.rowNum)).toEqual([1]);
    const [kept] = await engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at FROM facts WHERE id=$1', [factId]);
    expect(kept.expired_at).toBeNull();
  }
}), 240_000);

test('X6: deactivate refuses while a connector item is held (classic mode cannot read managed holds); after the printed exit it succeeds and the dispatch gate stays open', async () => withEnv(env, async () => {
  const account = 'reader@example.com';
  const gmailConfig = { kind: 'google', g_account: account, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
  for (const engine of engines) {
    const f = await source(engine, gmailConfig);
    const cfg = parseGoogleSourceConfig(gmailConfig, f.dir);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60301', Date.now() - 2 * 3_600_000);
    addThread(fx, 'a1b2c3d4e5f60302', Date.now() - 3 * 3_600_000);
    fx.failThreads.set('a1b2c3d4e5f60302', 400);
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(gmailFetch(fx), account));
    for (let i = 0; i < 3; i++) { await run(); await disposePersistenceConsumer(engine); }
    expect((await readAllSourceHolds(engine, { sourceIds: [f.id] }))[0]?.held.map(h => h.key)).toEqual(['a1b2c3d4e5f60302']);
    expect((await attemptedConnectorSourceIds(engine)).has(f.id)).toBe(true);

    const settle = () => engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_effects SET state='committed' WHERE state<>'committed'"); });
    await settle();
    const dry = await runPersistenceAdministration(engine, 'writer_deactivate', { dry_run: true }) as { blockers: Array<{ kind: string; source_id?: string; exit: string }>; apply_command?: string };
    const held = dry.blockers.find(b => b.kind === 'connector_holds');
    expect(held).toMatchObject({ source_id: f.id, exit: expect.stringContaining(`gbrain sources retry-held ${f.id}`) });
    expect(dry.apply_command).toBeUndefined();
    await expect(runPersistenceAdministration(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: await writerAdminState(engine) }))
      .rejects.toMatchObject({ code: 'writer_not_quiesced' });

    // The printed exit: retry the held thread (recovered upstream) and sync; the hold clears and deactivate proceeds.
    await retryHeld(engine, f.id);
    fx.failThreads.delete('a1b2c3d4e5f60302');
    fx.fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    await disposePersistenceConsumer(engine);
    expect(fx.fetched).toContain('a1b2c3d4e5f60302');
    expect(await readAllSourceHolds(engine, { sourceIds: [f.id] })).toEqual([]);
    await settle();
    const clean = await runPersistenceAdministration(engine, 'writer_deactivate', { dry_run: true }) as { apply_command?: string };
    const expected = /--expected-state ([a-f0-9]{64})$/.exec(clean.apply_command ?? '')?.[1];
    expect(expected).toBeDefined();
    const done = await runPersistenceAdministration(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: expected }) as Record<string, unknown>;
    expect(done).toMatchObject({ mode: 'classic', deactivated: true });

    // Lane B's gate survives Lane D's mode change: autopilot keeps dispatching the connector.
    expect((await attemptedConnectorSourceIds(engine)).has(f.id)).toBe(true);
    const added: Array<{ name: string; data: Record<string, unknown> }> = [];
    const queue = { add: async (name: string, data: Record<string, unknown>) => { added.push({ name, data }); return { id: added.length, coalesced: false }; } } as unknown as MinionQueue;
    await engine.executeRaw('UPDATE sources SET last_sync_at=NULL WHERE id=$1', [f.id]);
    const write = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try { await dispatchFreshnessSyncs(engine, queue, { baseInterval: 60, slot: `x6-${randomUUID()}`, timeoutMs: 60_000, jsonMode: true }); }
    finally { write.mockRestore(); log.mockRestore(); }
    expect(added.filter(job => job.name === 'sync').map(job => job.data.sourceId)).toContain(f.id);

    expect((await run()).status).not.toBe('partial');
    // Restore managed mode for the next check on this engine.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}), 240_000);

test('X11: the remediation run reaches every new repair kind, runs the free ones under --max-usd 0 and clears their doctor findings', async () => withEnv(env, async () => {
  for (const engine of engines) {
    expect(REPAIR_REGISTRY.map(spec => spec.kind)).toEqual(['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'connector-checkpoints',
      'request-indexes', 'connector-fences', 'orphan-bindings', 'embedding-effects']);
    // Pending work for Lane A (a dropped index) and Lane D (an orphan binding of a removed source).
    await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_run_open');
    await withPersistenceOff(engine, async () => {
      const [old] = await engine.executeRaw<{ incarnation: string }>("INSERT INTO sources (id, name) VALUES ('x11-orphan', 'x11-orphan') RETURNING incarnation::text");
      const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
      await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
        ['x11-orphan', old.incarnation, worktree.id]);
      await engine.executeRaw("DELETE FROM sources WHERE id = 'x11-orphan'");
    });
    const planned = Object.fromEntries((await planRepairSteps(engine, { noEmbed: true })).map(step => [step.kind, step]));
    expect(planned['request-indexes']).toMatchObject({ paid: false, embeds: 'none', command: 'gbrain repair request-indexes --apply' });
    expect(planned['orphan-bindings']).toMatchObject({ paid: false, embeds: 'none', command: 'gbrain repair orphan-bindings --apply' });
    const run = JSON.parse((await capture(() => runRemediate(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json']))).out);
    await disposePersistenceConsumer(engine);
    const byKind = Object.fromEntries(run.repairs.map((r: { kind: string }) => [r.kind, r]));
    expect(byKind['request-indexes']).toMatchObject({ status: 'completed' });
    expect(byKind['orphan-bindings']).toMatchObject({ status: 'completed' });
    expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_source_bindings WHERE source_id='x11-orphan'")).toEqual([]);
    const replanned = (await planRepairSteps(engine, { noEmbed: true })).map(step => step.kind);
    expect(replanned).not.toContain('request-indexes');
    expect(replanned).not.toContain('orphan-bindings');
  }
}), 240_000);
