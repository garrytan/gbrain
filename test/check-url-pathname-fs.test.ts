/**
 * Self-test for scripts/check-url-pathname-fs.sh — the guard against deriving a
 * FILESYSTEM path from `new URL(...).pathname`.
 *
 * That expression yields `/C:/Users/...` on Windows (a URL path, not a
 * filesystem path) and is an identity transform on POSIX, so Linux CI never
 * surfaces it — which is exactly why it was reintroduced across ~20 call sites
 * before 6ba694ec fixed them. The guard is the backstop; this pins the guard.
 *
 * Fixtures are written to a temp dir and the script is pointed at it via argv,
 * so this never scans the real tree. The fixture literals below carry a
 * `url-pathname-guard-ok` marker so the guard doesn't flag its own test file
 * when it scans the repo; the marker lives in a trailing comment, never inside
 * the fixture content itself.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-url-pathname-fs.sh');

let root: string;
let badDir: string;
let goodDir: string;

// Generous per-test timeouts: each case shells out to bash + find + grep +
// awk, and process spawn on Windows costs orders of magnitude more than the
// scan itself (the fixture dirs hold a handful of one-line files).
const SPAWN_TIMEOUT_MS = 60000;

function runGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync(['bash', SCRIPT, dir], { cwd: REPO_ROOT });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'url-pathname-guard-'));
  badDir = join(root, 'bad');
  goodDir = join(root, 'good');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(goodDir, { recursive: true });

  // BAD 1: the canonical pre-6ba694ec form.
  writeFileSync(join(badDir, 'bad_direct.ts'), "const REPO = new URL('..', import.meta.url).pathname;\n"); // url-pathname-guard-ok
  // BAD 2: inline as a Bun.spawn cwd — the shape that produced the uv_spawn ENOENT.
  writeFileSync(join(badDir, 'bad_cwd.ts'), "Bun.spawnSync(['bun'], { cwd: new URL('..', import.meta.url).pathname });\n"); // url-pathname-guard-ok
  // BAD 3: `new URL(...)` split across lines by the formatter.
  writeFileSync(join(badDir, 'bad_multiline.ts'), "const r = new URL(\n  '../..',\n  import.meta.url,\n).pathname;\n"); // url-pathname-guard-ok
  // BAD 4: two-step through a variable.
  writeFileSync(join(badDir, 'bad_twostep.ts'), "const u = new URL('..', import.meta.url);\nconst root = u.pathname;\n"); // url-pathname-guard-ok
  // BAD 5: an explicit file: literal, no import.meta.url in sight.
  writeFileSync(join(badDir, 'bad_fileliteral.ts'), "const p = new URL('file:///tmp/x').pathname;\n"); // url-pathname-guard-ok
  // BAD 6: pathToFileURL round-trip — same class.
  writeFileSync(join(badDir, 'bad_tofileurl.ts'), 'const p = pathToFileURL(dir).pathname;\n'); // url-pathname-guard-ok

  // GOOD: the two correct forms.
  writeFileSync(
    join(goodDir, 'good_fixed.ts'),
    "const ROOT = fileURLToPath(new URL('..', import.meta.url));\nconst here = import.meta.dir;\n",
  );
  // GOOD: parsing a postgres connection URL (test/e2e/helpers.ts shape).
  writeFileSync(
    join(goodDir, 'good_conn.ts'),
    "const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\\//, ''));\n",
  );
  // GOOD: two-step on a non-file URL (test/e2e/schema-drift.test.ts shape).
  writeFileSync(
    join(goodDir, 'good_conn_twostep.ts'),
    "const url = new URL(DATABASE_URL!);\nconst dbName = url.pathname.replace(/^\\//, '');\n",
  );
  // GOOD: HTTP request URL (test/e2e/self-upgrade-binary-swap.test.ts shape).
  writeFileSync(join(goodDir, 'good_http.ts'), 'const path = new URL(req.url).pathname;\n');
  // GOOD: assigning pathname, not reading it (test/e2e/pgbouncer-teardown.test.ts shape).
  writeFileSync(
    join(goodDir, 'good_assign.ts'),
    'const u = new URL(ADMIN_URL!);\nu.pathname = `/${TEST_DB}`;\n',
  );
  // GOOD: the banned form inside comments — including the JSDoc that documents
  // the rule — must not fire.
  writeFileSync(
    join(goodDir, 'good_comments.ts'),
    "/**\n * Use fileURLToPath, not new URL('..', import.meta.url).pathname\n */\n// const bad = new URL('..', import.meta.url).pathname;\nexport const x = 1;\n",
  );
  // GOOD: explicit opt-out marker.
  writeFileSync(
    join(goodDir, 'good_optout.ts'),
    "const p = new URL('..', import.meta.url).pathname; // url-pathname-guard-ok: really wants the URL path\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-url-pathname-fs guard', () => {
  test('flags every filesystem-path-from-URL shape', () => {
    const { code, out } = runGuard(badDir);
    expect(code).toBe(1);
    for (const f of [
      'bad_direct.ts',
      'bad_cwd.ts',
      'bad_multiline.ts',
      'bad_twostep.ts',
      'bad_fileliteral.ts',
      'bad_tofileurl.ts',
    ]) {
      expect(out).toContain(f);
    }
    // The message has to name the fix, not just the sin.
    expect(out).toContain('fileURLToPath');
  }, SPAWN_TIMEOUT_MS);

  test('does not flag legitimate URL.pathname uses, comments, or opt-outs', () => {
    const { code, out } = runGuard(goodDir);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  }, SPAWN_TIMEOUT_MS);

  test('is wired into `bun run verify` and check:all', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['check:url-pathname']).toContain('check-url-pathname-fs.sh');
    // package.json must invoke it through `bash` — bun cannot exec a .sh via
    // its shebang on Windows.
    expect(pkg.scripts['check:url-pathname']).toStartWith('bash ');
    expect(pkg.scripts['check:all']).toContain('check-url-pathname-fs.sh');

    // Authoritative over grepping the dispatcher body (which would pass on a
    // commented-out entry).
    const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts', 'run-verify-parallel.sh'), '--dry-list'], {
      cwd: REPO_ROOT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split('\n')).toContain('check:url-pathname');
  }, SPAWN_TIMEOUT_MS);
});
