/**
 * Engine migration: transfer brain data between PGLite and Postgres.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite non-empty target)
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, gbrainPath, effectiveEnvDatabaseUrl, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig, Page } from '../core/types.ts';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error('Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] [--force]');
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine = targetRaw === 'supabase' ? 'postgres' : targetRaw as 'postgres' | 'pglite';
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: supabase or pglite`);
  }

  const urlIdx = args.indexOf('--url');
  const pathIdx = args.indexOf('--path');

  return {
    targetEngine,
    targetUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    targetPath: pathIdx !== -1 ? args[pathIdx + 1] : undefined,
    force: args.includes('--force'),
  };
}

function getManifestPath(): string {
  return gbrainPath('migrate-manifest.json');
}

export interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  target_id?: string;
  schema_version?: number;
  started_at: string;
}

export function migrationTargetId(config: EngineConfig): string {
  const locator = config.engine === 'postgres'
    ? config.database_url ?? ''
    : resolve(config.database_path ?? gbrainPath('brain.pglite'));
  return createHash('sha256')
    .update(JSON.stringify([config.engine, locator]))
    .digest('hex');
}

export function manifestMatchesTarget(manifest: MigrateManifest, targetId: string): boolean {
  return manifest.schema_version === 2 && manifest.target_id === targetId;
}

function loadManifest(): MigrateManifest | null {
  const path = getManifestPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveManifest(manifest: MigrateManifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

interface MigratedSourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | string | null;
  config_json: string;
  archived: boolean;
  archived_at: Date | string | null;
  archive_expires_at: Date | string | null;
  contextual_retrieval_mode: string | null;
  trust_frontmatter_overrides: boolean;
  newest_content_at: Date | string | null;
  created_at: Date | string;
}

export async function copyMigrationSources(source: BrainEngine, target: BrainEngine): Promise<void> {
  const sources = await source.executeRaw<MigratedSourceRow>(`
    SELECT id, name, local_path, last_commit, last_sync_at, config::text AS config_json, archived,
           archived_at, archive_expires_at, contextual_retrieval_mode,
           trust_frontmatter_overrides, newest_content_at, created_at
      FROM sources
     ORDER BY (id = 'default') DESC, id`);

  for (const row of sources) {
    await target.executeRaw(`
      INSERT INTO sources
        (id, name, local_path, last_commit, last_sync_at, config, archived,
         archived_at, archive_expires_at, contextual_retrieval_mode,
         trust_frontmatter_overrides, newest_content_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        local_path = EXCLUDED.local_path,
        last_commit = EXCLUDED.last_commit,
        last_sync_at = EXCLUDED.last_sync_at,
        config = EXCLUDED.config,
        archived = EXCLUDED.archived,
        archived_at = EXCLUDED.archived_at,
        archive_expires_at = EXCLUDED.archive_expires_at,
        contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode,
        trust_frontmatter_overrides = EXCLUDED.trust_frontmatter_overrides,
        newest_content_at = EXCLUDED.newest_content_at,
        created_at = EXCLUDED.created_at`, [
      row.id, row.name, row.local_path, row.last_commit, row.last_sync_at,
      row.config_json, row.archived, row.archived_at, row.archive_expires_at,
      row.contextual_retrieval_mode, row.trust_frontmatter_overrides,
      row.newest_content_at, row.created_at,
    ]);
  }
}

/**
 * postgres.js's UNDEFINED_VALUE guard rejects any bound parameter that is JS
 * `undefined` — unlike PGLite, it will not silently treat it as SQL NULL.
 * A page read back from a PGLite source can carry `undefined` for a column
 * that is legitimately empty/NULL (a read-side driver-shape difference, not
 * a data problem), and passing that value straight into a Postgres
 * `putPage` throws mid-insert (#3194). Normalizing at this migrate-only
 * boundary — rather than inside `putPage` itself, which many non-migrate
 * callers also use — turns that driver-shape difference into an explicit
 * SQL NULL, so only a genuine NOT-NULL constraint violation (an actual data
 * problem) still surfaces as a page-copy failure.
 */
function nullifyUndefinedColumns<T extends Record<string, unknown>>(row: T): T {
  const normalized = { ...row };
  for (const key of Object.keys(normalized) as (keyof T)[]) {
    if (normalized[key] === undefined) normalized[key] = null as T[typeof key];
  }
  return normalized;
}

/**
 * Copy one page's full row (page body, chunks, tags, timeline, raw data)
 * from source to target. Throws on any failure — the caller (the per-page
 * loop in runMigrateEngine) decides how to account for that: track it as a
 * failed page and keep going, rather than letting one bad row silently
 * disappear from the progress count (#3194). Exported so unit tests can
 * inject fake engines and exercise the failure path without a live
 * DATABASE_URL.
 */
export async function copyPageToTarget(
  source: BrainEngine,
  target: BrainEngine,
  page: Page,
): Promise<void> {
  const sourceOpts = { sourceId: page.source_id };

  // Copy page (preserve source_id). v0.32.8 F8: thread source_id end-to-end
  // so multi-source pages migrate intact.
  await target.putPage(page.slug, nullifyUndefinedColumns({
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
    content_hash: page.content_hash,
  }), sourceOpts);

  // Copy chunks with embeddings.
  const chunks = await source.getChunksWithEmbeddings(page.slug, sourceOpts);
  if (chunks.length > 0) {
    await target.upsertChunks(page.slug, chunks.map(c => ({
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      chunk_source: c.chunk_source,
      embedding: c.embedding || undefined,
      model: c.model,
      token_count: c.token_count || undefined,
    })), sourceOpts);
  }

  // Copy tags
  const tags = await source.getTags(page.slug, sourceOpts);
  for (const tag of tags) {
    await target.addTag(page.slug, tag, sourceOpts);
  }

  // Copy timeline
  const timeline = await source.getTimeline(page.slug, sourceOpts);
  for (const entry of timeline) {
    await target.addTimelineEntry(page.slug, {
      date: entry.date,
      source: entry.source,
      summary: entry.summary,
      detail: entry.detail,
    }, sourceOpts);
  }

  // Copy raw data
  const rawData = await source.getRawData(page.slug, undefined, sourceOpts);
  for (const rd of rawData) {
    await target.putRawData(page.slug, rd.source, rd.data, sourceOpts);
  }
}

/** A page that failed to copy during migrate — tracked so the run's final
 * summary reports it honestly instead of letting the "N copied" counter
 * imply every page landed (#3194). */
export interface MigratePageFailure {
  source_id: string;
  slug: string;
  reason: string;
}

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  // Build target config
  const targetConfig: EngineConfig = { engine: opts.targetEngine };
  if (opts.targetEngine === 'postgres') {
    // #427 guard: don't let a cwd-.env DATABASE_URL become a migration target.
    targetConfig.database_url = opts.targetUrl || effectiveEnvDatabaseUrl();
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else {
    targetConfig.database_path = opts.targetPath || gbrainPath('brain.pglite');
  }
  const targetId = migrationTargetId(targetConfig);

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Load or create manifest for resume. Checked BEFORE the non-empty-target
  // guard below: a manifest matching this exact target means the target's
  // existing rows came from OUR OWN in-progress migration (#3194's per-page
  // failures now leave the target non-empty by design instead of crashing),
  // so a resume must not be treated as "attempting to migrate into a
  // foreign non-empty brain".
  let manifest = loadManifest();
  if (manifest && !manifestMatchesTarget(manifest, targetId)) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  const resumingMatchingManifest = manifest !== null;

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  if (opts.force) {
    if (targetStats.page_count > 0) {
      console.log('--force: wiping target brain...');
      // v0.18.0+ multi-source: deletePage(slug) is now source-scoped (defaults
      // to 'default'), so per-page iteration would skip non-default-source
      // rows. migrate-engine --force is a destructive wipe across the entire
      // brain — all sources, all pages — so we issue a raw DELETE that matches
      // the original semantic. Cascades through content_chunks / page_links /
      // tags / timeline_entries / page_versions via existing FKs.
      await targetEngine.executeRaw('DELETE FROM pages');
    }
    // --force always starts this exact migration fresh against this target:
    // a manifest tracking a previous attempt must not be trusted to skip
    // pages, regardless of whether the target LOOKED non-empty just now
    // (e.g. the target DB file was recreated out-of-band but
    // ~/.gbrain/migrate-manifest.json survived) — round 2 of #3194.
    manifest = null;
  } else if (targetStats.page_count > 0 && !resumingMatchingManifest) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  } else if (targetStats.page_count > 0 && resumingMatchingManifest) {
    console.log(`Resuming previous migration: ${manifest!.completed_slugs.length} page(s) already copied.`);
  }

  // v0.32.8 F8: manifest keys are now `${source_id}::${slug}` so multi-source
  // migrations don't collide on same-slug-different-source pages. Pre-v0.32.8
  // entries were bare slugs; we keep treating those as default-source for
  // back-compat resume.
  const completedSet = new Set(manifest?.completed_slugs || []);
  const makeManifestKey = (sourceId: string, slug: string): string =>
    sourceId === 'default' ? slug : `${sourceId}::${slug}`;
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      target_id: targetId,
      schema_version: 2,
      started_at: new Date().toISOString(),
    };
  }
  // Persist immediately, before any page copy runs. Otherwise a run where
  // EVERY page fails after its putPage lands (but before completed_slugs
  // ever gets a successful entry) leaves the target non-empty with no
  // manifest file on disk at all — the next invocation can't tell this
  // was a resumable in-progress migration and hits the non-empty guard
  // above requiring --force (round 2 of #3194).
  saveManifest(manifest);

  // Pages.source_id is a foreign key. Copy the complete source catalog first,
  // including archived rows and sync/routing metadata, so every page write has
  // a valid parent and the target preserves source behavior.
  await copyMigrationSources(sourceEngine, targetEngine);

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(makeManifestKey(p.source_id, p.slug)));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  // v0.32.8 F8: thread source_id end-to-end so multi-source pages migrate
  // intact. Pre-fix: putPage / getTags / getTimeline / getRawData / getLinks
  // all silently defaulted to source_id='default', so non-default-source
  // tags / timeline / raw / links were either dropped or attached to the
  // wrong row.
  let migrated = 0;
  const failures: MigratePageFailure[] = [];
  for (const page of pagesToMigrate) {
    try {
      await copyPageToTarget(sourceEngine, targetEngine, page);
      // Track progress with composite key so multi-source resume is correct.
      manifest!.completed_slugs.push(makeManifestKey(page.source_id, page.slug));
      saveManifest(manifest!);
      migrated++;
    } catch (e) {
      // #3194: a per-page write failure must never be swallowed into the
      // success count. Leave it OUT of completed_slugs (a resume retries
      // it — putPage/upsertChunks/etc. are all upserts, so re-running the
      // whole page copy is safe) and surface it in the final summary below
      // instead of letting "N pages copied" imply everything landed.
      failures.push({
        source_id: page.source_id,
        slug: page.slug,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    progress.tick(1, page.slug);
  }
  progress.finish();

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${pagesToMigrate.length} page(s) FAILED to copy and were NOT migrated:`);
    for (const f of failures) {
      const key = f.source_id === 'default' ? f.slug : `${f.source_id}::${f.slug}`;
      console.error(`  - ${key}: ${f.reason}`);
    }
    console.error('Re-run `gbrain migrate` to retry the failed pages (already-copied pages resume via the manifest).');
    // Non-fatal so the run still copies links + config for everything that
    // DID land, but the process must exit non-zero — a partial migration
    // must never look identical to a clean one.
    setCliExitVerdict(1);
  }

  // Copy links (after all pages exist in target).
  // v0.32.8 F8: thread source_id so cross-source links migrate correctly.
  // #3194: a page that failed to copy above does NOT exist on the target,
  // so any link touching it would violate the target's FK and abort this
  // whole phase (the exact "addLink failed: page ... not found" crash from
  // the original report). Skip links on either end of a known-failed page —
  // a retry that successfully copies the page also re-copies its links.
  const failedKeys = new Set(failures.map(f => makeManifestKey(f.source_id, f.slug)));
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    if (failedKeys.has(makeManifestKey(page.source_id, page.slug))) {
      progress.tick(1);
      continue;
    }
    const sourceOpts = { sourceId: page.source_id };
    const links = await sourceEngine.getLinks(page.slug, sourceOpts);
    for (const link of links) {
      if (failedKeys.has(makeManifestKey(page.source_id, link.to_slug))) continue;
      await targetEngine.addLink(
        link.from_slug, link.to_slug,
        link.context, link.link_type,
        undefined, undefined, undefined,
        { fromSourceId: page.source_id, toSourceId: page.source_id },
      );
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy config (selective).
  //
  // v0.37 fix wave Lane C.4: these DB-plane writes are SCHEMA METADATA for
  // the target engine — they record "the schema was sized using this
  // embedding model + dimension." They are NOT the runtime gateway config
  // (which lives in the file plane via `~/.gbrain/config.json`). When this
  // function copies them, it's preserving the schema-applied state across
  // the migration, not re-pointing the gateway. The newConfig below
  // doesn't carry these fields because the user's existing file config
  // already has them (or didn't, in which case the file plane should stay
  // unset and re-read from gateway defaults).
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config. v0.37 fix wave: preserve existing file-plane
  // embedding/expansion/chat config across the engine migration; only
  // the engine + connection target should change.
  //
  // #3194: only flip the ACTIVE config when the migration is fully clean.
  // A partial migration leaves the target's data incomplete; auto-switching
  // every subsequent `gbrain` invocation onto that incomplete target would
  // (a) make the failure invisible behind otherwise-normal usage and (b)
  // break the natural retry — `gbrain migrate --to X` again would hit the
  // "Already using X engine" guard even though the migration never actually
  // finished. Leaving the file-plane config untouched keeps the source the
  // active engine, so a retry (which resumes via the still-intact manifest)
  // is a same-shaped command, not a special case.
  if (failures.length === 0) {
    const existingFile = (await import('../core/config.ts')).loadConfigFileOnly() ?? ({} as GBrainConfig);
    const newConfig: GBrainConfig = {
      ...existingFile,
      engine: opts.targetEngine,
      ...(opts.targetEngine === 'postgres'
        ? { database_url: targetConfig.database_url, database_path: undefined }
        : { database_path: targetConfig.database_path, database_url: undefined }),
    };
    saveConfig(newConfig);
    // Clean up the resume manifest — only safe once nothing is left pending.
    clearManifest();
  }

  if (failures.length > 0) {
    console.log(`\nMigration completed with errors. ${migrated} of ${pagesToMigrate.length} pages copied, ${failures.length} failed (${completedSet.size} already done from a prior run). See failure list above.`);
    console.log(`Config NOT switched — still using engine: ${config.engine}. Re-run \`gbrain migrate --to ${opts.targetEngine}\` to retry; already-copied pages resume via the manifest.`);
  } else {
    console.log(`\nMigration complete. ${migrated} pages transferred.`);
    console.log(`Config updated to engine: ${opts.targetEngine}`);
  }
  if (failures.length === 0 && config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }

  // Post-migrate verification: confirm the target is healthy before we
  // leave the user. Catches incomplete copies, schema drift, and missing
  // embeddings immediately instead of on next CLI use. Non-fatal — prints
  // warnings and keeps going so the user sees the full picture.
  console.log('\nVerifying target...');
  try {
    await verifyTarget(targetEngine, sourceStats.page_count);
  } catch (e) {
    console.warn(`  Verification could not complete: ${e instanceof Error ? e.message : String(e)}`);
  }

  await targetEngine.disconnect();
}

/**
 * Lightweight doctor-style verify run against the migrated target.
 * Prints a small table of signals; does not exit. Callers own engine
 * lifecycle.
 */
async function verifyTarget(engine: BrainEngine, expectedPages: number): Promise<void> {
  const stats = await engine.getStats();
  if (stats.page_count === expectedPages) {
    console.log(`  ok  pages: ${stats.page_count} (matches source)`);
  } else {
    console.warn(`  WARN pages: ${stats.page_count} (source had ${expectedPages})`);
  }

  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      console.log(`  ok  embeddings: ${pct}% coverage, ${health.missing_embeddings} missing`);
    } else {
      console.warn(`  WARN embeddings: ${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale`);
    }
  } catch (e) {
    console.warn(`  WARN embeddings: could not measure (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    const version = await engine.getConfig('version');
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      console.log(`  ok  schema: version ${schemaVersion}`);
    } else {
      console.warn(`  WARN schema: version ${schemaVersion} (latest: ${LATEST_VERSION}). Run: gbrain apply-migrations --yes`);
    }
  } catch {
    console.warn('  WARN schema: version could not be read');
  }

  console.log('  Full health check: gbrain doctor');
}
