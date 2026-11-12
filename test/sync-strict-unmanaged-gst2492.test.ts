/**
 * GST-2492 PR 2: a strict source that refuses a direct import says why.
 *
 * 1. Protects: on a brain without managed persistence, every direct import into a git-canonical source is refused
 *    (`strict_requires_managed`, by design). The sync report names that cause: the failure ledger, the blocked-sync
 *    summary and the `--json` result carry `strict_requires_managed` and its own advice, for a full and an incremental
 *    sync, and never tell the user to fix YAML or use `--skip-failed` for it.
 * 2. Fails when: the cause is reported as `UNKNOWN`, or the advice sends the user to the frontmatter or to `--skip-failed`.
 * 3. Existing coverage: test/remember-strict-held-gst2492.test.ts rebuilds a strict source as mixed (no refusal).
 * 4. Real seams: performSync on a Git clone, the sync failure ledger, printSyncResult, PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { loadSyncFailures } from '../src/core/sync.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const page = (title: string) => `---\ntype: person\ntitle: ${title}\n---\n\nNotes about ${title}.\n`;
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const sync = (engine: BrainEngine, clone: string, extra: Record<string, unknown> = {}) =>
  performSync(engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true, ...extra } as never) as Promise<Record<string, any>>;
const livePages = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(r => r.slug);
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id='default'"))[0]?.last_commit ?? null;
const strictOn = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);

/** A strict managed source with two person pages committed, cloned; then a fresh database (no managed persistence) on the clone. */
async function onClone(databaseUrl: string | undefined, run: (fresh: BrainEngine, clone: string) => Promise<void>): Promise<void> {
  await managedBrain(async ({ engine, ctx, root }) => {
    await strictOn(engine);
    await call(ctx, 'put_page', { slug: 'people/alice-example', content: page('Alice Example') });
    await call(ctx, 'put_page', { slug: 'people/bea-example', content: page('Bea Example') });
    await settleManagedGitEffects(engine);
    const home = mkdtempSync(join(tmpdir(), 'gst2492-strict-sync-'));
    try {
      const clone = join(home, 'content');
      git(home, 'clone', '--quiet', root, clone);
      const fresh = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
        await run(fresh.engine, clone);
      } finally { await fresh.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, { databaseUrl, setup: gitRepo });
}

import { printSyncResult } from '../src/commands/sync/report.ts';

async function captured<T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { value: await run(), stderr: lines.join('\n') }; } finally { console.error = original; }
}
const printed = (result: Record<string, any>) => {
  let text = '';
  printSyncResult(result as never, { write: (chunk: string) => { text += chunk; return true; } } as never);
  return text;
};
const expectStrictAdvice = (text: string) => {
  expect(text).toContain('strict_requires_managed');
  expect(text).toContain('Do not use --skip-failed');
  expect(text).not.toContain('fix the YAML');
  expect(text).not.toContain('fix the frontmatter');
  expect(text).not.toContain("or use '--skip-failed'");
  expect(text).not.toContain("'gbrain sync --skip-failed' to move on");
  expect(text).not.toMatch(/acknowledge these files with 'gbrain sync --skip-failed/);
};

for (const backend of testBackends()) describe(`[${backend}] a strict source on a brain without managed persistence says why it imported nothing (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a full sync: the ledger, the summary and the result name strict_requires_managed and its own advice', () => onClone(databaseUrl, async (fresh, clone) => {
    await strictOn(fresh);
    const { value: result, stderr } = await captured(() => sync(fresh, clone));
    expect(result.status).toBe('blocked_by_failures');
    expect(result.failureCodes).toEqual([{ code: 'strict_requires_managed', count: 2 }]);
    expect(result.failureAdvice).toContain('git-canonical');
    expect(result.failureAdvice).toContain('Do not use --skip-failed');
    // The ledger keeps one entry per (source, path), refreshed by each run.
    const failures = loadSyncFailures().filter(f => ['people/alice-example.md', 'people/bea-example.md'].includes(f.path));
    expect(failures.map(f => f.code)).toEqual(['strict_requires_managed', 'strict_requires_managed']);
    expectStrictAdvice(stderr);
    expectStrictAdvice(printed(result));
    expect(await livePages(fresh)).toEqual([]);
  }), 240_000);

  test('an incremental sync after the source turns strict says the same', () => onClone(databaseUrl, async (fresh, clone) => {
    expect((await sync(fresh, clone)).status).not.toBe('blocked_by_failures');
    await strictOn(fresh);
    writeFileSync(join(clone, 'people/cleo-example.md'), page('Cleo Example'));
    git(clone, 'add', 'people/cleo-example.md');
    git(clone, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add cleo');
    const { value: result, stderr } = await captured(() => sync(fresh, clone));
    expect(result.status).toBe('blocked_by_failures');
    expect(result.failureCodes).toEqual([{ code: 'strict_requires_managed', count: 1 }]);
    expect(result.failureAdvice).toContain('Do not use --skip-failed');
    expectStrictAdvice(stderr);
    expectStrictAdvice(printed(result));
  }), 240_000);
});
