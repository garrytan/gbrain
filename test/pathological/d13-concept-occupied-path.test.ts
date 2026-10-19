/**
 * D-13 (GBRA-131, #6982): a new concept never overwrites an unindexed file
 * sitting at its path.
 *
 * Protects: on an unmanaged brain `publishClassicConcept` publishes a concept
 * with no database page only when nothing occupies its file path. A file the
 * database has never held at that path (an unindexed note) defers the
 * concept (`revision_conflict`, message naming the page with
 * `file_database_drift` and the sync fix) before anything is written: the
 * file keeps its bytes and no page is created, with
 * `cycle.synthesize_concepts.write_through` on or off, and the phase
 * reports the deferral while the run's other concepts publish. A file that
 * appears while the database import runs is kept. With the path free the
 * concept publishes to the database and, with the key on, to its file.
 * Fails when: a new concept's write binds `expectedFileBytes` to the unknown
 * file's own bytes (the pre-fix path), which overwrites it.
 * Seams: `importPage` (the phase's importer callback) lands the concurrent
 * file; the phase's `_atoms` input (deterministic narrative, no paid call).
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishClassicConcept } from '../../src/core/cycle/concept-publication.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SLUG = 'concepts/flywheel';
const SYNTHESIZED = 'SYNTHESIZED: a flywheel compounds.';
const UNINDEXED = '---\ntitle: Flywheel notes\n---\n\n# Flywheel notes by alice-example\n\nNever imported.\n';
const FM = { synthesized_by: 'synthesize_concepts-v0.41', tier: 3, member_hash: 'h1', visibility: 'world' };

interface Brain {
  engine: BrainEngine;
  path(slug: string): string;
  page(slug: string): Promise<string | null>;
  publish(opts: { writeThrough: boolean; importPage?: (markdown: string) => Promise<unknown> }): Promise<string>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d13-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(join(root, 'concepts'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
        const importPage = (markdown: string) => importFromContent(engine, SLUG, markdown, { noEmbed: true });
        await run({
          engine,
          path: slug => join(root, `${slug}.md`),
          page: async slug => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))[0]?.compiled_truth ?? null,
          publish: opts => publishClassicConcept(engine, SLUG, 'default', FM, SYNTHESIZED, '',
            { writeThrough: opts.writeThrough, importPage: opts.importPage ?? importPage })
            .then(() => 'published', (err: { code?: string; message?: string }) => `${err.code}: ${err.message}`),
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const deferredForDrift = (outcome: string, slug = SLUG) => outcome.startsWith('revision_conflict: ') && outcome.includes(`${slug} (file_database_drift`)
  && outcome.includes('gbrain sync --source default');

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-13 new concept and an unindexed file at its path (${backend})`, () => {
    for (const writeThrough of [true, false]) {
      test(`D-13 occupied path, write-through key ${writeThrough ? 'on' : 'off'}: the file keeps its bytes and no page is created`, async () => {
        await withBrain(databaseUrl, async b => {
          writeFileSync(b.path(SLUG), UNINDEXED);
          const outcome = await expectUnitNotAborted(() => b.publish({ writeThrough }));
          expect({ drift: deferredForDrift(outcome), file: readFileSync(b.path(SLUG), 'utf8') === UNINDEXED, page: await b.page(SLUG) })
            .toEqual({ drift: true, file: true, page: null });
        });
      }, 180_000);
    }

    test('D-13 the phase reports the deferral and still publishes the run\'s other concept', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('cycle.synthesize_concepts.write_through', 'true');
        writeFileSync(b.path(SLUG), UNINDEXED);
        const atoms = ['flywheel', 'moat'].flatMap(concept => [0, 1].map(i => ({ slug: `atoms/${concept}-${i}`, title: `${concept} ${i}`, body: `b${i}`,
          concept_refs: [concept], visibility: 'world' as const })));
        const result = await expectUnitNotAborted(() => runPhaseSynthesizeConcepts(b.engine, { _atoms: atoms, sourceId: 'default' }));
        const deferred = ((result.details as { publication_deferred?: Array<{ concept: string; reason: string }> }).publication_deferred ?? []);
        expect({ status: result.status, deferred: deferred.filter(d => d.concept === 'flywheel' && deferredForDrift(d.reason)).length,
          file: readFileSync(b.path(SLUG), 'utf8') === UNINDEXED, page: await b.page(SLUG), moat: existsSync(b.path('concepts/moat')) })
          .toEqual({ status: 'warn', deferred: 1, file: true, page: null, moat: true });
      });
    }, 180_000);

    test('D-13 concurrent: a file appearing while the database import runs is kept', async () => {
      await withBrain(databaseUrl, async b => {
        const outcome = await expectUnitNotAborted(() => b.publish({ writeThrough: true, importPage: async markdown => {
          const result = await importFromContent(b.engine, SLUG, markdown, { noEmbed: true });
          writeFileSync(b.path(SLUG), UNINDEXED);
          return result;
        } }));
        expect({ outcome: outcome.startsWith('revision_conflict'), file: readFileSync(b.path(SLUG), 'utf8') === UNINDEXED }).toEqual({ outcome: true, file: true });
      });
    }, 180_000);

    test('D-13 control: with the path free the concept publishes to the database and its file', async () => {
      await withBrain(databaseUrl, async b => {
        const outcome = await expectUnitNotAborted(() => b.publish({ writeThrough: true }));
        expect({ outcome, db: (await b.page(SLUG))?.includes(SYNTHESIZED), file: existsSync(b.path(SLUG)) && readFileSync(b.path(SLUG), 'utf8').includes(SYNTHESIZED) })
          .toEqual({ outcome: 'published', db: true, file: true });
      });
    }, 180_000);
  });
}
