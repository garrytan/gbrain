/**
 * GBRA-161 PR 0: every derived retirement is versioned, stamped and held from the purge for 30 days.
 *
 * Protects: (a) an unmanaged `extract_atoms` re-extraction versions each atom it retires and stamps it
 * `retired_by: extract-atoms`; past the 72 h purge window the engine bulk purge (preview and delete) and the coordinated
 * purge keep it while a plain tombstone of the same age goes, `restore_page` brings it back with its body, and the hold
 * ends 30 days after deletion; (b) an unmanaged chronicle re-judgment versions the event it retires before the soft
 * delete; (c) each derived stamp (extract-atoms, managed-reextract, stale-atoms, life-chronicle) is held on every purge
 * route, and an unknown stamp is not.
 * Fails when: a derived writer retires without a version or stamp, or a purge route removes a derived retirement inside
 * its hold (the pre-fix 72 h loss: purge cascades the page's page_versions with it).
 * Seams: the extract_atoms phase's `_transcripts` / `_chat` inputs and the chronicle phase's injected judge (no paid
 * call). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { DERIVED_RETIRED_BY } from '../../src/core/persistence/derived-retirement-hold.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const chat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` })));
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  };
};

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g0-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const extract = (engine: BrainEngine, titles: string[], hash: string) => runPhaseExtractAtoms(engine, {
  _transcripts: [{ filePath: '/fake/2026-09-07-meeting.txt', content: 'content', contentHash: hash }], _pages: [], _chat: chat(titles),
});
const atoms = async (engine: BrainEngine) => engine.executeRaw<{ slug: string; deleted: boolean; retired_by: string | null }>(
  "SELECT slug, deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by FROM pages WHERE type='atom' ORDER BY slug");
const versions = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1', [slug]))[0]!.n);
const backdate = (engine: BrainEngine, slug: string, hours: number) => engine.executeRaw(
  `UPDATE pages SET deleted_at = now() - ($2 || ' hours')::interval WHERE slug=$1`, [slug, String(hours)]);
const exists = async (engine: BrainEngine, slug: string) => (await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [slug])).length === 1;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 0 derived retirements are versioned, stamped and held (${backend})`, () => {
    test('an unmanaged atom re-extraction versions and stamps what it retires; every purge route holds it for 30 days', async () => {
      await withBrain(databaseUrl, async engine => {
        await extract(engine, ['Renders vs proof'], 'hash-one');
        const [old] = await atoms(engine);
        await extract(engine, ['Proof beats renders'], 'hash-two');
        const rows = await atoms(engine);
        const retired = rows.find(row => row.slug === old!.slug)!;
        expect(retired).toMatchObject({ deleted: true, retired_by: 'extract-atoms' });
        expect(rows.filter(row => !row.deleted)).toHaveLength(1);
        expect(await versions(engine, old!.slug)).toBeGreaterThan(0);

        await engine.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'A plain page.' });
        await engine.softDeletePage('notes/plain-example');
        await backdate(engine, 'notes/plain-example', 96);
        await backdate(engine, old!.slug, 96);
        expect((await engine.purgeDeletedPages(72, { dryRun: true })).slugs).toEqual(['notes/plain-example']);
        expect((await purgeDeletedPagesCoordinated(engine, 72)).slugs).toEqual(['notes/plain-example']);
        expect(await exists(engine, old!.slug)).toBe(true);

        await engine.restorePage(old!.slug);
        const [restored] = await engine.executeRaw<{ deleted: boolean; compiled_truth: string }>(
          'SELECT deleted_at IS NOT NULL AS deleted, compiled_truth FROM pages WHERE slug=$1', [old!.slug]);
        expect(restored).toMatchObject({ deleted: false });
        expect(restored!.compiled_truth).toContain('Renders vs proof body.');

        await engine.softDeletePage(old!.slug);
        await backdate(engine, old!.slug, 31 * 24);
        expect((await engine.purgeDeletedPages(72)).slugs).toEqual([old!.slug]);
      });
    }, 120_000);

    test('an unmanaged chronicle re-judgment versions the event it retires', async () => {
      await withBrain(databaseUrl, async engine => {
        const today = new Date().toISOString().slice(0, 10);
        const body = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
        const ev = (what: string) => ({ when: today, who: ['people/alice-example'], what, kind: 'commitment' });
        await engine.setConfig('chronicle.auto_settle_seconds', '0');
        await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
        await engine.putPage('meetings/sync', { type: 'meeting', title: 'Sync', compiled_truth: body, frontmatter: { date: today } });
        await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta')] }) });
        const [first] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE type='event'");
        await engine.putPage('meetings/sync', { type: 'meeting', title: 'Sync', compiled_truth: `${body} Wording changed.`, frontmatter: { date: today } });
        await runPhaseChronicle(engine, { judge: async () => ({ events: [ev('Alice agreed to ship the beta in May')] }) });
        const [row] = await engine.executeRaw<{ deleted: boolean; retired_by: string | null }>(
          "SELECT deleted_at IS NOT NULL AS deleted, frontmatter->>'retired_by' AS retired_by FROM pages WHERE slug=$1", [first!.slug]);
        expect(row).toEqual({ deleted: true, retired_by: 'life-chronicle' });
        expect(await versions(engine, first!.slug)).toBeGreaterThan(0);
      });
    }, 120_000);

    test('every derived stamp is held on every purge route; an unknown stamp is not', async () => {
      await withBrain(databaseUrl, async engine => {
        const stamps = [...DERIVED_RETIRED_BY, 'operator-cleanup'];
        for (const stamp of stamps) {
          const slug = `notes/${stamp}-example`;
          await engine.putPage(slug, { type: 'note', title: stamp, compiled_truth: `Retired by ${stamp}.`, frontmatter: { retired_by: stamp } });
          await engine.softDeletePage(slug);
          await backdate(engine, slug, 96);
        }
        expect((await engine.purgeDeletedPages(72, { dryRun: true })).slugs).toEqual(['notes/operator-cleanup-example']);
        expect((await purgeDeletedPagesCoordinated(engine, 72)).slugs).toEqual(['notes/operator-cleanup-example']);
        for (const stamp of DERIVED_RETIRED_BY) expect(await exists(engine, `notes/${stamp}-example`)).toBe(true);
      });
    }, 120_000);
  });
}
