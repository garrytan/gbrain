/**
 * Structural assertions for fix-wave fixes whose behavior is best verified
 * at source-shape level rather than via a runtime harness:
 *
 *  - #1125 query drain cache writes — assert cli.ts awaits the drain after
 *    the query op completes.
 *  - #1090 admin embed — assert the two-tier resolution (cwd path + embedded
 *    manifest fallback) is in serve-http.ts and consumes ADMIN_ASSETS.
 *  - #1077 admin register-client PKCE — assert the admin endpoint honors
 *    grantTypes / redirectUris / tokenEndpointAuthMethod from the body.
 *  - #1100 PGLite phaseASchema — assert the v0.11.0 orchestrator routes
 *    in-process when the engine is pglite (not via execSync subprocess).
 *  - #1124 query no-expand — assert the parseOpArgs negation logic exists.
 *
 * Source-grep regression tests are the right tool when the rule is "this
 * specific line shape must stay present"; a behavioral test would either
 * duplicate what an E2E covers or require heavy mocking that hides the
 * regression behind a test seam.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('v0.42.20.0 — search-cache drained via the background-work registry', () => {
  // Supersedes the v0.36.1.x #1125 query-only drain: search-cache now registers
  // a registry drainer (drained for BOTH search and query, bounded), and cli.ts
  // drains the whole registry rather than calling awaitPendingSearchCacheWrites
  // directly for the 'query' op only.
  test('hybrid.ts registers a bounded search-cache drainer', () => {
    const src = readFileSync('src/core/search/hybrid.ts', 'utf8');
    expect(src).toMatch(/export async function awaitPendingSearchCacheWrites/);
    expect(src).toMatch(/pendingCacheWrites\.add\(promise\)/);
    expect(src).toMatch(/trackCacheWrite\(/);
    // Now bounded (was an unbounded Promise.allSettled) + registered.
    expect(src).toMatch(/registerBackgroundWorkDrainer\(\{[\s\S]*?name:\s*'search-cache'/);
    expect(src).toMatch(/Promise\.race/);
  });
});

describe('v0.36.1.x #1090 — admin embed two-tier resolution', () => {
  test('serve-http.ts uses ADMIN_ASSETS manifest when admin/dist is not next to cwd', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(src).toMatch(/import\(['"]\.\.\/admin-embedded/);
    expect(src).toMatch(/ADMIN_ASSETS/);
    expect(src).toMatch(/ADMIN_INDEX_HTML/);
    // Two-tier: dev path (cwd-relative admin/dist) AND embedded manifest fallback
    expect(src).toMatch(/useDevPath/);
  });

  test('src/admin-embedded.ts is auto-generated with file: imports', () => {
    const src = readFileSync('src/admin-embedded.ts', 'utf8');
    expect(src).toMatch(/AUTO-GENERATED/);
    expect(src).toMatch(/with \{ type: 'file' \}/);
    expect(src).toMatch(/export const ADMIN_ASSETS/);
    expect(src).toMatch(/export const ADMIN_INDEX_HTML/);
  });

  test('build script + CI guard exist', () => {
    const buildSrc = readFileSync('scripts/build-admin-embedded.ts', 'utf8');
    expect(buildSrc).toMatch(/walk\(DIST/);
    expect(buildSrc).toMatch(/with \{ type: 'file' \}/);
    const guard = readFileSync('scripts/check-admin-embedded.sh', 'utf8');
    expect(guard).toMatch(/git diff --exit-code -- src\/admin-embedded\.ts/);
  });
});

describe('v0.36.1.x #1077 — admin register-client supports PKCE public clients', () => {
  test('admin endpoint reads grantTypes / redirectUris / tokenEndpointAuthMethod from request body', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');
    // The destructure must surface name / tokenTtl / grantTypes /
    // redirectUris / tokenEndpointAuthMethod from req.body. v0.39.3.0
    // WARN-9 (PR #1308) moved `scopes` to a separate read line that
    // accepts BOTH `scopes` (admin SPA) AND `scope` (OAuth wire singular)
    // via `?? `, so this regex no longer requires `scopes` in the inline
    // destructure — it's separately covered by the scope-source check
    // below.
    expect(src).toMatch(/const\s+\{\s*name,\s*(?:[^}]*?,\s*)?tokenTtl,\s*grantTypes,\s*redirectUris,\s*tokenEndpointAuthMethod\s*\}\s*=\s*req\.body/);
    // v0.39.3.0 WARN-9: the route must still read a `scope`/`scopes` field
    // (under either name) from req.body. Pin the fallback pattern so the
    // PKCE-fix regression contract stays load-bearing.
    expect(src).toMatch(/req\.body[^;]*scopes\s*\?\?\s*[^;]*scope\b/);
    // v0.41.3 (T4 atomicity fix, codex F4): admin endpoint now validates
    // tokenEndpointAuthMethod via the shared validator and passes it to
    // registerClientManual as a positional arg. Pre-v0.41.3 the route did
    // INSERT (confidential) → UPDATE (NULL out secret_hash) for the 'none'
    // case, which left a confidential row stranded if the UPDATE failed.
    // Atomic now: one INSERT writes the correct shape; no post-insert
    // UPDATE block (the regex deliberately asserts the post-insert UPDATE
    // is GONE).
    expect(src).toMatch(/validateTokenEndpointAuthMethod\(tokenEndpointAuthMethod\)/);
    expect(src).toMatch(/registerClientManual\([^)]*validatedAuthMethod[^)]*\)/);
    // Regression guard: post-insert UPDATE flipping client_secret_hash to
    // NULL based on a runtime check is exactly the non-atomic pattern T4
    // killed. Re-introducing it brings back codex F4.
    expect(src).not.toMatch(/UPDATE oauth_clients SET client_secret_hash = NULL, token_endpoint_auth_method = 'none'/);
  });
});

describe('v0.41.37.0 #1605 — v0.11.0 phaseASchema routes in-process for ALL engines', () => {
  test('phaseASchema calls runMigrateOnlyCore (in-process) + is awaited', () => {
    // Supersedes #1100's PGLite-only in-process branch. v0.41.37.0 #1605 routes
    // EVERY engine through runMigrateOnlyCore (no execSync subprocess at all),
    // which is strictly stronger: PGLite still never subprocesses, AND the
    // Windows+Postgres getaddrinfo-ENOTFOUND spawn bug is closed too.
    // The eng.initSchema() call moved into src/commands/migrations/in-process.ts.
    const src = readFileSync('src/commands/migrations/v0_11_0.ts', 'utf8');
    expect(src).toContain('runMigrateOnlyCore()');
    expect(src).not.toContain("execSync('gbrain init --migrate-only'");
    expect(src).toMatch(/await\s+phaseASchema/);
  });

  test('apply-migrations skips pre-flight schema-version probe on PGLite', () => {
    const src = readFileSync('src/commands/apply-migrations.ts', 'utf8');
    expect(src).toMatch(/skipPreflight\s*=\s*cfg\.engine\s*===\s*'pglite'/);
  });
});

describe('v0.36.1.x #1124 — query --no-expand actually negates expand', () => {
  test("cli.ts parseOpArgs handles --no-<key> as boolean negation", () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/arg\.startsWith\(['"]--no-['"]\)/);
    expect(src).toMatch(/positiveDef\?\.type\s*===\s*'boolean'/);
    expect(src).toMatch(/params\[positiveKey\]\s*=\s*false/);
  });
});

describe('v0.42.20.0 — background-work registry drains every sink before disconnect', () => {
  // Supersedes the v0.41.8.0 #1247/#1269/#1290 per-call last-retrieved drain:
  // last-retrieved is one of four registry sinks. #2084 moved the registry
  // drain out of cli.ts's inline finallys into finishCliTeardown
  // (cli-force-exit.ts), which every cli.ts teardown site routes through —
  // the drain-before-disconnect invariant is pinned there (and behaviorally
  // by test/cli-finish-teardown.test.ts).
  test('cli-force-exit.ts imports + drains the registry inside finishCliTeardown', () => {
    const src = readFileSync('src/core/cli-force-exit.ts', 'utf8');
    expect(src).toMatch(/import\s+\{\s*drainAllBackgroundWorkForCliExit[\s\S]*?\}\s*from\s+['"]\.\/background-work\.ts['"]/);
    expect(src).toMatch(/export async function finishCliTeardown/);
  });

  test('last-retrieved.ts still exports the bounded drain + registers a drainer', () => {
    const src = readFileSync('src/core/last-retrieved.ts', 'utf8');
    expect(src).toMatch(/export async function awaitPendingLastRetrievedWrites/);
    expect(src).toMatch(/pendingLastRetrievedWrites\s*=\s*new\s+Set/);
    expect(src).toMatch(/Promise\.race/);
    expect(src).toMatch(/registerBackgroundWorkDrainer\(\{[\s\S]*?name:\s*'last-retrieved'/);
  });

  test('all four sinks register a drainer', () => {
    expect(readFileSync('src/core/facts/queue.ts', 'utf8'))
      .toMatch(/registerBackgroundWorkDrainer\(\{[\s\S]*?name:\s*'facts'[\s\S]*?abort:/);
    expect(readFileSync('src/core/search/hybrid.ts', 'utf8'))
      .toMatch(/name:\s*'search-cache'/);
    expect(readFileSync('src/core/last-retrieved.ts', 'utf8'))
      .toMatch(/name:\s*'last-retrieved'/);
    expect(readFileSync('src/core/eval-capture.ts', 'utf8'))
      .toMatch(/name:\s*'eval-capture'/);
  });

  test('finishCliTeardown positioning: registry drain appears BEFORE engine disconnect', () => {
    // #2084: the invariant moved from cli.ts's inline finallys into the shared
    // helper. The drain must run against a live engine (facts abort-path
    // logIngest, #1762) before disconnect tears the pools down.
    const src = readFileSync('src/core/cli-force-exit.ts', 'utf8');
    const drainCallRe = /await\s+drain\s*\(\s*\{\s*timeoutMs:\s*drainTimeoutMs\s*\}\s*\)/;
    const disconnectCallRe = /await\s+opts\.engine\.disconnect\s*\(/;
    expect(src).toMatch(drainCallRe);
    expect(src).toMatch(disconnectCallRe);
    const drainIdx = src.indexOf(src.match(drainCallRe)![0]);
    const disconnectIdx = src.indexOf(src.match(disconnectCallRe)![0]);
    expect(drainIdx).toBeLessThan(disconnectIdx);
  });

  test('background-work.ts: Map registry, ordered drain, awaited abort, test seam', () => {
    const src = readFileSync('src/core/background-work.ts', 'utf8');
    expect(src).toMatch(/new\s+Map<string,\s*BackgroundWorkDrainer>/);
    expect(src).toMatch(/sort\(\s*\(a,\s*b\)\s*=>\s*a\.order\s*-\s*b\.order/);
    expect(src).toMatch(/if\s*\(unfinished\s*>\s*0\s*&&\s*d\.abort\)\s*\{[\s\S]*?await\s+d\.abort\(\)/);
    expect(src).toMatch(/export function __registerDrainerForTest/);
  });

  test('cli-force-exit.ts daemon guard excludes "serve"', () => {
    const src = readFileSync('src/core/cli-force-exit.ts', 'utf8');
    expect(src).toMatch(/export function shouldForceExitAfterMain/);
    expect(src).toMatch(/DAEMON_COMMANDS[\s\S]*serve/);
  });
});

describe('#2084 — cli.ts owns process-exit teardown via finishCliTeardown', () => {
  test('no bare awaited engine disconnects remain in cli.ts', () => {
    // The awaited forms are the call-site contract (comments never use the
    // awaited literal, so this is comment-proof — eng-review D13.2). A bare
    // disconnect skips the bounded drain + computed-deadline backstop and
    // reopens the lingering-socket hang class.
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).not.toContain('await engine.disconnect()');
    expect(src).not.toContain('await eng.disconnect()');
  });

  test('the pre-handler hard-deadline timer is gone (handler time is not teardown budget)', () => {
    // Pre-#2084 the op-dispatch timer armed BEFORE the op handler, so any op
    // slower than 10s was force-killed mid-run with exit 0 and truncated
    // output. The deadline now arms inside finishCliTeardown, at teardown
    // start only.
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).not.toContain('DISCONNECT_HARD_DEADLINE_MS');
  });

  test('all nine swept sites route through finishCliTeardown; one exit seam', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    const calls = src.match(/await finishCliTeardown\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(9);
    // The single process-exit seam: flushThenExit in the import.meta.main
    // block, fed by currentExitCode().
    expect(src).toMatch(/import\.meta\.main/);
    expect(src).toMatch(/flushThenExit\(currentExitCode\(\)\)/);
  });

  test('pglite-engine contains the Emscripten process.exitCode hijack', () => {
    // PGLite's WASM runtime writes its own status into process.exitCode (99
    // alive / exit status on close) and ignores `undefined` assignment. The
    // create call runs inside preservingProcessExitCode to keep the global
    // tidy; close is deliberately unwrapped (see below) — the CLI's verdict
    // is immune either way via the owned channel.
    const src = readFileSync('src/core/pglite-engine.ts', 'utf8');
    expect(src).toMatch(/preservingProcessExitCode\(\(\)\s*=>\s*\n?\s*PGlite\.create/);
    // close stays UNWRAPPED by design: its status write is baseline behavior
    // test runners depend on; the CLI's verdict is immune because it lives in
    // the gbrain-owned channel, never read back from process.exitCode.
    const helper = readFileSync('src/core/cli-force-exit.ts', 'utf8');
    expect(helper).toMatch(/let cliVerdict: number \| null = null/);
    expect(helper).toMatch(/return cliVerdict \?\? 0/);
    // The op-dispatch catch must set the verdict through the owned channel.
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/setCliExitVerdict\(1\);/);
  });
});

describe('v0.41.8.0 #1340 — PGLite WASM init classifier', () => {
  test('pglite-engine.ts exports classifyPgliteInitError + buildPgliteInitErrorMessage', () => {
    const src = readFileSync('src/core/pglite-engine.ts', 'utf8');
    expect(src).toMatch(/export function classifyPgliteInitError/);
    expect(src).toMatch(/export function buildPgliteInitErrorMessage/);
    // Per Codex finding #9: regex tightened to $$bunfs OR ENOENT+pglite.data
    expect(src).toMatch(/\$\$bunfs/);
    expect(src).toMatch(/ENOENT/);
  });

  test('pglite-engine.ts connect catch block routes through the classifier', () => {
    const src = readFileSync('src/core/pglite-engine.ts', 'utf8');
    expect(src).toMatch(/classifyPgliteInitError\(original\)/);
    expect(src).toMatch(/buildPgliteInitErrorMessage\(verdict, original\)/);
  });
});
