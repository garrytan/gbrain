import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { loadStorageConfig, validateStorageConfig, getStorageTier } from '../core/storage-config.ts';
import type { StorageConfig, StorageTier } from '../core/storage-config.ts';

interface StorageStatusResult {
  config: StorageConfig | null;
  repoPath: string | null;
  totalPages: number;
  pagesByTier: Record<StorageTier, number>;
  missingFiles: Array<{
    slug: string;
    expectedPath: string;
  }>;
  diskUsageByTier: Record<StorageTier, number>;
  warnings: string[];
}

export async function runStorage(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  
  if (!subcommand || subcommand === 'status') {
    await runStorageStatus(engine, args.slice(1));
  } else {
    console.error(`Unknown storage subcommand: ${subcommand}`);
    console.error('Available subcommands: status');
    process.exit(1);
  }
}

async function runStorageStatus(engine: BrainEngine, args: string[]) {
  // Try to determine repo path from args or sync configuration
  let repoPath: string | null = null;
  const repoIdx = args.indexOf('--repo');
  if (repoIdx !== -1 && args[repoIdx + 1]) {
    repoPath = args[repoIdx + 1];
  } else {
    // Try to get from sync configuration
    try {
      const sources = await engine.executeRaw<{local_path: string | null}>(
        `SELECT local_path FROM sources WHERE id = $1`,
        ['default']
      );
      if (sources[0]?.local_path) {
        repoPath = sources[0].local_path;
      }
    } catch {
      // Fall back to current directory if no sources configured
      repoPath = process.cwd();
    }
  }

  const result = await getStorageStatus(engine, repoPath);
  
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  
  // Human-readable output
  console.log('Storage Status');
  console.log('==============\n');
  
  if (!result.config) {
    console.log('No gbrain.yml configuration found.');
    if (result.repoPath) {
      console.log(`Checked: ${result.repoPath}/gbrain.yml`);
    }
    console.log('\nAll pages are stored in git by default.');
    console.log(`Total pages: ${result.totalPages}`);
    return;
  }
  
  console.log(`Repository: ${result.repoPath}`);
  console.log(`Total pages: ${result.totalPages}\n`);
  
  console.log('Storage Tiers:');
  console.log('-------------');
  console.log(`DB tracked:     ${result.pagesByTier.db_tracked.toLocaleString()} pages`);
  console.log(`DB only:        ${result.pagesByTier.db_only.toLocaleString()} pages`);
  console.log(`Unspecified:    ${result.pagesByTier.unspecified.toLocaleString()} pages`);

  if (result.diskUsageByTier.db_tracked > 0 || result.diskUsageByTier.db_only > 0) {
    console.log('\nDisk Usage:');
    console.log('-----------');
    if (result.diskUsageByTier.db_tracked > 0) {
      console.log(`DB tracked:     ${formatBytes(result.diskUsageByTier.db_tracked)}`);
    }
    if (result.diskUsageByTier.db_only > 0) {
      console.log(`DB only:        ${formatBytes(result.diskUsageByTier.db_only)}`);
    }
    if (result.diskUsageByTier.unspecified > 0) {
      console.log(`Unspecified:    ${formatBytes(result.diskUsageByTier.unspecified)}`);
    }
  }

  if (result.missingFiles.length > 0) {
    console.log('\nMissing Files (need restore):');
    console.log('-----------------------------');
    for (const missing of result.missingFiles.slice(0, 10)) {
      console.log(`  ${missing.slug}`);
    }
    if (result.missingFiles.length > 10) {
      console.log(`  ... and ${result.missingFiles.length - 10} more`);
    }
    console.log(`\nUse: gbrain export --restore-only --repo "${result.repoPath}"`);
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    console.log('---------');
    for (const warning of result.warnings) {
      console.log(`  ! ${warning}`);
    }
  }

  console.log('\nConfiguration:');
  console.log('--------------');
  console.log('DB tracked directories:');
  for (const dir of result.config.db_tracked) {
    console.log(`  - ${dir}`);
  }
  console.log('\nDB-only directories:');
  for (const dir of result.config.db_only) {
    console.log(`  - ${dir}`);
  }
}

async function getStorageStatus(engine: BrainEngine, repoPath: string | null): Promise<StorageStatusResult> {
  const config = repoPath ? loadStorageConfig(repoPath) : null;
  const warnings = config ? validateStorageConfig(config) : [];
  
  // Get all pages from database
  const pages = await engine.listPages({ limit: 1000000 });
  
  // Categorize pages by storage tier
  const pagesByTier: Record<StorageTier, number> = {
    db_tracked: 0,
    db_only: 0,
    unspecified: 0,
  };

  const diskUsageByTier: Record<StorageTier, number> = {
    db_tracked: 0,
    db_only: 0,
    unspecified: 0,
  };

  const missingFiles: Array<{ slug: string; expectedPath: string }> = [];

  for (const page of pages) {
    const tier = config ? getStorageTier(page.slug, config) : 'unspecified';
    pagesByTier[tier]++;

    // Check if file exists and calculate disk usage
    if (repoPath) {
      const filePath = join(repoPath, page.slug + '.md');
      if (existsSync(filePath)) {
        try {
          const stats = statSync(filePath);
          diskUsageByTier[tier] += stats.size;
        } catch {
          // Ignore errors reading file stats
        }
      } else if (config && tier === 'db_only') {
        // db-only file that's missing from disk — restore candidate
        missingFiles.push({
          slug: page.slug,
          expectedPath: filePath,
        });
      }
    }
  }
  
  return {
    config,
    repoPath,
    totalPages: pages.length,
    pagesByTier,
    missingFiles,
    diskUsageByTier,
    warnings
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}