/**
 * World explorer HTML renderer (Phase 3 — contributor DX).
 *
 * Reads the world-v1 shards + _ledger.json and emits a static HTML file
 * that renders the entire canonical world as an explorable tree. Zero
 * install, opens in any browser via `bun run eval:world:view`.
 *
 * Design:
 *   - Single-file HTML with inline CSS + minimal vanilla JS
 *   - Left rail: list of entities grouped by type (companies / people /
 *     meetings / concepts), each a clickable link
 *   - Right pane: per-entity card with compiled_truth, timeline, and a
 *     relationships section showing incoming + outgoing facts from _facts
 *   - URL fragment (#people/alice-chen) deep-links to an entity
 *
 * XSS safety:
 *   Every generated string field passes through escapeHtml() before being
 *   inserted into the DOM as text. `<`, `&`, `"`, `'` all get entity-encoded.
 *   Opus can (and sometimes does) generate content that looks like
 *   HTML/script tags; unescaped, any contributor opening world.html would
 *   run attacker-controlled JS. High-confidence vuln class, 9/10.
 *
 * Markdown:
 *   compiled_truth + timeline can contain inline markdown (bold, links).
 *   For safety, we DON'T render markdown — we preserve linebreaks + show
 *   `[Name](slug)` links as plain text. This is intentionally minimal;
 *   a proper renderer would sanitize every AST node which is out of scope
 *   for v1.1.
 *
 * Output: writes to eval/data/world-v1/world.html by default.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── HTML escaping (XSS safety) ──────────────────────────────────

/**
 * HTML-entity-encode a string for safe insertion as text content.
 * Escapes the 5 characters that matter for XSS: & < > " '
 * Does NOT escape Unicode (surrogate pairs etc. — those are fine as-is).
 */
export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Preserve linebreaks from Opus prose (they're meaningful) by replacing
 * \n with <br>. Called AFTER escapeHtml so the <br> isn't escaped.
 */
function preserveLineBreaks(escaped: string): string {
  return escaped.replace(/\n/g, '<br>');
}

// ─── Types ──────────────────────────────────────────────────────

interface Page {
  slug: string;
  type: 'person' | 'company' | 'meeting' | 'concept';
  title: string;
  compiled_truth: string;
  timeline: string;
  _facts: Record<string, unknown>;
}

interface Ledger {
  generated_at?: string;
  model?: string;
  costUsd?: number;
  files_total?: number;
  [key: string]: unknown;
}

// ─── Corpus loader ──────────────────────────────────────────────

function loadCorpus(dir: string): { pages: Page[]; ledger: Ledger } {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'));
  const pages: Page[] = [];
  let ledger: Ledger = {};
  for (const f of files) {
    const raw = readFileSync(join(dir, f), 'utf-8');
    if (f === '_ledger.json') {
      try { ledger = JSON.parse(raw) as Ledger; } catch { /* fall through */ }
      continue;
    }
    try {
      const p = JSON.parse(raw) as Page;
      if (Array.isArray(p.timeline)) p.timeline = (p.timeline as unknown as string[]).join('\n');
      if (Array.isArray(p.compiled_truth)) {
        p.compiled_truth = (p.compiled_truth as unknown as string[]).join('\n\n');
      }
      p.title = String(p.title ?? '');
      p.compiled_truth = String(p.compiled_truth ?? '');
      p.timeline = String(p.timeline ?? '');
      pages.push(p);
    } catch {
      // skip malformed files, but don't fail the whole render
    }
  }
  return { pages, ledger };
}

// ─── Rendering helpers ──────────────────────────────────────────

function renderEntityCard(p: Page): string {
  const slugSafe = escapeHtml(p.slug);
  const titleSafe = escapeHtml(p.title);
  const typeSafe = escapeHtml(p.type);
  const compiledSafe = preserveLineBreaks(escapeHtml(p.compiled_truth));
  const timelineSafe = preserveLineBreaks(escapeHtml(p.timeline));
  const factsJson = escapeHtml(JSON.stringify(p._facts, null, 2));

  return `
    <article class="entity" id="${slugSafe}" data-type="${typeSafe}">
      <header>
        <div class="entity-type">${typeSafe}</div>
        <h2>${titleSafe}</h2>
        <code class="slug">${slugSafe}</code>
      </header>
      <section>
        <h3>Compiled truth</h3>
        <div class="prose">${compiledSafe || '<em>(no compiled truth)</em>'}</div>
      </section>
      ${p.timeline ? `
      <section>
        <h3>Timeline</h3>
        <div class="prose">${timelineSafe}</div>
      </section>` : ''}
      <section class="facts">
        <h3>Canonical facts (_facts)</h3>
        <pre>${factsJson}</pre>
      </section>
    </article>
  `;
}

function renderRail(pages: Page[]): string {
  const grouped = new Map<string, Page[]>();
  for (const p of pages) {
    const arr = grouped.get(p.type) ?? [];
    arr.push(p);
    grouped.set(p.type, arr);
  }
  const order = ['company', 'person', 'meeting', 'concept'];
  const sections: string[] = [];
  for (const type of order) {
    const list = grouped.get(type) ?? [];
    if (list.length === 0) continue;
    list.sort((a, b) => a.title.localeCompare(b.title));
    const items = list.map(p => {
      const title = escapeHtml(p.title);
      const slug = escapeHtml(p.slug);
      return `<li><a href="#${slug}" data-slug="${slug}">${title}</a></li>`;
    }).join('');
    sections.push(`
      <section class="rail-section">
        <h4>${escapeHtml(type)}s <span class="count">(${list.length})</span></h4>
        <ul>${items}</ul>
      </section>
    `);
  }
  return sections.join('');
}

function renderLedger(ledger: Ledger, pageCount: number): string {
  const lines: string[] = [];
  lines.push(`<strong>${pageCount}</strong> entities`);
  if (ledger.generated_at) {
    lines.push(`generated <code>${escapeHtml(ledger.generated_at)}</code>`);
  }
  if (ledger.model) {
    lines.push(`via <code>${escapeHtml(ledger.model)}</code>`);
  }
  if (typeof ledger.costUsd === 'number') {
    lines.push(`cost <code>$${ledger.costUsd.toFixed(2)}</code>`);
  }
  return lines.join(' \u00b7 ');
}

// ─── Top-level render ───────────────────────────────────────────

export function renderWorldHtml(pages: Page[], ledger: Ledger = {}): string {
  const entityCards = pages
    .slice()
    .sort((a, b) => {
      const byType = a.type.localeCompare(b.type);
      return byType !== 0 ? byType : a.title.localeCompare(b.title);
    })
    .map(renderEntityCard)
    .join('\n');

  const rail = renderRail(pages);
  const ledgerLine = renderLedger(ledger, pages.length);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BrainBench twin-amara world explorer</title>
<style>
  :root {
    --fg: #1a1a1a; --fg-dim: #6b6b6b; --bg: #fafafa; --accent: #0a66c2;
    --card-bg: #fff; --border: #e5e5e5; --code-bg: #f4f4f4;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg);
    display: grid; grid-template-columns: 280px 1fr; min-height: 100vh;
  }
  nav.rail {
    background: #fff; border-right: 1px solid var(--border);
    padding: 16px 12px 40px; overflow-y: auto; position: sticky; top: 0; height: 100vh;
  }
  nav.rail h1 { font-size: 14px; margin: 0 0 4px; }
  nav.rail .subtitle { font-size: 11px; color: var(--fg-dim); margin-bottom: 16px; line-height: 1.4; }
  nav.rail .ledger { font-size: 10px; color: var(--fg-dim); margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  nav.rail h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-dim); margin: 14px 0 4px; }
  nav.rail .count { font-weight: normal; }
  nav.rail ul { list-style: none; padding: 0; margin: 0; }
  nav.rail li { margin: 0; }
  nav.rail a {
    display: block; padding: 3px 6px; color: var(--fg); text-decoration: none;
    font-size: 12.5px; border-radius: 3px;
  }
  nav.rail a:hover { background: #f0f7ff; color: var(--accent); }
  nav.rail a.active { background: #e8f1fc; color: var(--accent); font-weight: 500; }
  main { padding: 28px 36px 80px; max-width: 900px; }
  h1.page-title { font-size: 22px; margin: 0 0 4px; }
  p.page-subtitle { color: var(--fg-dim); margin: 0 0 28px; font-size: 13px; }
  article.entity {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 20px 24px; margin-bottom: 28px; scroll-margin-top: 16px;
  }
  article.entity header { margin-bottom: 14px; }
  article.entity .entity-type {
    display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--fg-dim); background: var(--code-bg); padding: 2px 6px; border-radius: 3px;
  }
  article.entity h2 { font-size: 19px; margin: 4px 0; }
  article.entity .slug { font-size: 11px; color: var(--fg-dim); }
  article.entity h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); margin: 16px 0 6px; }
  article.entity .prose { font-size: 14px; line-height: 1.55; }
  article.entity .prose em { color: var(--fg-dim); }
  article.entity section.facts pre {
    font: 11px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
    background: var(--code-bg); border-radius: 4px; padding: 10px;
    overflow-x: auto; white-space: pre-wrap; color: var(--fg);
  }
  @media (max-width: 800px) {
    body { grid-template-columns: 1fr; }
    nav.rail { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>
</head>
<body>
  <nav class="rail">
    <h1>twin-amara world</h1>
    <div class="subtitle">BrainBench v1.1 canonical corpus</div>
    <div class="ledger">${ledgerLine}</div>
    ${rail}
  </nav>
  <main>
    <h1 class="page-title">Explore the canonical world</h1>
    <p class="page-subtitle">
      Click an entity in the sidebar to jump to it. All content is HTML-entity-encoded
      to prevent XSS; Opus-generated prose can contain tag-like fragments. Use this
      as a reference when writing Tier 5.5 queries.
    </p>
    ${entityCards}
  </main>
  <script>
    // Highlight the active nav link based on scroll position. Minimal vanilla.
    (function() {
      const railLinks = document.querySelectorAll('nav.rail a[data-slug]');
      const entities = document.querySelectorAll('article.entity');
      function updateActive() {
        const y = window.scrollY + 120;
        let active = null;
        for (const e of entities) {
          const top = e.getBoundingClientRect().top + window.scrollY;
          if (top <= y) active = e.id;
        }
        railLinks.forEach(a => {
          if (a.getAttribute('data-slug') === active) a.classList.add('active');
          else a.classList.remove('active');
        });
      }
      window.addEventListener('scroll', updateActive, { passive: true });
      updateActive();
    })();
  </script>
</body>
</html>
`;
}

// ─── CLI entrypoint ─────────────────────────────────────────────

export function renderWorldHtmlToFile(dir: string, outPath?: string): string {
  const { pages, ledger } = loadCorpus(dir);
  const html = renderWorldHtml(pages, ledger);
  const target = outPath ?? join(dir, 'world.html');
  writeFileSync(target, html, 'utf-8');
  return target;
}

// Run directly (e.g. `bun eval/generators/world-html.ts`)
if (import.meta.main) {
  const dir = process.argv.find(a => a.startsWith('--dir='))?.slice('--dir='.length) ??
    'eval/data/world-v1';
  const out = process.argv.find(a => a.startsWith('--out='))?.slice('--out='.length);
  const target = renderWorldHtmlToFile(dir, out);
  console.log(`Wrote ${target}`);
}
