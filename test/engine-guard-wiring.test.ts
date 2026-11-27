/**
 * Every engine guard wrapper is wired into an engine, not only defined and re-exported.
 *
 * Protects: a merge that keeps one side's engine file cannot silently drop the guard the other side wired into it.
 * Sync 20 kept the trunk's postgres-engine.ts over master's #10345 and lost the read-route write guard: `read-route-guard.ts`
 * (`refuseWrites`, `refuseRawWrites`) stayed in the tree, still imported by the `abort-aware.ts` barrel, and no read route
 * used it, so a write routed through a read route ran without a deadline and failed only under one.
 *
 * The set, exactly: every function or const exported from a `src/core/engine-sql/*.ts` file whose name starts with `refuse`
 * or `guard`. Each must be named by at least one source file under src/ that is not the module that defines it, not a test,
 * and not a line that only re-exports it (`export { ... } from`). To check another tree, copy this file into that tree's test/
 * directory and run it there (the root is the parent of the file's directory). Seam: the file system only.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// test-reads-source-ok[structural]: the wiring of a guard is a property of the source text of the engines that import it.
const ROOT = join(import.meta.dir, '..');
const GUARD_EXPORT = /^export\s+(?:async\s+)?(?:function|const)\s+((?:refuse|guard)[A-Z]\w*)/gm;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** `module: name` for each guard export no other source file uses. */
export function unwiredGuardExports(root: string): string[] {
  const src = join(root, 'src');
  const files = tsFiles(src).map(path => ({ rel: relative(root, path), text: readFileSync(path, 'utf8') }));
  const engineSql = files.filter(f => /^src\/core\/engine-sql\/[^/]+\.ts$/.test(f.rel));
  const unwired: string[] = [];
  for (const mod of engineSql) {
    for (const [, name] of mod.text.matchAll(GUARD_EXPORT)) {
      const word = new RegExp(`\\b${name}\\b`);
      const used = files.some(f => f.rel !== mod.rel
        && f.text.split('\n').some(line => word.test(line) && !/^\s*export\s*\{[^}]*\}\s*from\b/.test(line)));
      if (!used) unwired.push(`${mod.rel}: ${name}`);
    }
  }
  return unwired.sort();
}

describe('engine guard wrappers are wired into an engine', () => {
  test('the set is not empty, so the check cannot pass by finding nothing', () => {
    const names = tsFiles(join(ROOT, 'src/core/engine-sql')).flatMap(path => [...readFileSync(path, 'utf8').matchAll(GUARD_EXPORT)].map(m => m[1]));
    expect(names).toContain('refuseWrites');
    expect(names).toContain('refuseRawWrites');
  });

  test('every refuse* and guard* export of src/core/engine-sql has a user outside its module, its re-export and the tests', () => {
    expect(unwiredGuardExports(ROOT)).toEqual([]);
  });
});
