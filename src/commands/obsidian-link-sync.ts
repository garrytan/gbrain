import { existsSync, readFileSync } from 'fs';
import { relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  addSlugCollisionsToReport,
  buildVaultIndex,
  createEmptyObsidianReport,
  desiredLinksForFile,
  mergeLinkReconcileResult,
  OBSIDIAN_EMBED_TYPE,
  OBSIDIAN_LINK_TYPE,
  type ObsidianLinkReport,
} from '../core/obsidian-links.ts';
import { isSyncable } from '../core/sync.ts';
import { collectMarkdownFiles } from './import.ts';

export interface ObsidianLinkSyncOpts {
  repoPath: string;
  dryRun: boolean;
  json: boolean;
  strict: boolean;
}

function parseArgs(args: string[]): ObsidianLinkSyncOpts {
  const repoIdx = args.indexOf('--repo');
  const positionalRepo = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo');
  const repoValue = repoIdx !== -1 ? args[repoIdx + 1] : undefined;
  const repoPath = repoValue && !repoValue.startsWith('--') ? repoValue : positionalRepo;
  if (!repoPath) {
    throw new Error('Usage: gbrain obsidian-link-sync --repo <path> [--dry-run] [--json] [--strict]');
  }
  return {
    repoPath,
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    strict: args.includes('--strict'),
  };
}

export async function runObsidianLinkSync(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain obsidian-link-sync --repo <path> [--dry-run] [--json] [--strict]');
    console.log('\nMirror Obsidian wikilinks into typed gbrain graph links.');
    return;
  }

  const opts = parseArgs(args);
  const report = await performObsidianLinkSync(engine, opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, opts.dryRun);
  }

  if (
    report.slugCollisions.length > 0 ||
    (opts.strict && (
      report.unresolved.length > 0 ||
      report.ambiguous.length > 0 ||
      report.missingSources.length > 0 ||
      report.missingTargets.length > 0
    ))
  ) {
    process.exit(1);
  }
}

export async function performObsidianLinkSync(
  engine: BrainEngine,
  opts: ObsidianLinkSyncOpts,
): Promise<ObsidianLinkReport> {
  if (!existsSync(opts.repoPath)) {
    throw new Error(`Repo not found: ${opts.repoPath}`);
  }

  const files = collectMarkdownFiles(opts.repoPath);
  const relativePaths = files.map(file => relative(opts.repoPath, file)).filter(isSyncable);
  const index = buildVaultIndex(relativePaths);
  const report = createEmptyObsidianReport();
  addSlugCollisionsToReport(index, report);
  const existingPageSlugs = await engine.getExistingPageSlugs(index.entries.map(entry => entry.slug));

  {
    for (const filePath of files) {
      const relativePath = relative(opts.repoPath, filePath);
      if (!isSyncable(relativePath)) continue;
      const sourceSlug = index.entries.find(e => e.relativePath === relativePath)?.slug || '';
      if (index.collidingSlugs.has(sourceSlug)) continue;
      if (!existingPageSlugs.has(sourceSlug)) {
        report.missingSources.push(relativePath);
        report.filesScanned++;
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const desired = desiredLinksForFile(relativePath, content, index, report);
      for (const [linkType, links] of Array.from(desired.linksByType)) {
        const filtered = [];
        for (const link of links) {
          if (existingPageSlugs.has(link.to_slug)) {
            filtered.push(link);
          } else {
            report.missingTargets.push({ source: relativePath, target: link.context || link.to_slug, toSlug: link.to_slug });
          }
        }
        desired.linksByType.set(linkType, filtered);
      }

      if (opts.dryRun) {
        for (const linkType of [OBSIDIAN_LINK_TYPE, OBSIDIAN_EMBED_TYPE]) {
          const current = (await engine.getLinks(desired.sourceSlug)).filter(l => l.link_type === linkType);
          const desiredTargets = new Map((desired.linksByType.get(linkType) || []).map(l => [l.to_slug, l.context || '']));
          for (const link of current) {
            if (!desiredTargets.has(link.to_slug)) report.removed++;
            else if (desiredTargets.get(link.to_slug) === link.context) report.unchanged++;
            else report.updated++;
          }
          for (const target of desiredTargets.keys()) {
            if (!current.some(l => l.to_slug === target)) report.added++;
          }
        }
      } else {
        await engine.transaction(async (tx) => {
          for (const linkType of [OBSIDIAN_LINK_TYPE, OBSIDIAN_EMBED_TYPE]) {
            const result = await tx.reconcileLinksForPage(
              desired.sourceSlug,
              linkType,
              desired.linksByType.get(linkType) || [],
            );
            mergeLinkReconcileResult(report, result);
          }
        });
      }
    }
  }

  if (!opts.dryRun) {
    await engine.logIngest({
      source_type: 'obsidian_link_sync',
      source_ref: opts.repoPath,
      pages_updated: [],
      summary: `Obsidian links: +${report.added} ~${report.updated} -${report.removed}, unresolved ${report.unresolved.length}, ambiguous ${report.ambiguous.length}, file embeds ${report.fileEmbeds.length}`,
    });
  }

  return report;
}

function printReport(report: ObsidianLinkReport, dryRun: boolean): void {
  console.log(`Obsidian link sync ${dryRun ? 'dry run' : 'complete'}:`);
  console.log(`  Markdown files scanned: ${report.filesScanned}`);
  console.log(`  Wikilinks found: ${report.wikilinksFound}`);
  console.log(`  Resolved links: ${report.resolved}`);
  console.log(`  Unresolved links: ${report.unresolved.length}`);
  console.log(`  Ambiguous links: ${report.ambiguous.length}`);
  console.log(`  File embeds reported: ${report.fileEmbeds.length}`);
  console.log(`  Missing source pages: ${report.missingSources.length}`);
  console.log(`  Missing target pages: ${report.missingTargets.length}`);
  console.log(`  Links ${dryRun ? 'would be ' : ''}added: ${report.added}`);
  console.log(`  Links ${dryRun ? 'would be ' : ''}updated: ${report.updated}`);
  console.log(`  Links ${dryRun ? 'would be ' : ''}removed: ${report.removed}`);
  if (report.slugCollisions.length > 0) {
    console.log('\nSlug collisions:');
    for (const collision of report.slugCollisions) {
      console.log(`  ${collision.slug}: ${collision.paths.join(', ')}`);
    }
  }
  if (report.unresolved.length > 0) {
    console.log('\nUnresolved links:');
    for (const item of report.unresolved.slice(0, 20)) {
      console.log(`  ${item.source}: ${item.raw}`);
    }
  }
  if (report.ambiguous.length > 0) {
    console.log('\nAmbiguous links:');
    for (const item of report.ambiguous.slice(0, 20)) {
      console.log(`  ${item.source}: ${item.raw} -> ${item.candidates.join(', ')}`);
    }
  }
}
