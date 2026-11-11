/**
 * GBRA-377 PR A: the guide's quick start (docs/guides/skill-resolver.md) runs
 * as written on an install with no brain.
 *
 * 1. Protects: the copy-paste commands in the guide.
 * 2. Fails when: a command, flag or output the quick start relies on changes.
 * 3. Seam: a `gbrain` shell function that runs src/cli.ts; a scratch
 *    GBRAIN_HOME with no config and no brain, and a scratch working directory.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('skill resolver guide', () => {
  test('the quick start runs with no brain', () => {
    const guide = readFileSync(join(ROOT, 'docs/guides/skill-resolver.md'), 'utf8');
    const section = guide.slice(guide.indexOf('## Quick start'));
    const block = /```bash\n([\s\S]*?)```/.exec(section)![1]!;
    const work = mkdtempSync(join(tmpdir(), 'skres-guide-'));
    try {
      const script = `set -euo pipefail\ngbrain() { "${process.execPath}" "${join(ROOT, 'src/cli.ts')}" "$@"; }\n${block}`;
      const run = Bun.spawnSync(['bash', '-c', script], { cwd: work, env: { ...process.env, GBRAIN_HOME: join(work, 'home') }, stdout: 'pipe', stderr: 'pipe' });
      const out = run.stdout.toString();
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(out).toContain('<relevant_skills>');
      expect(out).toContain('"id":"deploy"');
      expect(out).toContain('Removed catalog example.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
