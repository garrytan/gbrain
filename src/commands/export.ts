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
import { ExportPathCollision, ExportStage, EXPORT_PAYLOAD_LIMIT, EXPORT_SNAPSHOT_MS, EXPORT_STREAM_BYTES_PER_MS, exportPagePath, exportPayloadLimit } from '../core/export-stage.ts';
import { slugPortabilityProblem } from '../core/portable-slug.ts';
import { publishExport } from '../core/export-publish.ts';
import { nativeFileTarget } from '../core/persistence/native-file-target.ts';
import { exportBodyLedger, readExportPage, readExportWithdrawals, segmentedExportMarkdown } from '../core/export-snapshot.ts';
import { segmentedPageCeiling } from '../core/page-body/limits.ts';
import { isSegmentedPage } from '../core/page-body/page-shape.ts';

function option(args: string[], name: string): string | undefined {
  const indices = args.flatMap((arg, i) => arg === name || arg.startsWith(name + '=') ? [i] : []);
  if (!indices.length) return undefined;
  if (indices.length > 1) throw new Error(`${name} must be provided only once.`);
  const i = indices[0];
  const value = args[i].startsWith(name + '=') ? args[i].slice(name.length + 1) : args[i + 1];
  if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`${name} requires a value.`);
  return value;
}

/** A page exported under an escaped file name (GBRA-130 B-5): its slug is not a portable file name. */
export interface EscapedExportPage {
  source_id: string;
  slug: string;
  /** The file written, relative to --dir; its `slug:` stamp names the slug. */
  path: string;
  /** `unportable_slug`: import restores the slug from the escaped name. `segment_too_long`: the name was shortened and import refuses the file. */
  reason: 'unportable_slug' | 'segment_too_long';
  restorable: boolean;
  /** For a shortened page, how to move it to a portable slug; null when import restores it. */
  fix: { argv: string[] } | null;
}

export interface ExportReport { pages: number; escaped: EscapedExportPage[] }

interface ExportCollision { key: string; path: string; prior: string; source_id: string; slug: string }

/** One refusal naming every collision with its fix: separate exports per source, or a move when both pages share a source. */
function collisionRefusal(collisions: ExportCollision[], owners: Map<string, { source_id: string; label: string }>, outDir: string): Error {
  const lines = collisions.map(collision => {
    const owner = owners.get(collision.prior) ?? [...owners].find(([path]) => path.startsWith(collision.prior + '/'))?.[1];
    const fix = owner && owner.source_id !== collision.source_id
      ? `gbrain export --source ${collision.source_id} --dir ${outDir.replace(/\/+$/, '')}-${collision.source_id}`
      : `move one of the pages: put_page its content under a new slug, then delete_page ${collision.slug}`;
    return `  - ${collision.key} -> ${collision.path} collides with ${owner?.label ?? collision.prior} (export_path_collision); fix: ${fix}`;
  });
  return new Error(`Export path collision (including case, Unicode, page/sidecar or file-prefix aliases). Nothing was published. ${collisions.length} page path(s) collide:\n${lines.join('\n')}\nExport one source at a time with --source <id> into separate fresh directories.`);
}

function printEscaped(escaped: EscapedExportPage[]): void {
  const restorable = escaped.filter(page => page.restorable);
  const shortened = escaped.filter(page => !page.restorable);
  if (restorable.length) {
    console.log(`${restorable.length} page(s) have slugs that are not portable file names and were exported under escaped names; each file's slug: line keeps the slug, and import restores it:`);
    for (const page of restorable) console.log(`  - ${page.source_id}:${page.slug} -> ${page.path}`);
  }
  if (shortened.length) {
    console.log(`${shortened.length} page(s) have a slug segment longer than a file name may be and were exported under a shortened name; import refuses those files until the page moves to a shorter slug:`);
    for (const page of shortened) console.log(`  - ${page.source_id}:${page.slug} -> ${page.path}; fix: ${page.fix!.argv.join(' ')}, then delete_page ${page.slug}`);
  }
}

export async function runExport(engine: BrainEngine, args: string[]): Promise<ExportReport | undefined> {
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

Colliding planned paths and occupied output paths refuse (every collision is
listed); nothing is overwritten. A page whose slug is not a portable file name
(a ':', a Windows reserved name such as aux) is written under an escaped name
with a slug: line, and import restores its slug.
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
    const escaped: EscapedExportPage[] = [];
    const collisions: ExportCollision[] = [];
    const owners = new Map<string, { source_id: string; label: string }>();
    const started = Date.now();
    let streamedBytes = 0;
    const checkDeadline = () => {
      if (Date.now() - started > EXPORT_SNAPSHOT_MS + streamedBytes / EXPORT_STREAM_BYTES_PER_MS) throw new Error('Export snapshot time limit reached. Select a smaller scope with --source, --type or --slug-prefix.');
    };
    await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.executeRaw('SET LOCAL statement_timeout = 60000');
      let source = requested ? await resolveSourceId(tx, requested) : undefined;
      let repo = explicitRepo;
      if (restoreOnly) ({ source, repo } = await resolveRestoreTarget(tx, source, repo));
      const storage = restoreOnly && repo ? loadStorageConfig(repo) : null;
      if (restoreOnly && !storage) throw new Error('--restore-only requires a storage tiering config (gbrain.yml with a storage section).');
      const segmentedLimit = exportPayloadLimit(segmentedPageCeiling(tx.kind));
      let cursor = '0';
      for (;;) {
        checkDeadline();
        const batch = await tx.executeRaw<{ id: string; segmented: boolean; slug: string; source_id: string; source_path: string | null; source_path_bytes: number; raw_count: number; bytes: number }>(
          `SELECT p.id::text, p.body_storage='segmented' AS segmented, left(p.slug,4097) AS slug, p.source_id, left(p.source_path,4097) AS source_path, octet_length(p.source_path) AS source_path_bytes,
            (SELECT count(*) FROM raw_data r WHERE r.page_id=p.id) AS raw_count,
            CASE WHEN p.body_storage='segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth)::bigint + octet_length(p.timeline) END
              + octet_length(p.frontmatter::text)
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
            const target = exportPagePath(key.slug, Number(key.raw_count) > 0);
            if (restoreOnly && storage && repo) {
              if (!isDbOnly(key.slug, storage)) continue;
              if (existsSync(nativeFileTarget(repo, restoreFilePath(repo, key.slug, key.source_path, Number(key.source_path_bytes), await scannerSlugRootMode(tx, batchSource, repo))))) continue;
            }
            if (Number(key.bytes) > (key.segmented ? segmentedLimit : EXPORT_PAYLOAD_LIMIT)) throw new Error('Export page payload limit exceeded. No destination output was published.');
            const snapshot = await readExportPage(tx, key, withdrawals);
            const page = snapshot.page;
            // #5966: the slug stamp rule lives in slugStampedFrontmatter (markdown.ts), shared with every render; an
            // escaped file always carries its slug.
            const frontmatter = target.escaped ? { ...(page.frontmatter ?? {}), slug: page.slug } : slugStampedFrontmatter(page.slug, page.frontmatter ?? {});
            const meta = { type: page.type, title: page.title, tags: snapshot.tags };
            const label = `${page.source_id}:${page.slug}`;
            const raw = Number(key.raw_count) ? await tx.getRawData(page.slug, undefined, { sourceId: page.source_id, includeDeleted: true }) : [];
            try {
              if (isSegmentedPage(page)) {
                streamedBytes += Number(key.bytes);
                const head = serializeMarkdown(frontmatter, '', '', meta).slice(0, -1);
                await staged.addStream(target.path, Number(key.bytes), segmentedLimit, segmentedExportMarkdown(tx, page, exportBodyLedger(page.slug, withdrawals), head));
              } else staged.add(target.path, 'file', serializeMarkdown(frontmatter, page.compiled_truth, page.timeline, meta));
              owners.set(target.path, { source_id: page.source_id, label });
              if (raw.length) {
                staged.add(target.rawPath, 'file', JSON.stringify(Object.fromEntries(raw.map(row => [row.source, row.data])), null, 2) + '\n');
                owners.set(target.rawPath, { source_id: page.source_id, label });
              }
            } catch (error) {
              if (!(error instanceof ExportPathCollision)) throw error;
              collisions.push({ key: label, path: error.path, prior: error.prior, source_id: page.source_id, slug: page.slug });
              continue;
            }
            if (target.escaped) {
              const suggestion = target.restorable ? null : slugPortabilityProblem(page.slug)?.suggestion ?? null;
              escaped.push({ source_id: page.source_id, slug: page.slug, path: target.path, reason: target.restorable ? 'unportable_slug' : 'segment_too_long',
                restorable: target.restorable, fix: suggestion ? { argv: ['gbrain', 'put', suggestion] } : null });
            }
            staged.pages++;
          }
        }
        cursor = batch[batch.length - 1].id;
      }
      checkDeadline();
      if (collisions.length) throw collisionRefusal(collisions, owners, outDir);
    });
    console.log(`${restoreOnly ? 'Restoring' : 'Exporting'} ${stage.pages}${restoreOnly ? ' db_only' : ''} pages to ${outDir}/`);
    const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
    progress.start('export.pages', stage.pages);
    await publishExport(stage, outDir, path => { if (path.endsWith('.md')) progress.tick(); });
    progress.finish();
    console.log(`${restoreOnly ? 'Restored' : 'Exported'} ${stage.pages} pages to ${outDir}/`);
    printEscaped(escaped);
    return { pages: stage.pages, escaped };
  } catch (error) {
    console.error(`Error: Export failed: ${(error as Error).message}\nNo complete export was produced. If ${'.gbrain-export-status'} exists without a final COMPLETE line, the destination is incomplete. Preserve its files and retry into a fresh directory. See docs/storage-tiering.md#safe-export.`);
    if (stage) { stage.close(); stage = undefined; }
    process.exit(1);
  } finally { stage?.close(); }
}
