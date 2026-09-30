/**
 * T-G8 (refactor wave 1, EO7 + DX O7): PGLite snapshot hash inputs and CI cache keys.
 *
 * Protects: the unit suite never runs on a stale PGLite snapshot. The runtime
 * hash (`computeSnapshotSchemaHash`) must cover the static import closure of
 * the schema roots (computed here independently with the TypeScript AST), and
 * every `pglite-snapshot-*` cache key in .github/workflows/*.yml must hash the
 * same inputs while keeping its own profile namespace and artifact path.
 * Fails when: a migration file, schema fragment or helper is imported but not
 * hashed; a new dynamic import in the closure is unclassified; a cache key
 * drops a file or diverges from the others; a key's namespace and artifact
 * path disagree (a default-profile key restoring the legacy tar).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED,
  SNAPSHOT_SCHEMA_LEAVES,
  SNAPSHOT_SCHEMA_ROOTS,
  snapshotSchemaInputs,
} from '../src/core/snapshot-schema-inputs.ts';

const REPO = resolve(import.meta.dir, '..');
const CORE = join(REPO, 'src/core');
const WORKFLOWS = join(REPO, '.github/workflows');
const SEE = 'See:  docs/TESTING.md#pglite-schema-snapshot-default-on';

// test-reads-source-ok[structural]: the closure walk reads module text to follow imports.
const read = (rel: string) => readFileSync(join(CORE, rel), 'utf8');
const runtimeInputs = snapshotSchemaInputs((rel) => existsSync(join(CORE, rel)), read);
const repoPath = (coreRel: string) => relative(REPO, resolve(CORE, coreRel));

/** Independent closure: TS AST, static value imports + re-exports; dynamic literal imports reported separately. */
function astClosure(): { files: Set<string>; dynamic: Map<string, string> } {
  const files = new Set<string>();
  const dynamic = new Map<string, string>();
  const resolveSpec = (fromAbs: string, spec: string): string | undefined => {
    const base = resolve(dirname(fromAbs), spec);
    return [base, `${base}.ts`, join(base, 'index.ts')].find((c) => c.endsWith('.ts') && existsSync(c));
  };
  const stack = SNAPSHOT_SCHEMA_ROOTS.map((r) => join(CORE, r));
  while (stack.length > 0) {
    const abs = stack.pop()!;
    if (files.has(abs)) continue;
    files.add(abs);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
      let spec: string | undefined;
      if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && !stmt.isTypeOnly) spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (spec?.startsWith('.')) {
        const hit = resolveSpec(abs, spec);
        if (hit) stack.push(hit);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && arg.text.startsWith('.')) {
          const hit = resolveSpec(abs, arg.text);
          if (hit) dynamic.set(relative(CORE, hit), relative(REPO, abs));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files: new Set([...files].map((f) => relative(CORE, f))), dynamic };
}

interface CacheKey {
  file: string;
  line: number;
  namespace: string;
  patterns: string[];
  paths: string[];
}

function discoverCacheKeys(): CacheKey[] {
  const keys: CacheKey[] = [];
  for (const name of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const lines = readFileSync(join(WORKFLOWS, name), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!text.includes('pglite-snapshot')) return;
      const m = /key:\s*(pglite-snapshot[a-z-]*?)-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\((.*)\)\s*\}\}\s*$/.exec(text);
      if (!/^\s*key:/.test(text)) return;
      if (!m) throw new Error(`.github/workflows/${name}:${i + 1} has a pglite-snapshot cache key this test cannot parse: ${text.trim()}`);
      const paths: string[] = [];
      for (let j = i - 1; j >= 0 && !/^\s*-\s*uses:/.test(lines[j]!); j--) {
        const p = /^\s*(test\/fixtures\/pglite-snapshot[\w.-]*)\s*$/.exec(lines[j]!);
        if (p) paths.push(p[1]!);
      }
      keys.push({
        file: `.github/workflows/${name}`,
        line: i + 1,
        namespace: m[1]!,
        patterns: [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!),
        paths: paths.sort(),
      });
    });
  }
  return keys;
}

describe('snapshot schema hash inputs (EO7)', () => {
  const ast = astClosure();

  test('the runtime hash covers the full static import closure of the schema roots', () => {
    const missing = [...ast.files].filter((f) => !runtimeInputs.includes(f)).sort();
    if (missing.length > 0) {
      throw new Error(missing.map((f) => [
        `FAIL: src/core/${f} is in the static import closure of the PGLite schema roots but computeSnapshotSchemaHash does not hash it.`,
        'Why:  a change to it would leave the test-fixture PGLite snapshot stale.',
        'Fix:  make src/core/snapshot-schema-inputs.ts reach it (import form it does not follow?), and cover it in every',
        '      pglite-snapshot cache key in .github/workflows/e2e.yml and .github/workflows/test.yml.',
        SEE,
      ].join('\n')).join('\n'));
    }
    expect(missing).toEqual([]);
  });

  test('covers every split migration, the registry, migrate.ts, the PGLite schema and the bootstrap file', () => {
    const migrationFiles = readdirSync(join(CORE, 'schema-migrations')).filter((f) => /^v\d{3,}-.*\.ts$/.test(f));
    expect(migrationFiles.length).toBeGreaterThan(170);
    for (const f of migrationFiles) expect(runtimeInputs).toContain(`schema-migrations/${f}`);
    for (const f of [...SNAPSHOT_SCHEMA_ROOTS, ...SNAPSHOT_SCHEMA_LEAVES, 'schema-migrations/helpers.ts', 'engine-sql/bootstrap.ts']) expect(runtimeInputs).toContain(f);
  });

  test('every literal dynamic import inside the closure is classified (hashed leaf or not-hashed with a reason)', () => {
    const unclassified = [...ast.dynamic.entries()]
      .filter(([target]) => !SNAPSHOT_SCHEMA_LEAVES.includes(target) && !(target in SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED) && !ast.files.has(target))
      .map(([target, from]) => `FAIL: ${from} lazily imports src/core/${target}, which the snapshot hash neither hashes nor exempts.\n` +
        'Fix:  add it to SNAPSHOT_SCHEMA_LEAVES (runs during schema init/migrations) or SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED\n' +
        `      (with the reason) in src/core/snapshot-schema-inputs.ts; hashed leaves also go in every pglite-snapshot cache key.\n${SEE}`);
    if (unclassified.length > 0) throw new Error(unclassified.join('\n'));
    for (const target of Object.keys(SNAPSHOT_DYNAMIC_IMPORTS_NOT_HASHED)) expect(ast.dynamic.has(target)).toBe(true);
  });
});

describe('pglite-snapshot CI cache keys (DX O7)', () => {
  const keys = discoverCacheKeys();

  test('discovers every key: 13 across e2e.yml and test.yml, two profiles', () => {
    expect(keys.length).toBe(13);
    expect(keys.filter((k) => k.file.endsWith('e2e.yml')).length).toBe(5);
    expect(keys.filter((k) => k.file.endsWith('test.yml')).length).toBe(8);
    expect([...new Set(keys.map((k) => k.namespace))].sort()).toEqual(['pglite-snapshot', 'pglite-snapshot-default']);
  });

  test('every key hashes identical dependency inputs', () => {
    const first = keys[0]!;
    for (const k of keys) {
      if (k.patterns.join('\n') !== first.patterns.join('\n')) {
        throw new Error(`FAIL: ${k.file}:${k.line} hashFiles inputs differ from ${first.file}:${first.line}.\nWhy:  every pglite-snapshot key must invalidate on the same schema inputs.\nFix:  copy the hashFiles(...) argument list from ${first.file}:${first.line}.\n${SEE}`);
      }
    }
  });

  test('each profile namespace restores its own artifact paths', () => {
    for (const k of keys) {
      const stem = k.namespace === 'pglite-snapshot-default' ? 'pglite-snapshot-default' : 'pglite-snapshot';
      expect({ key: `${k.file}:${k.line}`, paths: k.paths }).toEqual({
        key: `${k.file}:${k.line}`,
        paths: [`test/fixtures/${stem}.tar`, `test/fixtures/${stem}.version`],
      });
    }
  });

  test('the keys cover every computeSnapshotSchemaHash input', () => {
    const globs = keys[0]!.patterns.map((p) => new Bun.Glob(p));
    const uncovered = runtimeInputs.map(repoPath).filter((f) => !globs.some((g) => g.match(f)));
    if (uncovered.length > 0) {
      throw new Error(uncovered.map((f) => [
        `FAIL: ${f} is a computeSnapshotSchemaHash input but no pglite-snapshot cache key covers it.`,
        'Why:  CI would restore a snapshot baked before the file changed, so the suite runs on a stale schema.',
        `Fix:  add '${f}' (or a glob covering it) to the hashFiles(...) list of all ${keys.length} pglite-snapshot keys in`,
        '      .github/workflows/e2e.yml and .github/workflows/test.yml (keep the lists identical).',
        SEE,
      ].join('\n')).join('\n'));
    }
    expect(uncovered).toEqual([]);
    for (const extra of ['test/helpers/legacy-embedding-config.ts', 'scripts/build-pglite-snapshot.ts']) {
      expect(keys[0]!.patterns).toContain(extra);
    }
  });
});
