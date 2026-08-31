/**
 * gbrain frontmatter CLI (src/commands/frontmatter.ts) — validate + generate
 * on real tmp-dir fixtures, no DB.
 *
 * runFrontmatter is driven IN-PROCESS for the pure-filesystem paths:
 * frontmatter.ts writes through console.log/console.error (never
 * process.stdout.write), so the harness swaps the console methods and reads
 * exit codes through currentExitCode() — the gbrain-owned verdict channel the
 * real CLI exit seam reads (same harness family as test/loops-cli.test.ts;
 * console capture per test/cache-cli.test.ts). GBRAIN_HOME is resolved lazily
 * per call (configDir()), so withEnv scopes the backup root per test.
 *
 * Two invocations stay REAL spawns as CLI wiring smokes so
 * `bun src/cli.ts frontmatter ...` exit codes stay pinned end-to-end:
 * one validate (exit 1 on errors) and one --fix (exit 0 + centralized backup
 * under GBRAIN_HOME).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runFrontmatter } from '../src/commands/frontmatter.ts';
import {
  currentExitCode,
  _resetCliExitVerdictForTests,
} from '../src/core/cli-force-exit.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const fence = '---';

interface Captured {
  out: string;
  err: string;
  /** gbrain's owned exit verdict after the run (0 when none was set). */
  verdict: number;
}

/**
 * Drive `gbrain frontmatter <args>` in-process. Frontmatter output goes
 * exclusively through console.log/console.error; the verdict channel is reset
 * before the run and read (then cleared, mirror included) after so no verdict
 * leaks into other tests in the shard.
 */
async function runFm(args: string[]): Promise<Captured> {
  const logOrig = console.log;
  const errOrig = console.error;
  const prevExitCode = process.exitCode;
  const out: string[] = [];
  const err: string[] = [];
  _resetCliExitVerdictForTests();
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
  try {
    await runFrontmatter(args);
  } finally {
    console.log = logOrig;
    console.error = errOrig;
  }
  const verdict = currentExitCode();
  // Never leak a verdict (or its process.exitCode mirror) into other tests.
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { out: out.join(''), err: err.join(''), verdict };
}

/** In-process replacement for the old `find <dir> -name <name>` child. */
function findFilesNamed(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === name) hits.push(full);
    }
  }
  return hits;
}

describe('gbrain frontmatter CLI (B4)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fm-cli-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('--help works without a DB', async () => {
    const { out, verdict } = await runFm(['--help']);
    expect(verdict).toBe(0);
    expect(out).toContain('frontmatter validation');
  });

  test('validate clean file: exit 0, OK message', async () => {
    const f = join(tmp, 'clean.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`);
    const { out, verdict } = await runFm(['validate', f]);
    expect(verdict).toBe(0);
    expect(out).toContain('OK');
  });

  // CLI wiring smoke #1 (kept as a real spawn): the validate error path's
  // exit code must survive cli.ts dispatch + the exit seam, not just the
  // in-process verdict channel.
  test('validate broken file: exit 1, codes listed', async () => {
    const f = join(tmp, 'broken.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`);
    const { stdout, exitCode } = await runCli(['frontmatter', 'validate', f]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('NESTED_QUOTES');
  }, 60_000);

  test('validate --json envelope shape', async () => {
    const f = join(tmp, 'broken.md');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`);
    const { out } = await runFm(['validate', f, '--json']);
    const env = JSON.parse(out);
    expect(env.ok).toBe(false);
    expect(env.total_files).toBe(1);
    expect(env.results[0].errors.length).toBeGreaterThan(0);
    expect(env.results[0].errors[0]).toHaveProperty('code');
  });

  test('validate --fix --dry-run does not write', async () => {
    const f = join(tmp, 'broken.md');
    const original = `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`;
    writeFileSync(f, original);
    const { out, verdict } = await runFm(['validate', f, '--fix', '--dry-run']);
    expect(out).toContain('would fix');
    expect(readFileSync(f, 'utf8')).toBe(original);
    expect(existsSync(f + '.bak')).toBe(false);
    // exit 0 with --fix even when issues remain (the fix path is the success path)
    expect(verdict).toBe(0);
  });

  // CLI wiring smoke #2 (kept as a real spawn): --fix through the real CLI,
  // pinning exit 0 + the GBRAIN_HOME-routed centralized backup end-to-end.
  test('validate --fix writes centralized backup and rewrites in place', async () => {
    const f = join(tmp, 'broken.md');
    const gbrainHome = join(tmp, 'home');
    const original = `${fence}\ntype: concept\ntitle: "P "I" L"\n${fence}\n\nbody`;
    writeFileSync(f, original);
    const { stdout, exitCode } = await runCli(
      ['frontmatter', 'validate', f, '--fix'],
      { env: { GBRAIN_HOME: gbrainHome } },
    );
    expect(exitCode).toBe(0);
    expect(existsSync(f + '.bak')).toBe(false);
    expect(stdout).toContain('centralized backups');
    const backupDir = join(gbrainHome, '.gbrain', 'backups', 'frontmatter');
    const backupPath = findFilesNamed(backupDir, 'broken.md.bak')[0];
    expect(backupPath).toBeTruthy();
    expect(readFileSync(backupPath, 'utf8')).toBe(original);
    expect(readFileSync(f, 'utf8')).toMatch(/^title: '.*'\s*$/m);
  }, 60_000);

  test('validate --fix succeeds on a non-git path (no dirty-tree guard)', async () => {
    // tmp is not a git repo; --fix must still work.
    const f = join(tmp, 'broken.md');
    const gbrainHome = join(tmp, 'home');
    writeFileSync(f, `${fence}\ntype: concept\ntitle: "A "B" C"\n${fence}\n\nbody`);
    const { verdict } = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runFm(['validate', f, '--fix']),
    );
    expect(verdict).toBe(0);
    expect(existsSync(f + '.bak')).toBe(false);
    expect(existsSync(join(gbrainHome, '.gbrain', 'backups', 'frontmatter'))).toBe(true);
  });

  test('validate scans a directory recursively, skips non-.md files', async () => {
    mkdirSync(join(tmp, 'subdir'), { recursive: true });
    writeFileSync(join(tmp, 'a.md'), `${fence}\ntype: concept\ntitle: A\n${fence}\n\nbody`);
    writeFileSync(join(tmp, 'subdir', 'b.md'), `${fence}\ntype: concept\ntitle: B\n${fence}\n\nbody`);
    writeFileSync(join(tmp, 'README.md'), 'meta');  // skipped by isSyncable
    writeFileSync(join(tmp, 'image.png'), 'not markdown');
    const { out } = await runFm(['validate', tmp, '--json']);
    const env = JSON.parse(out);
    // Two .md files: a.md, subdir/b.md. README.md is filtered by isSyncable.
    expect(env.total_files).toBe(2);
  });

  test('generate --fix skips catch-all note writes unless explicitly included', async () => {
    const gbrainHome = join(tmp, 'home');
    writeFileSync(join(tmp, 'random.md'), '# Random\n\nbody');
    writeFileSync(join(tmp, 'notes.md'), '# Also Random\n\nbody');

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const skipped = await runFm(['generate', tmp, '--fix', '--json']);
      expect(skipped.verdict).toBe(0);
      const skippedEnv = JSON.parse(skipped.out);
      expect(skippedEnv.generated).toBe(0);
      expect(skippedEnv.skippedCatchAll).toBe(2);
      expect(readFileSync(join(tmp, 'random.md'), 'utf8')).toBe('# Random\n\nbody');

      const included = await runFm(['generate', tmp, '--fix', '--json', '--include-catch-all']);
      expect(included.verdict).toBe(0);
      const includedEnv = JSON.parse(included.out);
      expect(includedEnv.generated).toBe(2);
      expect(readFileSync(join(tmp, 'random.md'), 'utf8')).toContain('type: note');
      expect(existsSync(join(gbrainHome, '.gbrain', 'backups', 'frontmatter'))).toBe(true);
      expect(existsSync(join(tmp, 'random.md.bak'))).toBe(false);
    });
  });

  test('validate missing path errors clearly', async () => {
    const { err, verdict } = await runFm(['validate', join(tmp, 'does-not-exist.md')]);
    expect(verdict).toBe(1);
    expect(err).toContain('not found');
  });
});
