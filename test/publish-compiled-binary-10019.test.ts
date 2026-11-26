/**
 * #10019: `gbrain publish` failed in the release binary with "Cannot find module 'marked'", because the inlined
 * marked.umd.js was read from node_modules at runtime and a `bun build --compile` binary has none. The script is now
 * embedded at build time from vendor/marked/, so this compiles a small harness around generateHtml and runs it from a
 * directory with no node_modules.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PUBLISH = resolve(import.meta.dir, '..', 'src', 'commands', 'publish.ts');
const VENDORED = resolve(import.meta.dir, '..', 'vendor', 'marked', 'marked.umd.js');
const INSTALLED = resolve(import.meta.dir, '..', 'node_modules', 'marked', 'lib', 'marked.umd.js');
const SOURCE_MODULE = resolve(import.meta.dir, '..', 'vendor', 'marked', 'marked-source.ts');

describe('#10019: publish in a compiled binary', () => {
  test('generateHtml inlines marked from a compiled binary run outside the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-publish-10019-'));
    try {
      const harness = join(dir, 'harness.ts');
      writeFileSync(harness, `import { generateHtml } from ${JSON.stringify(PUBLISH)};
process.stdout.write(generateHtml({ title: 'T', markdown: '# Hi', encrypted: null }));\n`);
      const out = join(dir, 'publish-harness');
      execFileSync('bun', ['build', '--compile', `--outfile=${out}`, harness], { encoding: 'utf-8', timeout: 180_000 });
      const run = spawnSync(out, [], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
      expect(run.stderr).not.toMatch(/Cannot find (module|package)/);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(readFileSync(VENDORED, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the vendored marked.umd.js matches the installed marked package', () => {
    expect(readFileSync(VENDORED, 'utf8')).toBe(readFileSync(INSTALLED, 'utf8'));
  });

  test('marked-source.ts holds marked.umd.js byte for byte', async () => {
    const { MARKED_JS } = await import(SOURCE_MODULE);
    expect(MARKED_JS).toBe(readFileSync(VENDORED, 'utf8'));
  });
});
