import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadStorageConfig, isDbOnly } from '../core/storage-config.ts';
import { slugifyPath } from '../core/sync.ts';
import { resolveRestoreTarget, resolveSourceId, isResolverUserError } from '../core/source-resolver.ts';
import { ALL_SOURCES } from '../core/source-id.ts';
import { listAllPages } from '../core/list-all-pages.ts';
import type { Page, PageFilters, PageType } from '../core/types.ts';

/** How many colliding slugs the refusal lists before summarising the rest. */
const COLLISION_LIST_LIMIT = 20;

/**
 * Slugs held by more than one source in `pages`, grouped on the NFC,
 * lowercased spelling: APFS is case- and normalization-insensitive, so
 * `Notes/Foo` and `notes/foo`, or NFC and NFD `café`, land on one file.
 * Each group carries its sorted spellings and source ids; groups inside a
 * single source are left alone.
 */
function findCrossSourceSlugs(pages: Page[]): Array<{ slugs: string[]; sources: string[] }> {
  const groups = new Map<string, { slugs: Set<string>; sources: Set<string> }>();
  for (const p of pages) {
    const key = p.slug.normalize('NFC').toLowerCase();
    const group = groups.get(key) ?? { slugs: new Set<string>(), sources: new Set<string>() };
    group.slugs.add(p.slug);
    group.sources.add(p.source_id);
    groups.set(key, group);
  }
  return [...groups]
    .filter(([, g]) => g.sources.size > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({ slugs: [...g.slugs].sort(), sources: [...g.sources].sort() }));
}

/**
 * Every page lands at <dir>/<slug>.md, so pages from two sources sharing a
 * slug would overwrite each other. Refuse (exit 1) before anything is
 * written; a `<source>/` path prefix is no way out, since import would
 * re-key those pages under new slugs.
 */
async function refuseCrossSourceCollisions(engine: BrainEngine, pages: Page[], restoreOnly: boolean): Promise<void> {
  const collisions = findCrossSourceSlugs(pages);
  if (collisions.length === 0) return;
  const listed = collisions
    .slice(0, COLLISION_LIST_LIMIT)
    .map((c) => `  ${c.slugs.join(', ')} (sources: ${c.sources.join(', ')})`);
  if (collisions.length > COLLISION_LIST_LIMIT) {
    listed.push(`  ... and ${collisions.length - COLLISION_LIST_LIMIT} more`);
  }
  // Restore writes to --dir (default ./export), so restoring in place
  // names the source's repo for both --repo and --dir.
  const perSource = restoreOnly
    ? 'gbrain export --restore-only --source <id> --repo <that source\'s repo> --dir <that source\'s repo>'
    : 'gbrain export --source <id> --dir <a separate directory per source>';
  // --source refuses an archived source, so name the restore step first.
  const archived = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE archived = true AND id = ANY($1::text[]) ORDER BY id`,
    [[...new Set(collisions.flatMap((c) => c.sources))]],
  );
  const restoreHints = archived.map(
    (r) => `Source "${r.id}" is archived; run \`gbrain sources restore ${r.id}\` before exporting it.`,
  );
  console.error(
    `Error: ${collisions.length} slug(s) exist in more than one source. Export writes each\n` +
      `page to <dir>/<slug>.md, so these pages would overwrite each other:\n` +
      `${listed.join('\n')}\n` +
      `Nothing was written. Export one source at a time into separate directories:\n` +
      `  ${perSource}` +
      (restoreHints.length > 0 ? `\n${restoreHints.join('\n')}` : ''),
  );
  process.exit(1);
}

/**
 * Resolve `--source <id>` / `--source=<id>`. Only the explicit flag counts:
 * with none, export spans every source (the GBRAIN_SOURCE, dotfile and
 * default tiers do not narrow it), and `__all__` spans every source too.
 * Exits 1 on a missing, invalid, unknown or archived id.
 */
async function resolveExportSource(
  engine: BrainEngine,
  args: string[],
): Promise<{ sourceId: string | undefined; allSources: boolean }> {
  const idx = args.findIndex((arg) => arg === '--source' || arg.startsWith('--source='));
  if (idx === -1) return { sourceId: undefined, allSources: false };
  const requested = args[idx].startsWith('--source=') ? args[idx].slice('--source='.length) : args[idx + 1];
  if (!requested || requested.startsWith('--')) {
    console.error('Error: --source requires a source id. Run `gbrain sources list` to see registered sources.');
    process.exit(1);
  }
  try {
    const resolved = await resolveSourceId(engine, requested);
    return resolved === ALL_SOURCES
      ? { sourceId: undefined, allSources: true }
      : { sourceId: resolved, allSources: false };
  } catch (e) {
    if (!isResolverUserError(e)) throw e;
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
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

  const { sourceId, allSources: allSourcesRequested } = await resolveExportSource(engine, args);

  // For non-restore exports, repoPath stays null because regular export
  // doesn't need a brain repo to run.
  let repoPath: string | null = explicitRepoPath;
  let restoreSourceId: string | undefined;
  if (restoreOnly) {
    const target = await resolveRestoreTarget(engine, {
      repo: explicitRepoPath,
      source: allSourcesRequested ? ALL_SOURCES : sourceId,
    });
    if (!target.ok) {
      console.error(`Error: ${target.message}`);
      process.exit(1);
    }
    repoPath = target.repoPath;
    restoreSourceId = target.sourceId === ALL_SOURCES ? undefined : target.sourceId;
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
  
  // Engine-side filters; listAllPages reads the full matching set in batches.
  const filters: Omit<PageFilters, 'limit' | 'offset' | 'sort'> = {};
  if (typeFilter) filters.type = typeFilter as PageType;
  if (slugPrefix) filters.slugPrefix = slugPrefix;
  const scopeSourceId = restoreOnly ? restoreSourceId : sourceId;
  if (scopeSourceId) filters.sourceId = scopeSourceId;

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
      // With --slug-prefix, query the narrower of the prefix and the tier
      // dir; skip the tier when neither contains the other.
      const prefix = filters.slugPrefix;
      const tierPrefix = !prefix || dir.startsWith(prefix) ? dir : prefix.startsWith(dir) ? prefix : undefined;
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

  await refuseCrossSourceCollisions(engine, pages, restoreOnly);

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
