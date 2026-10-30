/**
 * #7439: a page-triggered facts-absorb job refused `source_changed` while its target's canonical file was held
 * (`preparation_stalled`) stayed refused after an agreed `sources reconcile --apply` cleared the hold. The job's batch is
 * keyed by the page write it extracts from, so a retry found the stored terminal refusal and replayed it; only the
 * input-keyed sweep walked follow-up batches. A page-triggered batch now walks them too: once every refused page passes
 * the file check, its retained facts are admitted once under a follow-up batch, and the historical receipt is left as
 * it was. A file that still differs keeps the refusal.
 *
 * Contributed by @Masashi-Ono0611 (#7440).
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { ManagedBrain } from './helpers/managed-brain.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ORIGIN = 'notes/input', TARGET = 'companies/example', CLAIM = 'The example roadmap ships weekly.';

/** A page write's facts batch refused because the target's file is held `preparation_stalled` and differs from the page. */
async function refusedPageBatch({ engine, ctx, root }: ManagedBrain) {
  const requestId = randomUUID();
  for (const slug of [TARGET, ORIGIN]) {
    await submitPageMutation(ctx, { operation: 'put_page', params: {
      slug, content: `---\ntype: ${slug === TARGET ? 'company' : 'concept'}\ntitle: Example\n---\nAn example note for ${slug}.\n`,
      request_id: slug === ORIGIN ? requestId : randomUUID(),
    } });
  }
  const snapshot = (await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' }))!;
  const [write] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  const backstop: FactsBackstopCtx = { engine, sourceId: 'default', source: 'mcp:put_page', sessionId: null, persistenceRequestId: write!.id, operationContext: ctx };
  const input = { turnText: snapshot.page.compiled_truth, pageSlug: ORIGIN };
  const session = (await prepareManagedFactsSession(backstop, input))!;
  const path = `${TARGET}.md`, file = join(root, path), pristine = readFileSync(file, 'utf8');
  writeFileSync(file, pristine + '\nAn unimported edit.\n');
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: snapshot.sourceIncarnation,
    path, source_path: path, slug: TARGET, page_id: null, code: 'preparation_stalled', message: 'The write owner stalled.',
    upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION } }));
  const refused = await publishManagedFacts(engine, session, backstop, [{ fact: CLAIM, kind: 'fact', source: 'mcp:put_page',
    entity_slug: TARGET, confidence: 0.9, notability: 'high', embedding: null }], 'private', ORIGIN).catch(error => error);
  expect(refused.code).toBe('source_changed');
  const receipt = await engine.executeRaw<{ request_id: string; error_message: string }>(
    "SELECT request_id, error_message FROM persistence_requests WHERE operation='extract_facts' AND slug=$1", [TARGET]);
  expect(receipt).toHaveLength(1);
  expect(receipt[0]!.error_message).toContain('preparation_stalled');
  const retry = async () => resumeManagedFacts(engine, (await prepareManagedFactsSession(backstop, input))!);
  expect((await retry().catch(error => error)).code).toBe('source_changed');
  return { file, pristine, receipt, retry, write: write!.id };
}

/** The `gbrain repair failed-writes` preview rows for the target's fact requests. */
async function factsListing(engine: ManagedBrain['engine']) {
  const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
    .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
  return (preview.listing ?? []).filter(entry => entry.item.includes(`${TARGET} extract_facts`));
}

const factRows = (engine: ManagedBrain['engine']) => engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE fact=$1', [CLAIM]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`#7439 [${backend}]: a page-triggered facts batch refused for a stalled hold publishes its retained facts once the reconcile clears the hold`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { file, pristine, receipt, retry, write } = await refusedPageBatch(brain);
    expect(await factRows(engine)).toEqual([]);
    // Value: protects=repair failed-writes lists a held-file fact refusal with the job retry that recovers it, then drops it once a
    // follow-up committed; fails_when=the listing names extract --stale, loses the file-check note, or keeps a recovered request;
    // why_new=#7602 covers revision_conflict listings only; seam=the job died is set by SQL (the reset needs a dead job); no_claim=does
    // not run the job retry itself
    const key = `facts-absorb:write:${write}`;
    const origin = (await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' }))!;
    const job = await new MinionQueue(engine).add('facts-absorb', { slug: ORIGIN, sourceId: 'default', persistence_request_id: write, page_id: origin.page.id, revision: origin.revision }, { queue: 'default', idempotency_key: key });
    await engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE id=$1", [job.id]);
    const [listed, ...others] = await factsListing(engine);
    expect(others).toEqual([]);
    expect(listed!.class).toBe('producer_owned');
    expect(listed!.detail).toStartWith(`recover: gbrain facts retry-dead --reset 'facts-absorb:write:${write}'`);
    expect(listed!.detail).toContain('once the file check passes');
    writeFileSync(file, pristine);
    await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () => {
      const preview = await runReconcilePreview(engine, { source_id: 'default', slug: TARGET });
      expect(preview.status).toBe('ready');
      expect((await runReconcileApply(engine, { source_id: 'default', slug: TARGET, preview: preview.preview, request_id: randomUUID() })).state).toBe('committed');
    });
    expect(await readGitSourceHolds(engine, { sourceIds: ['default'] })).toEqual([]);
    const resumed = await retry();
    expect(resumed?.inserted).toBe(1);
    expect(resumed?.refused).toBeUndefined();
    expect(await factRows(engine)).toEqual([{ fact: CLAIM }]);
    expect(await engine.executeRaw('SELECT request_id, error_message FROM persistence_requests WHERE request_id=$1::uuid', [receipt[0]!.request_id])).toEqual(receipt);
    expect((await retry())?.inserted).toBe(1);
    expect(await factRows(engine)).toHaveLength(1);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a held-file fact refusal whose entity page was deleted once the hold cleared is listed as not recoverable,
  // never the job retry (the file walk admits nothing for a deleted page, so the refusal replays until the job dies again);
  // fails_when=the page-identity checks apply to moved-entity refusals only; why_new=the row above keeps the page; seam=none;
  // no_claim=a purge compacts the refusal's receipt, so a purged-and-recreated page is covered by the #7602 replaced-page row
  test(`#7439 [${backend}]: a held-file fact refusal whose entity page was deleted after the hold cleared is not listed for the job retry`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { file, pristine, write } = await refusedPageBatch(brain);
    const origin = (await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' }))!;
    const job = await new MinionQueue(engine).add('facts-absorb', { slug: ORIGIN, sourceId: 'default', persistence_request_id: write, page_id: origin.page.id, revision: origin.revision }, { queue: 'default', idempotency_key: `facts-absorb:write:${write}` });
    await engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE id=$1", [job.id]);
    writeFileSync(file, pristine);
    await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () => {
      const preview = await runReconcilePreview(engine, { source_id: 'default', slug: TARGET });
      expect((await runReconcileApply(engine, { source_id: 'default', slug: TARGET, preview: preview.preview, request_id: randomUUID() })).state).toBe('committed');
    });
    const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TARGET, expected_revision: snapshot.revision, request_id: randomUUID() } });
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`not recoverable: entity page ${TARGET} was deleted after these facts were admitted`]);
  }, { databaseUrl }), 120_000);

  test(`#7439 [${backend}]: while the held file still differs, a retry keeps the refusal and admits nothing`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { retry } = await refusedPageBatch(brain);
    expect((await retry().catch(error => error)).code).toBe('source_changed');
    expect(await factRows(engine)).toEqual([]);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 AND state='committed'", [TARGET])).toEqual([]);
  }, { databaseUrl }), 120_000);
}
