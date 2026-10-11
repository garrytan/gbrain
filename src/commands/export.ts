import { existsSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown, slugStampedFrontmatter } from '../core/markdown.ts';
import { scannerSlugRootMode } from '../core/write-through.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadStorageConfig, isDbOnly } from '../core/storage-config.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { ALL_SOURCES, assertValidSourceId } from '../core/source-id.ts';
import { resolveRestoreTarget, restoreFilePath } from '../core/restore-target.ts';
import { ExportStage, EXPORT_PAYLOAD_LIMIT, EXPORT_SNAPSHOT_MS, exportPathKey } from '../core/export-stage.ts';
import { publishExport } from '../core/export-publish.ts';
import { nativeFileTarget } from '../core/persistence/native-file-target.ts';
import { readExportPage, readExportWithdrawals } from '../core/export-snapshot.ts';

function option(args: string[], name: string): string | undefined {
  const indices = args.flatMap((arg, i) => arg === name || arg.startsWith(name + '=') ? [i] : []);
  if (!indices.length) return undefined;
  if (indices.length > 1) throw new Error(`${name} must be provided only once.`);
  const i = indices[0];
  const value = args[i].startsWith(name + '=') ? args[i].slice(name.length + 1) : args[i + 1];
  if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`${name} requires a value.`);
  return value;
}

export async function runExport(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain export [--dir <path>] [--source <id>] [--type <type>] [--slug-prefix <prefix>]
       gbrain export --restore-only [--source <id>] [--repo <path>] [--dir <path>] [--slug-prefix <prefix>]

Export a coherent point-in-time Markdown snapshot; this is not a database backup.
  --dir <path>           Output directory (default: ./export).
  --source <id>          Select one active source; omitted includes all sources.
  --type <type>          Select one page type.
  --slug-prefix <prefix> Select stored slugs beginning with this literal prefix.
  --restore-only        Export missing db_only files for one source.
  --repo <path>          Restore source's repository and storage config; output still goes to --dir.

Colliding planned paths and occupied output paths refuse; nothing is overwritten.
Existing empty directories and unrelated files are preserved. There is no force option.
The reserved .gbrain-export-status starts incomplete and ends with COMPLETE only
after successful publication. On failure, preserve partial output and retry into
a fresh directory. See docs/storage-tiering.md#safe-export.`);
    return;
  }
  let stage: ExportStage | undefined;
  try {
    const outDir = option(args, '--dir') ?? './export';
    const requested = option(args, '--source');
    const type = option(args, '--type');
    const prefix = option(args, '--slug-prefix');
    const explicitRepo = option(args, '--repo');
    const restoreOnly = args.includes('--restore-only');
    stage = new ExportStage();
    const staged = stage;
    const started = Date.now();
    const checkDeadline = () => {
      if (Date.now() - started > EXPORT_SNAPSHOT_MS) throw new Error('Export snapshot time limit reached. Select a smaller scope with --source, --type or --slug-prefix.');
    };
    await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.executeRaw('SET LOCAL statement_timeout = 60000');
      let source = requested ? await resolveSourceId(tx, requested) : undefined;
      let repo = explicitRepo;
      if (restoreOnly) ({ source, repo } = await resolveRestoreTarget(tx, source, repo));
      const storage = restoreOnly && repo ? loadStorageConfig(repo) : null;
      if (restoreOnly && !storage) throw new Error('--restore-only requires a storage tiering config (gbrain.yml with a storage section).');
      let cursor = '0';
      for (;;) {
        checkDeadline();
        const batch = await tx.executeRaw<{ id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number; raw_count: number; bytes: number }>(
          `SELECT p.id::text, left(p.slug,4097) AS slug, p.source_id, left(p.source_path,4097) AS source_path, octet_length(p.source_path) AS source_path_bytes,
            (SELECT count(*) FROM raw_data r WHERE r.page_id=p.id) AS raw_count,
            octet_length(p.compiled_truth)::bigint + octet_length(p.timeline) + octet_length(p.frontmatter::text)
              + octet_length(p.title) + octet_length(p.slug) + COALESCE(octet_length(p.source_path),0)
              + COALESCE((SELECT sum(octet_length(r.data::text)+octet_length(r.source)) FROM raw_data r WHERE r.page_id=p.id),0)
              + COALESCE((SELECT sum(octet_length(t.tag)) FROM tags t WHERE t.page_id=p.id),0) AS bytes
           FROM pages p WHERE p.id > $1::bigint AND p.deleted_at IS NULL
             AND ($2::text IS NULL OR p.source_id=$2) AND ($3::text IS NULL OR p.type=$3)
             AND ($4::text IS NULL OR starts_with(p.slug,$4)) ORDER BY p.id LIMIT 256`,
          [cursor, source === ALL_SOURCES ? null : source ?? null, type ?? null, prefix ?? null]);
        if (!batch.length) break;
        for (const batchSource of new Set(batch.map(key => key.source_id))) {
          checkDeadline();
          const withdrawals = await readExportWithdrawals(tx, batchSource);
          for (const key of batch.filter(key => key.source_id === batchSource)) {
            checkDeadline();
            assertValidSourceId(key.source_id);
            exportPathKey(key.slug + '.md');
            if (restoreOnly && storage && repo) {
              if (!isDbOnly(key.slug, storage)) continue;
              if (existsSync(nativeFileTarget(repo, restoreFilePath(repo, key.slug, key.source_path, Number(key.source_path_bytes), await scannerSlugRootMode(tx, batchSource, repo))))) continue;
            }
            if (Number(key.bytes) > EXPORT_PAYLOAD_LIMIT) throw new Error('Export page payload limit exceeded. No destination output was published.');
            const snapshot = await readExportPage(tx, key, withdrawals);
            const page = snapshot.page;
            // #5966: the slug stamp rule lives in slugStampedFrontmatter (markdown.ts), shared with every render.
            staged.add(page.slug + '.md', 'file', serializeMarkdown(slugStampedFrontmatter(page.slug, page.frontmatter ?? {}), page.compiled_truth, page.timeline,
              { type: page.type, title: page.title, tags: snapshot.tags }));
            const raw = Number(key.raw_count) ? await tx.getRawData(page.slug, undefined, { sourceId: page.source_id, includeDeleted: true }) : [];
            if (raw.length) {
              const parts = page.slug.split('/');
              const name = parts.pop()!;
              staged.add([...parts, '.raw', name + '.json'].join('/'), 'file', JSON.stringify(Object.fromEntries(raw.map(row => [row.source, row.data])), null, 2) + '\n');
            }
            staged.pages++;
          }
        }
        cursor = batch[batch.length - 1].id;
      }
      checkDeadline();
    });
    console.log(`${restoreOnly ? 'Restoring' : 'Exporting'} ${stage.pages}${restoreOnly ? ' db_only' : ''} pages to ${outDir}/`);
    const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
    progress.start('export.pages', stage.pages);
    await publishExport(stage, outDir, path => { if (path.endsWith('.md')) progress.tick(); });
    progress.finish();
    console.log(`${restoreOnly ? 'Restored' : 'Exported'} ${stage.pages} pages to ${outDir}/`);
  } catch (error) {
    console.error(`Error: Export failed: ${(error as Error).message}\nNo complete export was produced. If ${'.gbrain-export-status'} exists without a final COMPLETE line, the destination is incomplete. Preserve its files and retry into a fresh directory. See docs/storage-tiering.md#safe-export.`);
    if (stage) { stage.close(); stage = undefined; }
    process.exit(1);
  } finally { stage?.close(); }
}
