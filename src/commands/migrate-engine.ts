/**
 * Engine migration: prepare legacy data for the Postgres target runtime.
 *
 * Usage:
 *   mbrain migrate --to postgres [--url <connection_string>]  # Markdown-first guide, no DB page copy
 *   mbrain migrate --to supabase [--url <connection_string>]  # Markdown-first guide, no DB page copy
 *   mbrain migrate --to pglite [--path <db_path>]             # legacy test/escape hatch DB copy
 */

import { createEngine } from '../core/engine-factory.ts';
import { configDir, loadConfig, saveConfig, type MBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
}

export interface PostgresRuntimeMigrationGuideInput {
  target: 'postgres' | 'supabase' | 'pglite';
  source: string;
  sourcePageCount: number;
  migratedPageCount: number;
  contentHashMismatches: number;
  legacyDbOnlyRecords: number;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error('Usage: mbrain migrate --to <postgres|supabase> [--url <url>] [--force] (legacy: --to pglite --path <path>)');
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine = targetRaw === 'supabase' ? 'postgres' : targetRaw as 'postgres' | 'pglite';
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: postgres or supabase (legacy: pglite)`);
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
  return join(configDir(), 'migrate-manifest.json');
}

interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  target_identity?: string;
  source_identity?: string;
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
  const path = getManifestPath();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: mbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  const sourceIdentity = migrationConfigIdentity(config);

  console.log(formatPostgresRuntimeMigrationPreflight({
    target: opts.targetEngine,
    source: config.engine,
    force: opts.force,
  }));

  if (opts.targetEngine === 'postgres') {
    const sourceStats = typeof (sourceEngine as Partial<BrainEngine>).getStats === 'function'
      ? await sourceEngine.getStats().catch(() => null)
      : null;
    const legacyDbOnlyRecords = await countLegacyDbOnlyRecordsForReview(sourceEngine);
    console.log(formatPostgresRuntimeMigrationGuide({
      target: 'postgres',
      source: config.engine,
      sourcePageCount: sourceStats?.page_count ?? 0,
      migratedPageCount: 0,
      contentHashMismatches: 0,
      legacyDbOnlyRecords,
    }));
    console.error('Postgres target migration is Markdown-first and reconciler-gated.');
    console.error('This command does not copy legacy DB pages directly into the Postgres target.');
    console.error('Run Markdown source ingest/sync, projection reconciler, eval/replay smoke, and doctor before switching config.');
    console.error('Legacy DB-only state remains manual-review material, not automatic canonical memory.');
    process.exit(1);
  }

  // Build target config. The only executable DB-copy path left is the legacy
  // PGLite escape hatch above; Postgres target migration is guide-only until
  // Markdown ingest/reconciler gates can be enforced in-process.
  const targetConfig: EngineConfig = {
    engine: opts.targetEngine,
    database_path: opts.targetPath || join(homedir(), '.mbrain', 'brain.pglite'),
  };
  const targetIdentity = migrationConfigIdentity(targetConfig);

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Load or create manifest before target non-empty checks so interrupted
  // migrations can resume into the partially populated target they created.
  let manifest = loadManifest();
  if (manifest && manifest.target_engine !== opts.targetEngine) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  if (manifest && (
    manifest.target_identity !== targetIdentity
    || manifest.source_identity !== sourceIdentity
  )) {
    console.log('Previous migration manifest was for a different source or target. Starting fresh.');
    manifest = null;
  }

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  const targetLegacyDbOnlyRecords = await countLegacyDbOnlyRecordsForReview(targetEngine);
  if (targetLegacyDbOnlyRecords > 0) {
    console.error(`Target brain has ${targetLegacyDbOnlyRecords} DB-only runtime records.`);
    console.error('Migrate into an empty target or manually review and clean the target runtime state first.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  if (targetStats.page_count > 0 && !opts.force && !manifest) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  let targetPagesBefore = targetStats.page_count > 0
    ? await targetEngine.listPages({ limit: 100000 })
    : [];
  if (targetStats.page_count > 0 && opts.force) {
    console.log('--force: wiping target brain...');
    // Delete all pages (cascades to chunks, links, tags, etc.)
    for (const p of targetPagesBefore) {
      await targetEngine.deletePage(p.slug);
    }
    targetPagesBefore = [];
    manifest = null;
  }

  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      target_identity: targetIdentity,
      source_identity: sourceIdentity,
      started_at: new Date().toISOString(),
    };
  }
  const existingTargetSlugs = new Set(targetPagesBefore.map((page) => page.slug));
  const completedSlugs = manifest.completed_slugs.filter((slug) => existingTargetSlugs.has(slug));
  if (completedSlugs.length !== manifest.completed_slugs.length) {
    manifest.completed_slugs = completedSlugs;
    saveManifest(manifest);
  }
  const completedSet = new Set(completedSlugs);

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const sourcePageEmbeddings = new Map(
    (await sourceEngine.getPageEmbeddings()).map((entry) => [entry.slug, entry.embedding] as const),
  );
  const pagesToMigrate = allPages.filter(p => !completedSet.has(p.slug));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

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
    await targetEngine.updatePageEmbedding(
      page.slug,
      sourcePageEmbeddings.get(page.slug) ?? null,
    );

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

    if (migrated % 50 === 0 || migrated === pagesToMigrate.length) {
      console.log(`  Progress: ${migrated}/${pagesToMigrate.length} pages`);
    }
  }

  // Copy links (after all pages exist in target)
  console.log('Copying links...');
  for (const page of allPages) {
    const links = await sourceEngine.getLinks(page.slug);
    for (const link of links) {
      await targetEngine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
    }
  }

  // Copy config (selective)
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  const targetStatsAfter = await targetEngine.getStats();
  const targetPages = await targetEngine.listPages({ limit: 100000 });
  const targetContentHashes = new Map(targetPages.map((page) => [page.slug, page.content_hash] as const));
  const contentHashMismatches = allPages.filter((page) => (
    page.content_hash !== undefined && targetContentHashes.get(page.slug) !== page.content_hash
  )).length;
  const legacyDbOnlyRecords = await countLegacyDbOnlyRecordsForReview(sourceEngine);
  const migrationGuide = formatPostgresRuntimeMigrationGuide({
    target: opts.targetEngine,
    source: config.engine,
    sourcePageCount: sourceStats.page_count,
    migratedPageCount: targetStatsAfter.page_count,
    contentHashMismatches,
    legacyDbOnlyRecords,
  });

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(migrationGuide);

  if (targetStatsAfter.page_count !== sourceStats.page_count || contentHashMismatches > 0) {
    console.error('Migration verification failed. Review counts and hashes before using the target runtime.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  // Update local config
  const newConfig: MBrainConfig = {
    engine: opts.targetEngine,
    database_url: targetConfig.database_url,
    database_path: targetConfig.database_path,
    offline: false,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  };
  saveConfig(newConfig);

  // Clean up
  clearManifest();
  await targetEngine.disconnect();

  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }
}

export function formatPostgresRuntimeMigrationGuide(input: PostgresRuntimeMigrationGuideInput): string {
  const countsVerified = input.sourcePageCount > 0
    ? input.migratedPageCount === input.sourcePageCount
    : input.migratedPageCount === 0;
  const countLine = countsVerified
    ? `Counts verified: ${input.migratedPageCount}/${input.sourcePageCount} pages`
    : `Counts pending: ${input.migratedPageCount}/${input.sourcePageCount} pages`;
  const hashLine = countsVerified && input.contentHashMismatches === 0
    ? 'Content hashes verified'
    : input.contentHashMismatches === 0
      ? 'Content hash verification pending until Markdown import and projection reconciliation run'
      : `Content hash mismatches: ${input.contentHashMismatches}`;
  const title = input.target === 'pglite'
    ? 'Legacy DB Copy Migration Checklist'
    : 'Postgres Runtime Migration Checklist';
  return [
    '',
    title,
    '='.repeat(title.length),
    `Source engine: ${input.source}`,
    `Target engine: ${input.target}`,
    countLine,
    hashLine,
    `legacy DB-only records require manual review: ${input.legacyDbOnlyRecords}`,
    'Direct legacy DB page copy is not a Postgres activation path.',
    '',
    'Next steps:',
    '1. Back up the current brain repo and source database before cleanup.',
    '2. Export current Markdown brain: mbrain export --dir <backup/markdown-export>.',
    '3. Initialize Postgres: mbrain init --profile homebrew-postgres --non-interactive or mbrain init --url <connection_string> --non-interactive.',
    '4. Import exported Markdown through source ingest: mbrain import <backup/markdown-export> --no-embed.',
    '5. Manually review legacy DB-only candidates, profile memory, tasks, sessions, and mutation records before deciding what to import.',
    '6. No one-shot assertion rebuild command exists yet; keep DB-only claims manual until a governed rebuild command lands.',
    '7. Inspect projection lineage before accepting drift repair: mbrain projection-explain --target-type page --target-id <slug>.',
    '8. Run deterministic eval/replay smoke: bun run test:phase13.',
    '9. Run doctor after migration checks: mbrain doctor --json.',
    '10. Enable autopilot through onboarding when the doctor report is clean.',
  ].join('\n');
}

function formatPostgresRuntimeMigrationPreflight(input: {
  target: 'postgres' | 'pglite';
  source: string;
  force: boolean;
}): string {
  const forceLine = input.force
    ? 'WARNING: --force may wipe target pages; confirm backups before continuing.'
    : 'No target wipe requested.';
  const targetBoundary = input.target === 'postgres'
    ? 'For the Postgres target runtime, migrate canonical Markdown through source ingest/sync and projection reconciler.'
    : 'The PGLite path is a legacy DB-copy test/escape hatch, not a Postgres activation path.';
  const configBoundary = input.target === 'postgres'
    ? 'Do not switch config until projection reconciliation, eval/replay smoke, and doctor pass.'
    : 'Use this legacy path only when you intentionally want a PGLite compatibility target.';
  return [
    '',
    'Preflight safety checklist',
    '==========================',
    `Source engine: ${input.source}`,
    `Target engine: ${input.target}`,
    'Back up the current brain repo and source database before migration mutations.',
    'Export the current Markdown brain before migration mutations.',
    targetBoundary,
    'Review DB-only legacy records manually; do not promote them by direct DB page copy.',
    configBoundary,
    forceLine,
    '',
  ].join('\n');
}

function migrationConfigIdentity(config: Pick<EngineConfig, 'engine' | 'database_url' | 'database_path'>): string {
  if (config.engine === 'postgres') {
    return `postgres:${redactDatabaseUrlForManifest(config.database_url ?? '')}`;
  }
  return `${config.engine}:${config.database_path ?? ''}`;
}

function redactDatabaseUrlForManifest(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/@\s]+):[^@\s]+@/g, '://$1:[redacted]@');
  }
}

async function countLegacyDbOnlyRecordsForReview(engine: BrainEngine): Promise<number> {
  const counts = await Promise.all([
    countList(() => engine.getIngestLog({ limit: 100000 })),
    countList(() => engine.listTaskThreads()),
    countList(() => engine.listProfileMemoryEntries()),
    countList(() => engine.listPersonalEpisodeEntries()),
    countList(() => engine.listMemoryCandidateEntries()),
    countList(() => engine.listMemoryMutationEvents()),
    countList(() => engine.listMemoryRealms()),
    countList(() => engine.listMemorySessions()),
    countList(() => engine.listMemoryRedactionPlans()),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}

async function countList(list: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await list()).length;
  } catch {
    return 0;
  }
}
