import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadStorageConfig, isDbOnly } from '../core/storage-config.ts';
import type { PageType } from '../core/types.ts';

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';
  
  const repoIdx = args.indexOf('--repo');
  const repoPath = repoIdx !== -1 ? args[repoIdx + 1] : null;
  
  const typeIdx = args.indexOf('--type');
  const typeFilter = typeIdx !== -1 ? args[typeIdx + 1] as PageType : undefined;
  
  const slugPrefixIdx = args.indexOf('--slug-prefix');
  const slugPrefix = slugPrefixIdx !== -1 ? args[slugPrefixIdx + 1] : undefined;
  
  const restoreOnly = args.includes('--restore-only');
  
  // Load storage configuration if repo path is provided
  const storageConfig = repoPath ? loadStorageConfig(repoPath) : null;
  
  // Build filters. slugPrefix is engine-side (Issue #13) — no in-memory
  // post-filter, no full-table load.
  const filters: import('../core/types.ts').PageFilters = { limit: 100000 };
  if (typeFilter) filters.type = typeFilter;
  if (slugPrefix) filters.slugPrefix = slugPrefix;

  let pages: import('../core/types.ts').Page[];

  // Restore-only path: query each db_only directory with slugPrefix instead
  // of loading every page in the brain. On a 200K-page brain where 95% is
  // db_only, this is roughly the same load — but on brains where only 5K
  // out of 200K are db_only, this is a ~40x reduction.
  if (restoreOnly && repoPath && storageConfig) {
    const seen = new Set<string>();
    pages = [];
    for (const dir of storageConfig.db_only) {
      const tierFilters: import('../core/types.ts').PageFilters = {
        ...filters,
        slugPrefix: filters.slugPrefix
          ? // If user passed --slug-prefix, only include tier dirs that start with it.
            (dir.startsWith(filters.slugPrefix) ? dir : undefined)
          : dir,
      };
      if (!tierFilters.slugPrefix) continue;
      const tierPages = await engine.listPages(tierFilters);
      for (const p of tierPages) {
        if (seen.has(p.slug)) continue;
        seen.add(p.slug);
        if (!isDbOnly(p.slug, storageConfig)) continue; // belt-and-suspenders
        const filePath = join(repoPath, p.slug + '.md');
        if (existsSync(filePath)) continue;
        pages.push(p);
      }
    }
  } else {
    pages = await engine.listPages(filters);
  }
  if (restoreOnly) {
    console.log(`Restoring ${pages.length} db_only pages to ${outDir}/`);
  } else {
    console.log(`Exporting ${pages.length} pages to ${outDir}/`);
  }

  // Progress on stderr so stdout stays clean for scripts parsing counts.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('export.pages', pages.length);

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
    writeFileSync(filePath, md);

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
    progress.tick();
  }

  progress.finish();
  // Stdout summary preserved so scripts that grep for "Exported N pages" keep working.
  if (restoreOnly) {
    console.log(`Restored ${exported} pages to ${outDir}/`);
  } else {
    console.log(`Exported ${exported} pages to ${outDir}/`);
  }
}
