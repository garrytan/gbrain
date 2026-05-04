/**
 * v0.20.0 Cathedral II Layer 8 D3 — reconcile-links tests.
 *
 * Closes the v0.19.0 Layer 6 doc↔impl order-dependency: when a
 * markdown guide imports BEFORE the code file it cites, the E1
 * forward-scan drops the edge because addLink's inner SELECT can't
 * resolve the code slug yet. D3 batch-scans all markdown pages and
 * re-inserts missing edges. Idempotent via ON CONFLICT DO NOTHING.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReconcileLinks } from '../src/commands/reconcile-links.ts';

describe('Layer 8 D3 — reconcile-links', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Create a markdown guide that cites a code file.
    await engine.putPage('guides/sync-internals', {
      type: 'guide',
      title: 'Sync internals',
      compiled_truth: 'The sync path lives at src/core/sync.ts:172. See also src/commands/sync.ts.',
      timeline: '',
    });
    // Create the code pages the guide cites. page_kind='code' to match
    // the classifier output importCodeFile would produce.
    await engine.putPage('src-core-sync-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/core/sync.ts (typescript)',
      compiled_truth: 'module exports go here',
      timeline: '',
    });
    await engine.putPage('src-commands-sync-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/commands/sync.ts (typescript)',
      compiled_truth: 'module exports go here',
      timeline: '',
    });
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('extracts code refs and creates bidirectional edges', async () => {
    const result = await runReconcileLinks(engine);
    expect(result.status).toBe('ok');
    expect(result.markdownPagesScanned).toBeGreaterThanOrEqual(1);
    expect(result.codeRefsFound).toBeGreaterThanOrEqual(2);
    expect(result.edgesAttempted).toBeGreaterThanOrEqual(2);

    // Verify edges land: guide → code, code → guide.
    const guideLinks = await engine.getLinks('guides/sync-internals');
    const outgoing = guideLinks.map(l => l.to_slug);
    expect(outgoing).toContain('src-core-sync-ts');
    expect(outgoing).toContain('src-commands-sync-ts');

    const codeBacklinks = await engine.getBacklinks('src-core-sync-ts');
    expect(codeBacklinks.map(l => l.from_slug)).toContain('guides/sync-internals');
  });

  test('is idempotent — second run inserts zero new edges (ON CONFLICT DO NOTHING)', async () => {
    const before = await engine.getLinks('guides/sync-internals');
    const result = await runReconcileLinks(engine);
    expect(result.status).toBe('ok');
    const after = await engine.getLinks('guides/sync-internals');
    // Same edge count, same edges (ON CONFLICT DO NOTHING at the SQL layer).
    expect(after.length).toBe(before.length);
  });

  test('dry-run reports counts without writing', async () => {
    // Add a new markdown page with a ref, run dry-run, verify no new edges.
    await engine.putPage('guides/dry-run-test', {
      type: 'guide',
      title: 'Dry run test',
      compiled_truth: 'Another ref to src/core/sync.ts for dry-run coverage.',
      timeline: '',
    });
    const beforeLinks = await engine.getLinks('guides/dry-run-test');
    const result = await runReconcileLinks(engine, { dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.codeRefsFound).toBeGreaterThanOrEqual(1);
    // Dry-run doesn't increment edgesAttempted (we never call addLink).
    expect(result.edgesAttempted).toBe(0);
    const afterLinks = await engine.getLinks('guides/dry-run-test');
    expect(afterLinks.length).toBe(beforeLinks.length);
  });

  test('markdown page with no code refs is a no-op', async () => {
    await engine.putPage('guides/no-refs', {
      type: 'guide',
      title: 'No refs',
      compiled_truth: 'This page talks about design principles without citing any code paths.',
      timeline: '',
    });
    const before = await engine.getLinks('guides/no-refs');
    await runReconcileLinks(engine);
    const after = await engine.getLinks('guides/no-refs');
    expect(after.length).toBe(before.length);
  });

  test('respects auto_link=false', async () => {
    await engine.setConfig('auto_link', 'false');
    const result = await runReconcileLinks(engine);
    expect(result.status).toBe('auto_link_disabled');
    expect(result.markdownPagesScanned).toBe(0);
    await engine.setConfig('auto_link', 'true');
  });

  test('missing code target is counted, not thrown', async () => {
    // Create a guide citing a code file that doesn't exist.
    await engine.putPage('guides/missing-target', {
      type: 'guide',
      title: 'Missing',
      compiled_truth: 'See src/nonexistent/path.ts for details.',
      timeline: '',
    });
    const result = await runReconcileLinks(engine);
    expect(result.status).toBe('ok');
    // The ref was found, attempt was made, but inner JOIN drops silently.
    // In PGLite that's counted as edgesAttempted without an error.
    expect(result.codeRefsFound).toBeGreaterThan(0);
  });
});
