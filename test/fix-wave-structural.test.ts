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

describe('v0.36.1.x #1125 — query drain cache writes before CLI exit', () => {
  test("cli.ts awaits awaitPendingSearchCacheWrites for the 'query' op", () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    // Sequence: 'query' op match → import the drain → await
    expect(src).toMatch(/op\.name\s*===\s*'query'[\s\S]{0,200}awaitPendingSearchCacheWrites/);
    expect(src).toMatch(/await\s+awaitPendingSearchCacheWrites\(\)/);
  });

  test('hybrid.ts exports the drain helper + trackCacheWrite', () => {
    const src = readFileSync('src/core/search/hybrid.ts', 'utf8');
    expect(src).toMatch(/export async function awaitPendingSearchCacheWrites/);
    expect(src).toMatch(/pendingCacheWrites\.add\(promise\)/);
    expect(src).toMatch(/trackCacheWrite\(/);
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

describe('v0.36.1.x #1100 — PGLite v0.11.0 phaseASchema routes in-process', () => {
  test('phaseASchema branches on pglite and calls initSchema directly', () => {
    const src = readFileSync('src/commands/migrations/v0_11_0.ts', 'utf8');
    expect(src).toMatch(/cfg\?\.engine\s*===\s*'pglite'/);
    expect(src).toMatch(/eng\.initSchema\(\)/);
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
