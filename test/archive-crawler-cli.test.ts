/**
 * `gbrain archive-crawler check` — the gate the archive-crawler skill runs
 * before it reads, extracts or files anything from an archive.
 *
 * Authoring gate:
 *   1. Protects the skill's safety contract as an agent sees it: exit 1 and
 *      a reason when the allow-list is missing or a path is outside
 *      scan_paths / inside deny_paths, exit 0 for an allowed path.
 *   2. Fails if the command is unwired, if a refusal exits 0, or if a
 *      directory check stops naming the deny_paths a walk must skip.
 *   3. test/archive-crawler-config.test.ts pins the parser and the per-path
 *      predicate in-process; nothing exercised the command an agent runs.
 *   4. No seam: spawns the real CLI with --repo, so no brain is opened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

// realpath: the command reports canonical locations (macOS tmpdir is a symlink).
const work = realpathSync(mkdtempSync(join(tmpdir(), 'archive-crawler-cli-')));
const home = join(work, 'home');
const brain = join(work, 'brain');
const unconfigured = join(work, 'unconfigured');
const writing = join(work, 'archive', 'writing');
const letter = join(writing, 'letters', 'letter.txt');
const journal = join(writing, 'private', 'journal.txt');
const tax = join(work, 'archive', 'finances', 'tax.txt');

let missing: CliResult;
let mixed: CliResult;
let allowed: CliResult;
let directory: CliResult;
let configOnly: CliResult;
let relative: CliResult;
let noSubcommand: CliResult;

beforeAll(async () => {
  for (const dir of [home, brain, unconfigured, join(writing, 'letters'), join(writing, 'private'), join(work, 'archive', 'finances')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(letter, 'a letter');
  writeFileSync(journal, 'a journal');
  writeFileSync(tax, 'a tax return');
  writeFileSync(join(brain, 'gbrain.yml'), `archive-crawler:\n  scan_paths:\n    - ${writing}\n  deny_paths:\n    - ${join(writing, 'private')}\n`);
  writeFileSync(join(unconfigured, 'gbrain.yml'), 'storage:\n  db_tracked:\n    - originals/\n');

  const check = (...args: string[]) => ['archive-crawler', 'check', ...args];
  [missing, mixed, allowed, directory, configOnly, relative, noSubcommand] = await runCliBatch([
    check(letter, '--repo', unconfigured),
    check(letter, tax, journal, '--repo', brain, '--json'),
    check(letter, '--repo', brain),
    check(writing, '--repo', brain, '--json'),
    check('--repo', brain),
    check(join('archive', 'finances', 'tax.txt'), '--repo', brain, '--json'),
    ['archive-crawler'],
  ], { home, cwd: work });
}, 120_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('gbrain archive-crawler check', () => {
  it('refuses to run when gbrain.yml has no archive-crawler allow-list', () => {
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('archive-crawler: refusing to run. No `archive-crawler.scan_paths:` allow-list');
    expect(missing.stdout).not.toContain('allowed');
  });

  it('refuses a path outside scan_paths and a path inside deny_paths, and says why', () => {
    expect(mixed.exitCode).toBe(1);
    const result = JSON.parse(mixed.stdout);
    expect(result.ok).toBe(false);
    expect(result.paths.map((p: { path: string; allowed: boolean; reason?: string }) => [p.path, p.allowed, p.reason ?? null])).toEqual([
      [letter, true, null],
      [tax, false, 'outside_scan_paths'],
      [journal, false, 'denied'],
    ]);
    expect(result.paths[2].deny_path).toBe(join(writing, 'private') + sep);
  });

  it('passes an allowed path', () => {
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain(`archive-crawler: allowed  ${letter}`);
  });

  it('names the deny_paths a walk of an allowed directory must skip', () => {
    expect(directory.exitCode).toBe(0);
    expect(JSON.parse(directory.stdout).paths[0]).toMatchObject({ allowed: true, excluded: [join(writing, 'private') + sep] });
  });

  it('with no path, confirms the allow-list is configured and prints it', () => {
    expect(configOnly.exitCode).toBe(0);
    expect(configOnly.stdout).toContain(`scan_paths  ${writing}${sep}`);
    expect(configOnly.stdout).toContain(`deny_paths  ${join(writing, 'private')}${sep}`);
  });

  it('resolves a relative path against the working directory', () => {
    expect(relative.exitCode).toBe(1);
    expect(JSON.parse(relative.stdout).paths[0]).toMatchObject({ resolved: tax, allowed: false, reason: 'outside_scan_paths' });
  });

  it('treats a missing subcommand as a usage error, never a pass', () => {
    expect(noSubcommand.exitCode).toBe(2);
    expect(noSubcommand.stderr).toContain('Missing archive-crawler subcommand.');
  });
});
