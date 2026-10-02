/**
 * scripts/check-bash32.sh — every tracked shell script parses under bash 3.2.
 *
 * Protects: `bun run verify` on stock macOS, whose /bin/bash is GNU bash
 * 3.2.57 (#5810: a heredoc inside $(...) with an odd apostrophe parsed under
 * bash 5 and broke every Mac).
 * Fails when: the real 3.2 parser stops flagging the #5810 shape, a guard
 * fixture leaks into the scan, a failure loses its FAIL file:line / Why / Fix
 * / See lines, or a missing parser stops being a one-line skip (exit 2 under
 * GBRAIN_BASH32_REQUIRE=1).
 * Seams: GBRAIN_GUARD_ROOT (fixture tree), GBRAIN_BASH32 (parser binary; a
 * shim here), GBRAIN_BASH32_DOCKER (docker CLI). The real-parser cases run
 * when bash 3.2 is reachable without a network pull (stock /bin/bash, or the
 * pinned image already present) and are mandatory under
 * GBRAIN_BASH32_REQUIRE=1, which the CI step sets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts/check-bash32.sh');
const FIXTURES = join(REPO, 'test/fixtures/guards/check-bash32.sh');
const IMAGE = /^IMAGE='([^']+)'$/m.exec(readFileSync(SCRIPT, 'utf8'))![1]!;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bash32-guard-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string, mode = 0o644): string {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content, { mode });
  return abs;
}

/** A parser shim that reports bash 3 and rejects any file named bad*.sh. */
function shim(major = 3): string {
  return write('bin/bash32', `#!/bin/sh
if [ "$1" = "-c" ]; then
  case "$2" in *BASH_VERSINFO*) echo ${major} ;; *) echo "${major}.2.57(1)-shim" ;; esac
  exit 0
fi
case "$2" in *bad*.sh) echo "$2: line 4: unexpected EOF while looking for matching \\\`''" >&2; exit 2 ;; esac
exit 0
`, 0o755);
}

function run(guardRoot: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_BASH32: '', GBRAIN_BASH32_REQUIRE: '', GBRAIN_GUARD_ROOT: guardRoot, ...env },
  });
}

describe('check-bash32.sh reporting (parser shim)', () => {
  it('passes a tree whose scripts all parse and counts only scanned scripts', () => {
    write('tree/scripts/a.sh', 'echo a\n');
    write('tree/b.sh', 'echo b\n');
    write('tree/test/fixtures/guards/g/bad/x-bad.sh', 'echo fixture\n');
    const r = run(join(root, 'tree'), { GBRAIN_BASH32: shim() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✓ bash 3.2 parse: 2 script(s) parse under');
  });

  it('fails with FAIL file:line, Why, Fix and See, and never scans guard fixtures', () => {
    write('tree/scripts/ok.sh', 'echo ok\n');
    write('tree/scripts/bad-table.sh', 'echo bad\n');
    write('tree/test/fixtures/guards/g/bad/also-bad.sh', 'echo fixture\n');
    const r = run(join(root, 'tree'), { GBRAIN_BASH32: shim() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: scripts/bad-table.sh:4 does not parse under bash 3.2: unexpected EOF');
    expect(r.stderr).not.toContain('also-bad.sh');
    expect(r.stderr).toMatch(/^Why: {2}macOS \/bin\/bash is GNU bash 3\.2/m);
    expect(r.stderr).toContain("Fix:  read heredoc text with IFS= read -r -d '' VAR <<'EOF' || true");
    expect(r.stderr).toContain('See:  docs/TESTING.md#bash-32-parse-guard');
  });

  it('refuses an explicit GBRAIN_BASH32 that is not bash 3.x', () => {
    write('tree/a.sh', 'echo a\n');
    const r = run(join(root, 'tree'), { GBRAIN_BASH32: shim(5) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is not an executable bash 3.x');
  });

  it('prints one skip line without a parser, and exits 2 when the parser is required', () => {
    write('tree/a.sh', 'echo a\n');
    const noDocker = { GBRAIN_BASH32: 'docker', GBRAIN_BASH32_DOCKER: join(root, 'missing-docker') };
    const skipped = run(join(root, 'tree'), noDocker);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout.trim().split('\n')).toEqual([
      '- bash 3.2 parse: skipped (no bash 3.x at /bin/bash and no docker CLI; install Docker or set GBRAIN_BASH32 to a bash 3.2 binary)',
    ]);
    const required = run(join(root, 'tree'), { ...noDocker, GBRAIN_BASH32_REQUIRE: '1' });
    expect(required.status).toBe(2);
    expect(required.stderr).toContain('GBRAIN_BASH32_REQUIRE=1 forbids skipping');
  });
});

function realParserReachable(): boolean {
  if (process.env.GBRAIN_BASH32_REQUIRE === '1') return true;
  const native = spawnSync('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' });
  if (native.stdout?.trim() === '3') return true;
  return spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
}

describe.skipIf(!realParserReachable())('check-bash32.sh under the real bash 3.2 parser', () => {
  it('flags a heredoc inside $(...) with an odd apostrophe (the #5810 shape)', () => {
    const r = run(join(FIXTURES, 'bad'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL: scripts/heredoc-in-subst.sh:');
    expect(r.stderr).toContain("unexpected EOF while looking for matching `''");
  }, 60_000);

  it('passes the same table read with read -d', () => {
    const r = run(join(FIXTURES, 'good'));
    expect(r.status).toBe(0);
  }, 60_000);

  it('passes every tracked script in this repository', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', cwd: REPO, env: { ...process.env, GBRAIN_GUARD_ROOT: '' } });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 60_000);
});
