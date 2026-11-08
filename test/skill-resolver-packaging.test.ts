/**
 * GBRA-377 PR A: the skill resolver library's two published forms.
 *
 * 1. Protects: `gbrain/skill-resolver` (the package export Bun consumers
 *    import) and the dependency-free Node bundle the release attaches
 *    (scripts/build-skill-resolver-bundle.ts, gbrain-skill-resolver.mjs),
 *    which must import and resolve under Node with no node_modules.
 * 2. Fails when: the export path moves, or the bundle stops building or
 *    running under Node (a Bun-only API, an unbundled dependency).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('skill resolver packaging', () => {
  test('the package export names the library entry point', async () => {
    const pkg = await Bun.file(join(ROOT, 'package.json')).json() as { exports: Record<string, string> };
    expect(pkg.exports['./skill-resolver']).toBe('./src/core/skills/resolver/index.ts');
    const viaExport = await import('gbrain/skill-resolver');
    const direct = await import('../src/core/skills/resolver/index.ts');
    expect(viaExport.resolveSkills).toBe(direct.resolveSkills);
  });

  test.skipIf(!Bun.which('node'))('the Node bundle builds, imports under node from an empty directory and resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skres-node-'));
    try {
      const out = join(dir, 'gbrain-skill-resolver.mjs');
      const run = Bun.spawnSync([process.execPath, 'scripts/build-skill-resolver-bundle.ts', '--out', out, '--smoke'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const smoke = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!) as { node: string; bundled_skills: number; top: string };
      expect(smoke.top).toBe('x:deploy');
      expect(smoke.bundled_skills).toBeGreaterThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
