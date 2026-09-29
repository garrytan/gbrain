/**
 * slug_collisions doctor check (A3): files in a source checkout that map to
 * one page slug are reported with their paths and which one is indexed.
 *
 * PGLite in-memory ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { slugCollisionsCheck } from '../src/commands/doctor/checks/slug-collisions.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'slug-collide-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  execSync('git add -A && git commit -qm seed', { cwd: dir });
  return dir;
}

describe('slug_collisions doctor check', () => {
  test('a clean checkout is ok', async () => {
    const dir = repo({ 'notes/one.md': '---\ntitle: One\n---\nOne.\n' });
    await runSources(engine, ['add', 'clean', '--path', dir, '--no-federated']);
    const check = await slugCollisionsCheck(engine);
    expect(check.status).toBe('ok');
    expect(categorizeCheck('slug_collisions')).toBe('brain');
  }, 60_000);

  test('two files mapping to one slug are reported with the indexed path', async () => {
    const dir = repo({ 'notes/Foo Bar.md': '---\ntitle: One\n---\napples\n', 'notes/foo-bar.md': '---\ntitle: Two\n---\noranges\n' });
    await runSources(engine, ['add', 'collide', '--path', dir, '--no-federated']);
    await performSync(engine, { repoPath: dir, sourceId: 'collide', noPull: true, noEmbed: true });
    const check = await slugCollisionsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('collide:notes/foo-bar');
    expect(check.message).toContain('notes/Foo Bar.md');
    expect(check.message).toContain('notes/foo-bar.md');
    expect(check.message).toMatch(/indexed: notes\/(Foo Bar|foo-bar)\.md/);
  }, 60_000);
});
