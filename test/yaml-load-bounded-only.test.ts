/**
 * GBRA-133 PR 1 (PR 0 follow-up): js-yaml's `load` is unbounded on aliases, so
 * src/core/data-frontmatter.ts (loadBoundedYaml) is the only module that may
 * import it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Every js-yaml binding that can reach `load`/`loadAll`: a named import of either, a namespace or default import, or a require. */
function yamlLoadImports(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/import\s+([^;]*?)\s+from\s+['"]js-yaml['"]/g)) {
    const clause = match[1]!;
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const names = named.split(',').map(name => name.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')).filter(Boolean);
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (names.some(name => name === 'load' || name === 'loadAll' || name === 'safeLoad' || name === 'safeLoadAll') || outside.length > 0) found.push(match[0]);
  }
  for (const match of text.matchAll(/require\(\s*['"]js-yaml['"]\s*\)/g)) found.push(match[0]);
  for (const match of text.matchAll(/import\(\s*['"]js-yaml['"]\s*\)/g)) found.push(match[0]);
  return found;
}

describe('js-yaml load is imported only by data-frontmatter.ts', () => {
  test('no other src module imports load, loadAll, a namespace, a default or a require of js-yaml', () => {
    const offenders = sourceFiles(SRC).flatMap(path => {
      // test-reads-source-ok[structural]: the guard is a source scan; the bound lives in one module and every other js-yaml import must stay schema-only
      const imports = yamlLoadImports(readFileSync(path, 'latin1'));
      return imports.map(statement => `${relative(ROOT, path)}: ${statement}`);
    }).filter(line => !line.startsWith('src/core/data-frontmatter.ts:'));
    expect(offenders).toEqual([]);
  });

  test('the scanner sees every import shape it guards', () => {
    expect(yamlLoadImports("import { load } from 'js-yaml';")).toHaveLength(1);
    expect(yamlLoadImports("import { JSON_SCHEMA, load as yamlLoad } from 'js-yaml';")).toHaveLength(1);
    expect(yamlLoadImports("import * as yaml from 'js-yaml';")).toHaveLength(1);
    expect(yamlLoadImports("import yaml from 'js-yaml';")).toHaveLength(1);
    expect(yamlLoadImports("const yaml = require('js-yaml');")).toHaveLength(1);
    expect(yamlLoadImports("import { FAILSAFE_SCHEMA } from 'js-yaml';")).toEqual([]);
    expect(yamlLoadImports("import { dump, type Schema } from 'js-yaml';")).toEqual([]);
  });
});
