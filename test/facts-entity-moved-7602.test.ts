/**
 * #7602: two extractions from different source pages target the same entity page. One publishes first; the other's
 * entity request, admitted at the revision it read, is refused `revision_conflict` at preparation. The batch is keyed
 * by the page write it extracts from, so every facts-absorb retry replayed the same stored refusal until the job died
 * and the facts were dropped.
 *
 * 1. Protects: the refused request's retained facts are re-admitted at the entity's current revision and publish in the
 *    same run, with no second model call; a retry replays that outcome and admits nothing; the historical receipt is
 *    left as it was. A page that keeps moving is followed at most three times, a deleted entity page is not followed,
 *    and the refusal that stands is not retryable, so the job dead-letters on its first attempt instead of five.
 * 2. Fails when: the refusal replays (master before the fix), a follow-up re-runs the model, the cap is exceeded, a
 *    deleted page is re-targeted, or a standing refusal is retried.
 * 3. test/facts-absorb-stalled-receipt-7439.test.ts and test/managed-facts-withdrawal-recovery-6506.test.ts cover the
 *    file-check and withdrawal follow-ups this walk mirrors.
 * 4. Seams: the race is made deterministic by publishing the competing extraction while the losing one reads the
 *    entity page (the snapshot it then admits against is the one from before); gateway test transports.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { FENCE_FACTS_INTENT } from '../src/core/cycle/extract-facts.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { FACTS_DEFAULT_VISIBILITY_KEY } from '../src/core/facts/visibility.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import { jobRefusal } from '../src/core/minions/refusal.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../src/core/persistence/prepared-maintenance.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { FACTS_ENTITY_MOVED_MESSAGES } from '../src/core/persistence/verb-errors.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { ManagedBrain } from './helpers/managed-brain.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const TARGET = 'people/alice-example';
const CLAIM_B = 'Alice-example owns the synthetic onboarding checklist.';
const OTHER = 'companies/acme-example';
const CLAIM_OTHER = 'Acme-example runs the synthetic onboarding pilot.';
const CLAIM_SELF = 'The synthetic planning chat set the onboarding launch date.';
const BODY = 'Notes from a synthetic planning chat about the onboarding checklist and the launch date, kept for the regression.';

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

async function put(ctx: ManagedBrain['ctx'], slug: string, type: string) {
  const requestId = randomUUID();
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId,
    content: `---\ntype: ${type}\ntitle: Example\n---\n${BODY} (${slug})\n` } });
  const [write] = await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return write!.id;
}

const fact = (claim: string) => ({ fact: claim, kind: 'fact' as const, source: 'mcp:put_page', entity_slug: TARGET, confidence: 0.9, notability: 'high' as const, embedding: null });

/** A committed write of a source page and its extraction: the backstop context, the input and a fresh session per run. */
async function extraction({ engine, ctx }: ManagedBrain, slug: string) {
  const write = await put(ctx, slug, 'meeting');
  const backstop: FactsBackstopCtx = { engine, sourceId: 'default', source: 'mcp:put_page', sessionId: null, persistenceRequestId: write, operationContext: ctx };
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const input = { turnText: snapshot.page.compiled_truth, pageSlug: slug };
  // The backstop's settings for an automatic extraction (backstop.ts runPipelineBodyInner).
  const session = async () => Object.assign((await prepareManagedFactsSession(backstop, input))!, { reportRefusals: true, entityMoveRetry: true });
  return { slug, write, snapshot, backstop, input, session };
}

/**
 * The race: while the losing extraction reads the entity page before admitting (and again before each follow-up),
 * `move` publishes a competing write of that page, and the read returns the snapshot from before it.
 */
function raceEntityReads(engine: ManagedBrain['engine'], times: number, move: (n: number) => Promise<void>) {
  const read = engine.readPageSnapshot;
  let moves = 0, moving = false;
  engine.readPageSnapshot = (async function (this: typeof engine, slug: string, opts?: Parameters<typeof read>[1]) {
    const reader = /publishManagedFacts|readmitMovedFacts/.test(new Error().stack ?? '');
    const before = await read.call(this, slug, opts);
    if (this !== engine || slug !== TARGET || !reader || moving || moves >= times) return before;
    moving = true;
    try { await move(moves++); } finally { moving = false; }
    return before;
  }) as typeof engine.readPageSnapshot;
  return { moves: () => moves, restore: () => { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; } };
}

/** Each move publishes another extraction's fact onto the entity page, as a concurrent facts-absorb job would. */
async function competitors(brain: ManagedBrain, count: number) {
  const list: Array<Awaited<ReturnType<typeof extraction>>> = [];
  for (let i = 0; i < count; i++) list.push(await extraction(brain, `chats/source-${String.fromCharCode(97 + i)}`));
  return async (n: number) => {
    const competitor = list[n]!;
    const published = await publishManagedFacts(brain.engine, await competitor.session(), competitor.backstop,
      [fact(`Alice-example confirmed synthetic item ${n + 1}.`)], 'private', competitor.slug);
    expect(published.inserted).toBe(1);
  };
}

const entityRequests = (engine: ManagedBrain['engine']) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null }>(
  "SELECT request_id, state, error_code, error_message FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 AND intent->>'origin' LIKE '%chats/source-loser%' ORDER BY sequence", [TARGET]);
const claimB = (engine: ManagedBrain['engine']) => engine.executeRaw<{ fact: string; source_markdown_slug: string | null }>(
  'SELECT fact, source_markdown_slug FROM facts WHERE fact=$1', [CLAIM_B]);

/**
 * The page write's facts-absorb job, by its idempotency key. The facts-backstop effect queues it asynchronously, so a test
 * that reads or sets its status adds it first (an add with the same key returns the job the effect queued, if any).
 */
async function factsAbsorbJob(engine: ManagedBrain['engine'], loser: Awaited<ReturnType<typeof extraction>>, status?: string) {
  const key = `facts-absorb:write:${loser.write}`;
  const job = await new MinionQueue(engine).add('facts-absorb', { slug: loser.slug, sourceId: 'default', source: 'mcp:put_page', persistence_request_id: loser.write,
    page_id: loser.snapshot.page.id, revision: loser.snapshot.revision }, { queue: 'default', idempotency_key: key });
  if (status) expect(await engine.executeRaw('UPDATE minion_jobs SET status=$2 WHERE id=$1 RETURNING id', [job.id, status])).toHaveLength(1);
  return key;
}

/** The `gbrain repair failed-writes` preview rows for the losing extraction's entity requests. */
async function factsListing(engine: ManagedBrain['engine']) {
  const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
    .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
  return (preview.listing ?? []).filter(entry => entry.item.includes(`${TARGET} extract_facts`));
}

function jobContext(loser: Awaited<ReturnType<typeof extraction>>, id: number): MinionJobContext {
  const signal = new AbortController().signal;
  return { id, name: 'facts-absorb', attempts_made: 0, signal, deadlineAtMs: null, shutdownSignal: signal,
    data: { slug: loser.slug, sourceId: 'default', source: 'mcp:put_page', sessionId: `put_page:${loser.slug}`, visibility: 'private',
      persistence_request_id: loser.write, page_id: loser.snapshot.page.id, revision: loser.snapshot.revision },
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
}

/** A keyed chat stub that extracts CLAIM_B about the entity; returns the call counter. */
async function stubExtraction(engine: ManagedBrain['engine']) {
  const calls = { n: 0 };
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls.n++;
    return { text: JSON.stringify({ facts: [{ fact: CLAIM_B, kind: 'fact', entity: TARGET, confidence: 0.9, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('embedding_disabled', 'true');
  return calls;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = async (brain: ManagedBrain, competing: number) => {
    await put(brain.ctx, TARGET, 'person');
    const move = await competitors(brain, competing);
    return { move, loser: await extraction(brain, 'chats/source-loser') };
  };

  test(`#7602 [${backend}]: an extraction that lost the race on its entity page publishes its retained facts in the same run`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const race = raceEntityReads(engine, 1, move);
    const first = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect(first.inserted).toBe(1);
    expect(first.refused).toBeUndefined();
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect((await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!.page.compiled_truth).toContain(CLAIM_B);
    const requests = await entityRequests(engine);
    expect(requests.map(row => [row.state, row.error_code, row.error_message])).toEqual([
      ['conflict', 'revision_conflict', 'The fact entity changed after extraction admission.'], ['committed', null, null]]);
    for (let retry = 0; retry < 4; retry++) expect((await resumeManagedFacts(engine, await loser.session()))?.inserted).toBe(1);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toHaveLength(1);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=the follow-up of a batch that also committed a fact on its own source page (a page write that extracts facts
  // about itself) publishes, because the source page moved only by that batch's own commit; fails_when=the follow-up is refused
  // 'The source page changed during fact extraction.' and the run throws; why_new=the row above extracts facts about the entity
  // only; seam=none; no_claim=one self fact and one moved entity
  test(`#7602 [${backend}]: a batch that also committed a fact on its own source page re-admits the moved entity in the same run`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const race = raceEntityReads(engine, 1, move);
    const first = await publishManagedFacts(engine, await loser.session(), loser.backstop, [{ ...fact(CLAIM_SELF), entity_slug: loser.slug }, fact(CLAIM_B)],
      'private', loser.slug).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect({ inserted: first.inserted, refused: first.refused }).toEqual({ inserted: 2, refused: undefined });
    expect((await engine.readPageSnapshot(loser.slug, { sourceId: 'default' }))!.revision).not.toBe(loser.snapshot.revision);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect((await entityRequests(engine)).map(row => [row.state, row.error_code])).toEqual([['conflict', 'revision_conflict'], ['committed', null]]);
  }, { databaseUrl }), 120_000);

  // Value: protects=the third follow-up still runs and publishes when the page stops moving after three reads; fails_when=the walk
  // stops before MAX_FILE_REFUSAL_RETRIES follow-ups; why_new=the row below covers only the side where every follow-up loses;
  // seam=none; no_claim=the moves are direct publications from a read hook, not concurrent facts-absorb jobs
  test(`#7602 [${backend}]: a page that moves for the first three reads publishes on the third follow-up`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 3);
    const race = raceEntityReads(engine, 3, move);
    const first = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).finally(race.restore);
    expect(race.moves()).toBe(3);
    expect(first.inserted).toBe(1);
    expect(first.refused).toBeUndefined();
    expect((await entityRequests(engine)).map(row => [row.state, row.error_code])).toEqual([
      ['conflict', 'revision_conflict'], ['conflict', 'revision_conflict'], ['conflict', 'revision_conflict'], ['committed', null]]);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: a page that moves before every follow-up is followed three times, then the refusal stands and is not retryable`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 4);
    const race = raceEntityReads(engine, 4, move);
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(4);
    expect(refused.code).toBe('revision_conflict');
    expect(refused.retryable).toBe(false);
    const requests = await entityRequests(engine);
    expect(requests).toHaveLength(4);
    expect(requests.every(row => row.state === 'conflict' && row.error_code === 'revision_conflict')).toBe(true);
    const retry = await resumeManagedFacts(engine, await loser.session()).catch(error => error);
    expect([retry.code, retry.retryable]).toEqual(['revision_conflict', false]);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toEqual([]);
    await factsAbsorbJob(engine, loser, 'dead');
    const listing = await factsListing(engine);
    expect(listing).toHaveLength(4);
    for (const entry of listing) {
      expect(entry.class).toBe('producer_owned');
      expect(entry.detail).toStartWith(`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id`);
      expect(entry.detail).toEndWith('; its follow-up batches were refused as well, so a job retry replays the refusal');
      expect(entry.detail).not.toContain('extract --stale');
    }
  }, { databaseUrl }), 120_000);

  // Value: protects=an extraction interrupted with exactly MAX_FILE_REFUSAL_RETRIES refused batches still has a follow-up left, so
  // repair lists the job reset and the reset's replay publishes; fails_when=the cap check counts the third open batch as exhausted
  // (`>=`); why_new=the rows above end with 2 or 4 open batches; seam=the run is interrupted by a throwing read before the third
  // follow-up; no_claim=the interruption is a thrown read, not a killed worker
  test(`#7602 [${backend}]: an extraction interrupted with three refused batches is still listed for the job reset, and the reset publishes`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 3);
    const race = raceEntityReads(engine, 4, async n => { if (n === 3) throw new Error('interrupted before the third follow-up'); await move(n); });
    const interrupted = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(interrupted.message).toBe('interrupted before the third follow-up');
    expect((await entityRequests(engine)).map(row => [row.state, row.error_code])).toEqual(Array(3).fill(['conflict', 'revision_conflict']));
    const key = await factsAbsorbJob(engine, loser, 'dead');
    expect((await factsListing(engine)).map(entry => entry.detail?.split(' (')[0])).toEqual(Array(3).fill(`recover: gbrain facts retry-dead --reset '${key}'`));
    expect((await resumeManagedFacts(engine, await loser.session()))?.inserted).toBe(1);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a refusal whose source page was written again after its job died is listed for re-extraction, not the job
  // reset (the retry skips a superseded page write); fails_when=factsRecovery offers recover: without the job's own page check;
  // why_new=the rows above keep the source page; seam=the job's status is set by SQL; no_claim=does not run the reset job
  test(`#7602 [${backend}]: a refusal whose source page was written again after its job died is listed for re-extraction`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    expect((await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
    const key = await factsAbsorbJob(engine, loser, 'dead');
    expect((await factsListing(engine)).map(entry => entry.detail?.split(' (')[0])).toEqual([`recover: gbrain facts retry-dead --reset '${key}'`]);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: loser.slug, request_id: randomUUID(), expected_revision: loser.snapshot.revision,
      content: `---\ntype: meeting\ntitle: Example\n---\n${BODY} (rewritten)\n` } });
    expect((await engine.readPageSnapshot(loser.slug, { sourceId: 'default' }))!.revision).not.toBe(loser.snapshot.revision);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); ${loser.slug} changed after the page write its facts-absorb job extracts, so a job retry skips it`]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a dead job whose page write its own retry would skip for a reason other than a newer write (here the writer's
  // grant no longer covers the source page) is listed for re-extraction, not the reset; fails_when=factsRecovery offers recover: for
  // any skip but superseded/page_missing; why_new=the row above covers superseded only; seam=the grant is narrowed by SQL on the
  // writer row; no_claim=does not run the reset job
  test(`#7602 [${backend}]: a refusal whose page write its job would skip (writer grant narrowed) is listed for re-extraction`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    expect((await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
    const key = await factsAbsorbJob(engine, loser, 'dead');
    expect((await factsListing(engine)).map(entry => entry.detail?.split(' (')[0])).toEqual([`recover: gbrain facts retry-dead --reset '${key}'`]);
    const [writer] = await engine.executeRaw<{ principal_kind: string; principal_id: string }>('SELECT principal_kind, principal_id FROM persistence_requests WHERE id=$1::uuid', [loser.write]);
    expect(writer!.principal_kind).toBe('local_cli');
    expect(await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling = jsonb_set(COALESCE(grant_ceiling, '{}'::jsonb), '{slugPrefixes}', '[\"people/\"]'::jsonb) WHERE id=$1::uuid RETURNING id", [writer!.principal_id])).toHaveLength(1);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); a job retry would skip the page write (permission_denied), so gbrain facts retry-dead cannot recover it`]);
  }, { databaseUrl }), 120_000);

  // Value: protects=repair failed-writes offers the job reset only for a dead facts-absorb job, and the reset's replay publishes the
  // retained facts; fails_when=a waiting or completed job is listed with retry-dead (a command that finds no dead job), or the replay
  // does not publish; why_new=the rows above never list a recoverable refusal; seam=the job's status is set by SQL; no_claim=does not
  // run the worker or facts_drain
  test(`#7602 [${backend}]: a refusal stored before the fix is listed with the job retry once its job is dead, and the retry's replay publishes them`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    const refused = await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(refused.code).toBe('revision_conflict');
    const key = await factsAbsorbJob(engine, loser);
    const jobStatus = (status: string) => engine.executeRaw("UPDATE minion_jobs SET status=$2 WHERE name='facts-absorb' AND idempotency_key=$1 RETURNING id", [key, status]);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`pending: its facts-absorb job (${key}) is waiting; preview again once it ends`]);
    expect(await jobStatus('completed')).toHaveLength(1);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); its facts-absorb job is completed, so gbrain facts retry-dead has no dead job to reset`]);
    // Value: protects=a cancelled or vanished facts-absorb job is listed for re-extraction, never as pending or with the job reset;
    // fails_when=the pending check stops excluding cancelled (an endless "preview again") or a missing job gets retry-dead; why_new=the
    // rows above cover waiting, completed and dead only; seam=none; no_claim=the status and the job's absence are set by SQL
    expect(await jobStatus('cancelled')).toHaveLength(1);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); its facts-absorb job is cancelled, so gbrain facts retry-dead has no dead job to reset`]);
    const rekey = (from: string, to: string) => engine.executeRaw("UPDATE minion_jobs SET idempotency_key=$2 WHERE name='facts-absorb' AND idempotency_key=$1 RETURNING id", [from, to]);
    expect(await rekey(key, `${key}:elsewhere`)).toHaveLength(1);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); its facts-absorb job is gone, so gbrain facts retry-dead has no dead job to reset`]);
    expect(await rekey(`${key}:elsewhere`, key)).toHaveLength(1);
    expect(await jobStatus('dead')).toHaveLength(1);
    const [entry, ...others] = await factsListing(engine);
    expect(others).toEqual([]);
    expect(entry!.class).toBe('producer_owned');
    expect(entry!.detail).toStartWith(`recover: gbrain facts retry-dead --reset '${key}'`);
    const retried = await resumeManagedFacts(engine, await loser.session());
    expect(retried?.inserted).toBe(1);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a writer-guard-refused fact request is listed for re-extraction, never the job retry that would replay its refusal;
  // fails_when=factsRecovery offers retry-dead for any page-triggered request, or the listing names extract --stale again;
  // why_new=the #7602 listings cover conflict rows only; seam=none; no_claim=the guard refusal is stamped onto a stored receipt by SQL,
  // as test/repair-failed-writes-5983.test.ts does, not produced by a live writer guard
  test(`#7602 [${backend}]: a fact request the writer guard refused is listed for re-extraction, not a job retry`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    expect((await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`UPDATE persistence_requests SET state='failed', error_code='writer_coordinator_required'
        WHERE operation='extract_facts' AND slug=$1 AND state='conflict' AND intent->>'origin' LIKE '%chats/source-loser%'`, [TARGET]);
    });
    expect((await factsListing(engine)).map(entry => [entry.class, entry.detail])).toEqual([['producer_owned',
      `re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call)`]]);
    // Value: protects=the preview's producer warning for fact requests points at each listed request's own command; fails_when=the
    // warning names extract --stale again or one request's recover command for every fact request; why_new=no #7602 row reads the
    // preview warnings; seam=none; no_claim=one fact request only, so the per-request commands are not compared to each other
    const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
      .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    expect((preview.warnings ?? []).filter(warning => warning.includes('extract_facts'))).toEqual([
      'extract_facts:managed_facts_entity in default: produced by gbrain itself, not replayed here; each listed request names the command that recovers its facts']);
  }, { databaseUrl }), 120_000);

  // Value: protects=a moved-entity refusal of an extraction with its own request id (no page write, no facts-absorb job) is listed for
  // re-extraction with no job advice; fails_when=the listing drops refusals that have no job or offers retry-dead/pending for them;
  // why_new=every other #7602 listing row is page-triggered; seam=none; no_claim=the move is the wrapped entity read; no MCP caller
  test(`#7602 [${backend}]: a moved-entity refusal with no page write is listed for re-extraction of the source turn`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const backstop: FactsBackstopCtx = { ...loser.backstop, persistenceRequestId: undefined, requestId: randomUUID() };
    const session = Object.assign((await prepareManagedFactsSession(backstop, { turnText: loser.input.turnText }))!, { reportRefusals: true });
    expect([session.originalRequestId, session.entityMoveRetry]).toEqual([null, undefined]);
    const race = raceEntityReads(engine, 1, move);
    const refused = await publishManagedFacts(engine, session, backstop, [fact(CLAIM_B)], 'private').catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect([refused.code, refused.retryable]).toEqual(['revision_conflict', false]);
    expect(await claimB(engine)).toEqual([]);
    expect((await factsListing(engine)).map(entry => [entry.class, entry.detail])).toEqual([['producer_owned',
      're-extract: gbrain call extract_facts again on the current text of the source turn with a new request_id (one model call)']]);
  }, { databaseUrl }), 120_000);

  // Value: protects=the stored moved-entity refusal texts stay the ones pre-fix and current receipts carry, so a reword cannot
  // silently stop the walk and the repair preview from matching stored rows; fails_when=any FACTS_ENTITY_MOVED_MESSAGES entry is
  // reworded, dropped or reordered without a decision about stored receipts; why_new=the rows below iterate the list itself;
  // seam=none; no_claim=does not prove every thrower uses these constants
  test(`#7602 [${backend}]: the stored moved-entity refusal texts are frozen`, () => {
    expect([...FACTS_ENTITY_MOVED_MESSAGES]).toEqual(['The fact entity changed after extraction admission.', 'The fact entity changed during preparation.',
      'The fact deduplication state changed before publication.', 'The page changed during preparation.',
      'The page changed after it was read. Read its current revision before retrying.']);
  });

  // Value: protects=a revision_conflict whose stored message is not a moved-entity text (the source page changed) is neither
  // re-admitted by the walk nor listed by repair; fails_when=the predicate widens to every revision_conflict and re-admits facts
  // whose source page moved; why_new=every other row stores a moved-entity text; seam=the stored message is set by SQL;
  // no_claim=does not reproduce the source-page refusal path itself
  test(`#7602 [${backend}]: a revision_conflict stored with the source-page text is not followed or listed`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    expect((await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      expect(await tx.executeRaw("UPDATE persistence_requests SET error_message='The source page changed during fact extraction.' WHERE operation='extract_facts' AND slug=$1 AND state='conflict' RETURNING id", [TARGET])).toHaveLength(1);
    });
    await factsAbsorbJob(engine, loser, 'dead');
    const requests = await entityRequests(engine);
    expect((await resumeManagedFacts(engine, await loser.session()).catch(error => error)).code).toBe('revision_conflict');
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toEqual([]);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a refusal stored with any moved-entity message (the admission, preparation, deduplication and coordinator kinds,
  // and the page layer's stale-revision message stored before the fix) is listed with the job reset and re-admitted by it, and
  // repair --apply leaves it alone; fails_when=a message is missing from FACTS_ENTITY_MOVED_MESSAGES, so the receipt is never listed
  // and a reset replays it, or apply replays a fact request; why_new=the row above stores the admission-time message only;
  // seam=the stored message is set by SQL; no_claim=does not reproduce each message's own refusal path
  for (const message of FACTS_ENTITY_MOVED_MESSAGES) {
    test(`#7602 [${backend}]: a refusal stored with '${message}' is listed for the job reset and re-admitted`, () => managedBrain(async brain => {
      const { engine } = brain;
      const { move, loser } = await setup(brain, 1);
      const before = await loser.session();
      before.entityMoveRetry = false;
      const race = raceEntityReads(engine, 1, move);
      expect((await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        expect(await tx.executeRaw("UPDATE persistence_requests SET error_message=$2 WHERE operation='extract_facts' AND slug=$1 AND state='conflict' RETURNING id", [TARGET, message])).toHaveLength(1);
      });
      const key = await factsAbsorbJob(engine, loser, 'dead');
      expect((await factsListing(engine)).map(entry => entry.detail?.split(' (')[0])).toEqual([`recover: gbrain facts retry-dead --reset '${key}'`]);
      const requests = await entityRequests(engine);
      const scope = await resolveRepairScope(engine, 'default');
      const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } })).run('failed-writes', scope, { explicit: true, sourceFlag: 'default' });
      const applied = await (await repairRunner(engine, { apply: true, logger: { info() {}, warn() {}, error() {} } })).run('failed-writes', scope,
        { explicit: true, sourceFlag: 'default', ...(preview.apply_command ? { expect: preview.apply_command.split('--expect ')[1] } : {}) });
      expect(applied.outcomes?.replayed ?? 0).toBe(0);
      expect(await entityRequests(engine)).toEqual(requests);
      expect((await resumeManagedFacts(engine, await loser.session()))?.inserted).toBe(1);
      expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
      expect(await factsListing(engine)).toEqual([]);
    }, { databaseUrl }), 120_000);
  }

  // Value: protects=a re-admitted fact is never wider than the current default visibility, and keeps world under a world default;
  // fails_when=readmitMovedFacts re-admits the retained facts without narrowing them (or narrows unconditionally);
  // why_new=the other #7602 rows publish private facts only; seam=none; no_claim=the race is the wrapped entity read above
  for (const [defaultVisibility, published] of [[null, 'private'], ['world', 'world']] as const) {
    test(`#7602 [${backend}]: a world fact re-admitted after the race is ${published} under the ${defaultVisibility ?? 'unset'} default visibility`, () => managedBrain(async brain => {
      const { engine } = brain;
      if (defaultVisibility) await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, defaultVisibility);
      const { move, loser } = await setup(brain, 1);
      const race = raceEntityReads(engine, 1, move);
      const first = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'world', loser.slug).finally(race.restore);
      expect(race.moves()).toBe(1);
      expect(first.inserted).toBe(1);
      expect(await engine.executeRaw(`SELECT state, intent->'facts'->0->>'visibility' AS visibility FROM persistence_requests
        WHERE operation='extract_facts' AND slug=$1 AND intent->>'origin' LIKE '%chats/source-loser%' ORDER BY sequence`, [TARGET]))
        .toEqual([{ state: 'conflict', visibility: 'world' }, { state: 'committed', visibility: published }]);
      expect(await engine.executeRaw('SELECT visibility FROM facts WHERE fact=$1', [CLAIM_B])).toEqual([{ visibility: published }]);
    }, { databaseUrl }), 120_000);
  }

  // Value: protects=repair failed-writes names the command that produces each guard-refused maintenance facts write again;
  // fails_when=the listing sends a *_facts producer to gbrain extract --stale again (that sweep runs no fact producer), or a repair's
  // write to the dream cycle; why_new=no failed-writes test lists a maintenance producer; seam=none; no_claim=the guard refusal (and,
  // past the first row, the intent kind) is stamped onto a committed fence-facts receipt by SQL, as the writer-guard row above does
  const maintenanceProducers: Array<[kind: string, command: string]> = [
    [FENCE_FACTS_INTENT, 'the next `gbrain dream` cycle (or autopilot) produces it again'],
    ['managed_maintenance_expire_captured_facts', 'gbrain repair captured-facts --source default'],
    ['managed_maintenance_restore_extractor_facts', 'gbrain repair extractor-facts --source default'],
    ['managed_maintenance_restore_redacted_facts', 'gbrain repair redacted-facts --source default'],
    ['managed_maintenance_conversation_facts', 'gbrain extract-conversation-facts --source-id default --dry-run'],
  ];
  for (const [kind, command] of maintenanceProducers) {
    test(`#7602 [${backend}]: a guard-refused ${kind} write is listed with the command that produces it, not extract --stale`, () => managedBrain(async brain => {
      const { engine, ctx, root } = brain;
      await put(ctx, TARGET, 'person');
      const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
      await submitDatabaseMaintenanceIntent(engine, (await maintenancePreflight(engine, 'default', root))!, TARGET,
        { kind: FENCE_FACTS_INTENT, expected_revision: snapshot.revision, page_id: snapshot.page.id, embeddings: [] }, randomUUID());
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        expect(await tx.executeRaw(`UPDATE persistence_requests SET state='failed', error_code='writer_coordinator_required',
          intent=jsonb_set(intent, '{kind}', to_jsonb($3::text)) WHERE slug=$1 AND intent->>'kind'=$2 RETURNING operation`, [TARGET, FENCE_FACTS_INTENT, kind]))
          .toEqual([{ operation: 'submit_job' }]);
      });
      const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
        .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
      expect((preview.listing ?? []).filter(entry => entry.item.includes(`${TARGET} submit_job`)).map(entry => [entry.class, entry.detail]))
        .toEqual([['producer_owned', `re-run: ${command}`]]);
    }, { databaseUrl }), 120_000);
  }

  // Value: protects=an entity page replaced at its slug (a new page id) after admission is not re-targeted, and repair lists the
  // refusal for re-extraction, not the job retry that would replay it; fails_when=the replacement page gets the retained facts or the
  // listing offers retry-dead; why_new=the deleted-page row leaves no page at the slug; seam=none; no_claim=the replacement is a
  // direct purge and put in the race
  test(`#7602 [${backend}]: an entity page replaced after admission is not re-targeted and is listed for re-extraction`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { loser } = await setup(brain, 0);
    const race = raceEntityReads(engine, 1, async () => {
      const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TARGET, expected_revision: snapshot.revision, purge: true, request_id: randomUUID() } });
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: TARGET, request_id: randomUUID(),
        content: '---\ntype: person\ntitle: Example\n---\nA different synthetic person page created at the same slug after the purge.\n' } });
      expect((await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!.page.id).not.toBe(snapshot.page.id);
    });
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect([refused.code, refused.retryable]).toEqual(['revision_conflict', false]);
    expect((await entityRequests(engine)).map(row => row.state)).toEqual(['conflict']);
    expect(await claimB(engine)).toEqual([]);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); entity page ${TARGET} was replaced after these facts were admitted, so a job retry replays the refusal`]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a held-file sibling refused beside a moved entity is listed for re-extraction, not the job retry (the
  // file walk re-admits only a batch whose open requests are all held-file refusals); fails_when=the sibling is listed
  // with retry-dead, or the moved entity is not re-admitted; why_new=#7439 holds the only entity, the held-follow-up row
  // holds the moved entity itself; seam=the hold is written directly, as #7439 does; no_claim=does not clear the hold
  test(`#7602 [${backend}]: a held-file sibling refused beside a moved entity is listed for re-extraction`, () => managedBrain(async brain => {
    const { engine, ctx, root } = brain;
    const { move, loser } = await setup(brain, 1);
    await put(ctx, OTHER, 'company');
    const other = (await engine.readPageSnapshot(OTHER, { sourceId: 'default' }))!;
    const path = `${OTHER}.md`, file = join(root, path);
    writeFileSync(file, readFileSync(file, 'utf8') + '\nAn unimported edit.\n');
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: other.sourceIncarnation,
      path, source_path: path, slug: OTHER, page_id: null, code: 'preparation_stalled', message: 'The write owner stalled.',
      upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION } }));
    const race = raceEntityReads(engine, 1, move);
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [{ ...fact(CLAIM_OTHER), entity_slug: OTHER }, fact(CLAIM_B)],
      'private', loser.slug).catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect(refused.code).toBe('source_changed');
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    const key = await factsAbsorbJob(engine, loser, 'waiting');
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([]);
    const pending = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
      .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    expect((pending.listing ?? []).filter(entry => entry.item.includes(' extract_facts')).map(entry => entry.detail))
      .toEqual([`pending: its facts-absorb job (${key}) is waiting; preview again once it ends`]);
    await factsAbsorbJob(engine, loser, 'dead');
    const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
      .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
    expect((preview.listing ?? []).filter(entry => entry.item.includes(' extract_facts')).map(entry => [entry.item.split(' ')[0], entry.detail])).toEqual([
      [`default:${OTHER}`, `re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); its extraction also holds refusals one job retry does not re-admit together`]]);
  }, { databaseUrl }), 120_000);

  // Value: protects=when the entity's file is held between the move and the follow-up, repair lists the whole chain for
  // re-extraction instead of the job retry, which would replay the follow-up's file refusal; fails_when=either request is listed
  // with retry-dead; why_new=#7439 covers a held file on the original batch only; seam=the hold is written directly, as #7439 does;
  // no_claim=the follow-up is not re-admitted after the hold clears (a known limit: re-extraction recovers it)
  test(`#7602 [${backend}]: a moved entity whose file is held before the follow-up publishes is listed for re-extraction`, () => managedBrain(async brain => {
    const { engine, root } = brain;
    const { move, loser } = await setup(brain, 1);
    const race = raceEntityReads(engine, 2, async n => {
      if (n === 0) return move(0);
      const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
      const path = `${TARGET}.md`, file = join(root, path);
      writeFileSync(file, readFileSync(file, 'utf8') + '\nAn unimported edit.\n');
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: snapshot.sourceIncarnation,
        path, source_path: path, slug: TARGET, page_id: null, code: 'preparation_stalled', message: 'The write owner stalled.',
        upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION } }));
    });
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(2);
    expect(refused.code).toBe('source_changed');
    expect((await entityRequests(engine)).map(row => [row.state, row.error_code])).toEqual([['conflict', 'revision_conflict'], ['conflict', 'source_changed']]);
    expect(await claimB(engine)).toEqual([]);
    await factsAbsorbJob(engine, loser, 'dead');
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual(Array(2).fill(`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id (one model call); its extraction also holds refusals one job retry does not re-admit together`));
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: an entity page deleted after admission is not re-targeted; the refusal is not retryable`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { loser } = await setup(brain, 0);
    const race = raceEntityReads(engine, 1, async () => {
      const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TARGET, expected_revision: snapshot.revision, request_id: randomUUID() } });
    });
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect([refused.code, refused.retryable]).toEqual(['revision_conflict', false]);
    expect((await entityRequests(engine)).map(row => row.state)).toEqual(['conflict']);
    expect(await claimB(engine)).toEqual([]);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`not recoverable: entity page ${TARGET} was deleted after these facts were admitted`]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a moved entity is re-admitted though a sibling entity of the same extraction was deleted, and the sibling keeps its
  // refusal; fails_when=one deleted page abandons the whole follow-up (the moved entity's facts are dropped) or the deleted one is
  // re-targeted; why_new=the deleted-page test has a single entity; seam=none; no_claim=the move and the delete are direct writes in the race
  test(`#7602 [${backend}]: a moved entity is re-admitted beside a sibling whose page was deleted; the sibling stays refused`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { move, loser } = await setup(brain, 1);
    await put(ctx, OTHER, 'company');
    const race = raceEntityReads(engine, 1, async n => {
      await move(n);
      const other = (await engine.readPageSnapshot(OTHER, { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: OTHER, expected_revision: other.revision, request_id: randomUUID() } });
    });
    const result = await publishManagedFacts(engine, await loser.session(), loser.backstop, [{ ...fact(CLAIM_OTHER), entity_slug: OTHER }, fact(CLAIM_B)],
      'private', loser.slug).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect({ inserted: result.inserted, refused: result.refused?.map(row => [row.slug, row.code]) }).toEqual({ inserted: 1, refused: [[OTHER, 'revision_conflict']] });
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect(await engine.executeRaw('SELECT fact FROM facts WHERE fact=$1', [CLAIM_OTHER])).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=the entity walk stops when the moved requests it would follow carry different embedding signatures, and follows
  // them once they match; fails_when=the sameSignature check is dropped and facts embedded under another model are admitted under
  // the first request's signature; why_new=every other #7602 row retains one null signature; seam=none; no_claim=the second
  // signature is stamped onto a stored receipt by SQL (one admission never mixes them)
  test(`#7602 [${backend}]: moved requests whose retained embedding signatures differ are not followed until they match`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { move, loser } = await setup(brain, 1);
    await put(ctx, OTHER, 'company');
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, async n => {
      await move(n);
      const other = (await engine.readPageSnapshot(OTHER, { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: OTHER, request_id: randomUUID(), expected_revision: other.revision,
        content: `---\ntype: company\ntitle: Example\n---\n${BODY} (moved)\n` } });
    });
    expect((await publishManagedFacts(engine, before, loser.backstop, [{ ...fact(CLAIM_OTHER), entity_slug: OTHER }, fact(CLAIM_B)], 'private', loser.slug)
      .catch(error => error).finally(race.restore)).code).toBe('revision_conflict');
    const requests = () => engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(`SELECT slug, state, error_code FROM persistence_requests
      WHERE operation='extract_facts' AND slug = ANY($1::text[]) AND intent->>'origin' LIKE '%chats/source-loser%' ORDER BY sequence`, [[OTHER, TARGET]]);
    expect(await requests()).toEqual([{ slug: OTHER, state: 'conflict', error_code: 'revision_conflict' }, { slug: TARGET, state: 'conflict', error_code: 'revision_conflict' }]);
    const signature = (value: unknown) => engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      expect(await tx.executeRaw(`UPDATE persistence_requests SET intent=jsonb_set(intent, '{embedding}', $2::text::jsonb) WHERE operation='extract_facts'
        AND slug=$1 AND state='conflict' AND intent->>'origin' LIKE '%chats/source-loser%' RETURNING id`, [OTHER, JSON.stringify(value)])).toHaveLength(1);
    });
    const published = () => engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE fact = ANY($1::text[]) ORDER BY fact', [[CLAIM_OTHER, CLAIM_B]]);
    await signature({ model: 'openai:text-embedding-3-small', dimensions: 1536 });
    const stopped = await resumeManagedFacts(engine, await loser.session()).catch(error => error);
    expect([stopped.code, stopped.retryable]).toEqual(['revision_conflict', false]);
    expect(await requests()).toHaveLength(2);
    expect(await published()).toEqual([]);
    await signature(null);
    expect((await resumeManagedFacts(engine, await loser.session()))?.inserted).toBe(2);
    expect((await published()).map(row => row.fact).sort()).toEqual([CLAIM_OTHER, CLAIM_B].sort());
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: the facts-absorb job that lost the race completes in one attempt with one model call`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const calls = await stubExtraction(engine);
    const race = raceEntityReads(engine, 1, move);
    const result = await makeFactsAbsorbHandler(engine)(jobContext(loser, 1)).finally(race.restore) as { inserted: number };
    expect(race.moves()).toBe(1);
    expect(result.inserted).toBe(1);
    expect(calls.n).toBe(1);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: a standing refusal dead-letters the facts-absorb job on its first attempt; a retry calls no model`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 4);
    const calls = await stubExtraction(engine);
    const race = raceEntityReads(engine, 4, move);
    const handler = makeFactsAbsorbHandler(engine);
    const first: Error = await handler(jobContext(loser, 1)).then(() => new Error('the job completed')).catch(error => error).finally(race.restore);
    expect(jobRefusal(first)).toMatchObject({ code: 'revision_conflict' });
    expect(calls.n).toBe(1);
    const requests = await entityRequests(engine);
    expect(jobRefusal(await handler(jobContext(loser, 1)).catch(error => error))).toMatchObject({ code: 'revision_conflict' });
    expect(calls.n).toBe(1);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);
}
