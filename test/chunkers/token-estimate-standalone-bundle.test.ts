/**
 * A bundle run away from the build machine's node_modules (what a compiled
 * binary is) must still count with cl100k, not the len/4 fallback.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('token-estimate in a standalone bundle', () => {
  test('counts with cl100k when node_modules is not beside the bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-bundle-'));
    try {
      // Private project copy whose tiktoken package lacks the full-build WASM
      // (a machine where the build checkout's node_modules is not usable).
      const repo = resolve(import.meta.dir, '../..');
      const pkgSrc = join(repo, 'node_modules/@dqbd/tiktoken');
      const pkgDst = join(dir, 'proj/node_modules/@dqbd/tiktoken');
      cpSync(pkgSrc, pkgDst, { recursive: true, filter: (f) => f !== join(pkgSrc, 'tiktoken_bg.wasm') });
      mkdirSync(join(dir, 'proj/src/core/chunkers'), { recursive: true });
      copyFileSync(join(repo, 'src/core/cjk.ts'), join(dir, 'proj/src/core/cjk.ts'));
      const src = join(dir, 'proj/src/core/chunkers/token-estimate.ts');
      copyFileSync(join(repo, 'src/core/chunkers/token-estimate.ts'), src);
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, `import { estimateTokens, cl100kAvailable } from ${JSON.stringify(src)};
const text = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
console.log(JSON.stringify({ available: cl100kAvailable(), tokens: estimateTokens(text) }));
`);
      const out = join(dir, 'out');
      mkdirSync(out);
      const build = Bun.spawnSync([process.execPath, 'build', entry, '--outdir', out, '--target', 'bun'], { cwd: dir });
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync([process.execPath, join(out, 'entry.js')], { cwd: out });
      const parsed = JSON.parse(run.stdout.toString().trim().split('\n').pop() ?? '{}');
      expect(parsed).toEqual({ available: true, tokens: 401 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
