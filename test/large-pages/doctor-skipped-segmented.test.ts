/**
 * Wave B PR 2 decision #10: doctor reports what it skipped.
 *
 * 1. Protects: every doctor check whose scan reads whole page bodies (their
 *    SQL compares compiled_truth / timeline, which are NULL on a page stored
 *    in segments) reports the segmented pages it passed by:
 *    'skipped_segmented: N' on the check object (doctor --json) and a message
 *    ending in 'skipped (segmented): N' (the text line is 'name: message').
 *    'gbrain repair frontmatter' reports the same count in its preview and
 *    apply (residual 'skipped_segmented', warning 'skipped (segmented): N').
 *    A brain without segmented pages gets neither, so its output is unchanged.
 * 2. Fails when: a check drops the count (its segmented page is silently
 *    passed by and the brain looks healthier than it was checked to be), or
 *    reports a field on a brain that has no segmented page.
 * 3. Why existing coverage misses it: the doctor goldens and check tests run
 *    on brains with inline pages only.
 * Seams: none. Counting is one COUNT query per check (no per-page loop).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { createProgress } from '../../src/core/progress.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { renderRepairResult } from '../../src/commands/repair.ts';
import { computeDoctorReport, type Check } from '../../src/commands/doctor.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { contentSanityEntry } from '../../src/commands/doctor/checks/content-quality.ts';
import { markdownBodyEntry } from '../../src/commands/doctor/checks/data-integrity.ts';
import { checkLinkResolutionOpportunity } from '../../src/commands/doctor/checks/calibration.ts';
import { fenceIntegrityCheck } from '../../src/commands/doctor/checks/fence-integrity.ts';
import { coreMemoryCheck } from '../../src/commands/doctor/checks/core-memory.ts';
import { extractionBacklogsEntry } from '../../src/commands/doctor/checks/local-audits.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-skipped-segmented-'));
const logger = { info() {}, warn() {}, error() {} };
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
/** The checks whose scans read whole bodies. */
const AFFECTED = ['core_memory', 'extract_health', 'fence_integrity', 'link_resolution_opportunity', 'markdown_body_completeness', 'oversized_pages', 'scraper_junk_pages'];

interface Brain { kind: string; mixed: BrainEngine; inline: BrainEngine }
const brains: Brain[] = [];
const closers: Array<() => Promise<void>> = [];

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\nalways_load: true\n---\n\n${body}\n\n## Notes\n\nSee [[missing-target]] for more.\n`;
const bigBody = () => conversationBody(1_200_000, { seed: 7 });

async function storage(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row!.body_storage;
}

/** One page (segmented with the switch on when 'big') plus a raw_data sidecar with headings, so every affected check reaches it. */
async function seed(engine: BrainEngine, sourceId: string, slug: string, big: boolean): Promise<void> {
  expect(await importFromContent(engine, slug, page(slug, big ? bigBody() : 'A short page.'), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  expect(await storage(engine, sourceId, slug)).toBe(big ? 'segmented' : 'inline');
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  await engine.executeRaw(`INSERT INTO raw_data(page_id, source, data) VALUES($1, 'fixture', $2::text::jsonb)`,
    [row!.id, JSON.stringify({ content: `## One\n\n${'Original text. '.repeat(100)}\n\n## Two\n\nMore.` })]);
}

beforeAll(async () => {
  await withEnv(env, async () => {
    const all: Array<{ kind: string; engine: BrainEngine }> = [];
    for (let i = 0; i < 2; i++) {
      const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); all.push({ kind: 'pglite', engine: lite });
      closers.push(async () => { await disposePersistenceConsumer(lite); await lite.disconnect(); });
    }
    for (let i = 0; process.env.DATABASE_URL && i < 2; i++) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
      all.push({ kind: 'postgres', engine: pg.engine });
      closers.push(async () => { await disposePersistenceConsumer(pg.engine); await pg.close(); });
    }
    for (const { engine } of all) {
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('seg-doctor','seg-doctor','{}') ON CONFLICT DO NOTHING");
    }
    for (let i = 0; i < all.length; i += 2) {
      const mixed = all[i]!.engine, inline = all[i + 1]!.engine;
      await seed(mixed, 'seg-doctor', 'notes/segmented', true);
      await seed(mixed, 'seg-doctor', 'notes/inline', false);
      await seed(inline, 'seg-doctor', 'notes/inline', false);
      await seed(inline, 'seg-doctor', 'notes/other-inline', false);
      // The facts backlog overlay on extract_health is read on unmanaged brains.
      for (const engine of [mixed, inline]) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      brains.push({ kind: all[i]!.kind, mixed, inline });
    }
  });
}, 600_000);

afterAll(async () => {
  await withEnv(env, async () => { for (const close of closers) await close(); });
  rmSync(home, { recursive: true, force: true });
});

function ctx(engine: BrainEngine): DoctorContext {
  return { engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: createProgress({ mode: 'quiet' }), skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null,
    schemaVersion: 0, connectionFailed: false, tier: 'standard' };
}

/** The affected checks, through the doctor's own JSON report (computeDoctorReport, then JSON). */
async function affectedChecks(engine: BrainEngine): Promise<Check[]> {
  const run = async (entry: { run(c: DoctorContext): Promise<unknown> }) => (await entry.run(ctx(engine))) as Check[];
  const checks: Check[] = [
    ...await run(contentSanityEntry),
    ...await run(markdownBodyEntry),
    await checkLinkResolutionOpportunity(engine),
    await fenceIntegrityCheck(engine),
    { name: 'core_memory', ...await coreMemoryCheck(engine) },
    ...(await run(extractionBacklogsEntry)).filter(c => c.name === 'extract_health'),
  ];
  const report = JSON.parse(JSON.stringify(computeDoctorReport(checks))) as { checks: Check[] };
  return report.checks.filter(c => AFFECTED.includes(c.name)).sort((a, b) => a.name.localeCompare(b.name));
}

describe('doctor reports the segmented pages its whole-body checks skipped', () => {
  test('one segmented page and one inline page: every affected check reports skipped_segmented: 1 in JSON and text', async () => withEnv(env, async () => {
    for (const brain of brains) {
      const checks = await affectedChecks(brain.mixed);
      // Fix lane P: core memory reads a core page stored in segments whole up to 24 MiB, so core_memory checks this 1.2 MB
      // page and reports nothing; its count of the core pages over 24 MiB is segmented-core-list.test.ts.
      const skipping = AFFECTED.filter(name => name !== 'core_memory');
      expect(checks.map(c => [brain.kind, c.name, c.skipped_segmented])).toEqual(AFFECTED.map(name => [brain.kind, name, skipping.includes(name) ? 1 : undefined]));
      for (const check of checks.filter(c => skipping.includes(c.name))) expect(check.message).toContain('skipped (segmented): 1 page(s) store their body in segments');
      expect(checks.find(c => c.name === 'core_memory')!.message).not.toContain('skipped (segmented)');
    }
  }), 600_000);

  test('a brain without segmented pages: no affected check carries the field or the text', async () => withEnv(env, async () => {
    for (const brain of brains) {
      const checks = await affectedChecks(brain.inline);
      expect(checks.map(c => [brain.kind, c.name, 'skipped_segmented' in c, c.message.includes('skipped (segmented)')]))
        .toEqual(AFFECTED.map(name => [brain.kind, name, false, false]));
    }
  }), 600_000);

  test('repair frontmatter: preview and apply report the segmented page the database-side check skipped', async () => withEnv(env, async () => {
    for (const brain of brains) {
      for (const [engine, segmented] of [[brain.mixed, 1], [brain.inline, 0]] as const) {
        const id = `fm-seg-${brain.kind}-${segmented}`, root = join(home, id);
        mkdirSync(join(root, 'notes'), { recursive: true });
        const files: Record<string, string> = {
          'notes/big.md': `---\ntitle: Big notes\n---\n\n${segmented ? bigBody() : 'Small.'}\n`,
          'notes/small.md': '---\ntitle: Small notes\n---\n\nA short page.\n',
          'notes/roundup.md': '---\ntitle: Payments roundup\nauthor: alice-example (citing acme-example) (original: https://example.invalid/a)\n---\nA synthetic roundup.\n',
        };
        for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
        for (const path of ['notes/big.md', 'notes/small.md']) await importFromFile(engine, join(root, path), path, { sourceId: id, noEmbed: true });
        expect(await storage(engine, id, 'notes/big')).toBe(segmented ? 'segmented' : 'inline');
        const scope = await resolveRepairScope(engine, id);
        const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger })).run('frontmatter', scope, { explicit: true, sourceFlag: id });
        expect(preview.affected).toBe(1);
        const hash = preview.apply_command.split('--expect ')[1]!.split(' ')[0]!;
        const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger })).run('frontmatter', scope, { explicit: true, sourceFlag: id, expect: hash });
        expect(applied.applied).toBe(1);
        for (const result of [preview, applied]) {
          const text = renderRepairResult(result);
          const seen: unknown[] = [brain.kind, result.mode, result.residuals.skipped_segmented, text.includes('skipped_segmented=1'),
            text.includes('WARNING: skipped (segmented): 1 page(s) store their body in segments')];
          expect(seen).toEqual(segmented ? [brain.kind, result.mode, 1, true, true] : [brain.kind, result.mode, undefined, false, false]);
        }
      }
    }
  }), 600_000);
});
