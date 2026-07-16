import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const roots: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(label: string): string {
  const path = join(tmpdir(), `gbrain-drift-hardening-${label}-${Date.now()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

describe('multi-source drift scan hardening', () => {
  test('prefers tracked git markdown and ignores dependency output', async () => {
    const dir = root('git');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tracked.md'), '# tracked');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'noise.md'), '# noise');
    execFileSync('git', ['init'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['add', 'docs/tracked.md'], { cwd: dir, windowsHide: true });
    await engine.putPage('docs/tracked', { type: 'note', title: 'tracked', compiled_truth: '.', frontmatter: {} });
    await engine.putPage('node_modules/pkg/noise', { type: 'note', title: 'noise', compiled_truth: '.', frontmatter: {} });
    const result = await findMisroutedPages(engine, [{ id: 'source-a', local_path: dir }]);
    expect(result.count).toBe(1);
    expect(result.sample[0].slug).toBe('docs/tracked');
  });

  test('honors environment bounds when explicit options are absent', async () => {
    const dir = root('env');
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `page-${i}.md`), '# page');
    await withEnv({ GBRAIN_DRIFT_LIMIT: '2', GBRAIN_DRIFT_TIMEOUT_MS: '10000' }, async () => {
      const result = await findMisroutedPages(engine, [{ id: 'source-b', local_path: dir }]);
      expect(result.walk_truncated).toBe(true);
    });
  });
});
