/**
 * pages-03: a chronicle judge that is calling the model when the one-time upgrade re-read stores a page's values as
 * written is paid once, and its campaign keeps the page.
 *
 * 1. Protects: a `--max-usd` campaign row whose judge holds the lease when the new binary's first sync re-reads the
 *    unchanged file (a new content hash, nothing new to judge) ends with exactly one model call for that page, its spend
 *    recorded once, and the campaign stamp and attempt history on the page's live row.
 * 2. Fails when: the re-read leaves the leased row at the old hash and the write decision opens a fresh row at the new
 *    hash: the judge's publication is refused as superseded, its paid answer is dropped, and the next drain judges the
 *    page again outside the campaign (a second paid call, no cap, no attempt history).
 *    Also protects the same row waiting out a retry delay at the re-read: no drain judges the page until the delay ends,
 *    then the campaign row itself is judged at the new hash.
 * 3. Existing coverage: test/frontmatter-upgrade-reread.test.ts only checks that the leased row stays at the old hash
 *    and takes the judge's spend; it never runs the judge or a second drain.
 * 4. Runs on PGLite (the managed-brain fixture). The judge is the phase's injected judge, recording spend on the
 *    ambient BudgetTracker; the embedding provider is a stub. No network, no model calls.
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
import { campaignSpentUsd } from '../src/core/chronicle/campaign.ts';
import type { ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
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
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
  return oldHash;
}

/** A judge that records one priced call per invocation; the first call waits until the test releases it. */
function pausingJudge() {
  let entered!: () => void, release!: () => void;
  const inCall = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const judge = Object.assign((async () => {
    recordOnTracker(getCurrentBudgetTracker(), { modelId: CHAT, ...CALL, label: 'chronicle', kind: 'chat' });
    if (++judge.calls === 1) { entered(); await released; }
    return { events: [] };
  }) as ChronicleJudge, { calls: 0, inCall, release });
  return judge;
}

type LedgerRow = { content_hash: string; state: string; trigger: string; campaign_id: string | null; attempts: number; max_attempts: number | null; cost_usd: string | number | null };
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

/** One paid call in all, each spend once, all inside the campaign, and the live row is the campaign's with its outcome. */
async function expectJudgedOnceInCampaign(engine: BrainEngine, id: number, liveHash: string): Promise<void> {
  const rows = await engine.executeRaw<LedgerRow>(
    `SELECT content_hash, state, trigger, campaign_id, attempts, max_attempts, cost_usd FROM chronicle_page_state
      WHERE page_id=$1 AND extractor_version=$2 ORDER BY decided_at`, [id, CHRONICLE_EXTRACTOR_VERSION]);
  const spent = Math.round(rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0) * 10_000) / 10_000;
  expect(spent).toBe(0.25 + CALL_USD);
  expect(await campaignSpentUsd(engine, 'campaign-a')).toBe(0.25 + CALL_USD);
  // Both attempts count against the campaign's cap.
  expect(rows.find(row => row.content_hash === liveHash)).toMatchObject(
    { state: 'extracted', trigger: 'backfill', campaign_id: 'campaign-a', attempts: 2, max_attempts: 2 });
}

const inGateway = (body: () => Promise<void>) =>
  withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-reread-chronicle' }, async () => {
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, chat_model: CHAT, env: { OPENAI_API_KEY: 'sk-test-reread-chronicle' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
    try { await body(); } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });

describe('pages-03: the upgrade re-read while a chronicle judge is calling the model', () => {
  test('a campaign row leased by a running judge is judged once, its spend recorded once, its campaign kept', () => managedBrain(async ({ engine, root }) => {
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
      // The next drain finds nothing to judge.
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(1);
      await expectJudgedOnceInCampaign(engine, id, liveHash);
    });
  }, { setup }), 240_000);

  test('a campaign row waiting out its retry delay is judged once, at the new hash, when the delay ends', () => managedBrain(async ({ engine, root }) => {
    await inGateway(async () => {
      const { id, oldHash } = await campaignBrain(engine, '1 hour');
      const liveHash = await upgradeReread(engine, root, oldHash);
      await drainEffects(engine);
      const judge = pausingJudge();
      judge.release();
      // While the delay runs, no drain judges the page: not the write decision at the new hash either.
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(0);
      // The delay ends: the campaign row is judged, once.
      await engine.executeRaw(`UPDATE chronicle_page_state SET next_attempt_at = now() - interval '1 second' WHERE page_id=$1 AND content_hash=$2`, [id, oldHash]);
      await runPhaseChronicle(engine, { judge });
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(1);
      await expectJudgedOnceInCampaign(engine, id, liveHash);
    });
  }, { setup }), 240_000);
});
