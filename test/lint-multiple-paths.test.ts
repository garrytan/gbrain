/**
 * `gbrain lint` and `gbrain frontmatter validate` check EVERY path argument.
 *
 * Pre-fix, `gbrain lint a.md b.md` linted only the first positional and
 * `gbrain frontmatter validate a.md b.md` only the last; the others were
 * dropped without a message while the command reported on the one it kept
 * (lint exit 0, validate "OK" + exit 0 when the dropped file was the broken
 * one). A caller batching files therefore got silent partial coverage, and a
 * caller that did not batch had to spawn one process per file.
 *
 * Protects: N targets are processed in one run with aggregated counts; a
 * missing target is refused before anything is linted; lint's default exit
 * stays 0 with findings and the opt-in `--strict` exits 1 while any finding
 * remains; validate's JSON envelope keeps `target` for one path and reports
 * `targets` for several. Real `bun src/cli.ts` spawns, no database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliBatch } from './helpers/cli-spawn.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-lint-multi-'));
const home = join(root, 'home');
const clean = join(root, 'clean.md');
const dirty = join(root, 'dirty.md');
const broken = join(root, 'broken.md');
const dirA = join(root, 'a');
const dirB = join(root, 'b');

const CLEAN = '---\ntype: concept\ntitle: Clean\ncreated: 2026-01-01\n---\n\n# Clean\n\nA clean page with enough body text.\n';
// llm-preamble (fixable) + placeholder-date (not fixable).
const DIRTY = '---\ntype: concept\ntitle: Dirty\ncreated: 2026-01-01\n---\n\nOf course. Here is the page.\n\n# Dirty\n\nDated YYYY-MM-DD.\n';
const BROKEN = '---\ntype: concept\ntitle: "P "I" L"\n---\n\nbody\n';

beforeAll(() => {
  mkdirSync(home);
  mkdirSync(dirA);
  mkdirSync(dirB);
  writeFileSync(clean, CLEAN);
  writeFileSync(dirty, DIRTY);
  writeFileSync(broken, BROKEN);
  writeFileSync(join(dirA, 'index.md'), CLEAN);
  writeFileSync(join(dirB, 'index.md'), DIRTY);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const cli = (args: string[]) => runCli(args, { home });

describe('gbrain lint <path>...', () => {
  test('lints every file argument, not just the first', async () => {
    const { stdout, exitCode } = await cli(['lint', clean, dirty]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`${dirty}:`);
    expect(stdout).toContain('llm-preamble');
    expect(stdout).toContain('2 pages scanned. 2 issue(s) in 1 page(s).');
  }, 60_000);

  test('several directories: pages are shown under their directory and counted together', async () => {
    const { stdout, exitCode } = await cli(['lint', dirA, dirB]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`${join(dirB, 'index.md')}:`);
    expect(stdout).toContain('2 pages scanned. 2 issue(s) in 1 page(s).');
  }, 60_000);

  test('a missing target is refused before anything is linted', async () => {
    const { stdout, stderr, exitCode } = await cli(['lint', dirty, join(root, 'nope.md')]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Not found: ${join(root, 'nope.md')}`);
    expect(stdout).not.toContain('pages scanned');
  }, 60_000);

  test('--strict exits 1 while a finding remains in ANY target; default and clean runs exit 0', async () => {
    const [strictDirty, strictClean, strictDryRun] = await runCliBatch([
      ['lint', clean, dirty, '--strict'],
      ['lint', clean, join(dirA, 'index.md'), '--strict'],
      ['lint', clean, dirty, '--strict', '--fix', '--dry-run'],
    ], { home });
    expect(strictDirty.exitCode).toBe(1);
    expect(strictDirty.stdout).toContain('2 pages scanned. 2 issue(s) in 1 page(s).');
    expect(strictClean.exitCode).toBe(0);
    // A dry run fixes nothing, so the findings still remain.
    expect(strictDryRun.exitCode).toBe(1);
  }, 60_000);
});

describe('gbrain frontmatter validate <path>...', () => {
  test('validates every file argument, not just the last', async () => {
    const { stdout, exitCode } = await cli(['frontmatter', 'validate', broken, clean]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('across 1 file(s) (scanned 2)');
    expect(stdout).toContain(broken);
    expect(stdout).toContain('NESTED_QUOTES');
  }, 60_000);

  test('--json: one target keeps `target`; several report `targets` and every result', async () => {
    const [one, several] = await runCliBatch([
      ['frontmatter', 'validate', clean, '--json'],
      ['frontmatter', 'validate', clean, broken, '--json'],
    ], { home });
    const single = JSON.parse(one.stdout);
    expect(single.target).toBe(clean);
    expect(single.targets).toBeUndefined();
    const multi = JSON.parse(several.stdout);
    expect(several.exitCode).toBe(1);
    expect(multi.target).toBeUndefined();
    expect(multi.targets).toEqual([clean, broken]);
    expect(multi).toMatchObject({ ok: false, total_files: 2, files_with_errors: 1 });
    expect(multi.results.map((r: { path: string }) => r.path)).toEqual([clean, broken]);
  }, 60_000);
});
