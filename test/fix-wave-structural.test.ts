/**
 * Structural assertions for fix-wave fixes whose behavior is best verified
 * at source-shape level rather than via a runtime harness:
 *
 *  - #1125 query drain cache writes — assert cli.ts awaits the drain after
 *    the query op completes.
 *  - search CLI exit — assert cli.ts drains last_retrieved_at writes before
 *    disconnecting after search/query/get_page.
 *  - search namespace dispatch — assert `gbrain search modes/stats/tune`
 *    routes before the legacy `search <query>` operation.
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

describe('search CLI one-shot cleanup', () => {
  test('cli.ts drains last_retrieved_at write-backs before disconnecting', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/op\.name\s*===\s*'search'[\s\S]{0,220}awaitPendingLastRetrievedWrites/);
    expect(src).toMatch(/await\s+awaitPendingLastRetrievedWrites\(\)/);
  });

  test('last-retrieved.ts tracks pending write-back promises', () => {
    const src = readFileSync('src/core/last-retrieved.ts', 'utf8');
    expect(src).toContain('pendingRetrievalWrites');
    expect(src).toMatch(/export async function awaitPendingLastRetrievedWrites/);
    expect(src).toMatch(/trackRetrievalWrite\(/);
  });
});

describe('search namespace dispatch', () => {
  test('cli.ts routes search modes/stats/tune before the legacy search op', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/SEARCH_NAMESPACE_SUBCOMMANDS\s*=\s*new Set\(\[['"]modes['"], ['"]stats['"], ['"]tune['"]\]\)/);
    expect(src).toMatch(/command\s*===\s*'search'[\s\S]{0,180}SEARCH_NAMESPACE_SUBCOMMANDS\.has/);
    expect(src).toMatch(/await handleCliOnly\(command,\s*subArgs\)/);
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
    // PKCE branch NULLs client_secret_hash + sets auth method to 'none'
    expect(src).toMatch(/tokenEndpointAuthMethod\s*===\s*'none'/);
    expect(src).toMatch(/client_secret_hash\s*=\s*NULL,\s*token_endpoint_auth_method\s*=\s*'none'/);
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
