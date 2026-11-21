/**
 * pages-03: a chronicle judge that is calling the model when the one-time upgrade re-read stores a page's values as
 * written keeps its spend in its campaign, and nothing it wrote is lost or taken from an operator.
 *
 * 1. Protects: the re-read never moves a pending or failed chronicle row (a paid judge may still be calling the model
 *    for it: no lease is provably over), so a `--max-usd` campaign row's spend and attempt history stay on its row at the
 *    old hash and the campaign counts every paid call once. The new hash is judged once more, outside the campaign, and
 *    the cycle marks the old row superseded. A chronicle attempt owns only the event pages whose live content is exactly
 *    what it proposed.
 * 2. Fails when: the re-read moves a row whose judge still runs (the lease ended, or the campaign's last attempt was
 *    failed as exhausted mid-call), so the judge's spend lands on a hash no row has and the campaign loses it; or when
 *    a failed activation adopts an operator's edit of an event the attempt wrote as the attempt's own, so a later
 *    generation overwrites the edit.
 * 3. Existing coverage: test/frontmatter-upgrade-reread.test.ts checks that a settled row moves with its page and that
 *    a leased row stays at the old hash and takes the judge's spend; it never runs the judge or a second drain.
 *    Also protects (pages-03 follow-up, the race cases):
 *    - a judge whose lease ended just before the re-read, and a judge whose lease ended before a later run, keep their
 *      spend (and a failure) on the row they claimed, inside the campaign;
 *    - the campaign's last attempt, failed as exhausted while its judge still runs, keeps its spend (finding 1);
 *    - a late judge never changes the new hash's decision;
 *    - events a publication wrote before the re-read superseded it stay owned by the page's ledger, also when the
 *      re-read renamed the page, so the next judging updates them instead of treating them as operator edits;
 *    - an operator edit made to such an event before the failed activation is never owned, and a later judging keeps
 *      it (finding 3);
 *    - a re-read with extraction off, and a re-read that renamed the page, judge nothing twice.
 * 4. Runs on PGLite and, with DATABASE_URL, on Postgres (the managed-brain fixture). The Rust engine serves no raw SQL,
 *    so the managed sync and the chronicle phase stop there with engine_capability_missing. The judge is the phase's
 *    injected judge, recording spend on the ambient BudgetTracker; the embedding provider is a stub. No network, no
 *    model calls.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setEmbedTransportForTests, configureGateway, getCurrentBudgetTracker, resetGateway } from '../src/core/ai/gateway.ts';
import { recordOnTracker } from '../src/core/ai/budget-record.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { contentHash } from '../src/core/utils.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from '../src/core/chronicle/contract.ts';
import { campaignSpentUsd, failExhaustedCampaignRows } from '../src/core/chronicle/campaign.ts';
import type { ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const DIMS = 1536, MODEL = 'openai:text-embedding-3-small', CHAT = 'anthropic:claude-sonnet-4-6';
/** One recorded judge call: 1000 input + 100 output tokens at the sonnet rate. */
const CALL = { inputTokens: 1000, outputTokens: 100 }, CALL_USD = 0.0045;
const SLUG = 'meetings/kept';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const meeting = `---\ntype: meeting\ntitle: ${SLUG}\ndate: 2024-03-01\nroom: 0101\n---\n\n${`The committed notes of ${SLUG}, about acme-example and widget-co. `.repeat(12)}\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'meetings'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, `${SLUG}.md`), meeting);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'meetings');
};
/** HEAD's tree as a new root commit, so the next sync walks the whole tree (as the first sync of a new binary does). */
function rewriteHistory(root: string): void {
  const rewritten = git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', 'HEAD^{tree}', '-m', `rewritten ${randomUUID().slice(0, 8)}`);
  git(root, 'reset', '-q', '--soft', rewritten); git(root, 'reflog', 'expire', '--expire=now', '--all'); git(root, 'gc', '-q', '--prune=now');
}
const vector = (text: string) => { const d = createHash('sha256').update(text).digest(); return Float32Array.from({ length: DIMS }, (_, i) => (d[i % 32]! - 128) / 128); };
async function drainEffects(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < 20; i++) if (!await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 50 })) break;
}
type Row = { id: number; title: string; type: string; compiled_truth: string; timeline: string | null; frontmatter: Record<string, unknown>; content_hash: string };
const pageRow = async (engine: BrainEngine) => (await engine.executeRaw<Row>(
  'SELECT id, title, type, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE slug=$1', [SLUG]))[0]!;
const revisionOf = async (engine: BrainEngine) => (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;

/** What an older gbrain left: the old typing stored, the hash it computed over that typing, and its parser version. */
async function storedByOlderGbrain(engine: BrainEngine): Promise<string> {
  let oldHash = '';
  await withManagedFixtureWrite(engine, ['default'], async tx => {
    const row = await pageRow(tx);
    const legacy = { ...row.frontmatter, ...legacyTypedFrontmatter(meeting) };
    expect(legacy).toMatchObject({ date: '2024-03-01T00:00:00.000Z', room: 101 });
    oldHash = contentHash({ title: row.title, type: row.type as never, compiled_truth: row.compiled_truth, timeline: row.timeline ?? '', frontmatter: legacy, tags: [] });
    await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb, content_hash=$2 WHERE slug=$3', [JSON.stringify(legacy), oldHash, SLUG]);
  });
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
    [SYNC_IMPORT_PROVENANCE_OP, await revisionOf(engine), String((await pageRow(engine)).id)]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"import=1;frontmatter=1;fence=1"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
  return oldHash;
}

/** A judge that records one priced call per invocation; the first call waits until the test releases it, then fails when `failFirst`. */
function pausingJudge(failFirst = false) {
  let entered!: () => void, release!: () => void;
  const inCall = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const judge = Object.assign((async () => {
    recordOnTracker(getCurrentBudgetTracker(), { modelId: CHAT, ...CALL, label: 'chronicle', kind: 'chat' });
    if (++judge.calls === 1) {
      entered(); await released;
      if (failFirst) throw new Error('provider error');
    }
    return { events: [] };
  }) as ChronicleJudge, { calls: 0, inCall, release });
  return judge;
}

const OPTS = { sourceId: 'default', noPull: true };

/**
 * A brain an older gbrain left with the page queued into a --max-usd campaign: one paid attempt failed (its spend and
 * its failed judge call recorded) and the retry is due at `retryAt`. Nothing else is recorded for the page. Automatic
 * extraction is on and settles at once, and the page is recent enough for it: a fresh write decision at the new hash is
 * judged by the next drain unless something stops it.
 */
async function campaignBrain(engine: BrainEngine, retryAt: string): Promise<{ id: number; oldHash: string }> {
  await engine.setConfig('auto_chronicle', 'true');
  await engine.setConfig('chronicle.auto_settle_seconds', '0');
  await engine.setConfig('chronicle.auto_recent_days', '3650');
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await drainEffects(engine);
  const oldHash = await storedByOlderGbrain(engine);
  const { id } = await pageRow(engine);
  await engine.executeRaw('DELETE FROM chronicle_page_state WHERE page_id=$1', [id]);
  await engine.executeRaw(`INSERT INTO chronicle_page_state (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
      attempts, next_attempt_at, cost_usd, cost_attempts, judge_input_failures, campaign_id, attempt_cap_usd, max_attempts, pricing_policy, campaign_max_usd)
    VALUES ('default', $1, $2, $3, $4, 'failed', 'judge_chat_error', 'backfill', 1, now() + $5::interval, 0.25, ARRAY[1], 0,
      'campaign-a', 0.25, 2, 'enforced', 5)`, [id, oldHash, CHRONICLE_EXTRACTOR_VERSION, SLUG, retryAt]);
  return { id, oldHash };
}

/** The new binary's first sync re-reads the unchanged file: the values as written, a new content hash. */
async function upgradeReread(engine: BrainEngine, root: string, oldHash: string): Promise<string> {
  rewriteHistory(root);
  expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced' });
  const reread = await pageRow(engine);
  expect(reread.frontmatter).toMatchObject({ date: '2024-03-01', room: '0101' });
  expect(reread.content_hash).not.toBe(oldHash);
  return reread.content_hash;
}

type LedgerRow = { content_hash: string; state: string; reason: string | null; trigger: string; campaign_id: string | null; attempts: number;
  max_attempts: number | null; cost_usd: string | number | null; event_slugs: string[] | null; event_hashes: string[] | null };
const ledger = (engine: BrainEngine, id: number) => engine.executeRaw<LedgerRow>(
  `SELECT content_hash, state, reason, trigger, campaign_id, attempts, max_attempts, cost_usd, event_slugs, event_hashes FROM chronicle_page_state
    WHERE page_id=$1 AND extractor_version=$2 ORDER BY decided_at`, [id, CHRONICLE_EXTRACTOR_VERSION]);
const usd = (value: number) => Math.round(value * 10_000) / 10_000;
const expireLease = (engine: BrainEngine, id: number, hash: string) =>
  engine.executeRaw(`UPDATE chronicle_page_state SET next_attempt_at = now() - interval '1 second' WHERE page_id=$1 AND content_hash=$2`, [id, hash]);

/**
 * The campaign row stays at the old hash with its attempts and every paid call it made (`campaignCalls`), counted once
 * in its campaign; the new hash was judged `outsideCalls` times, outside the campaign, and nothing else was paid.
 */
async function expectCampaignKeptItsSpend(engine: BrainEngine, id: number, hashes: { oldHash: string; liveHash: string },
  campaignCalls: number, outsideCalls: number): Promise<void> {
  const rows = await ledger(engine, id);
  expect(await campaignSpentUsd(engine, 'campaign-a')).toBe(usd(0.25 + campaignCalls * CALL_USD));
  expect(usd(rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0))).toBe(usd(0.25 + (campaignCalls + outsideCalls) * CALL_USD));
  expect(rows.filter(row => row.campaign_id === 'campaign-a')).toEqual([
    expect.objectContaining({ content_hash: hashes.oldHash, trigger: 'backfill', attempts: 1 + campaignCalls, max_attempts: 2 })]);
  if (outsideCalls) expect(rows.find(row => row.content_hash === hashes.liveHash)).toMatchObject({ state: 'extracted', campaign_id: null });
}

const inGateway = (body: () => Promise<void>) =>
  withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-reread-chronicle' }, async () => {
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, chat_model: CHAT, env: { OPENAI_API_KEY: 'sk-test-reread-chronicle' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
    try { await body(); } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });

/** A judge that proposes one event per call, recording one priced call each time. */
function eventJudge() {
  const judge = Object.assign((async () => {
    recordOnTracker(getCurrentBudgetTracker(), { modelId: CHAT, ...CALL, label: 'chronicle', kind: 'chat' });
    judge.calls++;
    return { events: [{ when: '2024-03-01T12:00:00Z', who: [], what: 'The team agreed on the plan for acme-example', kind: 'decision' }] };
  }) as ChronicleJudge, { calls: 0 });
  return judge;
}

/** `engine`, except that `hook` runs once, when the publication activates the page's events (its first deleted-inclusive read of the page). */
function beforeActivation(engine: BrainEngine, hook: (target: BrainEngine) => Promise<boolean>): BrainEngine {
  let done = false;
  return new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'readPageSnapshot') return typeof value === 'function' ? value.bind(target) : value;
      return async (slug: string, opts?: { includeDeleted?: boolean }) => {
        if (!done && slug === SLUG && opts?.includeDeleted) done = await hook(target);
        return target.readPageSnapshot(slug, opts as never);
      };
    },
  }) as BrainEngine;
}
const liveEvents = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE type='event' AND deleted_at IS NULL ORDER BY slug`)).map(r => r.slug);
const ownedBy = async (engine: BrainEngine, id: number) => {
  const rows = await ledger(engine, id);
  return { slugs: new Set(rows.flatMap(row => row.event_slugs ?? [])), hashes: new Set(rows.flatMap(row => row.event_hashes ?? [])) };
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
describe(`pages-03: the upgrade re-read while a chronicle judge is calling the model (${backend})`, () => {
  test('a campaign row leased by a running judge stays at its old hash: its spend lands once in its campaign and the new hash is judged once more', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      // The chronicle phase claims the row (its lease, the campaign's second attempt) and calls the model...
      const judge = pausingJudge();
      const firstDrain = runPhaseChronicle(engine, { judge });
      await judge.inCall;
      // ...while the new binary's first sync re-reads the unchanged file.
      const liveHash = await upgradeReread(engine, root, oldHash);
      judge.release();
      await firstDrain;
      await drainEffects(engine);
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash }, 1, 1);
    });
  }, { setup, databaseUrl }), 240_000);

  test('a campaign row waiting out its retry delay stays at its old hash and is superseded; the new hash is judged once', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '1 hour');
      const liveHash = await upgradeReread(engine, root, oldHash);
      await drainEffects(engine);
      const judge = pausingJudge();
      judge.release();
      await runPhaseChronicle(engine, { judge });
      // The delay ends: the old row is not judged, since its content is no longer live.
      await expireLease(engine, id, oldHash);
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(1);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash }, 0, 1);
      expect((await ledger(engine, id)).find(row => row.content_hash === oldHash)).toMatchObject({ state: 'skipped', reason: 'superseded' });
    });
  }, { setup, databaseUrl }), 240_000);

  test('a judge whose lease ended just before the re-read keeps its answer\'s spend in its campaign', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const judge = pausingJudge();
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const firstDrain = runPhaseChronicle(engine, { judge });
      await judge.inCall;
      // The judge's lease ends while it is still calling the model; then the re-read runs.
      await expireLease(engine, id, oldHash);
      const liveHash = await upgradeReread(engine, root, oldHash);
      await drainEffects(engine);
      judge.release();
      await firstDrain;
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash }, 1, 1);
    });
  }, { setup, databaseUrl }), 240_000);

  test('a failing judge whose lease ended before a later run keeps its failure\'s spend in its campaign', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const judge = pausingJudge(true);
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const firstDrain = runPhaseChronicle(engine, { judge });
      await judge.inCall;
      const liveHash = await upgradeReread(engine, root, oldHash);
      await drainEffects(engine);
      await expireLease(engine, id, oldHash);
      // A later run while the judge still runs: it judges the new hash and leaves the old row where it is.
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      judge.release();
      await firstDrain;
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash }, 1, 1);
    });
  }, { setup, databaseUrl }), 240_000);

  test('the campaign\'s last attempt, failed as exhausted while its judge still runs, keeps its spend through the re-read', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const judge = pausingJudge();
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      // The first attempt's executor crashed after its claim, so the row is still pending.
      await engine.executeRaw(`UPDATE chronicle_page_state SET state='pending', reason=NULL WHERE page_id=$1`, [id]);
      // The claim takes the campaign's last attempt (2 of 2) and the judge calls the model.
      const firstDrain = runPhaseChronicle(engine, { judge });
      await judge.inCall;
      // Its lease ends and the exhausted-row sweep fails the row: state failed, no retry time, the judge still running.
      await expireLease(engine, id, oldHash);
      await failExhaustedCampaignRows(engine);
      expect((await ledger(engine, id)).find(row => row.content_hash === oldHash)).toMatchObject({ state: 'failed', reason: 'campaign_exhausted', attempts: 2 });
      const liveHash = await upgradeReread(engine, root, oldHash);
      await drainEffects(engine);
      judge.release();
      await firstDrain;
      expect(await campaignSpentUsd(engine, 'campaign-a')).toBe(usd(0.25 + CALL_USD));
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash }, 1, 1);
    });
  }, { setup, databaseUrl }), 240_000);

  test('a late judge never changes the decision the re-read recorded for the new hash', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const judge = pausingJudge();
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const firstDrain = runPhaseChronicle(engine, { judge });
      await judge.inCall;
      await expireLease(engine, id, oldHash);
      // The re-read lands with extraction off (a --no-extract sync): the new hash is decided as a skip.
      rewriteHistory(root);
      expect(await performManagedSync(engine, { ...OPTS, noExtract: true })).toMatchObject({ status: 'synced' });
      await drainEffects(engine);
      const liveHash = (await pageRow(engine)).content_hash;
      expect(liveHash).not.toBe(oldHash);
      judge.release();
      await firstDrain;
      expect(judge.calls).toBe(1);
      const rows = await ledger(engine, id);
      const live = rows.find(row => row.content_hash === liveHash);
      expect(live).toMatchObject({ state: 'skipped', reason: 'no_extract', campaign_id: null });
      expect(Number(live!.cost_usd ?? 0)).toBe(0);
      expect(Number(rows.find(row => row.content_hash === oldHash)!.cost_usd)).toBeCloseTo(0.25 + CALL_USD, 10);
      expect(await campaignSpentUsd(engine, 'campaign-a')).toBe(usd(0.25 + CALL_USD));
    });
  }, { setup, databaseUrl }), 240_000);

  test('events a publication wrote before the re-read superseded it stay owned, so the next judging updates them', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const judge = eventJudge();
      // The re-read lands after the publication committed its event pages and before it activates them.
      let liveHash: string | null = null, firstEvents: string[] = [];
      await runPhaseChronicle(beforeActivation(engine, async target => {
        firstEvents = await liveEvents(target);
        if (firstEvents.length) liveHash = await upgradeReread(target, root, oldHash);
        return firstEvents.length > 0;
      }), { judge });
      expect(liveHash).not.toBeNull();
      expect(firstEvents.length).toBeGreaterThan(0);
      await drainEffects(engine);
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      const live = await liveEvents(engine);
      expect(live).toEqual(firstEvents);
      const [row] = (await ledger(engine, id)).filter(r => r.content_hash === liveHash);
      expect(row?.state).toBe('extracted');
      // The new hash's judging found them owned and recorded them as its own (an operator edit would be left out).
      expect([...(row?.event_slugs ?? [])].sort()).toEqual(live);
    });
  }, { setup, databaseUrl }), 240_000);

  test('events a publication wrote before a re-read that also renamed its page stay owned by the page\'s ledger', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const MOVED = 'meetings/moved';
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const judge = eventJudge();
      // The re-read also moves the page to another slug: an event's slug hashes its depth page, so the retry proposes
      // other slugs.
      let liveHash: string | null = null, firstEvents: string[] = [];
      await runPhaseChronicle(beforeActivation(engine, async target => {
        firstEvents = await liveEvents(target);
        if (!firstEvents.length) return false;
        git(root, 'mv', `${SLUG}.md`, `${MOVED}.md`);
        git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'move');
        expect(await performManagedSync(target, OPTS)).toMatchObject({ status: 'synced' });
        const [moved] = await target.executeRaw<{ id: number; content_hash: string }>('SELECT id, content_hash FROM pages WHERE slug=$1', [MOVED]);
        expect(moved?.id).toBe(id);
        expect(moved?.content_hash).not.toBe(oldHash);
        liveHash = moved!.content_hash;
        return true;
      }), { judge });
      expect(liveHash).not.toBeNull();
      await drainEffects(engine);
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      expect((await ledger(engine, id)).find(r => r.content_hash === liveHash)?.state).toBe('extracted');
      // Every live event the page produced, the first publication's included, is owned by the page's ledger.
      const owned = await ownedBy(engine, id);
      const live = await liveEvents(engine);
      expect(live.length).toBeGreaterThan(0);
      for (const slug of live) expect(owned.slugs.has(slug)).toBe(true);
    });
  }, { setup, databaseUrl }), 240_000);

  test('an operator edit to an event before its publication was superseded is never owned, and the next judging keeps it', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const EDIT = 'An operator corrected this event by hand.';
      const { id, oldHash } = await campaignBrain(engine, '-1 second');
      const judge = eventJudge();
      // After the publication committed its event page and before it activates it, an operator edits the event; then
      // the re-read supersedes the publication.
      let edited = '';
      await runPhaseChronicle(beforeActivation(engine, async target => {
        const [event] = await target.executeRaw<Row & { slug: string }>(
          `SELECT id, slug, title, type, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE type='event' AND deleted_at IS NULL`);
        if (!event) return false;
        edited = event.slug;
        const body = `${event.compiled_truth}\n\n${EDIT}`;
        await withManagedFixtureWrite(target, ['default'], tx => tx.executeRaw('UPDATE pages SET compiled_truth=$1, content_hash=$2 WHERE id=$3',
          [body, contentHash({ title: event.title, type: event.type as never, compiled_truth: body, timeline: event.timeline ?? '', frontmatter: event.frontmatter, tags: [] }), event.id]));
        await upgradeReread(target, root, oldHash);
        return true;
      }), { judge });
      expect(edited).not.toBe('');
      const [{ content_hash: editedHash }] = await engine.executeRaw<{ content_hash: string }>('SELECT content_hash FROM pages WHERE slug=$1', [edited]);
      expect((await ownedBy(engine, id)).hashes.has(editedHash)).toBe(false);
      // The new hash is judged and proposes the same event: the operator's edit stands.
      await drainEffects(engine);
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(2);
      const [after] = await engine.executeRaw<{ compiled_truth: string; deleted_at: string | null }>('SELECT compiled_truth, deleted_at FROM pages WHERE slug=$1', [edited]);
      expect(after).toMatchObject({ deleted_at: null });
      expect(after!.compiled_truth).toContain(EDIT);
      expect((await ownedBy(engine, id)).hashes.has(editedHash)).toBe(false);
    });
  }, { setup, databaseUrl }), 240_000);

  test('a re-read with extraction turned off keeps the page unjudged after the old row stops waiting', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '1 hour');
      rewriteHistory(root);
      expect(await performManagedSync(engine, { ...OPTS, noExtract: true })).toMatchObject({ status: 'synced' });
      await drainEffects(engine);
      const liveHash = (await pageRow(engine)).content_hash;
      expect(liveHash).not.toBe(oldHash);
      expect((await ledger(engine, id)).find(row => row.content_hash === liveHash)).toMatchObject({ state: 'skipped', reason: 'no_extract' });
      await expireLease(engine, id, oldHash);
      const judge = pausingJudge();
      judge.release();
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(0);
      expect((await ledger(engine, id)).find(row => row.content_hash === liveHash)).toMatchObject({ state: 'skipped', reason: 'no_extract' });
    });
  }, { setup, databaseUrl }), 240_000);

  test('a page renamed by the re-read is judged once at its new path; its waiting campaign row is not judged', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '1 hour');
      git(root, 'mv', `${SLUG}.md`, 'meetings/kept-renamed.md');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'rename');
      expect(await performManagedSync(engine, OPTS)).toMatchObject({ status: 'synced' });
      await drainEffects(engine);
      const [live] = await engine.executeRaw<{ id: number; slug: string; content_hash: string }>('SELECT id, slug, content_hash FROM pages WHERE id=$1 AND deleted_at IS NULL', [id]);
      expect(live).toMatchObject({ slug: 'meetings/kept-renamed' });
      expect(live!.content_hash).not.toBe(oldHash);
      const judge = pausingJudge();
      judge.release();
      await runPhaseChronicle(engine, { judge });
      await expireLease(engine, id, oldHash);
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(1);
      await expectCampaignKeptItsSpend(engine, id, { oldHash, liveHash: live!.content_hash }, 0, 1);
    });
  }, { setup, databaseUrl }), 240_000);
});
}
