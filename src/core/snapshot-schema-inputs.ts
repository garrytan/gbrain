/**
 * Inputs of the PGLite snapshot schema hash (refactor wave 1, EO7).
 *
 * `computeSnapshotSchemaHash` (pglite-engine.ts) hashes the raw bytes of every
 * file returned here, so a test-fixture snapshot goes stale whenever anything
 * that shapes a fresh PGLite schema changes. The list is computed, not
 * hand-kept: the static import closure of SNAPSHOT_SCHEMA_ROOTS (`import`,
 * `export ... from`; `import type` skipped) plus SNAPSHOT_SCHEMA_LEAVES.
 * Every literal dynamic `import()` inside the closure must be classified in
 * SNAPSHOT_SCHEMA_LEAVES or SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED, and every
 * `pglite-snapshot-*` CI cache key must cover the same files;
 * test/snapshot-inputs-closure.test.ts names any file that is missing.
 *
 * Pure: the caller supplies file access, so this module never imports fs.
 * Paths are relative to src/core/.
 */

/** Modules whose static import closure defines the fresh PGLite schema. */
export const SNAPSHOT_SCHEMA_ROOTS: readonly string[] = [
  'pglite-schema.ts',
  'schema-migrations/registry.generated.ts',
  'migrate.ts',
  'engine-sql/bootstrap.ts',
];

/**
 * Hashed as bytes, closure not followed:
 * - pglite-engine.ts holds `PGLiteEngine#initSchema`'s replay sequence (the
 *   forward-reference bootstrap it runs is the engine-sql/bootstrap.ts root);
 * - grants/service.ts is lazy-imported by grants/migration.ts (a migration
 *   handler helper) together with the grant profile table it validates against
 *   (its full static closure is ~500 unrelated modules).
 */
export const SNAPSHOT_SCHEMA_LEAVES: readonly string[] = [
  'pglite-engine.ts',
  'grants/service.ts',
  'grants/profiles.ts',
  'minions/tools/brain-allowlist.ts',
];

/** Dynamic imports inside the closure that never run during schema init or migrations. */
export const SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED: Readonly<Record<string, string>> = {
  'operations.ts': 'verbs.ts request-time verb handlers',
  'persistence/memory-mutations.ts': 'verbs.ts request-time verb handlers',
  'persistence/verb-errors.ts': 'verbs.ts request-time verb handlers',
  'verbs/entity-card.ts': 'verbs.ts request-time verb handlers',
  'think/index.ts': 'verbs.ts request-time verb handlers',
  'embedding.ts': 'verbs.ts request-time verb handlers',
  'model-pricing.ts': 'verbs.ts request-time verb handlers',
};

const STATIC_SPECIFIER =
  /(?:^|[\n;])[ \t]*(?:import\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?|export\s+(?!type\s)[^'";]*?\sfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Resolve `spec` imported from `fromFile` (both relative to src/core/). */
export function resolveRelative(fromFile: string, spec: string): string {
  const parts = ['src', 'core', ...fromFile.split('/').slice(0, -1)];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const repoRel = parts.join('/');
  return repoRel.startsWith('src/core/') ? repoRel.slice('src/core/'.length) : `../../${repoRel}`;
}

/** Relative specifiers a module statically loads (type-only imports excluded). */
export function staticRelativeSpecifiers(source: string): string[] {
  return [...source.matchAll(STATIC_SPECIFIER)].map((m) => m[1]!);
}

export function snapshotSchemaInputs(
  exists: (relPath: string) => boolean,
  read: (relPath: string) => string,
): string[] {
  const seen = new Set<string>();
  const stack = [...SNAPSHOT_SCHEMA_ROOTS];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticRelativeSpecifiers(read(file))) {
      const base = resolveRelative(file, spec);
      const hit = [base, `${base}.ts`, `${base}/index.ts`].find((c) => /\.(ts|js|mjs)$/.test(c) && exists(c));
      if (hit && !seen.has(hit)) stack.push(hit);
    }
  }
  for (const leaf of SNAPSHOT_SCHEMA_LEAVES) seen.add(leaf);
  return [...seen].sort();
}
