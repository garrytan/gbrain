/**
 * GST-2492 PR 2: the doctor check `strict_facts_outside_git`.
 *
 * 1. Protects: a brain with no strict source is told so (ok). On a strict source, a fact the git-gap census counts with
 *    no Git home warns, names the count by group and gives the read-only `gbrain repair facts-home` preview as its fix.
 *    A source that is not strict is never judged, whatever its database holds.
 * 2. Fails when: a strict source's database-only fact goes unreported, the fix is not the preview, or a mixed source warns.
 * 3. Existing coverage: test/held-bare-name-move-gst2492.test.ts pins the held-row candidates in the message.
 * 4. Real seams: the registered doctor entry on a managed Git checkout, PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { strictFactsOutsideGitEntry } from '../src/commands/doctor/checks/strict-facts-outside-git.ts';
import { DOCTOR_GIT_GAP_NEWEST } from '../src/commands/doctor/checks/db-ahead-of-git.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const check = async (engine: BrainEngine) => ((await strictFactsOutsideGitEntry.run({ engine, progress: { heartbeat() {} }, args: [] } as unknown as DoctorContext)) as Array<Record<string, any>>)
  .find(c => c.name === 'strict_facts_outside_git')!;
/** A database-only fact row an older gbrain left, written outside the write guards. */
async function legacyFact(engine: BrainEngine, claim: string): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await engine.insertFact({ fact: claim, kind: 'fact', entity_slug: 'notes/kitchen-remodel', visibility: 'world', source: 'legacy import' } as never, { source_id: 'default' }); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

for (const backend of testBackends()) describe(`[${backend}] doctor strict_facts_outside_git (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a source that is not strict is not judged, even with a database-only fact', () => managedBrain(async ({ engine }) => {
    await legacyFact(engine, 'The kitchen remodel starts in March.');
    expect(await check(engine)).toMatchObject({ status: 'ok', details: { sources: [] } });
  }, { databaseUrl, setup: gitRepo }), 180_000);

  test('a strict source with a fact that has no Git home warns and gives the read-only preview', () => managedBrain(async ({ engine }) => {
    await legacyFact(engine, 'The kitchen remodel starts in March.');
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const result = await check(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('default: 1 fact(s) without a Git home');
    expect(result.message).toContain('entity_page_missing 1');
    expect(result.fix).toMatchObject({ argv: ['gbrain', 'repair', 'facts-home', '--source', 'default', '--json'], consent: [], actor: 'agent' });
    expect(result.details.sources).toMatchObject([{ source_id: 'default', outside_git: 1, groups: { entity_page_missing: 1 } }]);
  }, { databaseUrl, setup: gitRepo }), 180_000);

  test('GBRA-541: a strict source whose census the budget stopped is health unknown, never ok', () => managedBrain(async ({ engine }) => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    const result = (await withEnv({ GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS: '1' }, () => strictFactsOutsideGitEntry.run({ engine, progress: { heartbeat() {} }, args: [],
      entryDeadlineAt: Date.now() } as unknown as DoctorContext)) as Array<Record<string, any>>).find(c => c.name === 'strict_facts_outside_git')!;
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'git_gap_timeout' });
    expect(result.message).toContain('Health unknown, not clear');
  }, { databaseUrl, setup: gitRepo }), 180_000);

  test('GBRA-541: a fenced fact on a page older than the census window is health unknown, never ok', () => managedBrain(async ({ engine }) => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at)
        VALUES ('default', 'notes/porch-repair', 'note', 'Porch repair', 'plain text', '', '{}'::jsonb, now() - make_interval(days => 30))`);
      await engine.executeRaw(`INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter)
        SELECT 'default', 'notes/n-' || g, 'note', 'n', 'plain text', '', '{}'::jsonb FROM generate_series(1, ${DOCTOR_GIT_GAP_NEWEST}) g`);
      await engine.insertFact({ fact: 'The porch repair is booked for May.', kind: 'fact', entity_slug: 'notes/porch-repair', visibility: 'world', source: 'legacy import' } as never, { source_id: 'default' });
      await engine.executeRaw(`UPDATE facts SET row_num=1, source_markdown_slug='notes/porch-repair' WHERE source_id='default' AND fact='The porch repair is booked for May.'`);
    } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    const result = await check(engine);
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'git_gap_newest' });
    expect(result.details.sources).toMatchObject([{ source_id: 'default', complete: true, facts_on_unread_pages: 1 }]);
    expect(result.message).toContain('1 fenced fact(s) on pages older than');
  }, { databaseUrl, setup: gitRepo }), 180_000);
});
