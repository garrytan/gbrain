import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';

/**
 * Normalize internal markdown links for filesystem viewability.
 *
 * Internally GBrain uses slug-form references like `[name](./alice)` because
 * the slug is the canonical identifier in the DB. But when those pages are
 * exported as `.md` files on disk and opened in standard markdown viewers
 * (Obsidian, VS Code preview, GitHub web view), the viewers look for a literal
 * file at `./alice` — which doesn't exist (the actual file is `./alice.md`).
 * Result: every internal link is broken on disk despite working inside GBrain.
 *
 * This rewriter appends `.md` to internal slug-form links so the exported
 * markdown is viewable as-is. External URLs, anchors, mailto, and links that
 * already carry a file extension are left alone.
 */
export function normalizeInternalLinks(content: string): string {
  return content.replace(
    /(\[[^\]]+\])\(([^)]+)\)/g,
    (match, label, target) => {
      // Skip empty / anchor-only / external schemes
      if (!target || target.startsWith('#')) return match;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return match; // http:, https:, mailto:, ftp:, file:, etc.
      // Strip query/anchor for extension check
      const withoutFragment = target.split(/[?#]/)[0];
      // Skip if already has a file extension (.md, .png, .pdf, etc.)
      // Match basename's extension to avoid false positives on dotted directories
      const basename = withoutFragment.split('/').pop() || '';
      if (/\.[a-z0-9]{1,5}$/i.test(basename)) return match;
      // Skip empty basename (trailing slash)
      if (!basename) return match;
      // Append .md (preserving any query/anchor)
      const fragment = target.slice(withoutFragment.length);
      return `${label}(${withoutFragment}.md${fragment})`;
    },
  );
}

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';

  const pages = await engine.listPages({ limit: 100000 });
  console.log(`Exporting ${pages.length} pages to ${outDir}/`);

  let exported = 0;

  for (const page of pages) {
    const tags = await engine.getTags(page.slug);
    const md = serializeMarkdown(
      page.frontmatter,
      page.compiled_truth,
      page.timeline,
      { type: page.type, title: page.title, tags },
    );

    const filePath = join(outDir, page.slug + '.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, normalizeInternalLinks(md));

    // Export raw data as sidecar JSON
    const rawData = await engine.getRawData(page.slug);
    if (rawData.length > 0) {
      const slugParts = page.slug.split('/');
      const rawDir = join(outDir, ...slugParts.slice(0, -1), '.raw');
      mkdirSync(rawDir, { recursive: true });
      const rawPath = join(rawDir, slugParts[slugParts.length - 1] + '.json');

      const rawObj: Record<string, unknown> = {};
      for (const rd of rawData) {
        rawObj[rd.source] = rd.data;
      }
      writeFileSync(rawPath, JSON.stringify(rawObj, null, 2) + '\n');
    }

    exported++;
    if (exported % 100 === 0) {
      process.stdout.write(`\r  ${exported}/${pages.length} exported`);
    }
  }

  console.log(`\nExported ${exported} pages to ${outDir}/`);
}
