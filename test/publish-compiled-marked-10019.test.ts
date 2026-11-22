import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('publish bundled without node_modules (#10019)', () => {
  test('generateHtml works from a bundle that cannot resolve marked at runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-10019-'));
    try {
      const out = join(dir, 'bundle.js');
      const build = Bun.spawnSync(
        ['bun', 'build', resolve('src/commands/publish.ts'), '--target=bun', '--outfile', out],
        { cwd: process.cwd() },
      );
      expect(build.exitCode).toBe(0);
      const driver = join(dir, 'run.js');
      writeFileSync(driver, `import { generateHtml } from ${JSON.stringify(out)};
process.stdout.write(generateHtml({ title: 'T', markdown: '# Hi', encrypted: null }));`);
      const run = Bun.spawnSync(['bun', driver], { cwd: dir });
      const stdout = run.stdout.toString();
      const stderr = run.stderr.toString();
      expect(run.exitCode).toBe(0);
      expect(stdout).toContain('marked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
