/**
 * foresights lint link checks: dead and ambiguous links between the brain's own pages.
 *
 * Deterministic and read-only: zero LLM calls, no database. Reads the markdown
 * files under the lint root, builds the slug set and the basename index the
 * engine's link extraction uses, and checks every body link the extractor would
 * turn into an edge (core/link-extraction.ts entityRefPasses):
 *
 * - `dead-link`       the target is no page under the lint root
 * - `ambiguous-link`  a bare `[[name]]` matches more than one page, so the
 *                     engine leaves it unresolved (unique-match-only)
 *
 * Out of scope on purpose: source-qualified `[[source:slug]]` links (another
 * source's pages are not on this disk), links to non-markdown files
 * (attachments), external URLs, links inside code, and frontmatter link
 * fields. A link counts as live when ANY resolution the extractor tries finds a
 * page, so a link the graph would link is never reported.
 *
 * Embeddable core: no filesystem access here. The caller passes the page list
 * and the reader (src/commands/lint.ts walks the tree).
 */
import { relative } from 'path';
import {
  entityRefPasses,
  buildBasenameIndex,
  queryBasenameIndex,
  pageRelativeMarkdownSlugs,
  resolveMarkdownLinkSlug,
} from '../link-extraction.ts';
import { pathToSlug, slugifyPath } from '../sync.ts';

export type LinkRule = 'dead-link' | 'ambiguous-link';

export interface LinkFinding {
  /** Path relative to the lint root, as lint reports it. */
  file: string;
  line: number;
  rule: LinkRule;
  message: string;
  /** The link target as written. */
  target: string;
  /** For ambiguous-link: the pages the name matches. */
  candidates?: string[];
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const MARKDOWN_HREF_RE = /\[[^\]\n]*\]\(([^)\s]+)/y;
const NON_PAGE_EXT_RE = /\.(?!mdx?$)[a-z0-9]{1,8}$/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function hrefAt(body: string, index: number): string | null {
  MARKDOWN_HREF_RE.lastIndex = index;
  const m = MARKDOWN_HREF_RE.exec(body);
  return m ? m[1] : null;
}

/**
 * Check the links of `pages` (absolute paths, the pages lint is linting) against
 * `targets` (absolute paths of every markdown page under `root` a link may point
 * at). Returns findings keyed by the path relative to root. A page `read` throws
 * on is skipped (lint itself reports a page that vanished mid-scan).
 */
export function checkLinks(
  root: string,
  pages: string[],
  targets: string[],
  read: (path: string) => string,
): Map<string, LinkFinding[]> {
  const all = targets;
  const slugs = new Set(all.map((p) => pathToSlug(relative(root, p))));
  const index = buildBasenameIndex(slugs);
  const findings = new Map<string, LinkFinding[]>();

  for (const page of pages) {
    const rel = relative(root, page);
    const self = pathToSlug(rel);
    let text: string;
    try {
      text = read(page);
    } catch {
      continue; // lint itself reports a page that vanished mid-scan
    }
    const fm = FRONTMATTER_RE.exec(text);
    const offset = fm ? fm[0].length : 0;
    const body = text.slice(offset);
    const out: LinkFinding[] = [];
    const passes = entityRefPasses(body);
    const report = (rule: LinkRule, at: number, target: string, message: string, candidates?: string[]) =>
      out.push({ file: rel, line: lineAt(text, offset + at), rule, message, target, ...(candidates ? { candidates } : {}) });

    // Passes 0 and 1: markdown links (`[x](dir/page.md)`, `[x](./page.md)`, `[x](../dir/page.md)`).
    for (const ref of [...passes[0], ...passes[1]]) {
      const href = ref.index !== undefined ? hrefAt(body, ref.index) : null;
      if (!href || NON_PAGE_EXT_RE.test(href.replace(/#.*$/, ''))) continue; // an attachment, not a page
      const tries = [...pageRelativeMarkdownSlugs(self, href), resolveMarkdownLinkSlug(self, href)].filter(Boolean) as string[];
      if (!tries.some((s) => slugs.has(s))) {
        report('dead-link', ref.index ?? 0, href, `link to ${tries[tries.length - 1] ?? href}: no such page`);
      }
    }
    // Pass 2 (`[[source:slug]]`) points into another source: not checkable from this disk.
    // Pass 3: `[[dir/page]]` wikilinks with a known top-level directory.
    for (const ref of passes[3]) {
      const slug = slugifyPath(ref.slug).toLowerCase();
      if (!slugs.has(slug) && !slugs.has(ref.slug.toLowerCase())) {
        report('dead-link', ref.index ?? 0, ref.slug, `link to ${slug}: no such page`);
      }
    }
    // Pass 4: any other `[[name]]`, resolved like the engine: the exact slug, else a unique basename match.
    for (const ref of passes[4]) {
      if (ref.slug.includes('/') && (slugs.has(slugifyPath(ref.slug).toLowerCase()) || slugs.has(ref.slug.toLowerCase()))) continue;
      const tail = ref.slug.includes('/') ? ref.slug.slice(ref.slug.lastIndexOf('/') + 1) : ref.slug;
      const matches = queryBasenameIndex(index, tail).filter((s) => s !== self);
      if (matches.length === 0) {
        if (queryBasenameIndex(index, tail).includes(self)) continue; // a link to the page itself
        report('dead-link', ref.index ?? 0, ref.slug, `link to [[${ref.slug}]]: no page has that name`);
      } else if (matches.length > 1) {
        report('ambiguous-link', ref.index ?? 0, ref.slug,
          `[[${ref.slug}]] matches ${matches.length} pages (${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ', ...' : ''}); write the full path`,
          matches);
      }
    }
    if (out.length) findings.set(rel, out.sort((a, b) => a.line - b.line));
  }
  return findings;
}
