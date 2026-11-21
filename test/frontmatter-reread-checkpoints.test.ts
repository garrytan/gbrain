/**
 * pages-03: the one-time sync re-read after the upgrade keeps a managed atom page's failure count and its held retry.
 *
 * 1. Protects: a page whose managed atom extraction failed (malformed model output) under an older gbrain, stored
 *    with the old frontmatter typing, keeps its paid-attempt bound across the re-read that changes its content hash
 *    and nothing it means: after two failed attempts it gets exactly one more model call before it is held. A page
 *    the older gbrain held after three failures stays held, and the retry its hold displays (the held request) still
 *    recovers it after the re-read.
 * 2. Fails when: the re-read carries the failure checkpoint where the drain never reads it (the page gets three more
 *    paid attempts), or the held page's retry still names the old content hash (the retry is refused
 *    revision_conflict and the page can never be recovered by the displayed retry).
 *    Also protects (pages-03 follow-up): the same bound for a page the input cap cut, whose failed requests' receipts
 *    were compacted before the upgrade (fails when the carried failure count is filed under a key the drain never reads,
 *    so the page gets three more paid attempts); and the displayed retry of a held page renamed in the same sync as the
 *    re-read (fails when the retry reads the page at its old slug and is refused source_changed).
 * 3. Runs on PGLite and, with DATABASE_URL, on Postgres (the managed-brain fixture). The Rust engine serves no raw SQL,
 *    so the managed sync stops there with engine_capability_missing. The model and the embedding provider are stubs;
 *    no network.
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
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { contentHash } from '../src/core/utils.ts';
import { discoverExtractablePages, MAX_DETERMINISTIC_FAILURES, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { listHeldManagedAtoms } from '../src/core/persistence/atom-maintenance.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { EXTRACT_MAX_INPUT_CHARS_KEY } from '../src/core/cycle/extract-atoms-input.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const DIMS = 1536, MODEL = 'openai:text-embedding-3-small';
const SLUG = 'meetings/kept';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const meeting = `---\ntype: meeting\ntitle: ${SLUG}\ndate: 2024-03-01\nroom: 0101\n---\n\n${`The committed notes of ${SLUG}, about acme-example and widget-co. `.repeat(20)}\n`;
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
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
type Row = { id: number; title: string; type: string; compiled_truth: string; timeline: string | null; frontmatter: Record<string, unknown>; content_hash: string };
const pageRow = async (engine: BrainEngine, slug = SLUG) => (await engine.executeRaw<Row>(
  'SELECT id, title, type, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE slug=$1', [slug]))[0]!;
const hashOf = (row: Row, frontmatter: Record<string, unknown>) => contentHash({ title: row.title, type: row.type as never, compiled_truth: row.compiled_truth, timeline: row.timeline ?? '', frontmatter, tags: [] });

/** What an older gbrain left: the old typing stored, the hash it computed over that typing, and its parser version. */
async function storedByOlderGbrain(engine: BrainEngine): Promise<string> {
  let oldHash = '';
  await withManagedFixtureWrite(engine, ['default'], async tx => {
    const row = await pageRow(tx);
    const legacy = { ...row.frontmatter, ...legacyTypedFrontmatter(meeting) };
    expect(legacy).toMatchObject({ date: '2024-03-01T00:00:00.000Z', room: 101 });
    oldHash = hashOf(row, legacy);
    await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb, content_hash=$2 WHERE slug=$3', [JSON.stringify(legacy), oldHash, SLUG]);
  });
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
    [SYNC_IMPORT_PROVENANCE_OP, await revisionOf(engine, SLUG), String((await pageRow(engine)).id)]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"import=1;frontmatter=1;fence=1"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
  return oldHash;
}

/** A model stub: malformed output unless a valid reply is queued. Counts every call (each one is paid). */
function model() {
  const replies: string[] = [];
  let calls = 0;
  const chat = async (): Promise<ChatResult> => {
    calls++;
    return { text: replies.shift() ?? 'not valid output', blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { replies, chat, calls: () => calls };
}
const VALID = JSON.stringify([{ title: 'Measured progress', atom_type: 'insight', body: 'Measure progress against clear exit criteria.' }]);

/** One managed atom drain of the page at its current stored content, as the cycle runs it. */
async function extract(engine: BrainEngine, chat: () => Promise<ChatResult>, slug = SLUG) {
  const row = await pageRow(engine, slug);
  const run = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
    _pages: [{ slug, content: row.compiled_truth, contentHash: row.content_hash }], _chat: chat as never });
  await disposePersistenceConsumer(engine);
  return run;
}

const withStubs = (run: () => Promise<void>) => withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-reread-checkpoints' }, async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-reread-checkpoints' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
  try { await run(); } finally { __setEmbedTransportForTests(null); __setChatTransportForTests(null); resetGateway(); }
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
describe(`pages-03: the re-read keeps managed atom failure checkpoints usable (${backend})`, () => {
  test('a page with two failed paid attempts gets exactly one more model call after the re-read before it is held', () => managedBrain(async ({ engine, root }) => {
    await withStubs(async () => {
      const opts = { sourceId: 'default', noPull: true };
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      await drainEffects(engine);
      const oldHash = await storedByOlderGbrain(engine);
      const m = model();
      // The older gbrain's drain sent the page to the model twice; both replies were malformed.
      for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES - 1; attempt++) {
        expect((await extract(engine, m.chat)).details?.malformed_outputs).toBe(1);
        expect(m.calls()).toBe(attempt);
      }
      expect(await listHeldManagedAtoms(engine, ['default'])).toEqual([]);

      rewriteHistory(root);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: 1 });
      expect((await pageRow(engine)).content_hash).not.toBe(oldHash);

      // The bound is per content, and the re-read changed nothing the page means: one attempt is left.
      for (let run = 0; run < MAX_DETERMINISTIC_FAILURES; run++) await extract(engine, m.chat);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES);
      expect((await listHeldManagedAtoms(engine, ['default'])).map(entry => [entry.locator, entry.attempts])).toEqual([[SLUG, MAX_DETERMINISTIC_FAILURES]]);
      expect(await discoverExtractablePages(engine, 'default', [SLUG])).toEqual([]);
    });
  }, { setup, databaseUrl }), 240_000);

  test('the retry a held page displays still recovers it after the re-read', () => managedBrain(async ({ engine, root }) => {
    await withStubs(async () => {
      const opts = { sourceId: 'default', noPull: true };
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      await drainEffects(engine);
      const oldHash = await storedByOlderGbrain(engine);
      const m = model();
      for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES; attempt++) await extract(engine, m.chat);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES);
      const [heldBefore] = await listHeldManagedAtoms(engine, ['default']);
      expect(heldBefore).toMatchObject({ locator: SLUG, attempts: MAX_DETERMINISTIC_FAILURES });

      rewriteHistory(root);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: 1 });
      expect((await pageRow(engine)).content_hash).not.toBe(oldHash);
      // Still held, and the hold still names the request its reviewed retry runs on.
      const held = await listHeldManagedAtoms(engine, ['default']);
      expect(held.map(entry => entry.locator)).toEqual([SLUG]);
      const requestId = held[0]!.request_id;
      expect(requestId).toBe(heldBefore!.request_id);

      // The user approves the displayed retry (gbrain jobs submit extract-atoms-drain --params {sourceId, retryRequestId}).
      m.replies.push(VALID);
      __setChatTransportForTests(m.chat as never);
      const retried = await retryManagedAtomBatch(engine, 'default', requestId, 'reviewed-retry-after-reread');
      await disposePersistenceConsumer(engine);
      expect(retried).toMatchObject({ status: 'ok', model_rerun: true });
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
      expect(await listHeldManagedAtoms(engine, ['default'])).toEqual([]);
      const atoms = await engine.executeRaw<{ source_slug: string }>("SELECT frontmatter->>'source_slug' AS source_slug FROM pages WHERE type='atom' AND deleted_at IS NULL");
      expect(atoms).toEqual([{ source_slug: SLUG }]);
      // Recovered for good: the next drain neither discovers nor calls the model for it.
      expect(await discoverExtractablePages(engine, 'default', [SLUG])).toEqual([]);
      await extract(engine, m.chat);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
    });
  }, { setup, databaseUrl }), 240_000);

  test('a cut page with two failed paid attempts and compacted receipts gets exactly one more model call after the re-read', () => managedBrain(async ({ engine, root }) => {
    await withStubs(async () => {
      const opts = { sourceId: 'default', noPull: true };
      await engine.setConfig(EXTRACT_MAX_INPUT_CHARS_KEY, '1000');
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      expect((await pageRow(engine)).compiled_truth.length).toBeGreaterThan(1000);
      await drainEffects(engine);
      const oldHash = await storedByOlderGbrain(engine);
      const m = model();
      // The older gbrain's drain read the page's first 1000 characters twice; both replies were malformed.
      for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES - 1; attempt++) await extract(engine, m.chat);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES - 1);
      // Its receipts aged out: the requests no longer say where the page was cut.
      await Bun.sleep(5);
      expect(await compactWriteReceipts(engine, 0)).toBeGreaterThan(0);
      const intents = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM persistence_requests WHERE intent->'origin'->>'partialInputChars' IS NOT NULL`);
      expect(intents[0]!.n).toBe(0);

      rewriteHistory(root);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: 1 });
      expect((await pageRow(engine)).content_hash).not.toBe(oldHash);

      for (let run = 0; run < MAX_DETERMINISTIC_FAILURES; run++) await extract(engine, m.chat);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES);
      expect((await listHeldManagedAtoms(engine, ['default'])).map(entry => [entry.locator, entry.attempts])).toEqual([[SLUG, MAX_DETERMINISTIC_FAILURES]]);
    });
  }, { setup, databaseUrl }), 240_000);

  test('the retry a held page displays recovers it after a re-read that also renamed it', () => managedBrain(async ({ engine, root }) => {
    await withStubs(async () => {
      const opts = { sourceId: 'default', noPull: true };
      const MOVED = 'meetings/moved';
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      await drainEffects(engine);
      const oldHash = await storedByOlderGbrain(engine);
      const m = model();
      for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES; attempt++) await extract(engine, m.chat);
      const [heldBefore] = await listHeldManagedAtoms(engine, ['default']);
      expect(heldBefore).toMatchObject({ locator: SLUG, attempts: MAX_DETERMINISTIC_FAILURES });

      // The upgrade's first sync finds the file moved to another name, unchanged: one rename the sync reads anew.
      git(root, 'mv', `${SLUG}.md`, `${MOVED}.md`);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'move');
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced' });
      const moved = await pageRow(engine, MOVED);
      expect(moved?.content_hash).not.toBe(oldHash);
      const held = await listHeldManagedAtoms(engine, ['default']);
      expect(held.map(entry => entry.locator)).toEqual([MOVED]);
      expect(held[0]!.request_id).toBe(heldBefore!.request_id);

      m.replies.push(VALID);
      __setChatTransportForTests(m.chat as never);
      const retried = await retryManagedAtomBatch(engine, 'default', held[0]!.request_id, 'reviewed-retry-after-rename');
      await disposePersistenceConsumer(engine);
      expect(retried).toMatchObject({ status: 'ok', model_rerun: true });
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
      expect(await listHeldManagedAtoms(engine, ['default'])).toEqual([]);
      const atoms = await engine.executeRaw<{ source_slug: string }>("SELECT frontmatter->>'source_slug' AS source_slug FROM pages WHERE type='atom' AND deleted_at IS NULL");
      expect(atoms).toEqual([{ source_slug: MOVED }]);
      await extract(engine, m.chat, MOVED);
      expect(m.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
    });
  }, { setup, databaseUrl }), 240_000);
});
}
