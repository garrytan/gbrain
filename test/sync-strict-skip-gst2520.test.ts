/**
 * GST-2520: a refusal that comes from the source's setup is never skipped past.
 *
 * 1. Protects: on a brain without managed persistence every import into a git-canonical source is refused
 *    (strict_requires_managed). The files are fine, so a skip (--skip-failed, or the automatic one after three failed
 *    syncs) used to move the checkpoint to HEAD with no pages, after which status read synced, doctor was clean and a
 *    plain sync found nothing to do, even once the setup was fixed by removing canonical: git.
 * 2. Fails when: either skip advances last_commit past the refused files, the refusals are not left open under their
 *    own code, or removing canonical: git afterwards leaves the pages out of a plain sync.
 * 3. Real seams: performSync on a Git clone of a strict managed brain and the sync failure ledger, PGLite and Postgres.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { classifyErrorCode, decideGateAction, syncFailureCode } from '../src/core/sync-failure-ledger.ts';
import { unacknowledgedSyncFailures } from '../src/core/sync.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const page = (title: string) => '---\ntype: person\ntitle: ' + title + '\n---\n\nNotes about ' + title + '.\n';
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const sync = (engine: BrainEngine, clone: string, extra: Record<string, unknown> = {}) =>
  performSync(engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true, ...extra } as never) as Promise<Record<string, any>>;
const livePages = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(r => r.slug);
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit ?? null;
const strict = (engine: BrainEngine, on: boolean) => engine.executeRaw(on
  ? "UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'"
  : "UPDATE sources SET config = config - 'canonical' WHERE id='default'");
const refused = () => unacknowledgedSyncFailures().filter(f => f.code === 'strict_requires_managed');
const PAGES = ['people/alice-example', 'people/bea-example'];

/** A strict managed source with two person pages committed, cloned; then a fresh strict database (no managed persistence) on the clone. */
async function onClone(databaseUrl: string | undefined, run: (fresh: BrainEngine, clone: string) => Promise<void>): Promise<void> {
  await managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine, true);
    await call(ctx, 'put_page', { slug: PAGES[0], content: page('Alice Example') });
    await call(ctx, 'put_page', { slug: PAGES[1], content: page('Bea Example') });
    await settleManagedGitEffects(engine);
    const home = mkdtempSync(join(tmpdir(), 'gst2520-strict-skip-'));
    try {
      const clone = join(home, 'content');
      git(home, 'clone', '--quiet', root, clone);
      const fresh = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
        await strict(fresh.engine, true);
        await run(fresh.engine, clone);
      } finally { await fresh.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, { databaseUrl, setup: gitRepo });
}

describe('GST-2520: mode refusals are not skippable (pure)', () => {
  test('a mode refusal blocks with --skip-failed and past the auto-skip threshold; a bad file still skips', () => {
    const base = { sentinels: [], threshold: 3, attemptsByPath: new Map([['a.md', 5]]) };
    for (const code of ['strict_requires_managed', 'writer_coordinator_required']) {
      expect(decideGateAction({ ...base, fileFailures: [{ path: 'a.md', code }], skipFailed: true }).action).toBe('block');
      expect(decideGateAction({ ...base, fileFailures: [{ path: 'a.md', code }], skipFailed: false }).action).toBe('block');
    }
    expect(decideGateAction({ ...base, fileFailures: [{ path: 'a.md', code: 'YAML_PARSE' }], skipFailed: true }).action).toBe('advance');
    expect(decideGateAction({ ...base, fileFailures: [{ path: 'a.md', code: 'YAML_PARSE' }], skipFailed: false }).action).toBe('advance_then_autoskip');
  });
  test('the ledger records a mode refusal under its own code', () => {
    expect(classifyErrorCode('direct file import cannot write git-canonical source default on an unmanaged brain.', 'a.md')).toBe('strict_requires_managed');
    expect(classifyErrorCode('direct file import cannot mutate a managed brain through the legacy writer.', 'a.md')).toBe('writer_coordinator_required');
    expect(syncFailureCode(Object.assign(new Error('direct file import cannot write git-canonical source default on an unmanaged brain.'), { code: 'strict_requires_managed' }), 'a.md')).toBe('strict_requires_managed');
  });
});

for (const backend of testBackends()) describe('[' + backend + '] GST-2520: a strict source on an unmanaged brain is never skipped past', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let stderr: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { stderr?.mockRestore(); stderr = null; });

  test('--skip-failed leaves the checkpoint and the refusals, names the two fixes, and removing canonical: git then imports every page', () => onClone(databaseUrl, async (fresh, clone) => {
    expect((await sync(fresh, clone)).status).toBe('blocked_by_failures');
    stderr = spyOn(console, 'error');
    expect((await sync(fresh, clone, { skipFailed: true })).status).toBe('blocked_by_failures');
    const said = stderr.mock.calls.flat().join('\n');
    stderr.mockRestore(); stderr = null;
    expect(said).toContain('Not skipped (--skip-failed): strict_requires_managed');
    expect(said).toContain('Turn on managed persistence');
    expect(said).toContain('remove canonical: git');
    expect(await lastCommit(fresh)).toBeNull();
    expect(refused().length).toBe(2);
    await strict(fresh, false);
    await sync(fresh, clone);
    expect(await livePages(fresh)).toEqual(PAGES);
    expect(await lastCommit(fresh)).not.toBeNull();
  }), 240_000);

  test('five failed syncs in a row auto-skip nothing', () => onClone(databaseUrl, async (fresh, clone) => {
    const statuses: string[] = [];
    for (let run = 0; run < 5; run++) statuses.push(String((await sync(fresh, clone)).status));
    expect(statuses).toEqual(Array(5).fill('blocked_by_failures'));
    expect(await lastCommit(fresh)).toBeNull();
    expect(refused().length).toBe(2);
    expect(unacknowledgedSyncFailures().filter(f => f.state === 'auto_skipped')).toEqual([]);
  }), 300_000);
});
