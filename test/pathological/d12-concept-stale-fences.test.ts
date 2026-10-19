/**
 * D-12 (GBRA-131, #6982): an unmanaged concept republication never copies a
 * stale file's fences or timeline over the database's.
 *
 * Protects: `publishClassicConcept` composes the new narrative with the
 * `## Facts` fence, timeline, tags and frontmatter the database holds, and
 * proceeds only when the concept's canonical file holds nothing the database
 * lacks (it equals the page or one of its recent page_versions rows). A
 * facts row and timeline entry the database gained after the file was
 * written survive in both copies after publication. A database-only edit no
 * page_versions row explains, and a file edit to the fence or timeline that
 * sync has not imported, defer the concept (`revision_conflict`, message
 * naming the page with `file_database_drift`) with both copies unchanged.
 * An edit landing while the database import runs is kept. Agreeing copies
 * publish, and the replaced body is kept in page_versions.
 * Fails when: the file comparison skips fences and timeline and the
 * composition takes them from the file (the pre-fix path), dropping the
 * database's newer rows.
 * Seams: `importPage` (the phase's importer callback) lands the concurrent
 * edit. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishClassicConcept } from '../../src/core/cycle/concept-publication.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFactsFence, upsertFactRow } from '../../src/core/facts-fence.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest, writePageThrough } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SLUG = 'concepts/launch-dates';
const NARRATIVE = 'Launch dates slip when nobody owns them.';
const SYNTHESIZED = 'SYNTHESIZED: launch dates need a single owner.';
const T1 = '- **2026-01-05** | Acme Example moved its launch.';
const T2 = '- **2026-02-09** | DB-NEWER-TIMELINE: alice-example took ownership.';
const FM = { synthesized_by: 'synthesize_concepts-v0.41', tier: 2, member_hash: 'h1', visibility: 'world' };
const fact = (claim: string) => ({ claim, kind: 'fact' as const, confidence: 0.9, visibility: 'world' as const, notability: 'medium' as const, validFrom: '2026-01-05', source: 'test' });
const withFact = (body: string, claim: string) => upsertFactRow(body, fact(claim)).body;
const BODY_V1 = withFact(NARRATIVE, 'Acme Example ships quarterly');

interface Brain {
  engine: BrainEngine;
  path: string;
  file(): string;
  page(): Promise<{ compiled_truth: string; timeline: string }>;
  importBody(body: string, timeline: string): Promise<void>;
  publish(importPage?: (markdown: string) => Promise<unknown>): Promise<string>;
  versionsHolding(marker: string): Promise<number>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d12-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const importBody = async (body: string, timeline: string) => {
          await importFromContent(engine, SLUG, serializeMarkdown(FM, body, timeline, { type: 'concept', title: 'launch dates', tags: ['ops'] }), { noEmbed: true });
        };
        await importBody(BODY_V1, T1);
        const written = await writePageThrough(engine, SLUG, { sourceId: 'default' });
        expect(written.written).toBe(true);
        const importPage = (markdown: string) => importFromContent(engine, SLUG, markdown, { noEmbed: true });
        await run({
          engine, path: written.path!, importBody,
          file: () => readFileSync(written.path!, 'utf8'),
          page: async () => (await engine.executeRaw<{ compiled_truth: string; timeline: string }>(
            "SELECT compiled_truth, timeline FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]))[0]!,
          publish: (hook = importPage) => publishClassicConcept(engine, SLUG, 'default', { ...FM, member_hash: 'h2' }, SYNTHESIZED, NARRATIVE,
            { writeThrough: false, importPage: hook }).then(() => 'published', (err: { code?: string; message?: string }) => `${err.code}: ${err.message}`),
          versionsHolding: async marker => Number((await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
              WHERE p.source_id = 'default' AND p.slug = $1 AND (v.compiled_truth LIKE '%' || $2 || '%' OR v.timeline LIKE '%' || $2 || '%')`, [SLUG, marker]))[0]!.n),
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const claims = (text: string) => parseFactsFence(text).facts.map(f => f.claim);
const deferredForDrift = (outcome: string) => outcome.startsWith('revision_conflict: ') && outcome.includes(`${SLUG} (file_database_drift`)
  && outcome.includes('gbrain sync --source default');

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-12 concept republication and stale file fences/timeline (${backend})`, () => {
    test('D-12 db-newer (versioned): the database\'s newer facts row and timeline entry survive in both copies', async () => {
      await withBrain(databaseUrl, async b => {
        await b.importBody(withFact(BODY_V1, 'DB-NEWER-FACT: Acme Example ships monthly'), `${T1}\n${T2}`);
        const outcome = await expectUnitNotAborted(() => b.publish());
        const page = await b.page();
        const file = parseMarkdown(b.file(), b.path);
        expect({ outcome, db: claims(page.compiled_truth), dbTimeline: page.timeline.includes('DB-NEWER-TIMELINE'), dbNarrative: page.compiled_truth.includes(SYNTHESIZED) })
          .toEqual({ outcome: 'published', db: ['Acme Example ships quarterly', 'DB-NEWER-FACT: Acme Example ships monthly'], dbTimeline: true, dbNarrative: true });
        expect({ file: claims(file.compiled_truth), fileTimeline: file.timeline.includes('DB-NEWER-TIMELINE'), fileNarrative: file.compiled_truth.includes(SYNTHESIZED) })
          .toEqual({ file: ['Acme Example ships quarterly', 'DB-NEWER-FACT: Acme Example ships monthly'], fileTimeline: true, fileNarrative: true });
      });
    }, 180_000);

    test('D-12 db-newer (no version holds the file): the concept defers with file_database_drift and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        const current = (await b.engine.getPage(SLUG, { sourceId: 'default' }))!;
        await b.engine.putPage(SLUG, { type: 'concept', title: current.title, compiled_truth: withFact(BODY_V1, 'DB-NEWER-FACT: Acme Example ships monthly'),
          timeline: `${T1}\n${T2}`, frontmatter: current.frontmatter }, { sourceId: 'default' } as never);
        const fileBefore = b.file();
        const pageBefore = await b.page();
        const outcome = await expectUnitNotAborted(() => b.publish());
        expect({ drift: deferredForDrift(outcome), file: b.file() === fileBefore, db: JSON.stringify(await b.page()) === JSON.stringify(pageBefore) })
          .toEqual({ drift: true, file: true, db: true });
      });
    }, 180_000);

    test('D-12 file-newer: an unimported fence and timeline edit in the file defers the concept; neither copy changes', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = b.file().replace(T1, `${T1}\n- **2026-03-01** | FILE-ONLY-TIMELINE: saved in the editor.`);
        writeFileSync(b.path, edited);
        const pageBefore = await b.page();
        const outcome = await expectUnitNotAborted(() => b.publish());
        expect({ drift: deferredForDrift(outcome), file: b.file() === edited, db: JSON.stringify(await b.page()) === JSON.stringify(pageBefore) })
          .toEqual({ drift: true, file: true, db: true });
      });
    }, 180_000);

    test('D-12 concurrent fence edit while the import runs: the editor\'s bytes survive', async () => {
      await withBrain(databaseUrl, async b => {
        let edited = '';
        const outcome = await expectUnitNotAborted(() => b.publish(async markdown => {
          const result = await importFromContent(b.engine, SLUG, markdown, { noEmbed: true });
          edited = b.file().replace(T1, `${T1}\n- **2026-03-02** | CONCURRENT-TIMELINE: saved during the import.`);
          writeFileSync(b.path, edited);
          return result;
        }));
        expect({ outcome: outcome.startsWith('revision_conflict'), file: b.file() === edited, late: edited.includes('CONCURRENT-TIMELINE') })
          .toEqual({ outcome: true, file: true, late: true });
      });
    }, 180_000);

    test('D-12 agreeing copies: the concept publishes to both copies with its fence and timeline, and the old body is versioned', async () => {
      await withBrain(databaseUrl, async b => {
        const versionsBefore = await b.versionsHolding(NARRATIVE);
        const outcome = await expectUnitNotAborted(() => b.publish());
        const page = await b.page();
        const file = parseMarkdown(b.file(), b.path);
        expect({ outcome, db: claims(page.compiled_truth), file: claims(file.compiled_truth), dbT: page.timeline.trim(), fileT: file.timeline.trim(),
          narrative: page.compiled_truth.includes(SYNTHESIZED) && file.compiled_truth.includes(SYNTHESIZED) })
          .toEqual({ outcome: 'published', db: ['Acme Example ships quarterly'], file: ['Acme Example ships quarterly'], dbT: T1, fileT: T1, narrative: true });
        expect(await b.versionsHolding(NARRATIVE)).toBe(versionsBefore + 1);
      });
    }, 180_000);
  });
}
