import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine, Page } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';

  const slugsIdx = args.indexOf('--slugs');
  let slugFilter: string[] | null = null;
  if (slugsIdx !== -1) {
    const raw = args[slugsIdx + 1] ?? '';
    slugFilter = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (slugFilter.length === 0) {
      throw new Error('--slugs expected at least one slug (got empty value)');
    }
  }

  let pages: Array<Page | { slug: string; missing: true }>;
  if (slugFilter) {
    pages = [];
    for (const slug of slugFilter) {
      const p = await engine.getPage(slug);
      if (p) pages.push(p);
      else {
        console.warn(`[export] skip missing slug: ${slug}`);
        pages.push({ slug, missing: true });
      }
    }
  } else {
    pages = await engine.listPages({ limit: 100000 });
  }

  const realPages = pages.filter((p): p is Page => !('missing' in p));
  console.log(`Exporting ${realPages.length} pages to ${outDir}/`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('export.pages', realPages.length);

  let succeeded = 0;
  let failed = 0;

  for (const page of realPages) {
    try {
      const tags = await engine.getTags(page.slug);
      const md = serializeMarkdown(
        page.frontmatter,
        page.compiled_truth,
        page.timeline,
        { type: page.type, title: page.title, tags },
      );

      const filePath = join(outDir, page.slug + '.md');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md);

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

      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[export] FAILED ${page.slug}: ${msg}`);
      failed++;
    }
    progress.tick();
  }

  progress.finish();

  const summary = failed > 0
    ? `Exported ${succeeded} pages to ${outDir}/, ${failed} failed`
    : `Exported ${succeeded} pages to ${outDir}/`;
  console.log(summary);

  if (succeeded === 0) {
    process.exit(1);
  }
}
