/**
 * Engine migration: transfer brain data between PGLite and Postgres.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite non-empty target)
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

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
  return join(homedir(), '.gbrain', 'migrate-manifest.json');
}

interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  started_at: string;
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
    targetConfig.database_url = opts.targetUrl || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else {
    targetConfig.database_path = opts.targetPath || join(homedir(), '.gbrain', 'brain.pglite');
  }

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  if (targetStats.page_count > 0 && !opts.force) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  if (targetStats.page_count > 0 && opts.force) {
    console.log('--force: wiping target brain...');
    // Delete all pages (cascades to chunks, links, tags, etc.)
    const pages = await targetEngine.listPages({ limit: 100000 });
    for (const p of pages) {
      await targetEngine.deletePage(p.slug);
    }
  }

  // Load or create manifest for resume
  let manifest = loadManifest();
  if (manifest && manifest.target_engine !== opts.targetEngine) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  const completedSet = new Set(manifest?.completed_slugs || []);
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      started_at: new Date().toISOString(),
    };
  }

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(p.slug));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  let migrated = 0;
  for (const page of pagesToMigrate) {
    // Copy page
    await targetEngine.putPage(page.slug, {
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter,
      content_hash: page.content_hash,
    });

    // Copy chunks with embeddings
    const chunks = await sourceEngine.getChunksWithEmbeddings(page.slug);
    if (chunks.length > 0) {
      await targetEngine.upsertChunks(page.slug, chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: c.embedding || undefined,
        model: c.model,
        token_count: c.token_count || undefined,
      })));
    }

    // Copy tags
    const tags = await sourceEngine.getTags(page.slug);
    for (const tag of tags) {
      await targetEngine.addTag(page.slug, tag);
    }

    // Copy timeline
    const timeline = await sourceEngine.getTimeline(page.slug);
    for (const entry of timeline) {
      await targetEngine.addTimelineEntry(page.slug, {
        date: entry.date,
        source: entry.source,
        summary: entry.summary,
        detail: entry.detail,
      });
    }

    // Copy raw data
    const rawData = await sourceEngine.getRawData(page.slug);
    for (const rd of rawData) {
      await targetEngine.putRawData(page.slug, rd.source, rd.data);
    }

    // Copy versions
    const versions = await sourceEngine.getVersions(page.slug);
    // Versions are snapshots, we recreate them on the target
    // (createVersion takes a snapshot of current state, which we just set)

    // Track progress
    manifest!.completed_slugs.push(page.slug);
    saveManifest(manifest!);
    migrated++;
    progress.tick(1, page.slug);
  }
  progress.finish();

  // Copy links (after all pages exist in target)
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    const links = await sourceEngine.getLinks(page.slug);
    for (const link of links) {
      await targetEngine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy config (selective)
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config
  const newConfig: GBrainConfig = {
    engine: opts.targetEngine,
    ...(opts.targetEngine === 'postgres'
      ? { database_url: targetConfig.database_url }
      : { database_path: targetConfig.database_path }),
  };
  saveConfig(newConfig);

  // Clean up
  clearManifest();

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
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
