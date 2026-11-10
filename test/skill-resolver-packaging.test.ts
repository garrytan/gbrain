/**
 * GBRA-377 PR A: the skill resolver library's published forms.
 *
 * 1. Protects: `gbrain/skill-resolver` (the package export Bun consumers
 *    import), the dependency-free Node bundle the release attaches with its
 *    sha256 (scripts/build-skill-resolver-bundle.ts, gbrain-skill-resolver.mjs)
 *    and `gbrain skills library`, which writes the same bundle from the
 *    installed source to a fixed path; each must import and resolve under
 *    Node with no node_modules. In CI a missing node fails instead of skipping.
 * 2. Fails when: the export path moves, the bundle stops building or running
 *    under Node (a Bun-only API, an unbundled dependency, a JSON import
 *    without its attribute), the CLI and the release build differ, or the
 *    release stops attaching or checking the sha256.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION } from '../src/version.ts';

const ROOT = resolve(import.meta.dir, '..');
const NODE = Bun.which('node');
const needNode = !NODE && !process.env.CI;

describe('skill resolver packaging', () => {
  test('the package export names the library entry point', async () => {
    const pkg = await Bun.file(join(ROOT, 'package.json')).json() as { exports: Record<string, string> };
    expect(pkg.exports['./skill-resolver']).toBe('./src/core/skills/resolver/index.ts');
    const viaExport = await import('gbrain/skill-resolver');
    const direct = await import('../src/core/skills/resolver/index.ts');
    expect(viaExport.resolveSkills).toBe(direct.resolveSkills);
    expect(viaExport.commitSessionAsync).toBeFunction();
    expect(viaExport.GBRAIN_VERSION).toBe(VERSION);
  });

  test.skipIf(needNode)('the Node bundle builds, imports under node from an empty directory, resolves and commits', () => {
    expect(NODE, 'node is required in CI').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'skres-node-'));
    try {
      const out = join(dir, 'gbrain-skill-resolver.mjs');
      const run = Bun.spawnSync([process.execPath, 'scripts/build-skill-resolver-bundle.ts', '--out', out, '--smoke'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const smoke = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!) as { node: string; gbrain_version: string; bundled_skills: number; top: string };
      expect(smoke.top).toBe('x:deploy');
      expect(smoke.gbrain_version).toBe(VERSION);
      expect(smoke.bundled_skills).toBeGreaterThan(20);
      const sum = createHash('sha256').update(readFileSync(out)).digest('hex');
      expect(readFileSync(`${out}.sha256`, 'utf8')).toBe(`${sum}  gbrain-skill-resolver.mjs\n`);
      const home = join(dir, 'home');
      const cli = Bun.spawnSync([process.execPath, 'src/cli.ts', 'skills', 'library', '--json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_HOME: home } });
      expect(cli.exitCode, cli.stderr.toString()).toBe(0);
      const lib = JSON.parse(cli.stdout.toString()) as { path: string; sha256: string; bytes: number; gbrain_version: string };
      expect(lib.path).toBe(join(home, '.gbrain', 'lib', 'gbrain-skill-resolver.mjs'));
      expect(lib.sha256).toBe(sum);
      expect(lib.gbrain_version).toBe(VERSION);
      const probe = Bun.spawnSync([NODE!, '--input-type=module', '-e', `const m = await import(${JSON.stringify(lib.path)}); console.log(m.GBRAIN_VERSION, typeof m.resolveSkills, typeof m.commitSessionAsync);`], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      expect(probe.exitCode, probe.stderr.toString()).toBe(0);
      expect(probe.stdout.toString().trim()).toBe(`${VERSION} function function`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test.skipIf(needNode)('the version module imports under node (JSON import attribute)', () => {
    const run = Bun.spawnSync([NODE!, '--input-type=module', '-e', `const m = await import(${JSON.stringify(join(ROOT, 'src/version.ts'))}); console.log(m.VERSION);`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString().trim()).toBe(VERSION);
  });

  test('the release attaches the bundle with its sha256 and checks it before publishing', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('gbrain-darwin-arm64,gbrain-linux-x64,gbrain-skill-resolver.mjs,gbrain-skill-resolver.mjs.sha256');
    expect(wf).toContain('bun scripts/build-skill-resolver-bundle.ts --out bundle/gbrain-skill-resolver.mjs --smoke');
    expect(wf).toContain('artifacts/gbrain-skill-resolver.mjs/gbrain-skill-resolver.mjs.sha256');
    const check = wf.indexOf('sha256sum -c gbrain-skill-resolver.mjs.sha256');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(wf.indexOf('uses: softprops/action-gh-release'));
  });
});
