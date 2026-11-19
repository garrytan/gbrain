/**
 * #7147 follow-up: what a cold read verb's module graph leaves out.
 *
 * 1. Protects: loading the module behind `foresights get` (src/core/ops/pages.ts)
 *    does not load the page write path (persistence/page-mutations.ts, which
 *    pulled the journal, the persistence service, sync and PGLite WAL repair
 *    into every cold read on a Postgres brain), and the active-pack loader
 *    behind search and entity does not load the pack mutation module
 *    (schema-pack/mutate.ts, the filesystem guard and the mutation audit).
 * 2. Fails when: ops/pages.ts imports page-mutations statically again, or
 *    load-active.ts takes a helper from mutate.ts again.
 * 3. Existing coverage: test/cli-cold-start-registries.test.ts classifies
 *    load-time registrations; nothing pinned the size of a read's graph.
 * 4. Seam: none. A child process loads each module into a fresh registry.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

function loadedBy(entry: string): string[] {
  const script = `await import(${JSON.stringify(resolve(REPO_ROOT, entry))}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const r = Bun.spawnSync([process.execPath, '-e', script], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return (JSON.parse(r.stdout.toString().trim().split('\n').pop()!) as string[]).map(f => f.slice(REPO_ROOT.length + 1));
}

describe('a cold read loads no write path', () => {
  test('the get_page module loads neither the page write path nor PGLite WAL repair', () => {
    const loaded = loadedBy('src/core/ops/pages.ts');
    expect(loaded).toContain('src/core/ops/pages.ts');
    expect(loaded.filter(f => f === 'src/core/persistence/page-mutations.ts' || f === 'src/core/pglite-resetwal.ts' || f === 'src/core/persistence/journal.ts')).toEqual([]);
  }, 60_000);

  test('the active-pack loader does not load the pack mutation module', () => {
    const loaded = loadedBy('src/core/schema-pack/load-active.ts');
    expect(loaded).toContain('src/core/schema-pack/load-active.ts');
    expect(loaded.filter(f => f === 'src/core/schema-pack/mutate.ts' || f === 'src/core/schema-pack/mutate-audit.ts')).toEqual([]);
  }, 60_000);
});
