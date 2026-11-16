/**
 * #7956: `sources canonical --to git` judges the source's owner the way the managed sync context does before it looks at
 * the root, refuses a root it cannot read with a typed refusal, and reports `converted` only for a source that is still
 * git-canonical when the apply ends.
 *
 * Protects:
 * - a registered root that is gone, a file, a symlink loop or unreadable refuses `source_root_unreadable` (reason, fix)
 *   instead of a raw ENOENT or Git error, and never `git_checkout_required`, whose fix would create a repository there;
 * - an archived or re-registered source, a checkout another host owns and a draining worktree refuse `owner_unavailable`
 *   before the checkout check, so a checkout-less root on such a source is not refused as missing a checkout;
 * - a source returned to mixed (`--to mixed`) while the apply ran gets no closing strict pass and is reported
 *   `incomplete` with a message that says it is mixed, never `converted`.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { applyGitConversion, applyMixedConversion, planGitConversion, planMixedConversion, type ConversionProgress } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { acquireCommitLockAsync } from '../src/core/git/commit-push.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (body: string) => `---\ntype: concept\ntitle: note\n---\n\n${body}\n`;
const plain = ({ root }: { root: string }) => { mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/a.md'), note('A plain file.')); };
const committed = ({ root }: { root: string }) => {
  plain({ root });
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const name of ['b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(`Committed ${name}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

/** Runs the CLI and returns its last stdout line as JSON; `events` collects the --json progress lines on stderr. */
async function cli(engine: BrainEngine, args: string[], events: ConversionProgress[] = []): Promise<Record<string, any>> {
  const out: string[] = [];
  const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { out.push(String(line)); };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    for (const line of String(chunk).split('\n')) if (line.startsWith('{')) { const event = JSON.parse(line) as ConversionProgress; if (event.phase) events.push(event); }
    return true;
  }) as typeof process.stderr.write;
  try { await runSourcesCanonical(engine, args); }
  finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(out.at(-1)!);
}
const isStrict = async (engine: BrainEngine) => (await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).length === 1;
const worktree = "(SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default')";

for (const backend of testBackends()) describe(`[${backend}] #7956: owner, root and status of a git-canonical conversion`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const preview = ['default', '--to', 'git', '--dry-run', '--json'];

  const broken: Array<[string, (root: string) => void, string]> = [
    ['is gone', root => rmSync(root, { recursive: true, force: true }), 'missing'],
    ['is a file', root => { rmSync(root, { recursive: true, force: true }); writeFileSync(root, 'not a directory\n'); }, 'not_directory'],
    ['is a symlink loop', root => { rmSync(root, { recursive: true, force: true }); symlinkSync(root, root); }, 'symlink_loop'],
  ];
  for (const [name, breakRoot, reason] of broken) {
    // Value: protects=an unreadable owned root refuses typed with a fix instead of a raw error, and never as a missing checkout; fails_when=the plan reaches realpathSync or git rev-parse on it, or maps it to git_checkout_required; why_new=#7885's test only asserted it was not git_checkout_required; seam=none; no_claim=what sync itself says about such a root
    test(`a root that ${name} refuses source_root_unreadable (${reason}) with a fix, and writes nothing`, () => managedBrain(async ({ engine, root }) => {
      breakRoot(root);
      try {
        await expect(planGitConversion(engine, 'default')).rejects.toMatchObject({ code: 'source_root_unreadable' });
        const refused = await cli(engine, preview);
        expect(refused).toMatchObject({ status: 'refused', code: 'source_root_unreadable', reason, retryable: false,
          fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json'] } });
        expect(String(refused.message)).toContain(root);
        expect(await isStrict(engine)).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); }
    }, { databaseUrl, setup: committed }), 120_000);
  }

  // Value: protects=a root the account cannot list refuses typed (permission_denied); fails_when=EACCES surfaces raw; why_new=the cases above cover the other errno classes; seam=none; no_claim=root, who bypasses permissions (skipped)
  test.skipIf(process.getuid?.() === 0)('a root without read permission refuses source_root_unreadable (permission_denied)', () => managedBrain(async ({ engine, root }) => {
    chmodSync(root, 0o000);
    try {
      expect(await cli(engine, preview)).toMatchObject({ status: 'refused', code: 'source_root_unreadable', reason: 'permission_denied' });
    } finally { chmodSync(root, 0o755); }
  }, { databaseUrl, setup: committed }), 120_000);

  const unowned: Array<[string, string, string | undefined]> = [
    ['an archived source', "UPDATE sources SET archived=true WHERE id='default'", undefined],
    ['a re-registered source', "UPDATE persistence_source_bindings SET source_incarnation=gen_random_uuid() WHERE source_id='default'", 'incarnation_changed'],
    ['a checkout another host owns', `UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid() WHERE id=${worktree}`, 'host_mismatch'],
    ['a draining worktree', `UPDATE persistence_worktrees SET state='draining' WHERE id=${worktree}`, 'transfer_in_progress'],
  ];
  for (const [name, sql, reason] of unowned) {
    // Value: protects=the owner gate runs before the checkout check with the context's own conditions, so a checkout-less root on a source this host may not sync is refused as unowned, not as missing a checkout (whose fix is git init there); fails_when=the checkout check gates on a narrower predicate than resolveManagedSyncContext; why_new=no test set an unowned binding over a checkout-less root; seam=none; no_claim=the owner_unavailable message itself
    test(`${name} over a checkout-less root refuses owner_unavailable, not git_checkout_required`, () => managedBrain(async ({ engine }) => {
      await engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change', 'on', true)"); await tx.executeRaw(sql); });
      expect(await cli(engine, preview)).toMatchObject({ status: 'refused', code: 'owner_unavailable', ...(reason ? { reason } : {}) });
      expect(await isStrict(engine)).toBe(false);
    }, { databaseUrl, setup: plain }), 120_000);
  }

  /** Runs `run` once, when strict pass 2 has read its level; returns whether it ran. */
  const afterStrictPass2 = (seen: ConversionProgress[], run: () => Promise<void>) => {
    let done = false;
    installFaultHook(async point => {
      if (done || point !== 'sync:level_read' || seen.at(-1)?.phase !== 'strict_pass_2') return;
      done = true;
      await run();
    });
    return () => done;
  };
  const toMixed = async (engine: BrainEngine) => { await applyMixedConversion(engine, 'default', (await planMixedConversion(engine, 'default')).preview_hash); };

  // Value: protects=an apply whose source was returned to mixed during strict pass 2 reports incomplete with after.strict false, never converted; fails_when=status reads after.remaining alone; why_new=every converted test keeps the flag; seam=fault hook at sync:level_read; no_claim=a --to mixed racing the flag flip itself
  test('a --to mixed apply during strict pass 2 leaves the apply incomplete, not converted', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
    const seen: ConversionProgress[] = [];
    const fired = afterStrictPass2(seen, () => toMixed(engine));
    let result: Awaited<ReturnType<typeof applyGitConversion>>;
    try {
      const { preview: plan } = await planGitConversion(engine, 'default');
      result = await applyGitConversion(engine, 'default', plan.preview_hash, { noExtract: true, onProgress: progress => seen.push(progress) });
    } finally { installFaultHook(undefined); }
    expect(fired()).toBe(true);
    expect(result).toMatchObject({ status: 'incomplete', closing_passes: 0, after: { strict: false } });
    expect(await isStrict(engine)).toBe(false);
  }, { databaseUrl, setup: committed }), 300_000);

  // Value: protects=closing passes run only on a source that is still git-canonical: Git ahead on a source returned to mixed gets no closing pass, and the CLI says the source is mixed; fails_when=the closing loop drops its after.strict guard, or the refusal says git-canonical; why_new=the live-writer tests keep the flag; seam=fault hook at sync:level_read; no_claim=what a later mixed sync imports
  test('Git ahead on a source returned to mixed gets no closing pass, and the refusal says the source is mixed', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
    const seen: ConversionProgress[] = [];
    const fired = afterStrictPass2(seen, async () => {
      await toMixed(engine);
      writeFileSync(join(root, 'notes/b.md'), note('Committed by a live writer after strict pass 2.'));
      const lock = await acquireCommitLockAsync(root, 10_000);
      try { git(root, 'add', '--', 'notes/b.md'); git(root, 'commit', '-qm', 'live writer'); } finally { await lock.release(); }
    });
    let out: Record<string, any>;
    try {
      const { preview: plan } = await planGitConversion(engine, 'default');
      out = await cli(engine, ['default', '--to', 'git', '--apply', '--expect', plan.preview_hash, '--no-extract', '--json'], seen);
    } finally { installFaultHook(undefined); }
    expect(fired()).toBe(true);
    expect(out).toMatchObject({ status: 'incomplete', code: 'git_conversion_incomplete', result: { status: 'incomplete', closing_passes: 0, after: { strict: false } } });
    expect(out.result.after.git_wins.count).toBeGreaterThan(0);
    expect(out.message).toContain('is mixed');
    expect(out.message).not.toContain('is git-canonical');
    expect(await isStrict(engine)).toBe(false);
  }, { databaseUrl, setup: committed }), 300_000);
});
