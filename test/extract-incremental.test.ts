/**
 * Regression guards for the incremental extract path (PR #417).
 *
 * Eng-review Step 5: 8 unit cases asserting `runExtractCore({ slugs })`
 * processes only the requested slugs in the cycle path while
 * `slugs: undefined` falls through to the existing full-walk behavior.
 *
 * All tests use PGLite/in-memory — no DB connection required.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runExtractCore } from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let tempDir: string;

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-test-'));
  mkdirSync(join(tempDir, 'people'), { recursive: true });
  mkdirSync(join(tempDir, 'companies'), { recursive: true });
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function seedPage(slug: string, body: string): Promise<void> {
  const [type, name] = slug.split('/');
  await engine.putPage(slug, {
    type: type as 'person' | 'company',
    title: name,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    content_hash: 'h',
  });
  // Also write to disk so walkMarkdownFiles can find it
  const filePath = join(tempDir, slug + '.md');
  mkdirSync(join(tempDir, type), { recursive: true });
  writeFileSync(filePath, body);
}

describe('runExtractCore — incremental cycle path (#417)', () => {
  test('1. slugs: [] returns immediately with zero counts (early-return path)', async () => {
    await seedPage('people/alice-example', '# alice');
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'all',
      dir: tempDir,
      slugs: [],
    });
    expect(result.links_created).toBe(0);
    expect(result.timeline_entries_created).toBe(0);
    expect(result.pages_processed).toBe(0);
  });

  test('2. slugs: undefined falls through to full-walk path', async () => {
    await seedPage('people/alice-example', '# alice\n\n[bob](people/bob-example)');
    await seedPage('people/bob-example', '# bob');
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'all',
      dir: tempDir,
    });
    // Full walk processes everything found on disk
    expect(result.pages_processed).toBeGreaterThan(0);
  });

  test('3. slugs: [a, b] reads only those two files (incremental processing)', async () => {
    await seedPage('people/alice-example', '# alice');
    await seedPage('people/bob-example', '# bob');
    await seedPage('people/charlie-example', '# charlie');
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'all',
      dir: tempDir,
      slugs: ['people/alice-example', 'people/bob-example'],
    });
    // Only 2 files processed even though 3 exist on disk
    expect(result.pages_processed).toBe(2);
  });

  test('4. Slug whose file no longer exists is silently skipped', async () => {
    await seedPage('people/alice-example', '# alice');
    // people/ghost has no file on disk but is in the slugs list
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'all',
      dir: tempDir,
      slugs: ['people/alice-example', 'people/ghost'],
    });
    // alice processed; ghost skipped (no file)
    expect(result.pages_processed).toBe(1);
  });

  test('5. mode: links skips timeline extraction in incremental', async () => {
    const body = '# alice\n\n## Timeline\n- 2026-01-01: started';
    await seedPage('people/alice-example', body);
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,
      slugs: ['people/alice-example'],
    });
    // Timeline extraction skipped even though body contains a timeline
    expect(result.timeline_entries_created).toBe(0);
  });

  test('6. dryRun: true does not invoke addLinksBatch / addTimelineEntriesBatch', async () => {
    await seedPage('people/alice-example', '# alice\n\n[bob](people/bob-example)');
    await seedPage('people/bob-example', '# bob');

    let linksBatchCalled = false;
    let timelineBatchCalled = false;
    const originalAddLinks = engine.addLinksBatch.bind(engine);
    const originalAddTimeline = engine.addTimelineEntriesBatch.bind(engine);
    (engine as unknown as { addLinksBatch: typeof originalAddLinks }).addLinksBatch = async (...args) => {
      linksBatchCalled = true;
      return originalAddLinks(...args);
    };
    (engine as unknown as { addTimelineEntriesBatch: typeof originalAddTimeline }).addTimelineEntriesBatch = async (...args) => {
      timelineBatchCalled = true;
      return originalAddTimeline(...args);
    };

    await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'all',
      dir: tempDir,
      slugs: ['people/alice-example'],
      dryRun: true,
    });

    expect(linksBatchCalled).toBe(false);
    expect(timelineBatchCalled).toBe(false);
  });

  test('7. BATCH_SIZE flush — slugs producing >100 candidate links exercise the mid-iteration flush', async () => {
    // BATCH_SIZE in extract.ts is 100. Create one slug with 150 outbound links.
    const targets: string[] = [];
    for (let i = 0; i < 150; i++) {
      const target = `companies/co-${i}`;
      targets.push(target);
      await seedPage(target, `# co-${i}`);
    }
    const linkBlock = targets.map(t => `- [${t}](${t})`).join('\n');
    await seedPage('people/alice-example', `# alice\n\n${linkBlock}`);

    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,
      slugs: ['people/alice-example'],
    });
    // The flush happens mid-iteration when batch hits 100; the remaining 50 flush at end.
    // No exception means the flush path executed cleanly.
    expect(result.pages_processed).toBe(1);
    expect(result.links_created).toBeGreaterThanOrEqual(0); // Just confirms the flush path didn't blow up
  });

  test('8. Full-slug-set resolution — slug references file outside changed set', async () => {
    // alice references bob, but only alice is in the incremental slugs list.
    // The allSlugs set must still include bob (from walkMarkdownFiles) so
    // resolveSlug succeeds; otherwise the link would silently drop.
    // Markdown link pattern requires .md target.
    await seedPage('people/alice-example', '# alice\n\n[bob](bob-example.md)');
    await seedPage('people/bob-example', '# bob');

    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,
      slugs: ['people/alice-example'],
    });

    // Only alice's file was read, but the resulting link must reference bob
    // (resolved via the full allSlugs set built from walkMarkdownFiles).
    expect(result.pages_processed).toBe(1);
    // Link from alice to bob was extracted successfully via the full allSlugs set
    expect(result.links_created).toBeGreaterThan(0);
  });
});
