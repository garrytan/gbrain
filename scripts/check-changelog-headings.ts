#!/usr/bin/env bun
/**
 * check:changelog-headings — CHANGELOG.md keeps every release heading origin/master has.
 *
 * A tool or agent that rewrites CHANGELOG.md from a partial read can cut the file
 * (a 42k-line changelog written back as its first few hundred lines). Every
 * `## [X]` heading on the base ref must still be in the working tree's file, except
 * a release newer than the working tree's VERSION: since PRs carry no version, a
 * branch that lands without containing master is behind master's newest releases,
 * and its merged tree carries them.
 * Base ref: $GBRAIN_CHANGELOG_BASE_REF, default origin/master; unavailable: fails
 * under CI=true, skips locally. Exit 0 ok or skipped, 1 refused.
 * Docs: docs/RELEASING.md#release-restamp
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const versionParts = (v: string): number[] | null => (/^\d+(\.\d+){2,3}$/.test(v) ? v.split('.').map(Number) : null);
const compareParts = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

export function releaseHeadings(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('## ['));
}

export function main(opts: { cwd?: string; env?: Record<string, string | undefined>; log?: (line: string) => void } = {}): number {
  const root = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const ref = env.GBRAIN_CHANGELOG_BASE_REF || 'origin/master';
  const base = spawnSync('git', ['show', `${ref}:CHANGELOG.md`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (base.status !== 0) {
    if (env.CI === 'true') {
      log(`FAIL: check-changelog-headings: cannot read ${ref}:CHANGELOG.md`);
      log('Fix:  fetch the base ref (git fetch --no-tags --depth=1 origin +refs/heads/master:refs/remotes/origin/master)');
      return 1;
    }
    log(`skip: check-changelog-headings: ${ref} is not available`);
    log(`GBRAIN_CHECK_SKIPPED: base ref ${ref} unavailable`);
    return 0;
  }
  const file = join(root, 'CHANGELOG.md');
  const have = new Set(existsSync(file) ? releaseHeadings(readFileSync(file, 'utf8')) : []);
  const own = existsSync(join(root, 'VERSION')) ? versionParts(readFileSync(join(root, 'VERSION'), 'utf8').trim()) : null;
  const absent = releaseHeadings(base.stdout).filter((heading) => !have.has(heading));
  const newer = absent.filter((heading) => {
    const v = versionParts(/^## \[([^\]]+)\]/.exec(heading)?.[1] ?? '');
    return own !== null && v !== null && compareParts(v, own) > 0;
  });
  const missing = absent.filter((heading) => !newer.includes(heading));
  if (missing.length === 0) {
    const behind = newer.length > 0 ? `; ${newer.length} newer release heading(s) on ${ref} are not on this branch yet` : '';
    log(`check-changelog-headings: ok (every release heading on ${ref} is present${behind})`);
    return 0;
  }
  log(`FAIL: CHANGELOG.md is missing ${missing.length} release heading(s) that ${ref} has (first: ${missing[0]}).`);
  log('Why:  release history never leaves the changelog; a missing heading means the file was cut or an entry was deleted.');
  log(`Fix:  restore it from the base (git show ${ref}:CHANGELOG.md > CHANGELOG.md), put this branch\'s entry back on top, then rerun bun run check:changelog-headings.`);
  log('See:  docs/RELEASING.md#release-restamp');
  return 1;
}

if (import.meta.main) process.exit(main());
