/**
 * The graph map (core/graph/graph-map.ts, foresights graph-map).
 *
 * - evidence: each stored link's provenance tag maps to stated / inferred / tool_output.
 * - two levels: page -> atom -> concept becomes one page -- concept edge; atoms are not drawn.
 * - clusters: deterministic (input order never matters) and they split loosely joined groups.
 * - export: one HTML file with no network requests; a hostile title cannot break out of its element.
 * - on a real brain: private and deleted pages, and their links, never reach any output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildGraphMap, clusterGraph, edgeEvidence, graphMapExport, layoutGraph, renderGraphHtml, scriptSafeJson,
  type GraphLinkRow, type GraphPageRow,
} from '../src/core/graph/graph-map.ts';
import { loadGraphMap, runGraphMap, trimGraphMap } from '../src/commands/graph-map.ts';

const page = (id: number, slug: string, type: string | null = 'note', title: string | null = null): GraphPageRow => ({ id, slug, type, title });
const link = (from: number, to: number, link_source: string | null = 'markdown', link_type = '', link_kind: string | null = null): GraphLinkRow =>
  ({ from_page_id: from, to_page_id: to, link_source, link_type, link_kind });

describe('edgeEvidence', () => {
  test('written links are stated, gbrain-derived ones inferred, MCP tool mentions tool_output', () => {
    for (const s of ['markdown', 'frontmatter', 'wikilink-resolved', 'manual', null, '']) expect(edgeEvidence(s)).toBe('stated');
    for (const s of ['mentions', 'atom-provenance', 'concept-provenance', 'citation-graph']) expect(edgeEvidence(s)).toBe('inferred');
    expect(edgeEvidence('mcp-remote-mention')).toBe('tool_output');
    expect(edgeEvidence('markdown', 'typed_ner')).toBe('inferred');
  });
});

describe('buildGraphMap', () => {
  test('a page -> atom -> concept path becomes one inferred page -- concept edge, and atoms are not nodes', () => {
    const pages = [page(1, 'notes/a'), page(2, 'atoms/x', 'atom'), page(3, 'concepts/flywheel', 'concept', 'Flywheel'), page(4, 'notes/b')];
    const links = [link(1, 2, 'atom-provenance'), link(3, 2, 'concept-provenance', 'synthesized_from'), link(2, 3, 'concept-provenance', 'synthesizes'), link(1, 4)];
    const map = buildGraphMap(pages, links);
    expect(map.nodes.map(n => [n.slug, n.kind])).toEqual([['notes/a', 'page'], ['concepts/flywheel', 'concept'], ['notes/b', 'page']]);
    expect(map.edges).toEqual([
      { a: 1, b: 3, evidence: ['inferred'], types: ['mentions_concept'], weight: 1 },
      { a: 1, b: 4, evidence: ['stated'], types: [], weight: 1 },
    ]);
    expect(map.coverage).toEqual({ pages_with_concepts: 1, pages: 2, concepts: 1 });
  });

  test('links between the same two pages merge, keeping every evidence label; self links are dropped', () => {
    const map = buildGraphMap([page(1, 'a'), page(2, 'b')],
      [link(1, 2), link(2, 1, 'mentions'), link(1, 2, 'mcp-remote-mention', 'cites'), link(1, 1)]);
    expect(map.edges).toEqual([{ a: 1, b: 2, evidence: ['stated', 'inferred', 'tool_output'], types: ['cites'], weight: 3 }]);
    expect(map.nodes.map(n => n.degree)).toEqual([1, 1]);
  });

  test('a link to a page not in the list (private, deleted, other source) is ignored', () => {
    expect(buildGraphMap([page(1, 'a')], [link(1, 99)]).edges).toEqual([]);
  });
});

describe('clusterGraph', () => {
  // Two triangles joined by one inferred link.
  const pages = [1, 2, 3, 4, 5, 6].map(i => page(i, `p${i}`));
  const links = [link(1, 2), link(2, 3), link(1, 3), link(4, 5), link(5, 6), link(4, 6), link(3, 4, 'mentions')];

  test('splits loosely joined groups', () => {
    const c = clusterGraph(buildGraphMap(pages, links));
    expect(c.members).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(c.of.get(2)).toBe(0);
    expect(c.of.get(5)).toBe(1);
  });

  test('the same graph in any order gives the same clusters', () => {
    const a = clusterGraph(buildGraphMap(pages, links));
    const b = clusterGraph(buildGraphMap([...pages].reverse(), [...links].reverse()));
    expect(b.members).toEqual(a.members);
  });

  test('an isolated page is its own cluster', () => {
    expect(clusterGraph(buildGraphMap([page(1, 'a'), page(2, 'b')], [])).members).toEqual([[1], [2]]);
  });
});

describe('export', () => {
  const hostile = '</script><script>alert(1)</script> & "quotes"';
  const map = buildGraphMap([page(1, 'notes/x', 'note', hostile), page(2, 'notes/y')], [link(1, 2)]);
  const clusters = clusterGraph(map);
  const html = renderGraphHtml(graphMapExport(map, clusters, layoutGraph(map, clusters), { source: 'default', generatedAt: new Date('2026-11-17T00:00:00Z'), title: hostile }));

  test('is self-contained: no script, style or link loads anything from the network', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(html).toContain("default-src 'none'");
  });

  test('a hostile title cannot close the data script or inject markup', () => {
    expect(html.match(/<script/g)!.length).toBe(2);
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    const data = JSON.parse(html.split('<script id="graph-data" type="application/json">')[1]!.split('</script>')[0]!);
    expect(data.nodes[0].title).toBe(hostile);
    expect(scriptSafeJson('</script>')).not.toContain('</');
  });

  test('trimGraphMap keeps the best-connected nodes and only edges between kept nodes', () => {
    const big = buildGraphMap([1, 2, 3, 4].map(i => page(i, `p${i}`)), [link(1, 2), link(1, 3), link(1, 4), link(2, 3)]);
    const { map: t, dropped } = trimGraphMap(big, 3);
    expect(dropped).toBe(1);
    expect(t.nodes.map(n => n.id)).toEqual([1, 2, 3]);
    expect(t.edges.every(e => e.a !== 4 && e.b !== 4)).toBe(true);
  });
});

describe('on a brain', () => {
  let engine: PGLiteEngine;
  let dir: string;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gb-graph-map-'));
    const rows: Array<[string, string, string, Record<string, unknown>]> = [
      ['notes/alpha', 'note', 'Alpha', {}], ['notes/beta', 'note', 'Beta', {}], ['notes/secret', 'note', 'Secret plan', { visibility: 'private' }],
      ['atoms/a1', 'atom', 'a1', {}], ['concepts/pricing', 'concept', 'Pricing', {}], ['notes/gone', 'note', 'Gone', {}],
    ];
    for (const [slug, type, title, fm] of rows) {
      const [r] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter) VALUES ('default', $1, $2, $3, 'body', $4::text::jsonb) RETURNING id`,
        [slug, type, title, JSON.stringify(fm)]);
      ids[slug] = Number(r!.id);
    }
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [ids['notes/gone']]);
    const L = (f: string, t: string, src: string, type = '') => engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, $3, $4)`, [ids[f], ids[t], type, src]);
    await L('notes/alpha', 'notes/beta', 'markdown');
    await L('notes/alpha', 'notes/secret', 'markdown');
    await L('notes/secret', 'notes/beta', 'mentions');
    await L('notes/beta', 'notes/gone', 'markdown');
    await L('notes/beta', 'atoms/a1', 'atom-provenance');
    await L('concepts/pricing', 'atoms/a1', 'concept-provenance', 'synthesized_from');
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('private and deleted pages and their links are never read', async () => {
    const map = await loadGraphMap(engine, 'default');
    expect(map.nodes.map(n => n.slug).sort()).toEqual(['concepts/pricing', 'notes/alpha', 'notes/beta']);
    expect(map.edges.map(e => [e.a, e.b, e.evidence[0]])).toEqual([
      [ids['notes/alpha'], ids['notes/beta'], 'stated'],
      [ids['notes/beta'], ids['concepts/pricing'], 'inferred'],
    ]);
  });

  test('export writes one HTML file that names no private title', async () => {
    const out = join(dir, 'map.html');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: unknown) => { logs.push(String(m)); };
    try { await runGraphMap(engine, ['export', '--out', out, '--source', 'default', '--json']); } finally { console.log = orig; }
    const report = JSON.parse(logs.join('\n'));
    expect(report).toMatchObject({ out, nodes: 3, links: 2, dropped_nodes: 0 });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('Pricing');
    expect(html).not.toContain('Secret plan');
    expect(html).not.toContain('notes/secret');
    expect(html).not.toContain('notes/gone');
  });
});
