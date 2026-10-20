#!/usr/bin/env bun
/**
 * check:changelog-headings — CHANGELOG.md keeps every release heading origin/master has.
 *
 * A tool or agent that rewrites CHANGELOG.md from a partial read can cut the file
 * (a 42k-line changelog written back as its first few hundred lines). Every
 * `## [X]` heading on the base ref must still be in the working tree's file.
 * Base ref: $GBRAIN_CHANGELOG_BASE_REF, default origin/master; unavailable: fails
 * under CI=true, skips locally. Exit 0 ok or skipped, 1 refused.
 * Docs: docs/RELEASING.md#release-restamp
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const missing = releaseHeadings(base.stdout).filter((heading) => !have.has(heading));
  if (missing.length === 0) {
    log(`check-changelog-headings: ok (every release heading on ${ref} is present)`);
    return 0;
  }
  log(`FAIL: CHANGELOG.md is missing ${missing.length} release heading(s) that ${ref} has (first: ${missing[0]}).`);
  log('Why:  release history never leaves the changelog; a missing heading means the file was cut or an entry was deleted.');
  log(`Fix:  restore it from the base (git show ${ref}:CHANGELOG.md > CHANGELOG.md), put this branch\'s entry back on top, then rerun bun run check:changelog-headings.`);
  log('See:  docs/RELEASING.md#release-restamp');
  return 1;
}

if (import.meta.main) process.exit(main());
