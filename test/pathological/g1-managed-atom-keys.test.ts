/**
 * GBRA-161 PR 1b probes on managed atom keys and adoption (generations/adapters/atoms.ts, cycle/extract-atoms.ts):
 *   5. Two transcripts with one file name in two folders get two keys (root label plus root-relative path, never the
 *      basename) and two atoms; re-extracting one never retires or overwrites the other's.
 *   6. A transcript moved between runs keeps its key (the content pin matches the live generation whose file is gone):
 *      the generation's locator follows the file, and the next re-extraction of the moved file retires the atoms of
 *      the original key instead of leaving them orphaned under a second key.
 *   7. Populated-upgrade adoption: on the first managed publish of a page's atoms, an atom from before the ledger is
 *      adopted (and retired when the result no longer has it) only on retained extractor evidence equal to its current
 *      identity; a generated atom edited before the upgrade stays live and protected.
 * Seams: the phase's _transcripts / _pages / _chat inputs (no paid call). PGLite always, Postgres when DATABASE_URL is
 * set. Uses only APIs that exist before PR 1b, so it runs red on the PR 1a head.
 * Fails when: a transcript key is the basename or the absolute path (5, 6), or legacy ownership is read from origin
 * metadata alone (7).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const chat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: title + '.' })));
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } };
};

function transcript(path: string, root: string, label: string) {
  const content = String(require('node:fs').readFileSync(path, 'utf8'));
  return { filePath: path, content, contentHash: sha256(content), root: { path: root, label } };
}

async function extractTranscripts(engine: BrainEngine, items: ReturnType<typeof transcript>[], titles: string[]) {
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: items, _pages: [], _chat: chat(titles) });
  await disposePersistenceConsumer(engine);
  return result;
}

const transcriptAtoms = (engine: BrainEngine) => engine.executeRaw<{ slug: string; live: boolean; source_path: string; retired_by: string | null }>(
  "SELECT slug, deleted_at IS NULL AS live, frontmatter->>'source_path' AS source_path, frontmatter->>'retired_by' AS retired_by FROM pages WHERE source_id='default' AND type='atom' AND frontmatter ? 'source_path' ORDER BY slug");
const transcriptGenerations = (engine: BrainEngine) => engine.executeRaw<{ owner_key: string; locator: string | null }>(
  "SELECT owner_key, locator FROM derived_generations WHERE source_id='default' AND kind='atom' AND state='live' AND owner_key NOT LIKE 'source_slug:%' ORDER BY owner_key");
const said = (label: string) => (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(10);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('GBRA-161 PR 1b managed atom keys and adoption (' + backend + ')', () => {
    test('probe 5: one file name in two folders is two keys; re-extracting one leaves the other alone', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-g1-keys-'));
      try {
        const corpus = join(dir, 'corpus');
        const a = join(corpus, 'team-a', '2026-09-07-standup.txt');
        const b = join(corpus, 'team-b', '2026-09-07-standup.txt');
        mkdirSync(join(corpus, 'team-a'), { recursive: true }); mkdirSync(join(corpus, 'team-b'), { recursive: true });
        writeFileSync(a, said('team a')); writeFileSync(b, said('team b'));
        await managedBrain(async ({ engine }) => {
          expect((await extractTranscripts(engine, [transcript(a, corpus, 'corpus'), transcript(b, corpus, 'corpus')], ['Ship small changes'])).status).toBe('ok');
          expect((await transcriptGenerations(engine)).map(row => row.owner_key)).toEqual(['transcript:corpus/team-a/2026-09-07-standup.txt', 'transcript:corpus/team-b/2026-09-07-standup.txt']);
          const first = await transcriptAtoms(engine);
          expect(first.filter(row => row.live).map(row => row.source_path).sort()).toEqual([a, b]);
          writeFileSync(b, said('team b, revised'));
          expect((await extractTranscripts(engine, [transcript(b, corpus, 'corpus')], ['Review outcomes weekly'])).status).toBe('ok');
          const after = await transcriptAtoms(engine);
          expect(after.find(row => row.source_path === a && row.slug === first.find(old => old.source_path === a)!.slug)).toMatchObject({ live: true, retired_by: null });
          expect(after.filter(row => row.live).map(row => [row.source_path, row.slug.includes('review-outcomes-weekly')]).sort()).toEqual([[a, false], [b, true]]);
          expect(after.find(row => row.slug === first.find(old => old.source_path === b)!.slug)).toMatchObject({ live: false, retired_by: 'managed-reextract' });
        }, { databaseUrl });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 240_000);

    test('probe 6: a transcript moved between runs keeps its key and its next re-extraction retires the old atoms', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-g1-rename-'));
      try {
        const corpus = join(dir, 'corpus');
        const before = join(corpus, '2026-09-07-standup.txt');
        const moved = join(corpus, 'archive', '2026-09-07-standup.txt');
        mkdirSync(join(corpus, 'archive'), { recursive: true });
        writeFileSync(before, said('standup'));
        await managedBrain(async ({ engine }) => {
          expect((await extractTranscripts(engine, [transcript(before, corpus, 'corpus')], ['Ship small changes'])).status).toBe('ok');
          const [original] = (await transcriptAtoms(engine)).filter(row => row.live);
          renameSync(before, moved);
          await extractTranscripts(engine, [transcript(moved, corpus, 'corpus')], ['Ship small changes']);
          expect(await transcriptGenerations(engine)).toEqual([{ owner_key: 'transcript:corpus/2026-09-07-standup.txt', locator: moved }]);
          writeFileSync(moved, said('standup, revised'));
          expect((await extractTranscripts(engine, [transcript(moved, corpus, 'corpus')], ['Review outcomes weekly'])).status).toBe('ok');
          expect(await transcriptGenerations(engine)).toEqual([{ owner_key: 'transcript:corpus/2026-09-07-standup.txt', locator: moved }]);
          const after = await transcriptAtoms(engine);
          expect(after.find(row => row.slug === original!.slug)).toMatchObject({ live: false, retired_by: 'managed-reextract' });
          expect(after.filter(row => row.live).map(row => [row.source_path, row.slug.includes('review-outcomes-weekly')])).toEqual([[moved, true]]);
        }, { databaseUrl });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 240_000);

    test('probe 7: populated upgrade adopts an evidenced legacy atom and protects one edited before the upgrade', async () => {
      const NOTE = 'notes/acme-example-upgrade';
      await managedBrain(async ({ engine }) => {
        const page = (await engine.getPage(NOTE, { sourceId: 'default' }))!;
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [], _chat: chat(['Ship small changes']),
          _pages: [{ slug: NOTE, content: page.compiled_truth, contentHash: page.content_hash! }] });
        await disposePersistenceConsumer(engine);
        expect(result.status).toBe('ok');
        const rows = await engine.executeRaw<{ slug: string; live: boolean; retired_by: string | null; body: string }>(
          "SELECT slug, deleted_at IS NULL AS live, frontmatter->>'retired_by' AS retired_by, compiled_truth AS body FROM pages WHERE source_id='default' AND type='atom' ORDER BY slug");
        expect(rows.find(row => row.slug === 'atoms/2026-01-01/legacy-unedited')).toMatchObject({ live: false, retired_by: 'managed-reextract' });
        expect(rows.find(row => row.slug === 'atoms/2026-01-01/legacy-edited')).toMatchObject({ live: true, retired_by: null, body: 'A person corrected this atom before the upgrade.' });
        expect(rows.filter(row => row.live).map(row => row.slug.includes('ship-small-changes') || row.slug.endsWith('legacy-edited'))).toEqual([true, true]);
      }, { databaseUrl, setup: async ({ engine }) => {
        await engine.putPage(NOTE, { type: 'note', title: 'Acme example upgrade', compiled_truth: said('upgrade'), timeline: '' }, { sourceId: 'default' });
        const hash = (await engine.getPage(NOTE, { sourceId: 'default' }))!.content_hash!.slice(0, 16);
        for (const name of ['legacy-unedited', 'legacy-edited']) {
          const slug = 'atoms/2026-01-01/' + name;
          await engine.putPage(slug, { type: 'atom', title: name, compiled_truth: 'Extracted before the ledger existed.',
            frontmatter: { atom_type: 'insight', source_slug: NOTE, source_hash: 'earlier0000hash0', managed_extraction: true, dream_generated: true, extracted_by: 'extract_atoms-v0.41.2.1' } }, { sourceId: 'default' });
          await engine.createVersion(slug, { sourceId: 'default' });
        }
        const edited = (await engine.getPage('atoms/2026-01-01/legacy-edited', { sourceId: 'default' }))!;
        await engine.putPage(edited.slug, { ...edited, compiled_truth: 'A person corrected this atom before the upgrade.' }, { sourceId: 'default' });
        expect(hash).toHaveLength(16);
      } });
    }, 240_000);
  });
}
