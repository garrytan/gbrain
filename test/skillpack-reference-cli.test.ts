/**
 * CLI contract for `gbrain skillpack reference` flag combinations (#5491).
 *
 * Pins:
 *   - --all + --apply-clean-hunks stays refused (exit 2, no writes) and the
 *     error names the per-skill command to run instead
 *   - --help shows --apply-clean-hunks only on the per-skill form
 *   - the refusal fires before workspace resolution
 *   - boolean flags given a value (`--dry-run=true`) are refused, not ignored
 *   - --since needs a value, and without --all warns instead of being ignored
 *   - reference --harness help says apply takes exactly one skill
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const env = {
    ...process.env,
    HOME: scratch('sp-refcli-home-'),
    GBRAIN_HOME: scratch('sp-refcli-gb-'),
    OPENCLAW_WORKSPACE: '',
    ...opts.env,
  };
  const r = spawnSync('bun', [CLI, 'skillpack', ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Workspace with book-mirror scaffolded and a local edit on its SKILL.md. */
function editedWorkspace(): { ws: string; skillPath: string; edited: string } {
  const ws = scratch('sp-refcli-ws-');
  const scaffold = run(['scaffold', 'book-mirror', '--workspace', ws]);
  expect(scaffold.code, scaffold.stderr).toBe(0);
  const skillPath = join(ws, 'skills', 'book-mirror', 'SKILL.md');
  appendFileSync(skillPath, '\nIntentional local edit.\n');
  return { ws, skillPath, edited: readFileSync(skillPath, 'utf-8') };
}

describe('skillpack reference CLI flag contract', () => {
  test('--all --apply-clean-hunks is refused, writes nothing, and names the per-skill command', () => {
    const { ws, skillPath, edited } = editedWorkspace();

    const r = run(['reference', '--all', '--apply-clean-hunks', '--workspace', ws]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('gbrain skillpack reference --all');
    expect(r.stderr).toContain('gbrain skillpack reference <slug> --apply-clean-hunks');
    expect(readFileSync(skillPath, 'utf-8')).toBe(edited);
  }, 180_000);

  test('--help lists --apply-clean-hunks only on the per-skill form', () => {
    const r = run(['reference', '--help']);

    expect(r.code).toBe(0);
    const usage = r.stdout.split('\n').filter(l => l.startsWith('gbrain skillpack reference'));
    const allForm = usage.find(l => l.includes('--all'));
    const nameForm = usage.find(l => l.includes('<name>'));
    expect(allForm).toBeDefined();
    expect(nameForm).toBeDefined();
    expect(allForm).not.toContain('--apply-clean-hunks');
    expect(nameForm).toContain('--apply-clean-hunks');
    expect(nameForm).not.toContain('--all');
  }, 120_000);

  test('--all --apply-clean-hunks is refused before workspace resolution', () => {
    const r = run(['reference', '--all', '--apply-clean-hunks'], {
      cwd: scratch('sp-refcli-cwd-'),
      env: { OPENCLAW_WORKSPACE: '', GBRAIN_SKILLS_DIR: '' },
    });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('<slug> --apply-clean-hunks');
    expect(r.stderr).not.toContain('could not auto-detect');
  }, 120_000);

  test.each([
    { flag: '--dry-run', args: ['book-mirror', '--apply-clean-hunks', '--dry-run=true'] },
    { flag: '--apply-clean-hunks', args: ['book-mirror', '--apply-clean-hunks=true'] },
    { flag: '--all', args: ['--all=true'] },
    { flag: '--json', args: ['book-mirror', '--json=1'] },
  ])('$flag=<value> is refused and writes nothing', ({ flag, args }) => {
    const { ws, skillPath, edited } = editedWorkspace();

    const r = run(['reference', ...args, '--workspace', ws]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`${flag} is a boolean flag`);
    expect(readFileSync(skillPath, 'utf-8')).toBe(edited);
  }, 180_000);

  test.each([
    { label: 'last argument', args: ['--all', '--since'] },
    { label: 'followed by another flag', args: ['--all', '--since', '--json'] },
    { label: 'empty = form', args: ['--all', '--since='] },
  ])('--since with no value is refused ($label)', ({ args }) => {
    const r = run(['reference', '--workspace', scratch('sp-refcli-ws-'), ...args]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--since needs a value');
  }, 120_000);

  test.each<{ label: string; args: string[]; warns: boolean }>([
    { label: 'per-skill form warns and still runs', args: ['book-mirror', '--since', 'v0.1.0', '--json'], warns: true },
    { label: '--all form does not warn', args: ['--all', '--since', 'v999.999.999.0'], warns: false },
  ])('--since: $label', ({ args, warns }) => {
    const { ws } = editedWorkspace();

    const r = run(['reference', ...args, '--workspace', ws]);

    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr.includes('--since only applies with --all')).toBe(warns);
    if (args.includes('--json')) expect(JSON.parse(r.stdout).summary.differs).toBeGreaterThanOrEqual(1);
  }, 180_000);

  test('reference --harness help says --apply-clean-hunks takes exactly one skill', () => {
    const r = run(['reference', '--harness', 'claude-code', '--help']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--apply-clean-hunks needs exactly one skill');
  }, 120_000);
});
