/**
 * #7885: `sources canonical --to git` on a managed source whose root is not a Git checkout (a repo-less source, or a
 * fresh `git init` with no commit yet) refuses with a typed host refusal before anything is read, instead of
 * `internal_error` from a raw `git rev-parse`. The source stays usable as it is: its pages still write.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import { planGitConversion } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const note = (body: string) => `---\ntype: concept\ntitle: note\n---\n\n${body}\n`;
const plain = ({ root }: { root: string }) => { mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/a.md'), note('A plain file.')); };
const unborn = ({ root }: { root: string }) => { plain({ root }); execFileSync('git', ['-C', root, 'init', '-q']); };

async function cli(engine: Parameters<typeof runSourcesCanonical>[0], args: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { out.push(String(line)); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { await runSourcesCanonical(engine, args); }
  finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(out.at(-1)!);
}

const detached = ({ root }: { root: string }) => {
  plain({ root });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Example Writer'); git('config', 'user.email', 'writer@example.invalid');
  git('add', '-A'); git('commit', '-qm', 'notes'); git('checkout', '-q', '--detach');
};

for (const backend of testBackends()) describe(`[${backend}] #7885: --to git on a managed source without a Git checkout`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const [name, setup, code] of [['a plain directory', plain, 'git_checkout_required'], ['a git init with no commit', unborn, 'git_branch_unborn']] as const) {
    test(`${name}: preview and apply refuse ${code} with a fix, read nothing and write nothing; pages still write`, () => managedBrain(async ({ engine, ctx }) => {
      await expect(planGitConversion(engine, 'default')).rejects.toMatchObject({ code });
      for (const args of [['--dry-run', '--json'], ['--apply', '--expect', 'a'.repeat(64), '--json']]) {
        const refused = await cli(engine, ['default', '--to', 'git', ...args]);
        expect(refused).toMatchObject({ status: 'refused', code, fix: { argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], actor: 'user' } });
        expect(String(refused.message)).toContain('stays usable as it is');
      }
      expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
      const written = await operationsByName.put_page.handler(ctx, { slug: 'notes/after', content: note('Written after the refusal.') }) as { status: string };
      expect(written.status).toBe('created_or_updated');
    }, { databaseUrl, setup }), 120_000);
  }

  // Value: protects=a root on a detached HEAD is not refused as checkout-less, so the preview still plans; fails_when=assertConversionCheckout rethrows git_detached_head or maps it to a checkout refusal; why_new=the two refusal cases never reach the detached-HEAD early return; seam=none; no_claim=the apply on a detached HEAD (pushes are the durability check's concern)
  test('a detached HEAD is not a missing checkout: the preview plans instead of refusing', () => managedBrain(async ({ engine }) => {
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview.source_id).toBe('default');
  }, { databaseUrl, setup: detached }), 120_000);

  // Value: protects=a root that is gone (unmounted, moved) is never refused as checkout-less, whose fix would git init an empty repository there; fails_when=assertConversionCheckout maps an unreadable root to git_checkout_required; why_new=the refusal tests all have a readable root; seam=none; no_claim=which refusal the context resolution gives
  test('a root that is gone is not refused as a missing checkout: the context resolution owns it', () => managedBrain(async ({ engine, root }) => {
    rmSync(root, { recursive: true, force: true });
    try {
      const refused = await planGitConversion(engine, 'default').then(() => null, (error: { code?: string }) => error);
      expect(refused).not.toBeNull();
      expect(refused!.code).not.toBe('git_checkout_required');
    } finally { mkdirSync(root, { recursive: true }); }
  }, { databaseUrl, setup: plain }), 120_000);
});
