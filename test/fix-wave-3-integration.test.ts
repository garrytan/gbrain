/**
 * Fix wave 3 integrated scenario gate: the twelve cross-lane checks from the
 * wave plan, on PGLite here and on Postgres through
 * test/e2e/fix-wave-3-integration.test.ts. Checks 1-8 are the S1 gate.
 *
 * Authoring gate. (1) Protects the seams between the four lanes: connector
 * identity, no-op skip and pending batches (Lane A); coordinated maintenance
 * writers and the #5254 unbound policy (Lane B); embedding and projection
 * repairs (Lane C); and the recovery layer, writer-version stamps and admin
 * lock (Lane D). (2) Fails when one lane's contract breaks another's: a
 * connector re-render that deletes history a user added, a page write that
 * claims a connector's database-only source, a repair kind missing from the
 * remediation plan, a reconcile that leaves the unbound marker behind, a
 * publication stamped after its recheck failed. (3) Each lane's own suite
 * covers its path alone (test/connector-wave3.test.ts,
 * test/managed-writers-w3.test.ts, test/repair-contextual-mode-5621.serial.test.ts,
 * test/recovery-layer.test.ts and siblings); none runs two lanes' code on one
 * brain. (4) No production seam: every step goes through the real mutation,
 * connector, repair, doctor and reconcile entry points.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation, submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite, writeResponse } from '../src/core/persistence/service.ts';
import { admitWrite, compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { setWriterAdminLock } from '../src/core/persistence/admin-lock.ts';
import { writerStamp } from '../src/core/persistence/writer-versions.ts';
import { connectorCheckpointKey, connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { CONNECTOR_MIGRATION_OP } from '../src/core/persistence/connector-checkpoint-migration.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { planRepairSteps } from '../src/core/remediation/repairs.ts';
import { runWaveChecks, remoteWaveHandoff, WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { writerVersionCheck } from '../src/commands/doctor/checks/writer-version.ts';
import { checkUnboundSource } from '../src/commands/doctor/checks/unbound-source.ts';
import { runRemediate } from '../src/commands/doctor/remediate.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { timeContainedPhase } from '../src/core/cycle/phase-containment.ts';
import { LockStolenError } from '../src/core/db-lock.ts';
import { chat, configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { ALL_SOURCES } from '../src/core/source-id.ts';
import { withEnv } from './helpers/with-env.ts';
import { capture } from './helpers/wave-scenarios.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, issueFixture, githubFetch, contact, withGoogleAccount } from './helpers/connector-fixture.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';

const fixture = createConnectorFixture();
const { engines, env, source, boundSource, home } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const quiet = { info() {}, warn() {}, error() {} };
const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, config: { engine: engine.kind, embedding_disabled: true },
  sourceId, remote: false, dryRun: false, logger: quiet }) as unknown as OperationContext;
const mark = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ seq: string | null }>('SELECT max(sequence)::text AS seq FROM persistence_requests WHERE source_id=$1', [id]))[0]?.seq ?? '0';
async function admissions(engine: BrainEngine, id: string, after: string) {
  const rows = await engine.executeRaw<{ kind: string | null }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint", [id, after]);
  return { pages: rows.filter(r => /_(import|delete)$/.test(r.kind ?? '')).length, checkpoints: rows.filter(r => (r.kind ?? '').endsWith('_checkpoint')).length };
}
const incarnation = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]))[0]!.incarnation;
const protocol = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });

/** A People listing with a stable sync token; `org` changes the rendered page, `fail` models a provider outage. */
function people(list: () => Array<Record<string, unknown>>, opts: { fail?: () => boolean; onList?: () => Promise<void> } = {}) {
  return async (url: string) => {
    if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
    if (opts.fail?.()) return json({ error: { message: 'fixture people outage' } }, 503);
    await opts.onList?.();
    return json({ connections: new URL(url).searchParams.has('syncToken') ? [] : list(), nextSyncToken: 'contacts-stable' });
  };
}
const google = (engine: BrainEngine, f: { id: string; dir: string }, fetcher: (url: string) => Promise<Response>, extra: object = {}, config: Record<string, unknown> = googleConfig) =>
  runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), { ...options, ...extra }, withGoogleAccount(fetcher));
/** One connector run on a paused consumer, then the admissions it made. */
async function quietRun(engine: BrainEngine, f: { id: string; dir: string }, fetcher: (url: string) => Promise<Response>, extra: object = {},
  config: Record<string, unknown> = googleConfig) {
  await disposePersistenceConsumer(engine);
  const before = await mark(engine, f.id);
  await google(engine, f, fetcher, extra, config);
  return admissions(engine, f.id, before);
}
const addTimeline = (engine: BrainEngine, sourceId: string, slug: string, summary: string, date = '2026-03-01') => submitPageMutation(ctxFor(engine, sourceId),
  { operation: 'add_timeline_entry', params: { request_id: randomUUID(), slug, date, summary, source: 'operator' } });
const timeline = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.getTimeline(slug, { sourceId })).map(row => row.summary);
const VECTOR = `[${Array(1536).fill(0.01).join(',')}]`;

test('check 1 (S1): a cycle stamp mid-sweep while connector pages are pending; they publish and carry this release\'s writer stamps', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, googleConfig);
    // Hold publication: the owner's worktree drains, so accepted writes stay pending.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const stamp = async () => { const now = new Date().toISOString(); await engine.updateSourceConfig(f.id, { last_source_cycle_at: now, last_full_cycle_at: now }); };
    const fetcher = people(() => [contact('first', 'First Example'), contact('second', 'Second Example')], { onList: stamp });
    try { await google(engine, f, fetcher); } catch { /* the sweep stops on its wait budget with writes pending */ }
    const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' LIKE '%import' AND state='queued'", [f.id]);
    expect(pending.length).toBe(2);
    await stamp();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    const { version } = writerStamp();
    for (const row of pending) {
      const done = await waitForWrite(engine, row, { engine: engine.kind }, 20_000);
      expect(done.state).toBe('committed');
      // Lane D stamps both sides of a Lane A connector publication; the publication time is the database clock.
      expect(done).toMatchObject({ admitter_version: version, consumer_version: version });
      expect((done as WriteRequest & { published_at: unknown }).published_at).not.toBeNull();
    }
    expect(readFileSync(join(f.dir, 'people/first-example.md'), 'utf8')).toContain('First Example');
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

test('check 2 (S1): the no-op skip holds across a user timeline entry, a withdrawn fact, the contextual-mode repair and a safe-chunk reseal; the connector re-render keeps the history', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [true, false]) {
    const f = bound ? await boundSource(engine, googleConfig) : await source(engine, googleConfig);
    let org = 'Example Org';
    const fetcher = people(() => [{ ...contact('first', 'First Example'), organizations: [{ name: org }] }]);
    const slug = 'people/first-example';
    await google(engine, f, fetcher);
    // A user adds history to a connector page. On a database-only connector source the write stays
    // database-only (it never claims the connector's source); on a bound one it lands in the file.
    expect((await addTimeline(engine, f.id, slug, 'Operator note')).state).toBe('committed');
    // An earlier entry is spliced above the marked one without separating that bullet from its marker.
    expect((await addTimeline(engine, f.id, slug, 'Earlier note', '2026-02-01')).state).toBe('committed');
    expect(await engine.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1', [f.id])).toHaveLength(bound ? 1 : 0);
    // A withdrawn fact and a live fact on the same page.
    const ctx = ctxFor(engine, f.id);
    const live = await submitRememberMutation(ctx, { fact: 'Example live detail', entity: slug, provenance: 'integration', visibility: 'world' }) as { id: number };
    const remembered = await submitRememberMutation(ctx, { fact: 'Example retired detail', entity: slug, provenance: 'integration', visibility: 'world' }) as { id: number };
    await submitForgetMutation(ctx, 'forget', { id: remembered.id });
    // An upstream change re-renders the page from the provider: the user's entry survives (#5567).
    org = 'Renamed Example Org';
    expect((await quietRun(engine, f, fetcher, { resetCheckpoint: true })).pages).toBe(1);
    expect((await timeline(engine, f.id, slug)).sort()).toEqual(['Earlier note', 'Operator note']);
    const page = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(page.page.compiled_truth).toContain('Renamed Example Org');
    expect(page.page.timeline).toContain('Operator note');
    expect(page.page.timeline).toContain('Earlier note');
    if (bound) expect(readFileSync(join(f.dir, `${slug}.md`), 'utf8')).toContain('Earlier note');
    const facts = async () => Object.fromEntries((await engine.executeRaw<{ id: number; expired: boolean }>('SELECT id,expired_at IS NOT NULL AS expired FROM facts WHERE id=ANY($1::int[])',
      [[remembered.id, live.id]])).map(row => [Number(row.id), row.expired]));
    // The re-render keeps the page's facts fence: the withdrawn fact stays withdrawn, the live one stays live.
    expect(await facts()).toEqual({ [remembered.id]: true, [live.id]: false });
    expect(page.page.compiled_truth).toContain('Example live detail');
    // The carried-forward entry and the withdrawal do not defeat the skip.
    expect(await quietRun(engine, f, fetcher, { resetCheckpoint: true })).toEqual({ pages: 0, checkpoints: expect.any(Number) });
    // Lane C's contextual-mode repair stamps an embedded page with no mode; the next re-walk still skips.
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::text::vector WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$3)', [f.id, VECTOR, slug]);
    await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    const runner = await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet });
    const scope = await resolveRepairScope(engine, f.id);
    expect((await runner.run('contextual-mode', scope)).applied).toBe(1);
    expect((await engine.executeRaw<{ mode: string | null }>('SELECT contextual_retrieval_mode AS mode FROM pages WHERE source_id=$1 AND slug=$2', [f.id, slug]))[0]!.mode).not.toBeNull();
    expect((await quietRun(engine, f, fetcher, { resetCheckpoint: true })).pages).toBe(0);
    // A page below the safe-chunk fence is re-sealed by the repair, and the re-walk skips afterwards.
    await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [f.id, slug]);
    await engine.executeRaw('UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug=$2', [f.id, slug]);
    expect((await runner.run('safe-chunks', scope)).applied).toBe(1);
    expect((await quietRun(engine, f, fetcher, { resetCheckpoint: true })).pages).toBe(0);
    expect((await timeline(engine, f.id, slug)).sort()).toEqual(['Earlier note', 'Operator note']);
    expect(await facts()).toEqual({ [remembered.id]: true, [live.id]: false });
    await disposePersistenceConsumer(engine);
  }
}), 300_000);

test('check 2b (S1): a provider render that brings its own facts fence owns it: upstream corrections replace the stored rows', async () => withEnv(env, async () => {
  const fence = (claim: string) => `## Facts\n\n${renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }])}`;
  for (const engine of engines) {
    const f = await source(engine, githubConfig);
    let body = `A useful synthetic issue body.\n\n${fence('Provider claim alpha')}`;
    let updated = issueFixture.updated_at;
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/issues')) return json([{ ...issueFixture, body, updated_at: updated }]);
      if (path.endsWith('/issues/1')) return json({ ...issueFixture, body, updated_at: updated });
      return githubFetch()(url);
    };
    const run = (extra: object = {}) => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), { ...options, ...extra }, fetcher);
    await run();
    const [page] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND compiled_truth LIKE '%Provider claim alpha%'", [f.id]);
    expect(page).toBeDefined();
    body = `A useful synthetic issue body.\n\n${fence('Provider claim beta')}`;
    updated = '2026-02-01T00:00:00Z';
    await disposePersistenceConsumer(engine);
    await run({ resetCheckpoint: true });
    const current = (await engine.readPageSnapshot(page!.slug, { sourceId: f.id }))!;
    expect(current.page.compiled_truth).toContain('Provider claim beta');
    expect(current.page.compiled_truth).not.toContain('Provider claim alpha');
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

test('check 3 (S1): a quiet run over a page with a user timeline entry still stamps freshness, so gbrain waiting stays fresh; a provider outage neither stamps nor loses the entry', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    let down = false;
    const fetcher = people(() => [contact('first', 'First Example')], { fail: () => down });
    await google(engine, f, fetcher);
    expect((await addTimeline(engine, f.id, 'people/first-example', 'Operator note')).state).toBe('committed');
    // The first re-walk after a user entry may render the carried bullet into the page once.
    expect((await quietRun(engine, f, fetcher, { resetCheckpoint: true })).pages).toBeLessThanOrEqual(1);
    const seen = async () => (await engine.executeRaw<{ at: string }>('SELECT last_sync_at::text AS at FROM sources WHERE id=$1', [f.id]))[0]!.at;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE sources SET last_sync_at=now()-interval '2 days' WHERE id=$1", [f.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const stale = await seen();
    expect(await quietRun(engine, f, fetcher)).toEqual({ pages: 0, checkpoints: 0 });
    const fresh = await seen();
    expect(new Date(fresh).getTime()).toBeGreaterThan(new Date(stale).getTime());
    const waiting = await handleToolCall(engine, 'open_loops', { group_by: 'counterparty', limit: 3 }, { sourceId: ALL_SOURCES }) as { sources?: Array<{ id: string; stale: boolean }> };
    expect(waiting.sources?.find(row => row.id === f.id)?.stale ?? false).toBe(false);
    down = true;
    await disposePersistenceConsumer(engine);
    expect((await google(engine, f, fetcher)).status).toBe('partial');
    expect(await seen()).toBe(fresh);
    expect(await timeline(engine, f.id, 'people/first-example')).toEqual(['Operator note']);
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

test('check 4 (S1): a checkpoint orphaned by a content change is listed by the remediation plan and cleared by the agreed run; the live checkpoint, compacted receipts and a new incarnation keep working', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const fetcher = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    const oldKey = connectorCheckpointKey(f.id, await incarnation(engine, f.id), connectorIdentity('google', googleConfig, f.dir));
    const widened = { ...googleConfig, g_history_days: 365 };
    expect(await engine.updateSourceConfig(f.id, { g_history_days: 365 })).toBe(true);
    await disposePersistenceConsumer(engine);
    await google(engine, f, fetcher, {}, widened);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='managed-connector' AND fingerprint=$1", [oldKey]);
    // Receipt compaction does not hide the live checkpoint from the migration's loader or the cleanup.
    await protocol(engine, "UPDATE persistence_requests SET completed_at=now()-interval '60 days' WHERE source_id=$1 AND state='committed'", [f.id]);
    await compactWriteReceipts(engine, 30);
    // Lane A's orphan is a Lane D wave finding with a registered repair.
    const findings = Object.fromEntries((await runWaveChecks(engine)).map(finding => [finding.spec.id, finding]));
    expect(findings.connector_checkpoints!.state).toBe('finding');
    const steps = await planRepairSteps(engine, { noEmbed: true });
    const step = steps.find(s => s.kind === 'connector-checkpoints');
    expect(step).toMatchObject({ command: 'gbrain repair connector-checkpoints --apply', paid: false, embeds: 'none', lifetime_ids: 0, checks: ['connector_checkpoints'] });
    const run = await capture(() => runRemediate(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json']));
    const body = JSON.parse(run.out);
    expect(body.repairs.find((r: { kind: string }) => r.kind === 'connector-checkpoints')).toMatchObject({ status: 'completed' });
    expect(body.findings.find((r: { check_id: string }) => r.check_id === 'connector_checkpoints')).toMatchObject({ class: 'cleared' });
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [oldKey])).toHaveLength(0);
    const liveKey = connectorCheckpointKey(f.id, await incarnation(engine, f.id), connectorIdentity('google', widened, f.dir));
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [liveKey])).toHaveLength(1);
    expect((await quietRun(engine, f, fetcher, {}, widened)).pages).toBe(0);
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test('check 5 (S1): an account-change refusal and the connector findings never reach remote doctor lines', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const fetcher = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    await disposePersistenceConsumer(engine);
    const refused = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, withGoogleAccount(fetcher, 'someone-else@example.invalid'))
      .catch(error => error) as { code?: string; suggestion?: string };
    expect(refused.code).toBe('connector_account_changed');
    expect(refused.suggestion).toContain('someone-else@example.invalid');
    // A content change leaves an aged orphan: a real connector finding the remote caller sees only as a host-action line.
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='managed-connector'");
    expect(await engine.updateSourceConfig(f.id, { g_history_days: 400 })).toBe(true);
    const lines = await remoteWaveHandoff(engine, [f.id]);
    const text = JSON.stringify(lines);
    for (const secret of [googleConfig.g_account, 'someone-else@example.invalid', f.dir, home, 'op_checkpoints', 'managed-connector']) expect(text).not.toContain(secret);
    expect(lines.find(line => line.name === 'connector_checkpoints')).toMatchObject({ status: 'warn', details: { host_action: { state: 'action_required' } } });
    expect(new Set(lines.map(line => line.name))).toEqual(new Set(WAVE_CHECKS.filter(spec => !spec.hostOnly).map(spec => spec.id)));
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

test('check 6 (S1): a retired connector intent fails with its delivered hint and no consumer stamp; the writer-version advisory counts only published requests', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    await google(engine, f, people(() => [contact('first', 'First Example')]));
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' LIMIT 1", [f.id]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint='v2-cutoff'", [CONNECTOR_MIGRATION_OP]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,'v2-cutoff',jsonb_build_array(jsonb_build_object('cutoff',(now()-interval '1 hour')::text)))", [CONNECTOR_MIGRATION_OP]);
    const intent = { ...template!.intent, kind: 'managed_connector_import', checkpointKey: 'legacy-raw-config-key' };
    const row = await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId: f.id, sourceIncarnation: template!.source_incarnation,
      slug: template!.slug, pageId: template!.page_id, worktreeId: template!.worktree_id ?? undefined, principal: { kind: template!.principal_kind, id: template!.principal_id },
      authority: template!.authority, callerIntent: intent, intent } as never);
    // An older connector binary admitted it: no admitter stamp.
    await protocol(engine, 'UPDATE persistence_requests SET admitter_version=NULL,admitter_host_id=NULL WHERE id=$1::uuid', [row.id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    const done = await waitForWrite(engine, row, { engine: engine.kind }, 20_000);
    expect(done).toMatchObject({ state: 'failed', error_code: 'connector_intent_outdated', consumer_version: null, published_at: null });
    const delivered = (() => { try { writeResponse(done); } catch (error) { return error as { suggestion?: string; docs?: string }; } return {}; })();
    expect(delivered.suggestion).toContain('Upgrade gbrain on the host that runs connector jobs');
    expect(delivered.docs).toBe('docs/guides/write-refusals.md#connector-intent-outdated');
    // The failed legacy request is never counted as an old writer; an unstamped published one is.
    await disposePersistenceConsumer(engine);
    // Only this source's requests fall inside the advisory's seven-day window.
    await protocol(engine, "UPDATE persistence_requests SET published_at=now()-interval '30 days',completed_at=now()-interval '30 days' WHERE source_id<>$1 AND state='committed'", [f.id]);
    await protocol(engine, "UPDATE persistence_requests SET consumer_version=$2,published_at=now() WHERE source_id=$1 AND state='committed'", [f.id, writerStamp().version]);
    const clean = await writerVersionCheck(engine);
    expect(clean.status).toBe('ok');
    await protocol(engine, "UPDATE persistence_requests SET consumer_version=NULL WHERE id=$1::uuid", [template!.id]);
    const warned = await writerVersionCheck(engine);
    expect(warned.status).toBe('warn');
    expect(warned.message).toContain('gbrain upgrade');
  }
}), 180_000);

test('check 7 (S1): concept publication through the maintenance helper keeps private-first, provenance and promotion while other writes are pending, and leaves no derived-visibility finding', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, { kind: 'filesystem' });
    const ctx = ctxFor(engine, f.id);
    for (const n of [1, 2]) await submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug: `atoms/idea-${n}`,
      content: `---\ntitle: Idea ${n}\ntype: atom\nvisibility: world\nconcepts: [network-effects]\n---\nAtom ${n} about network effects.` } });
    // Another writer's request is admitted and still pending when synthesis starts.
    await disposePersistenceConsumer(engine);
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND slug='atoms/idea-1' AND state='committed' LIMIT 1", [f.id]);
    const pendingIntent = { ...template!.intent, slug: 'notes/pending-example', content: '---\ntitle: Pending\ntype: note\n---\nA pending write.\n' };
    const pending = await admitWrite(engine, { requestId: randomUUID(), operation: 'put_page', sourceId: f.id, sourceIncarnation: template!.source_incarnation,
      slug: 'notes/pending-example', pageId: null, worktreeId: template!.worktree_id ?? undefined, topologyGeneration: template!.topology_generation, principal: { kind: template!.principal_kind, id: template!.principal_id },
      authority: template!.authority, callerIntent: pendingIntent, intent: pendingIntent } as never);
    const result = await runPhaseSynthesizeConcepts(engine, { sourceId: f.id, brainDir: f.dir, _chat: async () => { throw new Error('a T3 concept must not call the model'); } });
    expect(result.status).toBe('ok');
    const concept = await engine.executeRaw<{ content: string; consumer_version: string | null }>(
      "SELECT intent->>'content' AS content,consumer_version FROM persistence_requests WHERE source_id=$1 AND slug='concepts/network-effects' AND state='committed' ORDER BY sequence", [f.id]);
    expect(concept.map(r => /visibility: (\w+)/.exec(r.content)?.[1])).toEqual(['private', 'world']);
    for (const r of concept) expect(r.consumer_version).toBe(writerStamp().version);
    expect((await engine.getLinks('concepts/network-effects', { sourceId: f.id })).filter(l => l.link_source === 'concept-provenance').map(l => l.to_slug).sort())
      .toEqual(['atoms/idea-1', 'atoms/idea-2']);
    expect((await waitForWrite(engine, pending, { engine: engine.kind }, 20_000)).state).toBe('committed');
    const visibility = (await runWaveChecks(engine)).find(finding => finding.spec.id === 'derived_visibility')!;
    expect(Number(visibility.check.details?.looser_concepts ?? 0)).toBe(0);
    await disposePersistenceConsumer(engine);
  }
}), 180_000);

test('check 8 (S1, Postgres): an unbound write, binding between admission and publication, sync after binding and the reconcile that resolves the collision', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, { kind: 'filesystem' });
    const ctx = ctxFor(engine, f.id);
    const note = (slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug,
      content: `---\ntitle: Example\ntype: note\n---\n\n${body}\n` } });
    if (engine.kind === 'pglite') {
      // PGLite keeps its automatic first-write claim; a locked admin lock does not block it.
      await setWriterAdminLock(engine, true);
      expect((await note('notes/automatic', 'Claimed by its first write.')).state).toBe('committed');
      await setWriterAdminLock(engine, false);
      expect(existsSync(join(f.dir, 'notes/automatic.md'))).toBe(true);
      continue;
    }
    await expect(note('notes/refused', 'Refused by default.')).rejects.toMatchObject({ code: 'owner_unavailable', detail: 'unbound_source' });
    await engine.setConfig('persistence.unbound_write', 'database_only');
    expect((await note('notes/kept', 'Written while unbound.')).state).toBe('committed');
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND slug='notes/kept' AND state='committed'", [f.id]);
    expect(template!.authority.databaseOnlyReason).toBe('unbound_source');
    expect((await checkUnboundSource(engine)).status).toBe('ok');
    // Admitted while unbound, published after binding: the recheck refuses and the consumer never stamps it.
    await disposePersistenceConsumer(engine);
    const intent = { ...template!.intent, slug: 'notes/raced', content: '---\ntitle: Raced\ntype: note\n---\n\nAdmitted while unbound.\n' };
    const raced = await admitWrite(engine, { requestId: randomUUID(), operation: 'put_page', sourceId: f.id, sourceIncarnation: template!.source_incarnation,
      slug: 'notes/raced', pageId: null, principal: { kind: template!.principal_kind, id: template!.principal_id },
      authority: template!.authority, callerIntent: intent, intent } as never);
    // The operator's admin lock blocks binding; unlocking lets the claim through.
    await setWriterAdminLock(engine, true);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await expect(claimWorktree(engine, f.id, f.dir)).rejects.toMatchObject({ code: 'writer_admin_locked' });
    await setWriterAdminLock(engine, false);
    await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    startPersistenceConsumer(engine, { engine: engine.kind });
    const failed = await waitForWrite(engine, raced, { engine: engine.kind }, 20_000);
    expect(failed).toMatchObject({ state: 'failed', error_code: 'owner_unavailable', consumer_version: null, published_at: null });
    const delivered = (() => { try { writeResponse(failed); } catch (error) { return error as { detail?: string; suggestion?: string }; } return {}; })();
    expect(delivered.detail).toBe('unbound_source');
    expect(delivered.suggestion).toContain('new request_id');
    // After binding, the kept page sits outside canonical files: doctor warns and names reconcile.
    const bound = await checkUnboundSource(engine);
    expect(bound.status).toBe('warn');
    expect(bound.message).toContain('gbrain sources reconcile <source> <slug>');
    // A canonical file appears at its slug path; Lane D's reconcile accepts the marked page and resolves it.
    mkdirSync(join(f.dir, 'notes'), { recursive: true });
    writeFileSync(join(f.dir, 'notes/kept.md'), '---\ntitle: Example\ntype: note\nfile_field: kept\n---\n\nWritten into the checkout.\n');
    const registration = await registerLocalWriter(engine, 'cli');
    await withVerifiedLocalRegistration(engine, registration, async () => {
      const preview = await runReconcilePreview(engine, { source_id: f.id, slug: 'notes/kept' });
      const resolved = await runReconcilePreview(engine, { source_id: f.id, slug: 'notes/kept', from: preview.preview,
        decisions: ((preview.conflict_paths ?? []) as string[]).map(path => ({ path, action: 'take_database' })) });
      expect((await runReconcileApply(engine, { source_id: f.id, slug: 'notes/kept', preview: resolved.preview, request_id: randomUUID() })).state).toBe('committed');
    });
    expect((await engine.executeRaw<{ reason: string | null; path: string | null }>('SELECT database_only_reason AS reason,source_path AS path FROM pages WHERE source_id=$1 AND slug=$2',
      [f.id, 'notes/kept']))[0]).toEqual({ reason: null, path: 'notes/kept.md' });
    expect((await checkUnboundSource(engine)).status).toBe('ok');
    expect(readFileSync(join(f.dir, 'notes/kept.md'), 'utf8')).toContain('Written while unbound.');
    await engine.setConfig('persistence.unbound_write', 'refuse');
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

test('check 9: every registered repair kind reaches the remediation plan with its cost class; --max-usd 0 still runs the free kinds', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const fetcher = people(() => [contact('first', 'First Example')]);
    await google(engine, f, fetcher);
    await disposePersistenceConsumer(engine);
    // Pending work for Lane C (mode) and Lane A (orphan checkpoint).
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::text::vector WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$3)', [f.id, VECTOR, 'people/first-example']);
    await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id=$1', [f.id]);
    // A second page is both below the safe-chunk fence and unsealed: contextual-mode can stamp it only after safe-chunks re-seals it.
    await google(engine, f, people(() => [contact('first', 'First Example'), contact('second', 'Second Example')]), { resetCheckpoint: true });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode=NULL,chunker_version=1,text_projection_revision=gen_random_uuid() WHERE source_id=$1 AND slug='people/second-example'", [f.id]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('managed-connector',$1,'[]'::jsonb,now()-interval '9 days')", [`orphan-${randomUUID()}`]);
    const kinds = REPAIR_REGISTRY.map(spec => spec.kind);
    expect(kinds).toEqual(['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'connector-checkpoints', 'request-indexes', 'connector-fences', 'orphan-bindings', 'embedding-effects']);
    const planned = Object.fromEntries((await planRepairSteps(engine, { noEmbed: true })).map(step => [step.kind, step]));
    expect(planned['contextual-mode']).toMatchObject({ paid: false, embeds: 'inline', command: 'gbrain repair contextual-mode --no-embed --apply' });
    expect(planned['connector-checkpoints']).toMatchObject({ paid: false, embeds: 'none' });
    expect(planned['safe-chunks']).toBeDefined();
    expect(planned['contextual-mode'].rationale).toContain('after safe-chunks re-seals them');
    const run = JSON.parse((await capture(() => runRemediate(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json']))).out);
    const byKind = Object.fromEntries(run.repairs.map((r: { kind: string }) => [r.kind, r]));
    expect(byKind['contextual-mode']).toMatchObject({ status: 'completed' });
    expect(byKind['connector-checkpoints']).toMatchObject({ status: 'completed' });
    const modes = await engine.executeRaw<{ slug: string; mode: string | null }>('SELECT slug,contextual_retrieval_mode AS mode FROM pages WHERE source_id=$1 ORDER BY slug', [f.id]);
    for (const row of modes) expect(row.mode).not.toBeNull();
    const replanned = (await planRepairSteps(engine, { noEmbed: true })).map(step => step.kind);
    expect(replanned).not.toContain('contextual-mode');
    expect(replanned).not.toContain('connector-checkpoints');
    await disposePersistenceConsumer(engine);
  }
}), 240_000);

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

test('check 10: connector writes on a bound, hardened source commit through coalesced Git effects; a failed push is retried and loses nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const remote = `${f.dir}.git`, pushLog = `${f.dir}.pushes`, reject = `${f.dir}.reject`;
    git(f.dir, 'init', '-q', '-b', 'main');
    git(f.dir, 'config', 'user.name', 'Example Writer'); git(f.dir, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(f.dir, 'README.md'), 'connector\n'); git(f.dir, 'add', 'README.md'); git(f.dir, 'commit', '-q', '-m', 'Initial');
    mkdirSync(remote); git(remote, 'init', '-q', '--bare');
    git(f.dir, 'remote', 'add', 'origin', remote); git(f.dir, 'push', '-q', '-u', 'origin', 'main');
    writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho push >> '${pushLog}'\n[ -f '${reject}' ] && exit 1\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(f.dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n', { mode: 0o755 });
    const pushes = () => existsSync(pushLog) ? readFileSync(pushLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const commits = () => Number(git(f.dir, 'rev-list', '--count', 'HEAD').trim());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const pass = () => runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
    const release = () => protocol(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
    let org = 'Example Org';
    const names = () => Array.from({ length: 12 }, (_, i) => ({ ...contact(`member-${i}`, `Member Example ${i}`), organizations: [{ name: i === 0 ? org : 'Example Org' }] }));
    const [beforeCommits, beforePushes] = [commits(), pushes()];
    await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
    try {
      await google(engine, f, people(names));
      await disposePersistenceConsumer(engine);
      await release();
      await pass();
      // Twelve connector pages, one coalesced commit and one push (#5530 x Lane A).
      expect(commits() - beforeCommits).toBe(1);
      expect(pushes() - beforePushes).toBe(1);
      for (let i = 0; i < 12; i++) expect(git(f.dir, 'show', `HEAD:people/member-example-${i}.md`)).toContain(`Member Example ${i}`);
      // A rejected push leaves the next change committed and retryable.
      writeFileSync(reject, '');
      org = 'Renamed Example Org';
      expect((await quietRun(engine, f, people(names), { resetCheckpoint: true })).pages).toBe(1);
      await disposePersistenceConsumer(engine);
      await release();
      await pass();
      expect(git(f.dir, 'show', 'HEAD:people/member-example-0.md')).toContain('Renamed Example Org');
      rmSync(reject, { force: true });
      await release();
      await pass();
      expect(git(remote, 'show', 'main:people/member-example-0.md')).toContain('Renamed Example Org');
      expect((await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.source_id=$1 AND e.kind='git' AND e.state<>'committed'", [f.id]))[0]!.n).toBe(0);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
    }
  }
}), 180_000);

test('check 11: a contained paid phase failure is an operator finding for the remediation run, the banner and remote doctor; a lost lease is never contained', async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: 'ok', blocks: [], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'stub:stub', providerId: 'stub' }));
  try {
    for (const engine of engines) {
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.breaker.%'");
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
      for (let i = 0; i < 3; i++) {
        const { result } = await timeContainedPhase({ engine, sourceId: 'default' }, 'synthesize_concepts', async () => {
          await chat({ messages: [{ role: 'user', content: 'x' }] });
          throw Object.assign(new Error('publication refused after synthesis'), { code: 'owner_unavailable' });
        });
        expect(result).toMatchObject({ status: 'fail', details: { contained: true, paid_loop_recorded: true } });
      }
      await expect(timeContainedPhase({ engine, sourceId: 'default' }, 'sync', async () => { throw new LockStolenError('cycle-lock'); }))
        .rejects.toBeInstanceOf(LockStolenError);
      const run = JSON.parse((await capture(() => runRemediate(engine, ['--remediate', '--yes', '--no-embed', '--max-usd', '0', '--json']))).out);
      const finding = run.findings.find((f: { check_id: string }) => f.check_id === 'dream_paid_loop');
      expect(finding).toMatchObject({ class: 'operator_required' });
      expect((await postUpgradeRecoveryBanner(engine, 'host')).join('\n')).toContain('dream_paid_loop: 1 (needs an operator action)');
      const remote = (await remoteWaveHandoff(engine)).find(line => line.name === 'dream_paid_loop')!;
      expect(remote).toMatchObject({ status: 'warn', details: { host_action: { state: 'action_required' } } });
      expect(remote.message).not.toContain('dream:phase:synthesize_concepts');
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.breaker.%'");
    }
  } finally { __setChatTransportForTests(null); resetGateway(); }
}, 180_000);

test('check 12: the admin lock never blocks ordinary publication or a connector page write; compaction keeps writer stamps', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    await google(engine, f, people(() => [contact('first', 'First Example')]));
    await setWriterAdminLock(engine, true);
    try {
      // A page write to an unbound connector source is database-only and never claims, locked or not.
      expect((await addTimeline(engine, f.id, 'people/first-example', 'Locked note')).state).toBe('committed');
      expect(await engine.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1', [f.id])).toHaveLength(0);
      const unchanged = people(() => [contact('first', 'First Example')]);
      expect((await quietRun(engine, f, unchanged, { resetCheckpoint: true })).pages).toBeLessThanOrEqual(1);
      expect((await quietRun(engine, f, unchanged, { resetCheckpoint: true })).pages).toBe(0);
      expect(await timeline(engine, f.id, 'people/first-example')).toEqual(['Locked note']);
    } finally { await setWriterAdminLock(engine, false); }
    // Admitted database-only while the connector source was unbound, published after an owner claimed it: refused.
    await disposePersistenceConsumer(engine);
    const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND operation='add_timeline_entry' AND state='committed' LIMIT 1", [f.id]);
    expect(template!.authority.databaseOnlyReason).toBe('connector_database');
    const intent = { ...template!.intent, summary: 'Raced note', date: '2026-04-01' };
    const raced = await admitWrite(engine, { requestId: randomUUID(), operation: 'add_timeline_entry', sourceId: f.id, sourceIncarnation: template!.source_incarnation,
      slug: template!.slug, pageId: template!.page_id, principal: { kind: template!.principal_kind, id: template!.principal_id },
      authority: template!.authority, callerIntent: intent, intent } as never);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    startPersistenceConsumer(engine, { engine: engine.kind });
    const refused = await waitForWrite(engine, raced, { engine: engine.kind }, 20_000);
    expect(refused).toMatchObject({ state: 'failed', error_code: 'owner_unavailable', consumer_version: null });
    const hint = (() => { try { writeResponse(refused); } catch (error) { return error as { suggestion?: string }; } return {}; })();
    expect(hint.suggestion).toContain('new request_id');
    expect(await timeline(engine, f.id, 'people/first-example')).not.toContain('Raced note');
    await disposePersistenceConsumer(engine);
    await protocol(engine, "UPDATE persistence_requests SET completed_at=now()-interval '60 days' WHERE source_id=$1 AND state='committed'", [f.id]);
    await compactWriteReceipts(engine, 30);
    const stamped = await engine.executeRaw<{ compacted: boolean; admitter_version: string | null; consumer_version: string | null }>(
      "SELECT compacted,admitter_version,consumer_version FROM persistence_requests WHERE source_id=$1 AND state='committed'", [f.id]);
    expect(stamped.some(row => row.compacted)).toBe(true);
    for (const row of stamped) expect(row).toMatchObject({ admitter_version: writerStamp().version, consumer_version: writerStamp().version });
  }
}), 180_000);
