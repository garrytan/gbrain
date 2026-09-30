import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite, writeResponse } from '../src/core/persistence/service.ts';
import { admitWrite, compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { readConnectorSourceStatuses } from '../src/core/persistence/connector-status.ts';
import { migrateConnectorCheckpoints, CONNECTOR_MIGRATION_OP } from '../src/core/persistence/connector-checkpoint-migration.ts';
import { connectorCheckpointKey, connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { preparePersistedMutation } from '../src/core/persistence/service.ts';
import { checkConnectorCheckpoints } from '../src/commands/doctor/checks/connector-checkpoints.ts';
import { connectorCheckpointsRepair } from '../src/core/repair/connector-checkpoints.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { performSync } from '../src/commands/sync.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { inspectUnchanged } from '../src/core/persistence/noop-kernel.ts';
import { ALL_SOURCES } from '../src/core/source-id.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, contact, issueFixture, githubFetch, withGoogleAccount, connectorPendingSet } from './helpers/connector-fixture.ts';

const { home, engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const mark = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ seq: string | null }>('SELECT max(sequence)::text AS seq FROM persistence_requests WHERE source_id=$1', [id]))[0]?.seq ?? '0';
const since = (engine: BrainEngine, id: string, after: string) => engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint ORDER BY sequence', [id, after]);
const incarnation = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]))[0].incarnation;

/** People fixture: `all` is the full listing a walk without a sync token returns; incremental walks return nothing. */
function people(all: () => Array<ReturnType<typeof contact>>, opts: { fail?: () => boolean; token?: () => string } = {}) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (opts.fail?.()) return json({ error: { message: 'fixture people outage' } }, 400);
    return json({ connections: u.searchParams.has('syncToken') ? [] : all(), nextSyncToken: opts.token?.() ?? 'contacts-stable' });
  };
  return { fetcher, calls };
}
const google = (engine: BrainEngine, f: { id: string; dir: string }, fetcher: (url: string) => Promise<Response>, account = googleConfig.g_account, extra: object = {}, config: Record<string, unknown> = googleConfig) =>
  runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), { ...options, ...extra }, withGoogleAccount(fetcher, account));

test('account pin: a contacts-only or calendar-only credential swap refuses before any admission; rotation for the same account resumes', async () => withEnv(env, async () => {
  for (const engine of engines) for (const service of ['contacts', 'calendar'] as const) {
    const config = { ...googleConfig, g_services: service };
    const f = await source(engine, config);
    const at = new Date(Date.now() - 3600_000).toISOString();
    const base = async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/calendar/')) return json({ items: [{ id: 'example-event', summary: 'Example planning', status: 'confirmed', start: { dateTime: at }, end: { dateTime: at } }], nextSyncToken: 'calendar-1' });
      return json({ connections: [contact('first', 'First Example')], nextSyncToken: 'contacts-1' });
    };
    expect((await google(engine, f, base, googleConfig.g_account, {}, config)).added).toBe(1);
    const state = await readManagedConnectorState(engine, f.id, await incarnation(engine, f.id));
    expect(state.account).toEqual({ kind: 'google', email: googleConfig.g_account });
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    const swapped = google(engine, f, base, 'someone-else@example.invalid', {}, config);
    await expect(swapped).rejects.toMatchObject({ code: 'connector_account_changed', detail: 'account_changed', docs: 'docs/guides/write-refusals.md#connector-account-changed' });
    const error = await swapped.catch(e => e) as { suggestion: string; message: string };
    // Identities stay out of the message (job records persist and serve it remotely) and appear in the local suggestion.
    expect(error.message).not.toContain('someone-else@example.invalid');
    expect(error.suggestion).toContain('pinned to owner@example.invalid; the credential resolves to someone-else@example.invalid');
    expect(error.suggestion).toContain('g_token_env (CONNECTOR_TEST_TOKEN)');
    expect(error.suggestion).toContain(`gbrain sync --source ${f.id}`);
    expect(error.suggestion).toContain(`gbrain sources archive ${f.id}`);
    expect(error.suggestion).toContain('gbrain google setup --account someone-else@example.invalid');
    expect(await since(engine, f.id, before)).toHaveLength(0);
    // --reset-checkpoint never authorizes an account change.
    await expect(google(engine, f, base, 'someone-else@example.invalid', { resetCheckpoint: true }, config)).rejects.toMatchObject({ code: 'connector_account_changed' });
    // A rotated token for the same account resumes the checkpoint: no page admission.
    expect((await google(engine, f, base, googleConfig.g_account, {}, config)).status).not.toBe('partial');
    expect((await since(engine, f.id, before)).filter(row => String(row.intent?.kind).endsWith('_import'))).toHaveLength(0);
  }
}), 180_000);

test('account pin: a GitHub App without an install id that resolves a different installation refuses with the new-source hint', async () => withEnv(env, async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pemPath = join(home, `app-${randomUUID().slice(0, 8)}.pem`);
  writeFileSync(pemPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const config = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_app_id: 4242, gh_app_pem_path: pemPath };
  for (const engine of engines) {
    const f = await source(engine, config);
    let installation = 100;
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/app/installations') return json([{ id: installation }]);
      if (path === `/app/installations/${installation}/access_tokens`) return json({ token: 'ghs_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      return githubFetch()(url);
    };
    const run = () => runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), options, fetcher);
    expect((await run()).status).not.toBe('partial');
    expect((await readManagedConnectorState(engine, f.id, await incarnation(engine, f.id))).account).toEqual({ kind: 'github', installationId: 100, login: null });
    installation = 200;
    const before = await mark(engine, f.id);
    const refused = await run().catch(e => e) as { code: string; suggestion: string };
    expect(refused.code).toBe('connector_account_changed');
    expect(refused.suggestion).toContain('--app-install 200');
    expect(refused.suggestion).toContain(`gbrain sources archive ${f.id}`);
    expect(await since(engine, f.id, before)).toHaveLength(0);
    // A token refresh re-mints for the installation first resolved, never a newly discovered one.
    const { AppTokenProvider } = await import('../src/core/github-source.ts');
    installation = 100;
    const minted: string[] = [];
    const provider = new AppTokenProvider(parseGitHubSourceConfig(config, f.dir).app!, async (url: string, init?: RequestInit) => { minted.push(new URL(url).pathname); return fetcher(url); });
    await provider.getToken();
    installation = 200;
    await provider.refresh().catch(() => {});
    expect(provider.installationId).toBe(100);
    expect(minted.filter(path => path.endsWith('/access_tokens'))).toEqual(['/app/installations/100/access_tokens', '/app/installations/100/access_tokens']);
    // Moving the PEM keeps the identity; the pin still decides.
    installation = 100;
    const moved = join(home, `moved-${randomUUID().slice(0, 8)}.pem`);
    writeFileSync(moved, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const movedConfig = { ...config, gh_app_pem_path: moved };
    expect(connectorIdentity('github', movedConfig, f.dir).digest).toBe(connectorIdentity('github', config, f.dir).digest);
  }
}), 180_000);

test('--reset-checkpoint re-walks once: newly covered items import, unchanged pages take no admission, the pin is kept; non-connector sources refuse', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const listing = [contact('first', 'First Example')];
    const { fetcher, calls } = people(() => listing);
    expect((await google(engine, f, fetcher)).added).toBe(1);
    // Provider now has an item only a full walk reveals (like a widened history window).
    listing.push(contact('second', 'Second Example'));
    await disposePersistenceConsumer(engine);
    expect((await google(engine, f, fetcher)).added).toBe(0);
    let before = await mark(engine, f.id);
    calls.length = 0;
    const reset = await google(engine, f, fetcher, googleConfig.g_account, { resetCheckpoint: true });
    expect(reset.added).toBe(1);
    expect(calls.some(url => url.includes('syncToken'))).toBe(false);
    const pages = (await since(engine, f.id, before)).filter(row => String(row.intent?.kind).endsWith('_import'));
    expect(pages.map(row => row.slug)).toEqual(['people/second-example']);
    const state = await readManagedConnectorState(engine, f.id, await incarnation(engine, f.id));
    expect(state.account).toEqual({ kind: 'google', email: googleConfig.g_account });
    // The re-walk saved a fresh cursor (it did not replay an older committed checkpoint), so the next run is incremental.
    await disposePersistenceConsumer(engine);
    calls.length = 0;
    await google(engine, f, fetcher);
    expect(calls.some(url => url.includes('syncToken=contacts-stable'))).toBe(true);
    await disposePersistenceConsumer(engine);
    before = await mark(engine, f.id);
    await google(engine, f, fetcher, googleConfig.g_account, { resetCheckpoint: true });
    expect((await since(engine, f.id, before)).filter(row => String(row.intent?.kind).endsWith('_import'))).toHaveLength(0);
    // A Git-backed source is not a connector.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const gitId = `git-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [gitId, join(home, gitId)]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await expect(performSync(engine, { sourceId: gitId, resetCheckpoint: true, noPull: true })).rejects.toMatchObject({ code: 'invalid_params' });
  }
}), 180_000);

test('freshness: a quiet run with an unchanged cursor stamps last_sync_at under the lease so gbrain waiting stays fresh; a failed sweep does not stamp', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    let fail = false;
    const { fetcher } = people(() => [contact('first', 'First Example')], { fail: () => fail });
    await google(engine, f, fetcher);
    const stamp = async () => (await engine.executeRaw<{ at: string }>('SELECT last_sync_at::text AS at FROM sources WHERE id=$1', [f.id]))[0].at;
    await engine.executeRaw("UPDATE sources SET last_sync_at=now()-interval '2 days' WHERE id=$1", [f.id]).catch(async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("UPDATE sources SET last_sync_at=now()-interval '2 days' WHERE id=$1", [f.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    const old = await stamp();
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    expect((await google(engine, f, fetcher)).status).toBe('up_to_date');
    expect(await since(engine, f.id, before)).toHaveLength(0);
    const fresh = await stamp();
    expect(new Date(fresh).getTime()).toBeGreaterThan(new Date(old).getTime());
    const waiting = await handleToolCall(engine, 'open_loops', { group_by: 'counterparty', limit: 3 }, { sourceId: ALL_SOURCES }) as { sources?: Array<{ id: string; stale: boolean }> };
    expect(waiting.sources?.find(row => row.id === f.id)?.stale ?? false).toBe(false);
    fail = true;
    expect((await google(engine, f, fetcher)).status).toBe('partial');
    expect(await stamp()).toBe(fresh);
    const status = (await readConnectorSourceStatuses(engine)).get(f.id)!;
    expect(status.upgrade_recovery).toBe('none');
  }
}), 180_000);

test('run counts: sources status reports the second run of the two-cycle fixture as zero admissions and N skipped unchanged', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const all = () => [contact('first', 'First Example'), contact('second', 'Second Example'), contact('third', 'Third Example')];
    const rewalk = async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: all(), nextSyncToken: 'contacts-stable' });
    };
    await google(engine, f, rewalk);
    expect((await readConnectorSourceStatuses(engine)).get(f.id)!.last_run).toMatchObject({ page_admissions: 3, skipped_unchanged: 0 });
    await disposePersistenceConsumer(engine);
    await google(engine, f, rewalk);
    expect((await readConnectorSourceStatuses(engine)).get(f.id)!.last_run).toMatchObject({
      page_admissions: 0, skipped_unchanged: 3, pending: 0, checkpoint_admissions: 0, stopped_on_wait_budget: false });
  }
}), 180_000);

test('pending set: a pending write that later fails is re-fetched under a new request id without --retry-failed; one that commits is not re-fetched', async () => withEnv(env, async () => {
  for (const engine of engines) for (const outcome of ['fails', 'commits'] as const) {
    const f = await boundSource(engine, githubConfig);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const run = () => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, githubFetch());
    expect(await run()).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    const [entry] = await connectorPendingSet(engine, f.id);
    const [accepted] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [f.id, entry.requestId]);
    await disposePersistenceConsumer(engine);
    const path = join(f.dir, 'gh/acme-example/app/1.md');
    if (outcome === 'fails') mkdirSync(dirname(path), { recursive: true });
    if (outcome === 'fails') writeFileSync(path, '---\ntitle: Operator file\n---\nAn unindexed operator file occupies the path.\n');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    expect((await waitForWrite(engine, accepted, { engine: engine.kind }, 20_000)).state).toBe(outcome === 'fails' ? 'conflict' : 'committed');
    if (outcome === 'fails') {
      rmSync(path);
      // A targeted refresh of a different item enumerates nothing else, so it keeps the failed entry for its own retry.
      await disposePersistenceConsumer(engine);
      await runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), { ...options, githubItem: { repo: 'acme-example/app', number: 2, kind: 'issue', deleted: true } }, githubFetch());
      expect((await connectorPendingSet(engine, f.id)).map(pending => pending.requestId)).toEqual([accepted.request_id]);
    }
    await disposePersistenceConsumer(engine);
    const before = await mark(engine, f.id);
    expect((await run()).status).not.toBe('partial');
    const pages = (await since(engine, f.id, before)).filter(row => String(row.intent?.kind).endsWith('_import'));
    if (outcome === 'fails') {
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ state: 'committed' });
      expect(pages[0].request_id).not.toBe(accepted.request_id);
      expect(pages[0].intent?.retryOf).toBe(accepted.request_id);
    } else expect(pages).toHaveLength(0);
    expect(await connectorPendingSet(engine, f.id)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  }
}), 180_000);

test('pending set: a committed-then-compacted pending receipt and a crash before the checkpoint cost no page admission on the next run; duplicates in one sweep admit once', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const dup = async (url: string) => url.includes('/settings/sendAs') ? json({ sendAs: [] })
      : json({ connections: [contact('first', 'First Example'), contact('first', 'First Example')], nextSyncToken: 'contacts-dup' });
    expect(await google(engine, f, dup)).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    const imports = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'", [f.id]);
    expect(imports).toHaveLength(1);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    expect((await waitForWrite(engine, imports[0], { engine: engine.kind }, 20_000)).state).toBe('committed');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE source_id=$1", [f.id]);
    await compactWriteReceipts(engine);
    const before = await mark(engine, f.id);
    expect((await google(engine, f, dup)).status).not.toBe('partial');
    expect((await since(engine, f.id, before)).filter(row => String(row.intent?.kind).endsWith('_import'))).toHaveLength(0);
    expect(await connectorPendingSet(engine, f.id)).toEqual([]);
  }
}), 180_000);

test('mixed versions: a v2 receipt refused by an old consumer names the consumer upgrade; permission_denied is never relabeled', async () => {
  const receipt = (error_code: string, kind: string) => ({ id: randomUUID(), request_id: randomUUID(), operation: 'submit_job', source_id: 'connector-example', state: 'failed',
    error_code, error_message: 'refused', intent: { kind }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) as unknown as WriteRequest;
  const refusal = (row: WriteRequest) => { try { writeResponse(row); } catch (error) { return error as { code: string; suggestion: string; detail?: string; docs?: string }; } throw new Error('expected refusal'); };
  const old = refusal(receipt('unsupported_mutation_protocol', 'connector_v2_import'));
  expect(old).toMatchObject({ code: 'unsupported_mutation_protocol', detail: 'consumer_upgrade_required', docs: 'docs/guides/write-refusals.md#unsupported-mutation-protocol' });
  expect(old.suggestion).toContain('gbrain upgrade on every consumer and worktree-owner host');
  for (const kind of ['connector_v2_import', 'managed_sync_import']) {
    const denied = refusal(receipt('permission_denied', kind));
    expect(denied.code).toBe('permission_denied');
    expect(denied.detail).toBeUndefined();
    expect(denied.suggestion).toBe('Inspect this receipt before submitting a new request_id.');
  }
  // A binary that predates the v2 namespace falls through to the same code for any kind it does not know.
  await expect(preparePersistedMutation({} as BrainEngine, receipt('', 'connector_v3_import') as WriteRequest & { operation: string }, { engine: 'pglite' }))
    .rejects.toMatchObject({ code: 'unsupported_mutation_protocol' });
});

test('mixed versions: a retired managed_connector_* intent fails connector_intent_outdated, pre_upgrade before the cutoff and naming the host upgrade after it', async () => withEnv(env, async () => {
  for (const engine of engines) for (const phase of ['pre_upgrade', 'post_cutoff'] as const) {
    const f = await source(engine, googleConfig);
    const { fetcher } = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' LIMIT 1", [f.id]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint='v2-cutoff'", [CONNECTOR_MIGRATION_OP]);
    const cutoff = phase === 'pre_upgrade' ? "now()+interval '1 hour'" : "now()-interval '1 hour'";
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,'v2-cutoff',jsonb_build_array(jsonb_build_object('cutoff',(${cutoff})::text)))`, [CONNECTOR_MIGRATION_OP]);
    const intent = { ...template.intent, kind: 'managed_connector_import', checkpointKey: 'legacy-raw-config-key' };
    const row = await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId: f.id, sourceIncarnation: template.source_incarnation,
      slug: template.slug, pageId: template.page_id, worktreeId: template.worktree_id ?? undefined, principal: { kind: template.principal_kind, id: template.principal_id },
      authority: template.authority, callerIntent: intent, intent } as never);
    startPersistenceConsumer(engine, { engine: engine.kind });
    const done = await waitForWrite(engine, row, { engine: engine.kind }, 20_000);
    expect(done).toMatchObject({ state: 'failed', error_code: 'connector_intent_outdated' });
    let delivered: { detail?: string; suggestion?: string; docs?: string } = {};
    try { writeResponse(done); } catch (error) { delivered = error as typeof delivered; }
    expect(delivered.docs).toBe('docs/guides/write-refusals.md#connector-intent-outdated');
    if (phase === 'pre_upgrade') {
      expect(delivered.detail).toBe('pre_upgrade');
      expect(delivered.suggestion).toContain('No host upgrade is needed');
    } else expect(delivered.suggestion).toContain('Upgrade gbrain on the host that runs connector jobs');
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

/** A committed legacy checkpoint receipt, as a pre-upgrade connector host left it. */
async function legacyCheckpoint(engine: BrainEngine, f: { id: string }, key: string, state: unknown, compacted = false) {
  const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint' ORDER BY sequence DESC LIMIT 1", [f.id]);
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)", [key, JSON.stringify([{ generation: 1, state }])]);
  const intent = { ...template.intent, kind: 'managed_connector_checkpoint', checkpointKey: key, configHash: 'legacy-raw-config-hash' };
  const row = await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId: f.id, sourceIncarnation: template.source_incarnation,
    slug: template.slug, pageId: null, worktreeId: template.worktree_id ?? undefined, principal: { kind: template.principal_kind, id: template.principal_id },
    authority: template.authority, callerIntent: intent, intent } as never);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_requests SET state='committed',completed_at=now(),outcome='{"status":"checkpointed"}'::jsonb${compacted ? ',compacted=true,intent=NULL' : ''} WHERE id=$1::uuid`, [row.id]);
  });
  return row;
}

test('migration 176: re-keys the newest committed checkpoint, re-walks a compacted one once, removes orphans, keeps referenced and newer rows, and a rerun changes nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const live = await source(engine, googleConfig), compacted = await source(engine, googleConfig), archived = await source(engine, googleConfig);
    const { fetcher, calls } = people(() => [contact('first', 'First Example')]);
    await google(engine, live, fetcher); await google(engine, compacted, fetcher); await google(engine, archived, fetcher);
    await disposePersistenceConsumer(engine);
    // Pretend the sources were last checkpointed by a pre-upgrade binary under raw-config keys.
    for (const f of [live, compacted, archived]) {
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op IN ('managed-connector','managed-connector-state') AND fingerprint IN ($1,$2)",
        [connectorCheckpointKey(f.id, await incarnation(engine, f.id), connectorIdentity('google', googleConfig, f.dir)), '']);
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-connector-state'");
    }
    const liveKey = `legacy-live-${randomUUID()}`;
    await legacyCheckpoint(engine, live, `legacy-older-${randomUUID()}`, { contacts_sync_token: 'older-token' });
    await legacyCheckpoint(engine, live, liveKey, { contacts_sync_token: 'legacy-token' });
    await legacyCheckpoint(engine, compacted, `legacy-compacted-${randomUUID()}`, { contacts_sync_token: 'lost-token' }, true);
    await legacyCheckpoint(engine, archived, `legacy-archived-${randomUUID()}`, { contacts_sync_token: 'archived-token' });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archived.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const orphan = `legacy-orphan-${randomUUID()}`, newer = `legacy-newer-${randomUUID()}`, referenced = `legacy-referenced-${randomUUID()}`;
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('managed-connector',$1,'[]'::jsonb,now()-interval '9 days'),('managed-connector',$2,'[]'::jsonb,now()+interval '1 hour'),('managed-connector',$3,'[]'::jsonb,now()-interval '9 days')", [orphan, newer, referenced]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('managed-connector-retry',$1,$2::text::jsonb,now()-interval '9 days')",
      [randomUUID(), JSON.stringify([{ checkpointKey: orphan, requestId: randomUUID(), baseRequestId: randomUUID() }])]);
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' LIMIT 1", [live.id]);
    await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId: live.id, sourceIncarnation: template.source_incarnation, slug: template.slug,
      pageId: template.page_id, principal: { kind: template.principal_kind, id: template.principal_id }, authority: template.authority,
      callerIntent: { ...template.intent, kind: 'managed_connector_import', checkpointKey: referenced }, intent: { ...template.intent, kind: 'managed_connector_import', checkpointKey: referenced } } as never);
    const lines: string[] = [];
    const report = await migrateConnectorCheckpoints(engine, line => lines.push(line));
    expect(report.rekeyed.map(row => row.source_id).sort()).toEqual([live.id, archived.id].sort());
    // An archived source keeps its cursor under the stable key, so a restore resumes it.
    const archivedKey = connectorCheckpointKey(archived.id, await incarnation(engine, archived.id), connectorIdentity('google', googleConfig, archived.dir));
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [archivedKey])).toHaveLength(1);
    expect(report.rewalking).toEqual([compacted.id]);
    expect(lines.join('\n')).toContain(`${live.id}: resumed from pre-upgrade checkpoint of`);
    expect(lines.join('\n')).toContain(`to re-walk: gbrain sync --source ${live.id} --reset-checkpoint`);
    const fingerprints = (await engine.executeRaw<{ op: string; fingerprint: string }>("SELECT op,fingerprint FROM op_checkpoints WHERE op IN ('managed-connector','managed-connector-retry')")).map(row => row.fingerprint);
    expect(fingerprints).not.toContain(orphan);
    expect(fingerprints).toContain(newer);
    expect(fingerprints).toContain(referenced);
    const liveNew = connectorCheckpointKey(live.id, await incarnation(engine, live.id), connectorIdentity('google', googleConfig, live.dir));
    const [copied] = await engine.executeRaw<{ completed_keys: Array<{ state: { contacts_sync_token: string } }> }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [liveNew]);
    expect(copied.completed_keys[0].state.contacts_sync_token).toBe('legacy-token');
    const statuses = await readConnectorSourceStatuses(engine);
    expect(statuses.get(live.id)).toMatchObject({ upgrade_recovery: 'resumed' });
    expect(statuses.get(live.id)!.resumed_from).not.toBeNull();
    expect(statuses.get(compacted.id)).toMatchObject({ upgrade_recovery: 'rewalking_once' });
    const snapshot = await engine.executeRaw("SELECT op,fingerprint,completed_keys FROM op_checkpoints WHERE op LIKE 'managed-connector%' ORDER BY op,fingerprint");
    expect(await migrateConnectorCheckpoints(engine, () => {})).toEqual({ rekeyed: [], rewalking: [], removed: { checkpoints: 0, retries: 0 } });
    expect(await engine.executeRaw("SELECT op,fingerprint,completed_keys FROM op_checkpoints WHERE op LIKE 'managed-connector%' ORDER BY op,fingerprint")).toEqual(snapshot);
    // The first post-upgrade runs: the live source resumes its legacy cursor and is pinned with unverified continuity; the compacted one re-walks once.
    calls.length = 0;
    await google(engine, live, fetcher);
    expect(calls.some(url => url.includes('syncToken=legacy-token'))).toBe(true);
    expect((await readConnectorSourceStatuses(engine)).get(live.id)).toMatchObject({ upgrade_recovery: 'resumed', continuity_unverified: true, account_pinned: true });
    await google(engine, compacted, fetcher);
    expect((await readConnectorSourceStatuses(engine)).get(compacted.id)).toMatchObject({ upgrade_recovery: 'none' });
  }
}), 240_000);

test('doctor counts a checkpoint orphaned by a content change once it is 7 days old; repair connector-checkpoints removes it and never copies', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const { fetcher } = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    const oldKey = connectorCheckpointKey(f.id, await incarnation(engine, f.id), connectorIdentity('google', googleConfig, f.dir));
    const widened = { ...googleConfig, g_history_days: 365 };
    expect(await engine.updateSourceConfig(f.id, { g_history_days: 365 })).toBe(true);
    await disposePersistenceConsumer(engine);
    await google(engine, f, fetcher, googleConfig.g_account, {}, widened);
    const count = async () => ((await checkConnectorCheckpoints(engine)).details as { count: number }).count;
    const before = await count();
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='managed-connector' AND fingerprint=$1", [oldKey]);
    expect(await count()).toBe(before + 1);
    const aged = await checkConnectorCheckpoints(engine);
    expect(aged.status).toBe('warn');
    expect(aged.message).toContain('gbrain repair connector-checkpoints');
    const ctx = { engine, config: { engine: engine.kind }, remote: false, logger: console } as unknown as OperationContext;
    const scope = await resolveRepairScope(engine);
    const dry = await runRepair(ctx, connectorCheckpointsRepair, scope, { apply: false });
    expect(dry.affected).toBeGreaterThanOrEqual(1);
    expect(dry.cost).toMatchObject({ lifetime_ids: 0, embedding_pages: 0 });
    const applied = await runRepair(ctx, connectorCheckpointsRepair, scope, { apply: true });
    expect(applied.applied).toBe(dry.affected);
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [oldKey])).toHaveLength(0);
    expect((await checkConnectorCheckpoints(engine)).status).toBe('ok');
    const liveKey = connectorCheckpointKey(f.id, await incarnation(engine, f.id), connectorIdentity('google', widened, f.dir));
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [liveKey])).toHaveLength(1);
  }
}), 180_000);

test('#5470 connector kernel: a safe-chunk reseal, projection lag, a pending contextual-mode page, a deleted page and a changed page admit; a carried-forward timeline row does not defeat the skip', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    let org = 'Example Org', tombstone = false;
    const rewalk = async (url: string) => url.includes('/settings/sendAs') ? json({ sendAs: [] })
      : json({ connections: [tombstone ? { resourceName: 'people/first', metadata: { deleted: true } } : { ...contact('first', 'First Example'), organizations: [{ name: org }] }], nextSyncToken: 'contacts-stable' });
    const slug = 'people/first-example';
    const admitted = async (change: () => Promise<unknown>) => {
      await change();
      await disposePersistenceConsumer(engine);
      const before = await mark(engine, f.id);
      await google(engine, f, rewalk);
      return (await since(engine, f.id, before)).filter(row => row.slug === slug && String(row.intent?.kind).endsWith('_import')).length;
    };
    await google(engine, f, rewalk);
    // A database-only timeline row (as extract --stale records one) is carried forward into the connector
    // render (#5567): the first re-walk may materialize it into the page once; it survives, and later re-walks skip.
    const summaries = () => engine.executeRaw<{ summary: string }>('SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2', [f.id, slug]);
    expect(await admitted(() => engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () =>
      tx.addTimelineEntry(slug, { date: '2026-01-02', summary: 'Met to review the example plan', source: 'meetings/2026-01-02' }, { sourceId: f.id }))))).toBeLessThanOrEqual(1);
    expect(await admitted(async () => {})).toBe(0);
    expect(await summaries()).toEqual([{ summary: 'Met to review the example plan' }]);
    expect(await admitted(() => engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [f.id, slug]))).toBe(1);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    expect(await admitted(async () => {})).toBe(0);
    // Below the safe-chunk fence: asked of the kernel directly, since the owner's projection worker may re-seal it before a re-walk.
    await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: f.id, includeDeleted: true });
    const file = { root: f.dir, path: join(f.dir, `${slug}.md`), content: existsSync(join(f.dir, `${slug}.md`)) ? readFileSync(join(f.dir, `${slug}.md`), 'utf8') : '' };
    const prepared = { noop: true, observedRevision: snapshot!.revision, apply: async () => ({}), file };
    expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: `${slug}.md`, databaseOnly: false })).toMatchObject({ admitReason: 'projection_work', projectionWorkRequired: true });
    await engine.executeRaw('UPDATE pages SET chunker_version=4 WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    expect((await inspectUnchanged(engine, { prepared, snapshot, sourcePath: `${slug}.md`, databaseOnly: false })).admitReason).toBeUndefined();
    // A publication that would queue embedding is not skipped while chunks lack vectors.
    expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: `${slug}.md`, databaseOnly: false, embeddingRequested: true })).toMatchObject({ admitReason: 'projection_work' });
    // An embedded page without a contextual mode awaits the contextual-mode repair: never skipped.
    const vector = `[${Array(1536).fill(0.01).join(',')}]`;
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::text::vector WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$3)', [f.id, vector, slug]);
    await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: `${slug}.md`, databaseOnly: false })).toMatchObject({ admitReason: 'projection_work' });
    await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [f.id, slug]);
    // The provider tombstones the contact, then lists it again: resurrecting a deleted page is always admitted.
    tombstone = true;
    await disposePersistenceConsumer(engine);
    await google(engine, f, rewalk);
    expect(await engine.getPage(slug, { sourceId: f.id })).toBeNull();
    tombstone = false;
    expect(await admitted(async () => {})).toBe(1);
    expect(await engine.getPage(slug, { sourceId: f.id })).not.toBeNull();
    org = 'Renamed Example Org';
    expect(await admitted(async () => {})).toBe(1);
  }
}), 240_000);

test('connector state row: a lost lease writes nothing; a new source incarnation starts empty', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    const { beginConnectorSync } = await import('../src/core/persistence/connector-sync.ts');
    const lost = { handle: { id: `gbrain-sync:${f.id}`, acquisitionToken: randomUUID(), acquiredAt: '1' }, signal: new AbortController().signal };
    await expect(beginConnectorSync(engine, f.id, 'google', cfg, options, lost as never)).rejects.toMatchObject({ name: 'LockStolenError' });
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector-state' AND completed_keys->0->'last_run' IS NOT NULL AND completed_keys::text LIKE '%' || $1 || '%'", [f.id])).toHaveLength(0);
    expect((await readManagedConnectorState(engine, f.id, await incarnation(engine, f.id))).account).toBeNull();
    const { fetcher } = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    const first = await incarnation(engine, f.id);
    expect((await readManagedConnectorState(engine, f.id, first)).account).not.toBeNull();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.id]);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [f.id, f.dir, JSON.stringify(googleConfig)]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const second = await incarnation(engine, f.id);
    expect(second).not.toBe(first);
    const fresh = await readManagedConnectorState(engine, f.id, second);
    expect(fresh).toMatchObject({ account: null, pending: [], upgrade_recovery: 'none', last_run: null });
  }
}), 180_000);

test('pending set: a checkpoint still pending at the end of a run is recorded and resolved first next run; a delta run keeps an unreached failure that only a full sweep drops', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    let token = 0;
    const { fetcher } = people(() => [contact('first', 'First Example')], { token: () => `contacts-${++token}` });
    await google(engine, f, fetcher);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    await disposePersistenceConsumer(engine);
    expect(await google(engine, f, fetcher)).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    const [checkpoint] = await connectorPendingSet(engine, f.id);
    expect(checkpoint).toMatchObject({ itemRef: '__managed_connector_checkpoint__' });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    expect((await google(engine, f, fetcher)).status).not.toBe('partial');
    expect(await connectorPendingSet(engine, f.id)).toEqual([]);
  }
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const run = (fetch: ReturnType<typeof githubFetch>, extra: object = {}) => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), { ...options, ...extra }, fetch);
    expect(await run(githubFetch())).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    const [entry] = await connectorPendingSet(engine, f.id);
    const [accepted] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [entry.requestId]);
    await disposePersistenceConsumer(engine);
    const path = join(f.dir, 'gh/acme-example/app/1.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '---\ntitle: Operator file\n---\nAn unindexed operator file occupies the path.\n');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    expect((await waitForWrite(engine, accepted, { engine: engine.kind }, 20_000)).state).toBe('conflict');
    rmSync(path);
    await disposePersistenceConsumer(engine);
    // The provider no longer lists the item: a delta run cannot tell deletion from absence, so it keeps the entry.
    expect((await run(githubFetch({ deleted: true }))).status).not.toBe('partial');
    expect((await connectorPendingSet(engine, f.id)).map(pending => pending.requestId)).toEqual([accepted.request_id]);
    await disposePersistenceConsumer(engine);
    await run(githubFetch({ deleted: true }), { full: true });
    expect(await connectorPendingSet(engine, f.id)).toEqual([]);
    expect((await readConnectorSourceStatuses(engine)).get(f.id)!.last_run).toMatchObject({ dropped_upstream: 1 });
  }
}), 240_000);
