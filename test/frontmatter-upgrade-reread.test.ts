/**
 * pages-03: the one-time sync re-read after the upgrade (SYNC_IMPORT_PARSER_VERSION moved) costs nothing paid.
 *
 * 1. Protects: when a brain written by an older gbrain (records naming the older parser, dates and numbers stored under
 *    the old typing) syncs once with this parser, a page whose file did not change makes no embedding call and queues
 *    no fact extraction: a page with no affected value keeps its revision, and a page with one stores the values as
 *    written with its chunks and embeddings untouched. No file is held and no file is rewritten.
 * 2. Fails when: the parser change re-embeds or re-extracts an unchanged page, or the re-read leaves the old typing.
 *    The paid page phases keyed on the page's content hash (extract_atoms' scan state, chronicle's ledger) keep their
 *    records across that re-read when the page's meaning is unchanged, so neither scans or judges it again; a page whose
 *    file did change is scanned again.
 * 3. Runs on PGLite (the managed-brain fixture). The embedding provider is a spy; no network, no model calls.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { contentHash } from '../src/core/utils.ts';
import { discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from '../src/core/chronicle/contract.ts';
import { campaignSpentUsd } from '../src/core/chronicle/campaign.ts';
import { listHeldManagedAtoms } from '../src/core/persistence/atom-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const DIMS = 1536, MODEL = 'openai:text-embedding-3-small';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PLAIN = ['notes/a', 'notes/b', 'notes/c'];
const TYPED = ['people/d', 'people/e'];
const plain = (slug: string) => `---\ntype: concept\ntitle: ${slug}\ntags: [alpha, beta]\n---\n\nThe committed body of ${slug}, about acme-example.\n`;
const typed = (slug: string) => `---\ntype: person\ntitle: ${slug}\nborn: 1990-05-01\nzip: 02134\nversion: 1.10\n---\n\nThe committed body of ${slug}.\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of PLAIN) writeFileSync(join(root, `${slug}.md`), plain(slug));
  for (const slug of TYPED) writeFileSync(join(root, `${slug}.md`), typed(slug));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};
/** HEAD's tree as a new root commit, so the next sync walks the whole tree (as the first sync of a new binary does). */
function rewriteHistory(root: string): void {
  const rewritten = git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', 'HEAD^{tree}', '-m', `rewritten ${randomUUID().slice(0, 8)}`);
  git(root, 'reset', '-q', '--soft', rewritten); git(root, 'reflog', 'expire', '--expire=now', '--all'); git(root, 'gc', '-q', '--prune=now');
}
const vector = (text: string) => { const d = createHash('sha256').update(text).digest(); return Float32Array.from({ length: DIMS }, (_, i) => (d[i % 32]! - 128) / 128); };

/** Runs every queued effect to the end (the embedding provider is the gateway's spy transport). */
async function drainEffects(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < 20; i++) if (!await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 50 })) break;
}
const effectCounts = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ kind: string; n: number }>(
  'SELECT kind, count(*)::int AS n FROM persistence_effects GROUP BY kind')).map(row => [row.kind, row.n]));
const chunkRows = (engine: BrainEngine) => engine.executeRaw<Record<string, unknown>>(`SELECT p.slug, c.id, c.chunk_index, c.chunk_text,
  c.embedding::text AS embedding, c.embedded_text_hash FROM content_chunks c JOIN pages p ON p.id=c.page_id ORDER BY p.slug, c.chunk_index`);
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;

describe('pages-03: the one-time re-read after the upgrade', () => {
  test('pages whose files did not change make no embedding call and queue no fact extraction', () => managedBrain(async ({ engine, root }) => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-upgrade-reread' }, async () => {
      const embedded: string[] = [];
      configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-upgrade-reread' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { embedded.push(...values); return { embeddings: values.map(v => Array.from(vector(v))) }; }) as never);
      try {
        const opts = { sourceId: 'default', noPull: true };
        expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
        await drainEffects(engine);
        expect(embedded.length).toBeGreaterThan(0); // the first sync embedded every page: the spy sees real calls
        const chunksBefore = await chunkRows(engine);
        expect(chunksBefore.every(row => row.embedding !== null)).toBe(true);

        // What an older gbrain left: its parser named in every record and on the pass row, the old typing stored.
        await withManagedFixtureWrite(engine, ['default'], async tx => {
          for (const slug of TYPED) {
            const [row] = await tx.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE slug=$1', [slug]);
            await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug=$2', [JSON.stringify({ ...row!.frontmatter, ...legacyTypedFrontmatter(typed(slug)) }), slug]);
          }
        });
        // The fixture write moved the revision; the older binary's record named the revision it imported, so name this one.
        for (const slug of TYPED) await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
          [SYNC_IMPORT_PROVENANCE_OP, await revisionOf(engine, slug), String((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.id)]);
        expect((await engine.getPage('people/d'))!.frontmatter).toMatchObject({ born: '1990-05-01T00:00:00.000Z', zip: 2134, version: 1.1 });
        await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
        await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
        const revisions = new Map(await Promise.all([...PLAIN, ...TYPED].map(async slug => [slug, await revisionOf(engine, slug)] as const)));
        const effectsBefore = await effectCounts(engine);
        embedded.length = 0;
        // The first sync of the new binary walks the whole tree.
        rewriteHistory(root);
        const reread = await performManagedSync(engine, opts);
        expect(reread).toMatchObject({ status: 'synced', pass: { kind: 'full', candidates: PLAIN.length + TYPED.length },
          waived: { imports: PLAIN.length }, modified: TYPED.length, embedded: 0 });
        // No file is held, and no file is rewritten: the re-read stores the written values from the unchanged files.
        expect((await readGitSourceHolds(engine, { sourceIds: ['default'] })).flatMap(entry => entry.holds.map(hold => `${hold.path}: ${hold.code}`))).toEqual([]);
        expect(git(root, 'status', '--porcelain')).toBe('');
        await drainEffects(engine);

        expect(embedded).toEqual([]);
        const effectsAfter = await effectCounts(engine);
        expect(effectsAfter['facts-backstop'] ?? 0).toBe(effectsBefore['facts-backstop'] ?? 0);
        expect(await chunkRows(engine)).toEqual(chunksBefore);
        for (const slug of PLAIN) expect(await revisionOf(engine, slug)).toBe(revisions.get(slug)!);
        for (const slug of TYPED) expect((await engine.getPage(slug))!.frontmatter).toMatchObject({ born: '1990-05-01', zip: '02134', version: '1.10' });
      } finally { __setEmbedTransportForTests(null); resetGateway(); }
    });
  }, { setup }), 240_000);

  const MEETINGS = ['meetings/kept', 'meetings/edited'];
  const meeting = (slug: string, room = '0101') => `---\ntype: meeting\ntitle: ${slug}\ndate: 2024-03-01\nroom: ${room}\n---\n\n${`The committed notes of ${slug}, about acme-example and widget-co. `.repeat(12)}\n`;
  const meetingSetup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'meetings'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of MEETINGS) writeFileSync(join(root, `${slug}.md`), meeting(slug));
    git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'meetings');
  };
  type Row = { id: number; title: string; type: string; compiled_truth: string; timeline: string | null; frontmatter: Record<string, unknown>; content_hash: string };
  const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<Row>(
    'SELECT id, title, type, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE slug=$1', [slug]))[0]!;
  const hashOf = (row: Row, frontmatter: Record<string, unknown>) => contentHash({ title: row.title, type: row.type as never, compiled_truth: row.compiled_truth, timeline: row.timeline ?? '', frontmatter, tags: [] });
  /** What an older gbrain left for each meeting: the old typing stored, the hash it computed over that typing, and its parser version. */
  const storedByOlderGbrain = async (engine: BrainEngine): Promise<Map<string, string>> => {
    const oldHash = new Map<string, string>();
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      for (const slug of MEETINGS) {
        const row = await pageRow(tx, slug);
        expect(hashOf(row, row.frontmatter)).toBe(row.content_hash); // the stored hash is the formula over the stored values
        const legacy = { ...row.frontmatter, ...legacyTypedFrontmatter(meeting(slug)) };
        expect(legacy).toMatchObject({ date: '2024-03-01T00:00:00.000Z', room: 101 });
        oldHash.set(slug, hashOf(row, legacy));
        await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb, content_hash=$2 WHERE slug=$3', [JSON.stringify(legacy), oldHash.get(slug), slug]);
      }
    });
    for (const slug of MEETINGS) await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
      [SYNC_IMPORT_PROVENANCE_OP, await revisionOf(engine, slug), String((await pageRow(engine, slug)).id)]);
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
    return oldHash;
  };
  /** The embedding provider stubbed, as every managed write here embeds. */
  const withStubEmbeddings = (run: () => Promise<void>) => withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-upgrade-reread' }, async () => {
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-upgrade-reread' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
    try { await run(); } finally { __setEmbedTransportForTests(null); resetGateway(); }
  });

  test('a re-read that changes only how values are kept does not scan or judge the page again', () => managedBrain(async ({ engine, root }) => {
    await withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-upgrade-reread' }, async () => {
      configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-upgrade-reread' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
      try {
        const opts = { sourceId: 'default', noPull: true };
        expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
        await drainEffects(engine);
        const oldHash = await storedByOlderGbrain(engine);
        // The older gbrain scanned both pages for atoms and judged both for events, at the hash it stored, and kept
        // no record at a hash it never computed (this fixture's own first sync left one there).
        for (const slug of MEETINGS) {
          const { id } = await pageRow(engine, slug);
          await engine.executeRaw('DELETE FROM chronicle_page_state WHERE page_id=$1', [id]);
          await engine.executeRaw('DELETE FROM extract_atoms_page_state WHERE page_id=$1', [id]);
          await engine.executeRaw(`INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
            SELECT incarnation, $1, $2, 0, true FROM sources WHERE id='default'`, [id, oldHash.get(slug)]);
          await engine.executeRaw(`INSERT INTO chronicle_page_state (source_id, page_id, content_hash, extractor_version, slug, state, trigger, event_hashes,
              cost_usd, campaign_id, judge_input_failures)
            VALUES ('default', $1, $2, $3, $4, 'extracted', 'auto', ARRAY['event-hash-1'], 0.25, 'campaign-a', 3)`, [id, oldHash.get(slug), CHRONICLE_EXTRACTOR_VERSION, slug]);
        }
        expect(await discoverExtractablePages(engine, 'default', MEETINGS)).toEqual([]);

        // One file changed what it says before the new binary's first sync, which walks the whole tree.
        writeFileSync(join(root, 'meetings/edited.md'), meeting('meetings/edited', '0102'));
        git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'edit');
        rewriteHistory(root);
        expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: MEETINGS.length });

        const kept = await pageRow(engine, 'meetings/kept'), edited = await pageRow(engine, 'meetings/edited');
        expect(kept.frontmatter).toMatchObject({ date: '2024-03-01', room: '0101' });
        expect(kept.content_hash).not.toBe(oldHash.get('meetings/kept'));
        expect(edited.frontmatter).toMatchObject({ room: '0102' });
        // extract_atoms discovery: only the page whose meaning changed is scanned again.
        expect((await discoverExtractablePages(engine, 'default', MEETINGS)).map(page => page.slug)).toEqual(['meetings/edited']);
        // chronicle: the kept page keeps its judged record at its live hash, so nothing judges it again; the edited
        // page gets a fresh decision for what it now says, not the old record.
        const ledger = await engine.executeRaw<{ slug: string; state: string; event_hashes: string[] }>(`SELECT c.slug, c.state, c.event_hashes FROM chronicle_page_state c
          JOIN pages p ON p.id=c.page_id AND p.content_hash=c.content_hash WHERE c.extractor_version=$1 ORDER BY c.slug`, [CHRONICLE_EXTRACTOR_VERSION]);
        expect(ledger).toEqual([{ slug: 'meetings/edited', state: 'skipped', event_hashes: [] },
          { slug: 'meetings/kept', state: 'extracted', event_hashes: ['event-hash-1'] }]);
        // The record moved, it was not copied: recorded spend and failed judge attempts count once.
        expect(await campaignSpentUsd(engine, 'campaign-a')).toBe(0.5);
        const keptRows = await engine.executeRaw<{ n: number; failures: number }>(
          'SELECT count(*)::int AS n, sum(judge_input_failures)::int AS failures FROM chronicle_page_state WHERE page_id=$1', [kept.id]);
        expect(keptRows).toEqual([{ n: 1, failures: 3 }]);
      } finally { __setEmbedTransportForTests(null); resetGateway(); }
    });
  }, { setup: meetingSetup }), 240_000);

  test('a re-read keeps a managed atom partial or held disposition, so neither unchanged page is sent to the model again', () => managedBrain(async ({ engine, root }) => {
    await withStubEmbeddings(async () => {
      const opts = { sourceId: 'default', noPull: true };
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      await drainEffects(engine);
      const oldHash = await storedByOlderGbrain(engine);
      // The older gbrain's managed atom drain read meetings/kept under a 4,096-character cap and held meetings/edited
      // after repeated failures; a managed brain records both only in its checkpoints, never in the scan state.
      const dispositions = [['meetings/kept', { partial: 4096 }], ['meetings/edited', { failure: 'judge_parse_failed', attempts: 3, held: true }]] as const;
      for (const [slug, disposition] of dispositions) {
        const { id } = await pageRow(engine, slug);
        await engine.executeRaw('DELETE FROM extract_atoms_page_state WHERE page_id=$1', [id]);
        await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
          SELECT 'managed-atoms', $1::text, jsonb_build_array(jsonb_build_object('sourceId', 'default', 'incarnation', incarnation::text, 'requestId', $1::text,
            'kind', 'page', 'locator', $2::text, 'pageId', $3::int, 'contentHash', $4::text) || $5::text::jsonb) FROM sources WHERE id='default'`,
          [`older-run-${slug}`, slug, id, oldHash.get(slug), JSON.stringify(disposition)]);
      }
      const held = async () => (await listHeldManagedAtoms(engine, ['default'])).map(entry => entry.locator);
      expect(await discoverExtractablePages(engine, 'default', MEETINGS)).toEqual([]);
      expect(await held()).toEqual(['meetings/edited']);

      rewriteHistory(root);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: MEETINGS.length });
      for (const slug of MEETINGS) expect((await pageRow(engine, slug)).content_hash).not.toBe(oldHash.get(slug));
      expect(await discoverExtractablePages(engine, 'default', MEETINGS)).toEqual([]);
      expect(await held()).toEqual(['meetings/edited']);
    });
  }, { setup: meetingSetup }), 240_000);
});
