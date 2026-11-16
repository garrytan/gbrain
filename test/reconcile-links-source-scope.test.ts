/**
 * reconcile-links reconciles one selected source and fails on a real write error.
 *
 * Protects: `gbrain reconcile-links --source <id>` scans, reads and links only
 * that source's pages (both edge directions inside it), refuses `__all__`,
 * and a link write that fails for any reason other than a missing target
 * fails the run instead of reporting `ok`.
 * Fails when: the CLI drops --source, the markdown scan reads every source
 * while edges default to `default` (zero edges, status ok), or the catch
 * goes back to warning and continuing.
 * Seams: `engine.addLink` is wrapped on this test's own engine instance for
 * the write-failure case; everything else is real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReconcileLinks, runReconcileLinksCli } from '../src/commands/reconcile-links.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const sourceId of ['source-a', 'source-b']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [sourceId]);
    await engine.putPage('guides/widget', { type: 'guide', title: 'Widget guide', compiled_truth: 'The widget lives at src/widget.ts:12.', timeline: '' }, { sourceId });
    await engine.putPage('src-widget-ts', { type: 'code', page_kind: 'code', title: 'src/widget.ts', compiled_truth: 'module', timeline: '' }, { sourceId });
  }
  await engine.putPage('guides/only-in-b', { type: 'guide', title: 'B only', compiled_truth: 'See src/widget.ts.', timeline: '' }, { sourceId: 'source-b' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

async function edges(): Promise<string[]> {
  const rows = await engine.executeRaw<{ edge: string }>(
    `SELECT f.source_id || ':' || f.slug || ' ' || l.link_type || ' ' || t.source_id || ':' || t.slug AS edge
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id`);
  return rows.map(r => r.edge).sort();
}

test('--source reconciles only that source and links its pages', async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await runReconcileLinksCli(engine, ['--source', 'source-a', '--json']);
  } finally {
    console.log = log;
  }
  expect(JSON.parse(lines.join('\n'))).toMatchObject({ status: 'ok', markdownPagesScanned: 1, edgesAttempted: 1, edgesTargetsMissing: 0 });
  expect(await edges()).toEqual([
    'source-a:guides/widget documents source-a:src-widget-ts',
    'source-a:src-widget-ts documented_by source-a:guides/widget',
  ]);
});

test('a sourceId scopes the scan to that source', async () => {
  const result = await runReconcileLinks(engine, { sourceId: 'source-b', dryRun: true });
  expect(result).toMatchObject({ status: 'ok', markdownPagesScanned: 2, codeRefsFound: 2 });
});

test('__all__ is refused before anything is read or written', async () => {
  await expect(runReconcileLinks(engine, { sourceId: '__all__' })).rejects.toMatchObject({ code: 'invalid_params' });
});

test('a link write that fails for a reason other than a missing target fails the run', async () => {
  const before = await edges();
  (engine as unknown as { addLink: unknown }).addLink = async () => { throw new Error('connection reset'); };
  try {
    await expect(runReconcileLinks(engine, { sourceId: 'source-b' })).rejects.toThrow('connection reset');
  } finally {
    delete (engine as unknown as { addLink?: unknown }).addLink;
  }
  expect(await edges()).toEqual(before);
});
