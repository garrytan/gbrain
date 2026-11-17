/**
 * #5988 producer checks: `foresights frontmatter validate` keeps its strict
 * exit-1-on-any-error contract (YAML that ingestion recovers by quoting still
 * fails), `--importable` reports the ingestion (hold-code) view, `--stdin` /
 * `-` validate piped content with an optional `--path` slug check,
 * `--staged` validates git index blobs, and `--fix` adds the safe quote
 * repair (interpretations only with `--include-ambiguous`), re-validates, and
 * refuses on a managed root with the coordinated repair command.
 *
 * Driven in-process through runFrontmatter's test seams (stdin stream, git
 * cwd) with the console captured, like test/frontmatter-cli.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { runFrontmatter, type FrontmatterIo } from '../src/commands/frontmatter.ts';
import { repairRecoverableFrontmatter } from '../src/core/brain-writer.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const RECOVERABLE = '---\ntitle: Acme-example (citing a wire) (original: https://example.com/a)\ntype: note\n---\n\nbody\n';
const FOLDED = '---\ntitle: first line of a post\nsecond line of the post\ntype: note\n---\n\nbody\n';

async function runFm(args: string[], io: FrontmatterIo = {}): Promise<{ out: string; err: string; verdict: number }> {
  const logOrig = console.log;
  const errOrig = console.error;
  const prevExitCode = process.exitCode;
  const out: string[] = [];
  const err: string[] = [];
  _resetCliExitVerdictForTests();
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
  try {
    await runFrontmatter(args, io);
  } finally {
    console.log = logOrig;
    console.error = errOrig;
  }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { out: out.join(''), err: err.join(''), verdict };
}

const stdin = (text: string): FrontmatterIo => ({ stdin: Readable.from([Buffer.from(text)]) });

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fm-producer-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('validate --stdin', () => {
  test('recoverable YAML fails the strict default and passes --importable with FRONTMATTER_RECOVERED', async () => {
    const strict = await runFm(['validate', '--stdin'], stdin(RECOVERABLE));
    expect(strict.verdict).toBe(1);
    expect(strict.out).toContain('[YAML_PARSE]');
    expect(strict.out).toContain('importable but not canonical; run foresights frontmatter validate <file> --fix (quoting only)');

    const importable = await runFm(['validate', '--stdin', '--importable', '--json'], stdin(RECOVERABLE));
    expect(importable.verdict).toBe(0);
    const env = JSON.parse(importable.out);
    expect(env.ok).toBe(true);
    expect(env.mode).toBe('importable');
    expect(env.results[0].errors[0]).toMatchObject({ code: 'YAML_PARSE', recoverable: true });
    expect(env.results[0].warnings.map((w: { code: string }) => w.code)).toContain('FRONTMATTER_RECOVERED');
  });

  test('an unrecoverable block exits 1 in both views; --importable names the hold', async () => {
    expect((await runFm(['validate', '--stdin'], stdin(FOLDED))).verdict).toBe(1);
    const importable = await runFm(['validate', '--stdin', '--importable', '--json'], stdin(FOLDED));
    expect(importable.verdict).toBe(1);
    expect(JSON.parse(importable.out).results[0].hold).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2 });
  });

  test("'-' as the path reads stdin", async () => {
    const dash = await runFm(['validate', '-', '--json'], stdin(RECOVERABLE));
    expect(dash.verdict).toBe(1);
    expect(JSON.parse(dash.out)).toMatchObject({ stdin: true, total_files: 1, ok: false });
    const clean = await runFm(['validate', '-'], stdin('---\ntitle: fine\ntype: note\n---\n\nbody\n'));
    expect(clean.verdict).toBe(0);
  });

  test('--path enables the slug check; without it the check is reported as skipped', async () => {
    const page = '---\ntitle: fine\ntype: note\nslug: other/thing\n---\n\nbody\n';
    const skipped = await runFm(['validate', '--stdin'], stdin(page));
    expect(skipped.verdict).toBe(0);
    expect(skipped.out).toContain('Slug check skipped');
    expect(JSON.parse((await runFm(['validate', '--stdin', '--json'], stdin(page))).out).slug_check).toBe('skipped');

    const checked = await runFm(['validate', '--stdin', '--path', 'notes/foo.md', '--json'], stdin(page));
    expect(checked.verdict).toBe(1);
    const env = JSON.parse(checked.out);
    expect(env.slug_check).toBe('checked');
    expect(env.results[0].errors.map((e: { code: string }) => e.code)).toContain('SLUG_MISMATCH');

    const held = await runFm(['validate', '--stdin', '--path=notes/foo.md', '--importable', '--json'], stdin(page));
    expect(held.verdict).toBe(1);
    expect(JSON.parse(held.out).results[0].hold.code).toBe('frontmatter_slug_conflict');

    const matching = await runFm(['validate', '--stdin', '--path', 'other/thing.md'], stdin(page));
    expect(matching.verdict).toBe(0);
  });

  test('--fix on stdin is refused with the file command', async () => {
    const r = await runFm(['validate', '--stdin', '--fix'], stdin(RECOVERABLE));
    expect(r.verdict).toBe(1);
    expect(r.err).toContain('foresights frontmatter validate <file> --fix');
  });
});

describe('validate --staged', () => {
  function repo(): string {
    const dir = join(tmp, 'repo');
    mkdirSync(join(dir, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  }
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args]);

  test('a broken staged blob fails while the fixed working copy passes (partially staged)', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'notes', 'a.md'), RECOVERABLE);
    writeFileSync(join(dir, 'notes', 'b c.md'), '---\ntitle: fine\ntype: note\n---\n\nbody\n');
    git(dir, 'add', '.');
    writeFileSync(join(dir, 'notes', 'a.md'), repairRecoverableFrontmatter(RECOVERABLE).content);

    const r = await runFm(['validate', '--staged'], { cwd: dir });
    expect(r.verdict).toBe(1);
    expect(r.out).toContain('notes/a.md (staged version)');
    expect(r.out).toContain('the staged version of notes/a.md is broken; the working copy passes. Review it and git add notes/a.md');
    expect(r.out).not.toContain('b c.md (staged version)');

    const json = JSON.parse((await runFm(['validate', '--staged', '--json'], { cwd: dir })).out);
    expect(json).toMatchObject({ staged: true, total_files: 2, files_failed: 1 });
    expect(json.results.find((x: { path: string }) => x.path === 'notes/a.md').working_copy_ok).toBe(true);

    git(dir, 'add', 'notes/a.md');
    expect((await runFm(['validate', '--staged'], { cwd: dir })).verdict).toBe(0);
  });

  test('a clean staged blob passes even when the working copy is broken', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'notes', 'a.md'), '---\ntitle: fine\ntype: note\n---\n\nbody\n');
    git(dir, 'add', '.');
    writeFileSync(join(dir, 'notes', 'a.md'), FOLDED);
    const r = await runFm(['validate', '--staged', '--', 'notes/a.md'], { cwd: dir });
    expect(r.verdict).toBe(0);
    expect(r.out).toContain('OK — 1 staged file(s) scanned');
  });

  test('--importable on staged blobs exits 0 for recoverable YAML; a path with no staged version fails', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'notes', 'a.md'), RECOVERABLE);
    git(dir, 'add', '.');
    expect((await runFm(['validate', '--staged', '--importable'], { cwd: dir })).verdict).toBe(0);
    const missing = await runFm(['validate', '--staged', 'notes/nope.md'], { cwd: dir });
    expect(missing.verdict).toBe(1);
    expect(missing.out).toContain('Stage it first: git add notes/nope.md');
  });
});

describe('validate --fix', () => {
  const home = () => join(tmp, 'home');

  test('the old invocation still fixes MISSING_CLOSE and exits 0 once clean', async () => {
    const f = join(tmp, 'note.md');
    writeFileSync(f, '---\ntitle: fine\ntype: note\n# Heading\n\nbody\n');
    const r = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    expect(r.verdict).toBe(0);
    expect(readFileSync(f, 'utf8')).toContain('---\n\n# Heading');
  });

  test('the safe quote repair changes only the recovered line and keeps CRLF and BOM', async () => {
    const f = join(tmp, 'note.md');
    const original = '\uFEFF---\r\ntitle: a: b\r\ntype: note\r\ntags: [x]\r\n---\r\n\r\nbody\r\n';
    writeFileSync(f, original);
    const r = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    expect(r.verdict).toBe(0);
    expect(r.out).toContain('fixed: Quoted the value of "title" at line 2');
    expect(readFileSync(f, 'utf8')).toBe(original.replace('title: a: b', 'title: "a: b"'));
    expect((await runFm(['validate', f])).verdict).toBe(0);
  });

  test('an error the fix cannot repair exits 1 and leaves the file unchanged', async () => {
    const f = join(tmp, 'note.md');
    writeFileSync(f, FOLDED);
    const r = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    expect(r.verdict).toBe(1);
    expect(r.out).toContain('still failing: [YAML_PARSE]');
    expect(r.out).toContain('--fix --include-ambiguous --dry-run');
    expect(readFileSync(f, 'utf8')).toBe(FOLDED);
  });

  test('interpretations apply only with --include-ambiguous (dry-run first, then write)', async () => {
    const f = join(tmp, 'note.md');
    writeFileSync(f, FOLDED);
    const preview = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix', '--include-ambiguous', '--dry-run']));
    expect(preview.verdict).toBe(0);
    expect(preview.out).toContain('would fix: Folded the unquoted lines after "title" (line 2)');
    expect(readFileSync(f, 'utf8')).toBe(FOLDED);

    const applied = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix', '--include-ambiguous']));
    expect(applied.verdict).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('---\ntitle: "first line of a post\\nsecond line of the post"\ntype: note\n---\n\nbody\n');
  });

  test('a #-leading title is quoted only with --include-ambiguous', async () => {
    const f = join(tmp, 'note.md');
    const page = '---\ntitle: #1 thing\ntype: note\n---\n\nbody\n';
    writeFileSync(f, page);
    await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    expect(readFileSync(f, 'utf8')).toBe(page);
    const r = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix', '--include-ambiguous']));
    expect(r.verdict).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('---\ntitle: "#1 thing"\ntype: note\n---\n\nbody\n');
  });

  test('a fix inside a git repo prints the restage step', async () => {
    const dir = join(tmp, 'repo');
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    const f = join(dir, 'note.md');
    writeFileSync(f, RECOVERABLE);
    const r = await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    expect(r.verdict).toBe(0);
    expect(r.out).toContain('restage them: git add -- note.md');
  });

  test('on a managed root it refuses with the coordinated repair command and writes nothing', async () => {
    const dir = join(tmp, 'managed');
    mkdirSync(dir);
    writeFileSync(join(dir, '.gbrain-managed'), '{}');
    const f = join(dir, 'note.md');
    writeFileSync(f, RECOVERABLE);
    let thrown: unknown;
    try {
      await withEnv({ GBRAIN_HOME: home() }, () => runFm(['validate', f, '--fix']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    const error = thrown as OperationError;
    expect(error.code).toBe('writer_coordinator_required');
    expect(error.suggestion).toContain('foresights repair frontmatter');
    expect(error.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'repair', 'frontmatter']);
    expect(readFileSync(f, 'utf8')).toBe(RECOVERABLE);
    expect(existsSync(join(home(), '.gbrain', 'backups'))).toBe(false);
    expect((await runFm(['validate', f, '--fix', '--dry-run'])).out).toContain('would fix');
  });
});
