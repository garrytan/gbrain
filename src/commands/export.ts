import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadStorageConfig, isDbOnly } from '../core/storage-config.ts';
import { slugifyPath } from '../core/sync.ts';
import { getDefaultSourcePath, resolveSourceId, isResolverUserError } from '../core/source-resolver.ts';
import { ALL_SOURCES } from '../core/source-id.ts';
import { listAllPages } from '../core/list-all-pages.ts';
import type { Page, PageFilters, PageType } from '../core/types.ts';

/** How many colliding slugs the refusal lists before summarising the rest. */
const COLLISION_LIST_LIMIT = 20;

/** Slugs held by more than one source in `pages`, sorted, each with its sorted source ids. */
function findCrossSourceSlugs(pages: Page[]): Array<{ slug: string; sources: string[] }> {
  const sourcesBySlug = new Map<string, Set<string>>();
  for (const p of pages) {
    const sources = sourcesBySlug.get(p.slug) ?? new Set<string>();
    sources.add(p.source_id);
    sourcesBySlug.set(p.slug, sources);
  }
  return [...sourcesBySlug]
    .filter(([, sources]) => sources.size > 1)
    .map(([slug, sources]) => ({ slug, sources: [...sources].sort() }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';

  const repoIdx = args.indexOf('--repo');
  const explicitRepoPath = repoIdx !== -1 ? args[repoIdx + 1] : null;

  const typeIdx = args.indexOf('--type');
  const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] as string) : undefined;

  const slugPrefixIdx = args.indexOf('--slug-prefix');
  const slugPrefix = slugPrefixIdx !== -1 ? args[slugPrefixIdx + 1] : undefined;

  const restoreOnly = args.includes('--restore-only');

  // --source honors the explicit flag only: with no flag, export keeps
  // spanning every source (the GBRAIN_SOURCE / dotfile / default tiers do
  // not narrow it). `__all__` is the resolver's span-everything sentinel.
  const sourceIdx = args.indexOf('--source');
  let sourceId: string | undefined;
  if (sourceIdx !== -1) {
    const requested = args[sourceIdx + 1];
    if (!requested || requested.startsWith('--')) {
      console.error('Error: --source requires a source id. Run `gbrain sources list` to see registered sources.');
      process.exit(1);
    }
    try {
      const resolved = await resolveSourceId(engine, requested);
      sourceId = resolved === ALL_SOURCES ? undefined : resolved;
    } catch (e) {
      if (!isResolverUserError(e)) throw e;
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Resolution chain (D5): explicit --repo → typed sources.getDefault() →
  // hard-error for restore-only paths (never fall through to cwd).
  // For non-restore exports, repoPath stays null because regular export
  // doesn't need a brain repo to run (D26 — exports include everything).
  let repoPath: string | null = explicitRepoPath;
  if (restoreOnly && !repoPath) {
    repoPath = await getDefaultSourcePath(engine);
    if (!repoPath) {
      console.error(
        `Error: gbrain export --restore-only requires --repo <path> or a configured\n` +
          `default source with a local_path. Run \`gbrain sources list\` to inspect\n` +
          `sources, or pass --repo explicitly.`,
      );
      process.exit(1);
    }
  }

  // Load storage configuration if repo path is provided
  const storageConfig = repoPath ? loadStorageConfig(repoPath) : null;

  // D5 + Codex P0: refuse --restore-only when there's no storage config to
  // scope the restore. Without storageConfig, the selective filter (db_only
  // pages missing on disk) can't run, and falling through to the full
  // listPages export silently dumps the entire DB. Catch this before any
  // page query fires.
  if (restoreOnly && !storageConfig) {
    console.error(
      `Error: gbrain export --restore-only requires a storage tiering config\n` +
        `(gbrain.yml with a "storage:" section) at ${repoPath}/gbrain.yml.\n` +
        `Without it, there's nothing to scope the restore to.\n` +
        `Run \`gbrain storage status\` to inspect the current configuration.`,
    );
    process.exit(1);
  }
  
  // Build filters. slugPrefix is engine-side (Issue #13) -- no in-memory
  // post-filter. listAllPages reads the full set in batches: a single
  // listPages call is capped by the engine's LIMIT.
  const filters: Omit<PageFilters, 'limit' | 'offset' | 'sort'> = {};
  if (typeFilter) filters.type = typeFilter as PageType;
  if (slugPrefix) filters.slugPrefix = slugPrefix;
  if (sourceId) filters.sourceId = sourceId;

  let pages: Page[];

  // Restore-only path: query each db_only directory with slugPrefix instead
  // of loading every page in the brain. On a 200K-page brain where 95% is
  // db_only, this is roughly the same load — but on brains where only 5K
  // out of 200K are db_only, this is a ~40x reduction.
  if (restoreOnly && repoPath && storageConfig) {
    // Overlapping tier dirs return a page more than once. Slugs are unique
    // per source, not brain-wide, so dedup on the (source_id, slug) identity.
    const seen = new Set<string>();
    pages = [];
    for (const dir of storageConfig.db_only) {
      const tierPrefix = filters.slugPrefix
        ? // If user passed --slug-prefix, only include tier dirs that start with it.
          (dir.startsWith(filters.slugPrefix) ? dir : undefined)
        : dir;
      if (!tierPrefix) continue;
      const tierPages = await listAllPages(engine, { ...filters, slugPrefix: tierPrefix });
      for (const p of tierPages) {
        const key = `${p.source_id}::${p.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isDbOnly(p.slug, storageConfig)) continue; // belt-and-suspenders
        const filePath = join(repoPath, p.slug + '.md');
        if (existsSync(filePath)) continue;
        pages.push(p);
      }
    }
  } else {
    pages = await listAllPages(engine, filters);
  }

  // Every page lands at <outDir>/<slug>.md, so two sources holding one slug
  // would write the same file and the last write would win. Refuse before
  // writing anything; a `<source>/` path prefix is no way out, since import
  // would re-key those pages under new slugs.
  const collisions = findCrossSourceSlugs(pages);
  if (collisions.length > 0) {
    const listed = collisions
      .slice(0, COLLISION_LIST_LIMIT)
      .map((c) => `  ${c.slug} (sources: ${c.sources.join(', ')})`);
    if (collisions.length > COLLISION_LIST_LIMIT) {
      listed.push(`  ... and ${collisions.length - COLLISION_LIST_LIMIT} more`);
    }
    const perSource = restoreOnly
      ? 'gbrain export --restore-only --source <id> --repo <that source\'s repo>'
      : 'gbrain export --source <id> --dir <a separate directory per source>';
    console.error(
      `Error: ${collisions.length} slug(s) exist in more than one source. Export writes each\n` +
        `page to <dir>/<slug>.md, so these pages would overwrite each other:\n` +
        `${listed.join('\n')}\n` +
        `Nothing was written. Export one source at a time into separate directories:\n` +
        `  ${perSource}`,
    );
    process.exit(1);
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
    // Slugs are unique per source, not brain-wide, so both sidecar reads are
    // pinned to the page's own source. Unscoped, `getTags` falls back to
    // `source_id = 'default'` and stamps the default source's tags onto a
    // same-slug page from another source (dropping its real ones).
    const tags = await engine.getTags(page.slug, { sourceId: page.source_id });
    // #3772: the file is written at <slug>.md and import re-derives the slug
    // from that path. When the stored slug is NOT a slugifyPath fixed point
    // (legacy/hand-keyed slugs with case, apostrophes, accents…), a re-import
    // would silently re-key the page — stamp the true identity into the
    // frontmatter so import can restore it (import accepts a frontmatter slug
    // whose slugified spelling equals the path-derived one). Fixed-point
    // slugs stay unstamped: no diff noise on the common path. A stale
    // frontmatter slug that contradicts the DB identity is corrected either way.
    const fmSlug = (page.frontmatter as Record<string, unknown> | null | undefined)?.['slug'];
    const needsSlugStamp = slugifyPath(page.slug + '.md') !== page.slug;
    const frontmatter = (needsSlugStamp || fmSlug !== undefined) && fmSlug !== page.slug
      ? { ...(page.frontmatter ?? {}), slug: page.slug }
      : page.frontmatter;
    const md = serializeMarkdown(
      frontmatter,
      page.compiled_truth,
      page.timeline,
      { type: page.type, title: page.title, tags },
    );

    // A page's identity is (source_id, slug); the path carries only the
    // slug. That is safe because the collision check above refused any
    // slug held by two sources in this page set.
    const filePath = join(outDir, page.slug + '.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, md);

    // Export raw data as sidecar JSON. Unscoped, this matches the slug in
    // EVERY source and the loop below merges the rows into one sidecar keyed
    // by `rd.source`, so another source's raw data silently overwrites this
    // page's own on a key collision.
    const rawData = await engine.getRawData(page.slug, undefined, {
      sourceId: page.source_id,
      includeDeleted: true, // the page list decides which rows export; raw follows its page
    });
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
