/**
 * Malformed-path rejection (poisoned-filename incident regression).
 *
 * Files literally named like markdown links (`[atoms/foo.md](https:/...)`)
 * were ingested without complaint — slugifySegment STRIPS brackets instead of
 * rejecting them, so junk files minted plausible slugs and polluted search.
 *
 * The fix adds SyncableReason 'malformed-path' to the classifier. These tests
 * pin the OPERATIONAL consequences, which are subtle (two prior outside-voice
 * findings live here):
 *
 *   1. REGRESSION-CRITICAL: a DELETE of a malformed path must still process —
 *      naively filtering manifest.deleted by isSyncable would orphan the
 *      previously-ingested DB row forever (searchable junk with no way out).
 *   2. A MODIFIED malformed file sweeps its stale DB row (the cleanup lane
 *      treats 'malformed-path' as delete-eligible, unlike metafile/pruned-dir).
 *   3. The full-sync reconcile treats malformed-path rows as eligible, so a
 *      full sync removes previously-ingested poison EVEN IF the junk file is
 *      still sitting in the repo.
 *   4. importFromFile's defense-in-depth returns an INFORMATIONAL skip
 *      (skip_reason='malformed_path') that never lands in failedFiles — a
 *      junk filename must not gate bookmark advancement.
 *
 * Marked .serial.test.ts: spawns git subprocesses and shares one PGLite
 * engine across tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { gitExec } from './helpers/git-exec.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

const JUNK_NAME = '[foo.md](https-example).md';

function gitInit(repo: string): void {
  gitExec('git init', repo);
  gitExec('git config user.email "test@test.com"', repo);
  gitExec('git config user.name "Test"', repo);
}

/** Seed a page row as if a pre-fix gbrain had ingested the junk file. */
async function seedPoisonedRow(slug: string, sourcePath: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: 'Poisoned page',
    compiled_truth: 'Junk row ingested before the malformed-path gate existed.',
    timeline: '',
    frontmatter: { type: 'note' },
  });
  await engine.executeRaw(
    `UPDATE pages SET source_path = $1 WHERE slug = $2`,
    [sourcePath, slug],
  );
}

describe('malformed-path sync semantics (poisoned-filename incident)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-malformed-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---',
      'type: concept',
      'title: Foo',
      '---',
      '',
      'Baseline content.',
    ].join('\n'));
    gitExec('git add -A && git commit -m "initial"', repoPath);
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('sync never imports a bracket-named file, and the skip is not a failure', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    writeFileSync(join(repoPath, JUNK_NAME), '# junk\n');
    gitExec('git add -A && git commit -m "junk lands"', repoPath);

    const result = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    // The junk file must not block the sync or land in the index.
    expect(['first_sync', 'synced', 'up_to_date']).toContain(result.status);
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1`, [JUNK_NAME],
    );
    expect(rows).toHaveLength(0);
  }, 60_000);

  test('REGRESSION-CRITICAL: deleting a junk file still deletes its pre-existing DB row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    writeFileSync(join(repoPath, JUNK_NAME), '# junk\n');
    gitExec('git add -A && git commit -m "junk lands"', repoPath);
    const first = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(first.status).not.toBe('blocked_by_failures');

    // Simulate the pre-fix world: the junk row is already in the DB.
    await seedPoisonedRow('atoms/foo-md-https-example', JUNK_NAME);

    gitExec(`git rm '${JUNK_NAME}'`, repoPath);
    gitExec('git commit -m "remove junk"', repoPath);

    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(second.status).not.toBe('blocked_by_failures');

    // Without the delete-lane carve-out the row would be orphaned forever.
    const survivor = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL`, [JUNK_NAME],
    );
    expect(survivor).toHaveLength(0);
  }, 60_000);

  test('a MODIFIED junk file sweeps its stale DB row (cleanup lane treats malformed-path as delete-eligible)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    writeFileSync(join(repoPath, JUNK_NAME), '# junk\n');
    gitExec('git add -A && git commit -m "junk lands"', repoPath);
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    await seedPoisonedRow('atoms/foo-md-https-example', JUNK_NAME);

    writeFileSync(join(repoPath, JUNK_NAME), '# junk edited\n');
    gitExec('git add -A && git commit -m "edit junk"', repoPath);
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    const survivor = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL`, [JUNK_NAME],
    );
    expect(survivor).toHaveLength(0);
  }, 60_000);

  test('full-sync reconcile sweeps poisoned rows even while the junk file still exists on disk', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Junk file committed AND still present in the working tree.
    writeFileSync(join(repoPath, JUNK_NAME), '# junk\n');
    gitExec('git add -A && git commit -m "junk lands"', repoPath);

    // Poisoned row exists in the default source (pre-fix ingestion).
    await seedPoisonedRow('atoms/foo-md-https-example', JUNK_NAME);

    // A sourceId-scoped FULL sync runs the delete-reconcile pass.
    const result = await performSync(engine, {
      repoPath, full: true, noPull: true, noEmbed: true, sourceId: 'default',
    });
    expect(result.status).not.toBe('blocked_by_failures');

    const survivor = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL`, [JUNK_NAME],
    );
    expect(survivor).toHaveLength(0);

    // Sanity: the healthy page was not collateral damage.
    const healthy = await engine.getPage('topics/foo');
    expect(healthy).not.toBeNull();
  }, 60_000);

  test('bare-bracket markdown row SURVIVES reconcile (only the poison signature is sweepable)', async () => {
    // Cross-model adversarial finding: a pre-gate release imported
    // `notes [draft].md` fine (brackets were slug-stripped). The file still
    // exists on disk; hard-deleting its row on a routine post-upgrade full
    // sync would be silent data loss. Only `](`/control-char paths sweep.
    const { performSync } = await import('../src/commands/sync.ts');
    const BARE = 'notes [draft].md';

    writeFileSync(join(repoPath, BARE), '# legit draft\n');
    gitExec('git add -A && git commit -m "bare-bracket note"', repoPath);
    await seedPoisonedRow('notes-draft', BARE);

    const result = await performSync(engine, {
      repoPath, full: true, noPull: true, noEmbed: true, sourceId: 'default',
    });
    expect(result.status).not.toBe('blocked_by_failures');

    const survivor = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL`, [BARE],
    );
    expect(survivor).toHaveLength(1);
  }, 60_000);

  test('importFromFile defense: bracket filename → informational skip with skip_reason, brackets never stripped into a slug', async () => {
    const { importFromFile } = await import('../src/core/import-file.ts');
    const abs = join(repoPath, JUNK_NAME);
    writeFileSync(abs, '# junk\n');
    const result = await importFromFile(engine, abs, JUNK_NAME, { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('malformed_path');
    expect(result.error).toContain('Rename the file');
    // The old behavior minted a bracket-stripped slug; the defense returns none.
    expect(result.slug).toBe('');
  }, 60_000);
});
