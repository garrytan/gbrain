/**
 * A live writer during a conversion: door commits (`gbrain git commit-push` in a managed checkout, file-first and under the
 * checkout's commit lock) that land after strict_pass_2 read its level used to leave the closing plan with Git ahead of the
 * database and the apply incomplete (`git_conversion_incomplete`), however fast it ran. The apply now runs bounded closing
 * strict passes that import them, and refuses with the operator contract only when Git is still ahead after the last one.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { applyGitConversion, CLOSING_PASSES, planGitConversion, type ConversionProgress } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { acquireCommitLockAsync } from '../src/core/git/commit-push.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const N = 12;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (i: number, body = `Committed body ${i}.`) => `---\ntype: concept\ntitle: note ${i}\n---\n\n${body}\n`;
const slugOf = (i: number) => `notes/n${String(i).padStart(2, '0')}`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < N; i++) writeFileSync(join(root, `${slugOf(i)}.md`), note(i));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};
/** A live writer's door commit: files written, then committed under the checkout's commit lock, as the door does. */
async function doorCommit(root: string, pages: number[], body: string): Promise<void> {
  for (const i of pages) writeFileSync(join(root, `${slugOf(i)}.md`), note(i, body));
  const lock = await acquireCommitLockAsync(root, 10_000);
  try { git(root, 'add', '--', ...pages.map(i => `${slugOf(i)}.md`)); git(root, 'commit', '-qm', `report: ${body}`); } finally { await lock.release(); }
}
const bodies = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; body: string }>(
  "SELECT slug, compiled_truth AS body FROM pages WHERE source_id='default' AND deleted_at IS NULL")).map(row => [row.slug, row.body.trim()]));
const strict = async (engine: BrainEngine) => (await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).length === 1;

for (const backend of testBackends()) describe(`[${backend}] a conversion with a live writer committing through the door`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  // Value: protects=door commits that land after strict_pass_2 read its level are imported by closing passes and the apply converts; fails_when=the apply ends incomplete on them (git_ahead) or drops their content; why_new=no test wrote through the door during a strict pass; seam=fault hook at sync:level_read; no_claim=database-first writes (put_page), whose Git effects commit their own files
  test('door commits after strict_pass_2 read its level, and during a closing pass, are imported and the source converts', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
    const seen: ConversionProgress[] = [];
    const writes: Array<{ phase: string; pages: number[]; body: string }> = [
      { phase: 'strict_pass_2', pages: [2, 3, 4], body: 'Report written during strict pass 2.' },
      { phase: 'strict_pass_closing', pages: [4, 5], body: 'Report written during the closing pass.' }];
    // The second lands at the closing pass's first level read, so the round after it imports it: one closing pass is enough.
    installFaultHook(async point => {
      const at = writes.findIndex(write => write.phase === seen.at(-1)?.phase);
      if (point !== 'sync:level_read' || at < 0) return;
      const [write] = writes.splice(at, 1);
      await doorCommit(root, write!.pages, write!.body);
    });
    let result: Awaited<ReturnType<typeof applyGitConversion>>;
    try {
      const { preview } = await planGitConversion(engine, 'default');
      result = await applyGitConversion(engine, 'default', preview.preview_hash, { noExtract: true, onProgress: progress => seen.push(progress) });
    } finally { installFaultHook(undefined); }
    expect(result).toMatchObject({ status: 'converted', closing_passes: 1, after: { strict: true, remaining: 0, git_wins: { count: 0 } } });
    expect(writes).toEqual([]);
    expect(await strict(engine)).toBe(true);
    const after = await bodies(engine);
    expect([2, 3].map(i => after[slugOf(i)])).toEqual(['Report written during strict pass 2.', 'Report written during strict pass 2.']);
    expect([4, 5].map(i => after[slugOf(i)])).toEqual(['Report written during the closing pass.', 'Report written during the closing pass.']);
    // The closing pass names the three paths Git was ahead at when the apply planned again.
    expect([...new Set(seen.filter(progress => progress.phase === 'strict_pass_closing').map(progress => progress.total))]).toEqual([3]);
  }, { databaseUrl, setup }), 300_000);

  // Value: protects=a writer that commits after every pass read its last level ends the apply after CLOSING_PASSES closing passes with the operator contract, and none of its commits is lost; fails_when=the closing loop is unbounded, refuses without fix, or a door commit's content never reaches the database; why_new=the bound and its refusal; seam=fault hook at sync:level_read; no_claim=how long the passes take
  test('a writer that commits after every pass stops the apply after the bounded closing passes, with a fix, and loses nothing', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
    let commits = 0, phase = '';
    installFaultHook(async point => {
      // After strict_pass_2 read its level, and after each closing pass released its drain lease (its last level read).
      if (!(point === 'sync:level_read' && phase === 'strict_pass_2' && commits === 0) && !(point === 'sync:tail_started' && phase === 'strict_pass_closing')) return;
      commits++;
      await doorCommit(root, [commits % N], `Report ${commits}.`);
    });
    const lines: string[] = [];
    const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
    console.log = (line: unknown) => { lines.push(String(line)); };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      for (const line of String(chunk).split('\n')) if (line.startsWith('{')) phase = (JSON.parse(line) as { phase?: string }).phase ?? phase;
      return true;
    }) as typeof process.stderr.write;
    try {
      const { preview } = await planGitConversion(engine, 'default');
      await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-extract', '--json']);
    } finally { console.log = log; process.stderr.write = write; installFaultHook(undefined); _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
    const out = JSON.parse(lines.at(-1)!);
    expect(out).toMatchObject({ status: 'incomplete', code: 'git_conversion_incomplete', result: { status: 'incomplete', closing_passes: CLOSING_PASSES, after: { strict: true } },
      fix: { argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'] } });
    expect(out.result.after.remaining).toBe(out.result.after.git_wins.count);
    expect(out.message).toContain(`${CLOSING_PASSES} closing pass(es), with Git still ahead`);
    expect(commits).toBe(1 + CLOSING_PASSES);
    expect(await strict(engine)).toBe(true);
    // Every door commit is Git's: a plain sync of the git-canonical source imports the last one, and the preview is clean.
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('synced');
    expect((await bodies(engine))[slugOf(commits % N)]).toBe(`Report ${commits}.`);
    expect((await planGitConversion(engine, 'default')).preview.remaining).toBe(0);
  }, { databaseUrl, setup }), 300_000);
});
