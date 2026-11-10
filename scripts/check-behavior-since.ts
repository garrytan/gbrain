#!/usr/bin/env bun
/**
 * check:behavior-since — a BEHAVIOR_CHANGES row with `since: 'TBD'` never ships.
 *
 *   bun run check:behavior-since              verify / CI: refuse TBD rows on a stamped tree or master
 *   bun scripts/check-behavior-since.ts --stamped
 *                                             restamp / release: refuse any TBD row
 *
 * Unstamped development branches write their rows as since: 'TBD' and the
 * merge-slot stamp gives them the release. compareReleases ranks 'TBD' below
 * every release, so a TBD row that ships is never disclosed by the upgrade
 * notice. Any TBD row is refused when:
 *   - --stamped is passed (release:restamp after it rewrites the rows, the
 *     Release workflow before it publishes);
 *   - the run is on master (GITHUB_REF=refs/heads/master, or HEAD is the base
 *     ref's commit), or the base ref itself carries a TBD row;
 *   - CHANGELOG.md has a release header for VERSION and VERSION differs from
 *     the base ref's VERSION (a stamped PR head, stamped by tool or by hand).
 * Otherwise VERSION equals the base's (an unstamped branch) and TBD rows pass.
 *
 * Under .gstack/ship-policy.json `merge: direct` versions are written at release, which never edits this file, so
 * a TBD row is refused on every tree: a plain-text row is a behavior-changes.d/<id>.md fragment and a function row
 * is dated `since: releasedIn('<id>')` (behavior-changes.d/README.md). With --stamped (the Release workflow) the
 * release commit must also hold no unfolded changelog.d fragment and a fresh behavior-change table, and a missing or
 * unparsable .gstack/ship-policy.json is refused rather than read as "not direct".
 *
 * Base ref: $GBRAIN_RELEASE_BASE_REF, default origin/master. When it is
 * unavailable the check fails under CI=true and skips locally.
 * Exit: 0 ok or skipped, 1 refused, 2 usage. Docs: docs/RELEASING.md#release-restamp
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, CHANGELOG_FRAGMENT_DIR, OUT } from './build-behavior-changes.ts';

export const NOTICE_FILE = 'src/core/behavior-change-notice.ts';
const POLICY_FILE = '.gstack/ship-policy.json';
const TBD = /since:\s*'TBD'/;
const SEE = 'See:  docs/RELEASING.md#release-restamp';

/** 1-based line numbers of the since: 'TBD' rows in the notice source. */
export function tbdLines(text: string): number[] {
  return text.split('\n').flatMap((line, i) => (TBD.test(line) ? [i + 1] : []));
}

export function main(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; log?: (line: string) => void } = {}): number {
  const root = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const unknown = argv.filter((a) => a !== '--stamped');
  if (unknown.length) {
    log(`usage: bun scripts/check-behavior-since.ts [--stamped]   (unknown: ${unknown.join(' ')})`);
    return 2;
  }
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
  };
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');

  if (argv.includes('--stamped') && !existsSync(join(root, NOTICE_FILE))) {
    log(`FAIL: ${NOTICE_FILE} is missing, so its rows cannot be checked before stamping or release.`);
    log('Fix:  check the file out (a sparse checkout must include it), then rerun.');
    log(SEE);
    return 1;
  }
  const policy = (() => { try { return { merge: JSON.parse(read(POLICY_FILE)).merge }; } catch (e) { return { error: existsSync(join(root, POLICY_FILE)) ? `cannot be parsed (${e instanceof Error ? e.message : String(e)})` : 'is missing' }; } })();
  if ('error' in policy && argv.includes('--stamped')) {
    log(`FAIL: ${POLICY_FILE} ${policy.error}, so this check cannot tell whether the release commit must have folded its changelog.d fragments and regenerated its behavior-change table.`);
    log('Why:  --stamped guards a stamp or a release; reading no policy as `merge` unset would skip those checks without saying so.');
    log(`Fix:  restore ${POLICY_FILE} from master (git checkout origin/master -- ${POLICY_FILE}; a sparse checkout must include .gstack), then rerun.`);
    log(SEE);
    return 1;
  }
  const direct = !('error' in policy) && policy.merge === 'direct';
  if (direct && argv.includes('--stamped')) {
    const unfolded = existsSync(join(root, CHANGELOG_FRAGMENT_DIR)) ? readdirSync(join(root, CHANGELOG_FRAGMENT_DIR)).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
    const table = build(root);
    const stale = table.problems.length > 0 || read(OUT) !== table.text;
    if (unfolded.length || stale) {
      log(`FAIL: the release commit (VERSION ${read('VERSION').trim()}) ${unfolded.length ? `still holds ${unfolded.length} unfolded ${CHANGELOG_FRAGMENT_DIR} fragment(s): ${unfolded.join(', ')}` : `has a stale ${OUT}`}${table.problems.length ? ` (${table.problems[0]})` : ''}.`);
      log('Why:  a release folds every changelog fragment into its CHANGELOG section and dates its behavior-change rows; a commit that did not is not a release.');
      log('Fix:  open the release again with gstack-release-stamp open, which stamps a fresh checkout of master; never edit a release/<version> branch by hand.');
      log('See:  docs/RELEASING.md#releases-per-batch');
      return 1;
    }
  }
  const lines = tbdLines(read(NOTICE_FILE));
  if (direct && lines.length) {
    log(`FAIL: ${lines.length} BEHAVIOR_CHANGES row(s) in ${NOTICE_FILE} say since: 'TBD' (line ${lines.join(', ')}).`);
    log('Why:  under merge: direct the release writes versions and never edits this file, so a TBD row would never be dated or disclosed.');
    log("Fix:  move a plain-text row to behavior-changes.d/<id>.md and name <!-- behavior-change: <id> --> in your changelog.d fragment; a function row keeps its line as since: releasedIn('<id>') with the same marker (bun run release:unstamp converts a branch).");
    log('See:  behavior-changes.d/README.md');
    return 1;
  }
  if (lines.length === 0) {
    log(`check-behavior-since: ok (no since: 'TBD' row in ${NOTICE_FILE})`);
    return 0;
  }
  const version = read('VERSION').trim();
  const refuse = (context: string) => {
    log(`FAIL: ${lines.length} BEHAVIOR_CHANGES row(s) in ${NOTICE_FILE} still say since: 'TBD' (line ${lines.join(', ')}) on ${context}.`);
    log("Why:  compareReleases ranks 'TBD' below every release, so a shipped TBD row is never shown by the upgrade notice; the merge-slot stamp must give each row its release.");
    log(`Fix:  run bun run release:restamp (it rewrites every since: 'TBD' to the new VERSION), or replace each since: 'TBD' with since: '${version}' by hand, then rerun bun run check:behavior-since.`);
    log(SEE);
    return 1;
  };

  if (argv.includes('--stamped')) return refuse(`a tree being stamped or released (VERSION ${version})`);
  if (env.GITHUB_REF === 'refs/heads/master') return refuse(`master (VERSION ${version})`);

  const ref = env.GBRAIN_RELEASE_BASE_REF || 'origin/master';
  const baseCommit = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!baseCommit.ok) {
    const msg = `check-behavior-since: base ref ${ref} is not available (git fetch origin master)`;
    if (env.CI === 'true') {
      log(`FAIL: ${msg}`);
      log('Why:  without the base ref the check cannot tell an unstamped branch from a stamped one.');
      log('Fix:  fetch it in the workflow (git fetch --no-tags --depth=1 origin +refs/heads/master:refs/remotes/origin/master)');
      log(SEE);
      return 1;
    }
    log(`skip: ${msg}`);
    log(`GBRAIN_CHECK_SKIPPED: base ref ${ref} unavailable`);
    return 0;
  }
  if (git('rev-parse', 'HEAD').out === baseCommit.out) return refuse(`the base ref ${ref} itself (VERSION ${version})`);
  const base = git('show', `${ref}:${NOTICE_FILE}`);
  if (base.ok && tbdLines(base.out).length > 0) return refuse(`a tree whose base ${ref} already ships a TBD row`);
  const baseVersion = git('show', `${ref}:VERSION`).out.trim();
  const header = read('CHANGELOG.md').split('\n').some((line) => line.startsWith(`## [${version}]`));
  if (header && version !== baseVersion) return refuse(`a stamped tree (VERSION ${version} has a CHANGELOG release header; ${ref} is at ${baseVersion})`);

  log(`check-behavior-since: ok (${lines.length} since: 'TBD' row(s) on an unstamped branch: VERSION ${version} equals ${ref}'s; the merge-slot stamp replaces them)`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
