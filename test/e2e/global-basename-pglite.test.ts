/**
 * Issue #972 E2E — opt-in global-basename wikilink resolution.
 *
 * Reproduces the issue's exact repro inside an in-memory PGLite brain:
 *
 *   /vault/projects/struktura.md  ← a real page
 *   /vault/concepts/knowledge-graph.md  ← contains `[[struktura]]`
 *
 * The bare wikilink `[[struktura]]` does NOT match WIKILINK_RE
 * (DIR_PATTERN-gated) so it falls through to the new pass 2c.
 *
 * Three contracts:
 *   1. Flag OFF (default) — extract emits ZERO basename edges (back-compat
 *      with pre-issue-#972 behavior: bare wikilinks outside DIR_PATTERN
 *      drop silently).
 *   2. Flag ON — extract emits ONE edge per basename match, tagged
 *      `link_type: 'wikilink_basename'`.
 *   3. Ambiguous basename (same name in two directories) — extract emits
 *      ONE edge per match. No silent winner-takes-all, no silent drop.
 *
 * Both DB-source AND FS-source paths covered. PGLite in-memory, no
 * DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages',
    'config',
  ]) {
    try { await (engine as any).db.exec(`DELETE FROM ${t}`); } catch { /* ok */ }
  }
}

beforeEach(async () => {
  await truncateAll();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-issue-972-'));
}, 15_000);

function writeFile(rel: string, content: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// ─── FS-source path (the issue's repro) ─────────────────────────────────

describe('issue #972 — FS-source (gbrain extract links default)', () => {
  test("repro: [[struktura]] in concepts/ resolves to projects/struktura when flag ON", async () => {
    // Seed both pages in the DB (extract validates targetSlug exists)
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: 'A project page.', timeline: '',
    });
    await engine.putPage('concepts/knowledge-graph', {
      type: 'concept', title: 'Knowledge Graph',
      compiled_truth: 'This concept relates to [[struktura]].', timeline: '',
    });
    // Mirror to disk so the FS extractor sees the files
    writeFile('projects/struktura.md',
      '---\ntitle: Struktura\ntype: project\n---\n\nA project page.\n');
    writeFile('concepts/knowledge-graph.md',
      '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nThis concept relates to [[struktura]].\n');

    await engine.setConfig('link_resolution.global_basename', 'true');

    await runExtract(engine, ['links', '--dir', brainDir]);

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    const strk = outLinks.find(l => l.to_slug === 'projects/struktura');
    expect(strk).toBeDefined();
    expect(strk!.link_type).toBe('wikilink_basename');
    // Issue #972 (T1): FS-source basename edges carry the same provenance
    // tag as DB / put_page, not the default 'markdown'.
    expect(strk!.link_source).toBe('wikilink-resolved');
  });

  test('back-compat: flag OFF → ZERO basename edges from same repro', async () => {
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });
    await engine.putPage('concepts/knowledge-graph', {
      type: 'concept', title: 'Knowledge Graph',
      compiled_truth: 'This relates to [[struktura]].', timeline: '',
    });
    writeFile('projects/struktura.md', '---\ntitle: Struktura\ntype: project\n---\n');
    writeFile('concepts/knowledge-graph.md',
      '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nThis relates to [[struktura]].\n');

    // Flag explicitly off (also the default)
    await engine.setConfig('link_resolution.global_basename', 'false');

    await runExtract(engine, ['links', '--dir', brainDir]);

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    expect(outLinks.find(l => l.to_slug === 'projects/struktura')).toBeUndefined();
    expect(outLinks.filter(l => l.link_type === 'wikilink_basename')).toEqual([]);
  });

  test('ambiguous basename → emits one edge per match (no silent winner)', async () => {
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });
    await engine.putPage('archive/struktura', {
      type: 'concept' as any, title: 'Struktura (archived)',
      compiled_truth: '', timeline: '',
    });
    await engine.putPage('concepts/x', {
      type: 'concept', title: 'X',
      compiled_truth: 'See [[struktura]].', timeline: '',
    });

    writeFile('projects/struktura.md', '---\ntitle: Struktura\ntype: project\n---\n');
    writeFile('archive/struktura.md', '---\ntitle: Struktura\ntype: concept\n---\n');
    writeFile('concepts/x.md',
      '---\ntitle: X\ntype: concept\n---\n\nSee [[struktura]].\n');

    await engine.setConfig('link_resolution.global_basename', 'true');

    await runExtract(engine, ['links', '--dir', brainDir]);

    const outLinks = await engine.getLinks('concepts/x');
    const basenameLinks = outLinks
      .filter(l => l.link_type === 'wikilink_basename')
      .map(l => l.to_slug)
      .sort();
    expect(basenameLinks).toEqual(['archive/struktura', 'projects/struktura']);
  });
});

// ─── DB-source path (gbrain extract links --source db) ──────────────────

describe('issue #972 — DB-source (gbrain extract links --source db)', () => {
  test('flag ON → bare wikilink in compiled_truth resolves to basename match', async () => {
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });
    await engine.putPage('concepts/knowledge-graph', {
      type: 'concept', title: 'Knowledge Graph',
      compiled_truth: 'This relates to [[struktura]].', timeline: '',
    });
    await engine.setConfig('link_resolution.global_basename', 'true');

    await runExtract(engine, ['links', '--source', 'db']);

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    const strk = outLinks.find(l => l.to_slug === 'projects/struktura');
    expect(strk).toBeDefined();
    expect(strk!.link_type).toBe('wikilink_basename');
  });

  test('flag OFF → no basename edges via DB path (back-compat)', async () => {
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });
    await engine.putPage('concepts/knowledge-graph', {
      type: 'concept', title: 'Knowledge Graph',
      compiled_truth: 'This relates to [[struktura]].', timeline: '',
    });

    await runExtract(engine, ['links', '--source', 'db']);

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    expect(outLinks.find(l => l.to_slug === 'projects/struktura')).toBeUndefined();
  });
});

// ─── put_page auto-link path ────────────────────────────────────────────
//
// put_page accepts `content` as a full markdown document with frontmatter
// (not the engine's narrow Page shape). Auto-link runs INSIDE put_page,
// so the basename-resolution path picks up the flag from
// engine.getConfig() once per call.

const PUT_PAGE_MARKDOWN_WITH_WIKILINK = `---
title: Knowledge Graph
type: concept
---

This relates to [[struktura]].
`;

describe('issue #972 — put_page auto-link', () => {
  test('newly-written page with bare wikilink → basename edge when flag ON', async () => {
    // Need the target page to exist first (auto-link validates against the
    // existing slug set).
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });

    await engine.setConfig('link_resolution.global_basename', 'true');

    const { operations } = await import('../../src/core/operations.ts');
    const putPage = operations.find(op => op.name === 'put_page')!;
    await putPage.handler(
      { engine, remote: false } as never,
      {
        slug: 'concepts/knowledge-graph',
        content: PUT_PAGE_MARKDOWN_WITH_WIKILINK,
      },
    );

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    const strk = outLinks.find(l => l.to_slug === 'projects/struktura');
    expect(strk).toBeDefined();
    expect(strk!.link_type).toBe('wikilink_basename');
  });

  test('flag OFF → put_page does NOT emit basename edge (back-compat)', async () => {
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura',
      compiled_truth: '', timeline: '',
    });

    // Default-off (no setConfig)

    const { operations } = await import('../../src/core/operations.ts');
    const putPage = operations.find(op => op.name === 'put_page')!;
    await putPage.handler(
      { engine, remote: false } as never,
      {
        slug: 'concepts/knowledge-graph',
        content: PUT_PAGE_MARKDOWN_WITH_WIKILINK,
      },
    );

    const outLinks = await engine.getLinks('concepts/knowledge-graph');
    expect(outLinks.find(l => l.to_slug === 'projects/struktura')).toBeUndefined();
  });

  test('stale basename edge is removed when the wikilink is deleted (codex #972)', async () => {
    // Regression: wikilink-resolved edges must be reconcilable, else they
    // survive after the bare wikilink is removed from the page body.
    await engine.putPage('projects/struktura', {
      type: 'project', title: 'Struktura', compiled_truth: '', timeline: '',
    });
    await engine.setConfig('link_resolution.global_basename', 'true');

    const { operations } = await import('../../src/core/operations.ts');
    const putPage = operations.find(op => op.name === 'put_page')!;

    // 1. Write the page WITH the wikilink → edge lands.
    await putPage.handler({ engine, remote: false } as never, {
      slug: 'concepts/knowledge-graph', content: PUT_PAGE_MARKDOWN_WITH_WIKILINK,
    });
    let outLinks = await engine.getLinks('concepts/knowledge-graph');
    expect(outLinks.find(l => l.to_slug === 'projects/struktura')).toBeDefined();

    // 2. Re-write the page WITHOUT the wikilink → edge must be reconciled away.
    await putPage.handler({ engine, remote: false } as never, {
      slug: 'concepts/knowledge-graph',
      content: '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nNo links here anymore.\n',
    });
    outLinks = await engine.getLinks('concepts/knowledge-graph');
    expect(outLinks.find(l => l.to_slug === 'projects/struktura')).toBeUndefined();
  });
});
