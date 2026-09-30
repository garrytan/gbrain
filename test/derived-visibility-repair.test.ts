/**
 * #5525 completion: extraction, synthesis and the tighten-only backfill stamp
 * explicit visibility on derived pages, and a later private flip of an origin
 * page reaches its atoms and concepts. Stubbed LLM; PGLite + Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { runPhaseWithStoredPageFixtures } from './helpers/extract-atoms-page-fixtures.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'gbrain-derived-visibility-'));

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const ctx = (engine: BrainEngine, remote: boolean, sourceId = 'default') => ({ engine, config: { engine: engine.kind, embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId }) as never;

async function remoteSees(engine: BrainEngine, slug: string): Promise<boolean> {
  __resetPrivateVisibilityCacheForTests();
  try { return ((await operationsByName.get_page.handler(ctx(engine, true), { slug })) as { slug: string }).slug === slug; }
  catch (error) { if (/Page not found/.test(String(error))) return false; throw error; }
}

async function seed(engine: BrainEngine, slug: string, type: string, frontmatter: Record<string, unknown>, body = `${slug} body text`) {
  const result = await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type: type as never, title: slug, tags: [] }),
    { noEmbed: true, forceRechunk: true });
  expect(['imported', 'skipped']).toContain(result.status);
}

const visibilityOf = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ v: string | null }>("SELECT frontmatter->>'visibility' AS v FROM pages WHERE slug=$1 AND source_id='default'", [slug]))[0]?.v ?? null;

async function reset(engine: BrainEngine) {
  await engine.executeRaw("DELETE FROM links"); await engine.executeRaw("DELETE FROM content_chunks"); await engine.executeRaw("DELETE FROM pages");
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
}

const stubChat = async (o: ChatOpts): Promise<ChatResult> => {
  const label = String(o.messages[0]?.content ?? '').split('\n')[0].replace('Source: ', '').replace(/[^a-z0-9]+/gi, ' ').trim();
  return { text: JSON.stringify([{ title: `Insight from ${label}`, atom_type: 'insight', body: `Quokkaword insight distilled from ${label}.` }]),
    blocks: [{ type: 'text', text: '' }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
};

describe('#5525 extraction stamps the origin visibility on every atom (non-managed path)', () => {
  test('private page and transcript atoms are private and hidden remotely; a world page yields a readable world atom', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/private-origin', 'note', { visibility: 'private' }, 'A private planning record.');
      await seed(engine, 'notes/world-origin', 'note', {}, 'A public planning record.');
      const pageRow = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!;
      const result = await runPhaseWithStoredPageFixtures(engine, {
        _pages: await Promise.all(['notes/private-origin', 'notes/world-origin'].map(async slug => {
          const p = await pageRow(slug); return { slug, content: p.compiled_truth, contentHash: p.content_hash! };
        })),
        _transcripts: [{ filePath: '/fake/private-session.txt', content: 'a private conversation', contentHash: 'abcdef0123456789' }],
        _chat: stubChat,
      });
      expect(result.details?.atoms_extracted).toBe(3);
      const atoms = await engine.executeRaw<{ slug: string; origin: string | null; transcript: string | null; v: string | null }>(
        "SELECT slug,frontmatter->>'source_slug' AS origin,frontmatter->>'source_path' AS transcript,frontmatter->>'visibility' AS v FROM pages WHERE type='atom' ORDER BY slug");
      const bySource = Object.fromEntries(atoms.map(a => [a.origin ?? a.transcript, a]));
      expect(bySource['notes/private-origin'].v).toBe('private');
      expect(bySource['/fake/private-session.txt'].v).toBe('private');
      expect(bySource['notes/world-origin'].v).toBe('world');
      expect(await remoteSees(engine, bySource['notes/private-origin'].slug)).toBe(false);
      expect(await remoteSees(engine, bySource['/fake/private-session.txt'].slug)).toBe(false);
      expect(await remoteSees(engine, bySource['notes/world-origin'].slug)).toBe(true);
    }
  }, 120_000);
});

describe('#5525 extraction stamps the origin visibility on every atom (managed path)', () => {
  test('a world page yields a world atom and a private page a private atom', async () => {
    for (const engine of engines) {
      await reset(engine);
      const dir = mkdtempSync(join(home, 'managed-'));
      try {
        await withEnv({ GBRAIN_HOME: dir }, async () => {
          await seed(engine, 'notes/managed-world', 'note', {}, 'A public project record. '.repeat(20));
          await seed(engine, 'notes/managed-private', 'note', { visibility: 'private' }, 'A private project record. '.repeat(20));
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          const items = await Promise.all(['notes/managed-world', 'notes/managed-private'].map(async slug => {
            const p = (await engine.getPage(slug, { sourceId: 'default' }))!; return { slug, content: p.compiled_truth, contentHash: p.content_hash! };
          }));
          const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: items, _chat: stubChat });
          expect(result.details?.atoms_extracted).toBe(2);
          const atoms = await engine.executeRaw<{ origin: string; v: string }>(
            "SELECT frontmatter->>'source_slug' AS origin,frontmatter->>'visibility' AS v FROM pages WHERE type='atom' ORDER BY 1");
          expect(atoms).toEqual([{ origin: 'notes/managed-private', v: 'private' }, { origin: 'notes/managed-world', v: 'world' }]);
        });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }
  }, 120_000);
});

describe('#5525 concepts take the strictest visibility of their inputs', () => {
  test('one private and one world input make a private concept; two world inputs a world concept; tighten-only on re-synthesis', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'atoms/a1', 'atom', { visibility: 'world', concepts: ['concepts/mixed', 'concepts/open'] });
      await seed(engine, 'atoms/a2', 'atom', { visibility: 'private', concepts: ['concepts/mixed'] });
      await seed(engine, 'atoms/a3', 'atom', { visibility: 'world', concepts: ['concepts/open', 'concepts/later'] });
      await seed(engine, 'atoms/a4', 'atom', { visibility: 'world', concepts: ['concepts/later'] });
      await runPhaseSynthesizeConcepts(engine, { _chat: stubChat as never, sourceId: 'default' });
      expect(await visibilityOf(engine, 'concepts/mixed')).toBe('private');
      expect(await visibilityOf(engine, 'concepts/open')).toBe('world');
      expect(await visibilityOf(engine, 'concepts/later')).toBe('world');
      expect(await remoteSees(engine, 'concepts/mixed')).toBe(false);
      expect(await remoteSees(engine, 'concepts/open')).toBe(true);
      // A re-synthesized concept that gains a private input becomes private ...
      await seed(engine, 'atoms/a5', 'atom', { visibility: 'private', concepts: ['concepts/later'] });
      await runPhaseSynthesizeConcepts(engine, { _chat: stubChat as never, sourceId: 'default' });
      expect(await visibilityOf(engine, 'concepts/later')).toBe('private');
      // ... and stays private when that input goes away (tighten-only).
      await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE slug='atoms/a5'");
      await runPhaseSynthesizeConcepts(engine, { _chat: stubChat as never, sourceId: 'default' });
      expect(await visibilityOf(engine, 'concepts/later')).toBe('private');
    }
  }, 120_000);
});

describe('#5525 backfill edge cases', () => {
  test('a concept whose members are known only from atoms\' concepts: lists is stamped private', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/public', 'note', {});
      await seed(engine, 'atoms/m1', 'atom', { visibility: 'world', source_slug: 'notes/public', concepts: ['concepts/legacy'] });
      await seed(engine, 'concepts/legacy', 'concept', { synthesized_by: 'synthesize_concepts-v0.41' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await runRepair(ctx(engine, false), visibilityRepair, await resolveRepairScope(engine), { apply: true });
      });
      expect(await visibilityOf(engine, 'concepts/legacy')).toBe('private');
    }
  }, 120_000);

  test('an item whose origin turned private after planning is not stamped with the stale decision', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/flips', 'note', {});
      await seed(engine, 'atoms/flipping', 'atom', { source_slug: 'notes/flips' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const scope = await resolveRepairScope(engine);
        const plan = await visibilityRepair.plan(engine, scope, null);
        expect(plan.items.map(i => i.change)).toEqual([{ from: null, to: 'world' }]);
        await seed(engine, 'notes/flips', 'note', { visibility: 'private' });
        expect(await visibilityRepair.apply(ctx(engine, false), plan.items[0])).toBe(false);
        expect(await visibilityOf(engine, 'atoms/flipping')).toBeNull();
        await runRepair(ctx(engine, false), visibilityRepair, scope, { apply: true });
      });
      expect(await visibilityOf(engine, 'atoms/flipping')).toBe('private');
    }
  }, 120_000);
});

describe('#5525 a concept whose provenance edges cannot land stays private', () => {
  test('world inputs that are not pages in this source leave the concept private', async () => {
    for (const engine of engines) {
      await reset(engine);
      await runPhaseSynthesizeConcepts(engine, { _chat: stubChat as never, sourceId: 'default', _atoms: [
        { slug: 'atoms/elsewhere-1', title: 'One', body: 'One.', concept_refs: ['concepts/unlinked'], visibility: 'world' },
        { slug: 'atoms/elsewhere-2', title: 'Two', body: 'Two.', concept_refs: ['concepts/unlinked'], visibility: 'world' },
      ] });
      expect(await visibilityOf(engine, 'concepts/unlinked')).toBe('private');
    }
  }, 120_000);
});

describe('#5525 a concept made private while its narrative is generated stays private', () => {
  test('the tighten-only check reads the concept after the model call', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/origin', 'note', {});
      const synthesized = { synthesized_by: 'synthesize_concepts-v0.41' };
      await seed(engine, 'concepts/race', 'concept', { ...synthesized, visibility: 'world' }, 'An earlier narrative.');
      for (let i = 1; i <= 5; i++) await seed(engine, `atoms/race-${i}`, 'atom', { visibility: 'world', source_slug: 'notes/origin', concepts: ['concepts/race'] }, `Race atom ${i}.`);
      let calls = 0;
      const flippingChat = async (o: ChatOpts): Promise<ChatResult> => {
        calls++;
        await seed(engine, 'concepts/race', 'concept', { ...synthesized, visibility: 'private' }, 'An earlier narrative.');
        return { ...(await stubChat(o)), text: 'The race atoms describe one recurring insight about planning under uncertainty.' };
      };
      await runPhaseSynthesizeConcepts(engine, { _chat: flippingChat as never, sourceId: 'default' });
      expect(calls).toBeGreaterThan(0);
      expect(await visibilityOf(engine, 'concepts/race')).toBe('private');
    }
  }, 120_000);
});

describe('#5525 a later private flip of an origin page reaches derived atoms and concepts', () => {
  test('flipping the origin hides its world atom and the concept built from it; the backfill then stamps them', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/origin', 'note', {});
      await seed(engine, 'atoms/from-origin', 'atom', { visibility: 'world', source_slug: 'notes/origin', concepts: ['concepts/flip'] });
      await seed(engine, 'atoms/other', 'atom', { visibility: 'world', source_slug: 'notes/other', concepts: ['concepts/flip'] });
      await seed(engine, 'notes/other', 'note', {});
      await runPhaseSynthesizeConcepts(engine, { _chat: stubChat as never, sourceId: 'default' });
      expect(await visibilityOf(engine, 'concepts/flip')).toBe('world');
      expect(await remoteSees(engine, 'atoms/from-origin')).toBe(true);
      expect(await remoteSees(engine, 'concepts/flip')).toBe(true);
      await seed(engine, 'notes/origin', 'note', { visibility: 'private' });
      expect(await remoteSees(engine, 'atoms/from-origin')).toBe(false);
      expect(await remoteSees(engine, 'concepts/flip')).toBe(false);
      expect(await remoteSees(engine, 'atoms/other')).toBe(true);
      const doctor = await derivedVisibilityCheck(engine);
      expect(doctor.status).toBe('warn');
      expect(doctor.details).toMatchObject({ looser_atoms: 1, count: 'exact' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const scope = await resolveRepairScope(engine);
        const applied = await runRepair(ctx(engine, false), visibilityRepair, scope, { apply: true });
        expect(applied.applied).toBe(2);
      });
      expect(await visibilityOf(engine, 'atoms/from-origin')).toBe('private');
      expect(await visibilityOf(engine, 'concepts/flip')).toBe('private');
      expect(await visibilityOf(engine, 'atoms/other')).toBe('world');
    }
  }, 120_000);
});

describe('#5525 tighten-only visibility backfill', () => {
  test('stamps, tightens and reports; never loosens; a second run changes nothing', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seed(engine, 'notes/world', 'note', {});
      await seed(engine, 'notes/private', 'note', { visibility: 'private' });
      await seed(engine, 'atoms/unstamped-world', 'atom', { source_slug: 'notes/world' });
      await seed(engine, 'atoms/leaked-transcript', 'atom', { visibility: 'world', source_path: '/sessions/example.jsonl' });
      await seed(engine, 'atoms/leaked-gone-origin', 'atom', { visibility: 'world', source_slug: 'notes/deleted-origin' });
      await seed(engine, 'atoms/over-private', 'atom', { visibility: 'private', source_slug: 'notes/world', managed_extraction: true });
      await seed(engine, 'atoms/unstamped-private', 'atom', { source_slug: 'notes/private' });
      await seed(engine, 'concepts/orphan', 'concept', { synthesized_by: 'synthesize_concepts-v0.41', visibility: 'world' });
      expect(await remoteSees(engine, 'atoms/leaked-transcript')).toBe(true);
      expect(await remoteSees(engine, 'atoms/leaked-gone-origin')).toBe(true);
      expect(await remoteSees(engine, 'atoms/unstamped-world')).toBe(false);
      expect((await derivedVisibilityCheck(engine)).details).toMatchObject({ unstamped_atoms: 2, looser_atoms: 2, count: 'exact' });
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const scope = await resolveRepairScope(engine);
        const preview = await runRepair(ctx(engine, false), visibilityRepair, scope, { apply: false });
        expect(preview.affected).toBe(4);
        expect(preview.residuals).toEqual({ atoms_origin_gone_to_private: 1, concepts_without_lineage: 1 });
        expect(await visibilityOf(engine, 'atoms/unstamped-world')).toBeNull();
        const applied = await runRepair(ctx(engine, false), visibilityRepair, scope, { apply: true });
        expect(applied).toMatchObject({ applied: 4, complete: true });
        const again = await runRepair(ctx(engine, false), visibilityRepair, scope, { apply: true });
        expect(again).toMatchObject({ affected: 0, applied: 0, complete: true });
      });
      expect(await visibilityOf(engine, 'atoms/unstamped-world')).toBe('world');
      expect(await visibilityOf(engine, 'atoms/leaked-transcript')).toBe('private');
      expect(await visibilityOf(engine, 'atoms/leaked-gone-origin')).toBe('private');
      expect(await visibilityOf(engine, 'atoms/over-private')).toBe('private');
      expect(await visibilityOf(engine, 'atoms/unstamped-private')).toBe('private');
      expect(await visibilityOf(engine, 'concepts/orphan')).toBe('world');
      expect(await remoteSees(engine, 'atoms/leaked-transcript')).toBe(false);
      expect(await remoteSees(engine, 'atoms/leaked-gone-origin')).toBe(false);
      expect(await remoteSees(engine, 'atoms/unstamped-world')).toBe(true);
      expect((await derivedVisibilityCheck(engine)).status).toBe('ok');
    }
  }, 120_000);
});
