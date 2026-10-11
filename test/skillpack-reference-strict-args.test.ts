/**
 * `gbrain skillpack reference` argument safety (#5491, wave 14 P1.11).
 *
 * Protects: a no-write boundary the user asked for. `--apply-clean-hunks`
 * overwrites local skill edits; `--dry-run` is the only thing between the
 * user and that write. Before this fix the handler tested the exact
 * `--dry-run` token, so `--dry-run=true` (and any typo) ran the real apply.
 * Regression: a token the command would ignore reaches the writer. Existing
 * coverage (test/skillpack-reference-apply.test.ts) drives the core
 * function directly and never sees the CLI flag parse. No production seam:
 * the child-process cases observe the skill bytes, the in-process cases
 * spy on the writer the CLI dispatch would reach.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strictArgsRefusal } from '../src/cli/strict-args.ts';
import { runSkillpack } from '../src/commands/skillpack.ts';
import * as referenceCore from '../src/core/skillpack/reference.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKILL = 'ask-user';
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** A workspace whose copy of the bundled skill carries a local edit the apply would align to gbrain. */
function driftedWorkspace(): { ws: string; file: string; before: string } {
  const ws = mkdtempSync(join(tmpdir(), 'sp-strict-ws-'));
  created.push(ws);
  mkdirSync(join(ws, 'skills', SKILL), { recursive: true });
  const upstream = readFileSync(join(REPO, 'skills', SKILL, 'SKILL.md'), 'utf-8');
  const lines = upstream.split('\n');
  lines.splice(Math.floor(lines.length / 2), 0, 'A local edit the user made on purpose.');
  const file = join(ws, 'skills', SKILL, 'SKILL.md');
  writeFileSync(file, lines.join('\n'));
  return { ws, file, before: readFileSync(file, 'utf-8') };
}

function runCli(args: string[]) {
  const r = Bun.spawnSync(['bun', 'src/cli.ts', 'skillpack', 'reference', ...args], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: 'test', GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('strict-args table', () => {
  test.each([
    ['--dry-run=true'], ['--dry-run=false'], ['--dry-rnu'], ['--unknown'], ['--json=1'], ['--apply-clean-hunks=yes'],
  ])('refuses %s with invalid_params and a read-only fix', (bad) => {
    const refusal = strictArgsRefusal('skillpack', ['reference', SKILL, '--apply-clean-hunks', bad]);
    expect(refusal?.code).toBe('invalid_params');
    expect(refusal?.message).toContain(`\`${bad}\``);
    expect(refusal?.why).toContain('Nothing was changed');
    expect(refusal?.fix?.argv).toEqual(['gbrain', 'skillpack', 'reference', '--all']);
  });

  test('accepts both grammars', () => {
    expect(strictArgsRefusal('skillpack', ['reference', SKILL])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', SKILL, '--apply-clean-hunks', '--dry-run', '--json'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', SKILL, '--workspace', '/tmp/ws'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', SKILL, '--workspace=/tmp/ws'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', '--all', '--since', '0.59.0.0', '--json'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', '--all', '--since=0.59.0.0'])).toBeNull();
  });

  test('a second positional and a repeated value flag refuse', () => {
    expect(strictArgsRefusal('skillpack', ['reference', SKILL, 'other'])?.message).toContain('`other`');
    expect(strictArgsRefusal('skillpack', ['reference', SKILL, '--workspace', 'a', '--workspace', 'b'])?.message).toContain('more than once');
  });

  test('the harness lane keeps its own parser', () => {
    expect(strictArgsRefusal('skillpack', ['reference', '--harness', 'claude-code', '--persona', 'gbrain-daily'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['reference', '--harness=codex', '--skill', 'brain-ops'])).toBeNull();
  });

  test('other skillpack subcommands are not strict', () => {
    expect(strictArgsRefusal('skillpack', ['scaffold', SKILL, '--whatever'])).toBeNull();
    expect(strictArgsRefusal('skillpack', ['list', '--whatever'])).toBeNull();
  });
});

describe('in-process dispatch never reaches the writer', () => {
  test.each([['--dry-run=true'], ['--dry-run=false'], ['--dry-rnu'], ['--unknown']])('%s exits 2 with zero writer calls', async (bad) => {
    const { ws, file, before } = driftedWorkspace();
    const apply = spyOn(referenceCore, 'runReferenceApply');
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const write = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      await expect(runSkillpack(['reference', SKILL, '--apply-clean-hunks', bad, '--workspace', ws])).rejects.toThrow('exit:2');
      expect(apply).toHaveBeenCalledTimes(0);
      expect(readFileSync(file, 'utf-8')).toBe(before);
    } finally {
      apply.mockRestore(); exit.mockRestore(); err.mockRestore(); write.mockRestore();
    }
  });
});

describe('CLI child process', () => {
  test.each([['--dry-run=true'], ['--dry-run=false'], ['--dry-rnu'], ['--unknown']])('%s exits 2 and leaves the skill bytes unchanged', (bad) => {
    const { ws, file, before } = driftedWorkspace();
    const r = runCli([SKILL, '--apply-clean-hunks', bad, '--workspace', ws]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('invalid_params');
    expect(r.stderr).toContain(bad);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  }, 90_000);

  test('the exact --dry-run still previews without writing', () => {
    const { ws, file, before } = driftedWorkspace();
    const r = runCli([SKILL, '--apply-clean-hunks', '--dry-run', '--workspace', ws, '--json']);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).dryRun).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  }, 90_000);

  test('--all with --apply-clean-hunks refuses and prints the three-command update path', () => {
    const { ws } = driftedWorkspace();
    const r = runCli(['--all', '--apply-clean-hunks', '--workspace', ws]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('gbrain skillpack reference --all');
    expect(r.stderr).toContain('gbrain skillpack reference <name>');
    expect(r.stderr).toContain('gbrain skillpack reference <name> --apply-clean-hunks');
  }, 90_000);

  test('help shows the per-skill and --all forms as separate grammars', () => {
    const r = runCli(['--help']);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain('gbrain skillpack reference <name> [--workspace PATH] [--apply-clean-hunks [--dry-run]] [--json]');
    expect(r.stdout).toContain('gbrain skillpack reference --all [--workspace PATH] [--since <version>] [--json]');
    expect(r.stdout).not.toContain('<name> | --all');
  }, 90_000);
});
