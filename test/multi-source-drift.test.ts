/**
 * v0.31.8 — multi_source_drift doctor check (D8 + D14 + D17 + OV12 + OV13).
 *
 * Heuristic: a non-default source X with local_path set, where the FS at
 * local_path contains a markdown file whose slug exists at (default, slug)
 * in DB but is missing from (X, slug). Surfaces evidence of pre-v0.30.3
 * putPage misroutes OR an incomplete initial sync.
 *
 * Test cases (5):
 *   1. Single-source brain → check skipped (no row in checks output).
 *   2. Multi-source brain, no misroutes → status `ok`.
 *   3. Multi-source brain, 2 misrouted slugs → status `warn` with sample.
 *   4. Multi-source brain, healthy same-slug-across-sources (file at X has
 *      DB row at X AND default has its own legitimate slug) → ok (NOT a
 *      false positive).
 *   5. FS walk hits limit → status `warn 'check skipped, walk too large'`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';

let engine: PGLiteEngine;
const TMP_ROOTS: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const dir of TMP_ROOTS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmpRoot(label: string): string {
  const dir = join(tmpdir(), `gbrain-drift-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

function seedFile(root: string, relPath: string, content = 'placeholder\n'): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('findMisroutedPages — heuristic correctness', () => {
  test('case 1: no non-default sources → returns empty result (caller skips check)', async () => {
    // Findfn is called by doctor only when at least one non-default source
    // with local_path exists; passing an empty array is the equivalent.
    const result = await findMisroutedPages(engine, []);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 2: multi-source brain, no misroutes → count=0', async () => {
    const root = makeTmpRoot('case2');
    seedFile(root, 'people/alice.md');
    seedFile(root, 'people/bob.md');

    // Register the source via runSources, then update local_path directly.
    await runSources(engine, ['add', 'src-case2', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case2'],
    );
    // Both slugs land in (src-case2, *), NOT in (default, *). Healthy.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '.' }, { sourceId: 'src-case2' });
    await engine.putPage('people/bob',   { type: 'person', title: 'Bob',   compiled_truth: '.' }, { sourceId: 'src-case2' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case2', local_path: root }]);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 3: multi-source brain, 2 misrouted slugs → warn with sample', async () => {
    const root = makeTmpRoot('case3');
    seedFile(root, 'people/charlie.md');
    seedFile(root, 'people/dana.md');

    await runSources(engine, ['add', 'src-case3', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case3'],
    );
    // Both slugs land in (default, *) — the misroute shape.
    await engine.putPage('people/charlie', { type: 'person', title: 'Charlie', compiled_truth: '.' });
    await engine.putPage('people/dana',    { type: 'person', title: 'Dana',    compiled_truth: '.' });
    // src-case3 has neither.

    const result = await findMisroutedPages(engine, [{ id: 'src-case3', local_path: root }]);
    expect(result.count).toBe(2);
    expect(result.sample.length).toBe(2);
    const slugs = result.sample.map(s => s.slug).sort();
    expect(slugs).toEqual(['people/charlie', 'people/dana']);
    for (const s of result.sample) {
      expect(s.intended_source).toBe('src-case3');
      expect(s.local_path).toBe(root);
    }
  });

  test('case 4: healthy same-slug-across-sources is NOT a false positive (OV4 redesign)', async () => {
    const root = makeTmpRoot('case4');
    seedFile(root, 'topics/widget.md');

    await runSources(engine, ['add', 'src-case4', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case4'],
    );
    // Page exists at BOTH sources — the v0.18.0 supported state. The FS file
    // at src-case4 has a row at (src-case4, ...) AND default has its own.
    await engine.putPage('topics/widget', { type: 'concept', title: 'Default widget', compiled_truth: '.' });
    await engine.putPage('topics/widget', { type: 'concept', title: 'Src widget',     compiled_truth: '.' }, { sourceId: 'src-case4' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case4', local_path: root }]);
    // Heuristic requires "(default, slug) AND NOT (X, slug)". Since both
    // exist, it's NOT misroute. Count must be 0 — this is the codex OV4 fix
    // case, the original "same-slug-across-sources = corruption" heuristic
    // would have false-positived here.
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 5: FS walk hits limit → walk_truncated=true', async () => {
    const root = makeTmpRoot('case5');
    // Seed 12 files with a limit of 5 to force truncation.
    for (let i = 0; i < 12; i++) {
      seedFile(root, `topics/file-${i}.md`);
    }

    const result = await findMisroutedPages(engine, [{ id: 'src-case5-fake', local_path: root }], {
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.walk_truncated).toBe(true);
  });

  test('case 6 (OV13): unreadable local_path does NOT crash; returns empty', async () => {
    const result = await findMisroutedPages(engine, [
      { id: 'src-fake', local_path: '/nonexistent/path/that/does/not/exist' },
    ]);
    // Walk silently returns zero files; count=0, NOT throw.
    expect(result.count).toBe(0);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 7 (OV13): .mdx files are walked alongside .md', async () => {
    const root = makeTmpRoot('case7');
    seedFile(root, 'topics/mdx-page.mdx');

    await runSources(engine, ['add', 'src-case7', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case7'],
    );
    // Misroute the slug into default.
    await engine.putPage('topics/mdx-page', { type: 'concept', title: 'mdx', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case7', local_path: root }]);
    expect(result.count).toBe(1);
    expect(result.sample[0].slug).toBe('topics/mdx-page');
  });
});
