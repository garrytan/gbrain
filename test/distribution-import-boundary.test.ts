// T26: `src/core/distribution/` import boundary regression guard.
//
// E2 + Codex F6: the distribution module is shared infrastructure
// (tarball, trust-prompt, registry, remote-source). It MUST NOT
// import from:
//   - src/commands/ (command-layer code; would create a layering inversion)
//   - src/core/schema-pack/ (downstream consumer)
//   - src/core/postgres-engine.ts / pglite-engine.ts (engines should
//     not be referenced from distribution)
//   - src/core/config.ts (config resolution shouldn't reach into
//     distribution; the reverse is fine on a case-by-case basis but
//     stays controlled)
//
// This test reads the distribution module's source files via fs and
// asserts that the import statements match an allowlist. If a future
// commit accidentally adds a forbidden import, this test fails loud
// before the bad module shape lands in `bun run verify`.
//
// Per Codex F25 we use a simple source-text grep rather than
// dependency-cruiser to avoid the extra tooling dep. The check is
// narrow (imports only) and lives next to the actual module shape.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST_DIR = join(import.meta.dir, '../src/core/distribution');

// Allowlist of paths the distribution module MAY import FROM.
// Currently empty + only re-exports from skillpack/; if a real
// implementation lands in distribution/ later, this allowlist
// expands carefully.
const ALLOWED_IMPORT_PREFIXES: readonly string[] = [
  '../skillpack/',     // permitted re-export source (Option B)
  'node:',             // node built-ins
];

// Hard-forbidden imports — any of these on a `from` line is a fail.
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /from\s+['"][^'"]*\/commands\//,
  /from\s+['"]\.\.\/schema-pack\//,
  /from\s+['"][^'"]*postgres-engine/,
  /from\s+['"][^'"]*pglite-engine/,
  /from\s+['"]\.\.\/config\.ts['"]/,
  /from\s+['"]\.\.\/config\/['"]/,
];

describe('distribution module import boundary (E2 + Codex F6)', () => {
  test('every src/core/distribution/*.ts file passes the import allowlist', () => {
    const files = readdirSync(DIST_DIR).filter(f => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const path = join(DIST_DIR, file);
      const content = readFileSync(path, 'utf-8');
      // Match `from '<path>'` and `from "<path>"`
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const match of importMatches) {
        const importPath = match[1];
        const allowed = ALLOWED_IMPORT_PREFIXES.some(prefix => importPath.startsWith(prefix));
        if (!allowed) {
          throw new Error(
            `forbidden import in ${file}: "${importPath}"\n` +
            `distribution/ may only import from: ${ALLOWED_IMPORT_PREFIXES.join(', ')}\n` +
            `if this is intentional, update ALLOWED_IMPORT_PREFIXES in this test`,
          );
        }
        for (const pat of FORBIDDEN_PATTERNS) {
          if (pat.test(match[0])) {
            throw new Error(
              `forbidden import pattern in ${file}: "${importPath}" matches ${pat}`,
            );
          }
        }
      }
    }
  });

  test('distribution/index.ts re-exports cover the v0.37 helper surface', async () => {
    // Ensure the v0.37 helpers we promised are accessible via the
    // distribution barrel. Schema-pack consumers depend on these names.
    const dist = await import('../src/core/distribution/index.ts');
    expect(typeof dist.extractTarball).toBe('function');
    expect(typeof dist.packTarball).toBe('function');
    expect(typeof dist.askTrust).toBe('function');
    expect(typeof dist.loadRegistry).toBe('function');
    expect(typeof dist.resolveSource).toBe('function');
    expect(typeof dist.classifySpec).toBe('function');
    expect(typeof dist.effectiveTier).toBe('function');
    expect(typeof dist.validateRegistryCatalog).toBe('function');
    expect(typeof dist.runScaffoldThirdParty).toBe('function');
    expect(dist.REGISTRY_SCHEMA_VERSION).toBe('gbrain-registry-v1');
  });
});
