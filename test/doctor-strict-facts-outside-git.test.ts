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
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

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
});
