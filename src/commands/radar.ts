/**
 * `gbrain radar export` — emit a static, visual-mirror snapshot of the brain.
 *
 * Radar is a read-only MIRROR, not a second GBrain. This command reads the
 * GBrain engine (NOT the Markdown vault) and writes a full, atomic snapshot
 * under <out>/snapshot/current/ (preserving the prior snapshot as previous/).
 *
 * Design: docs/designs/RADAR_SNAPSHOT_EXPORT.md. Exporter: src/core/radar/export.ts.
 */

import type { BrainEngine } from '../core/engine.ts';
import { gbrainPath } from '../core/config.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { exportSnapshot, RadarValidationError } from '../core/radar/export.ts';
import type { RadarExportOpts } from '../core/radar/types.ts';

const HELP = `gbrain radar — visual-mirror snapshot exporter

USAGE
  gbrain radar export [flags]      Generate a full snapshot of the brain

FLAGS
  --out <dir>           Base output dir (default: $GBRAIN_HOME/.gbrain/radar).
                        Snapshot lands under <out>/snapshot/current/.
  --source-id <id>      Restrict the snapshot to a single source.
  --scope <label>       Record the operator's scope intent in the manifest.
  --include-private     Include pages classified private (default: excluded).
  --pretty              Pretty-print JSON (2-space) instead of compact.
  --max-pages <n>       Cap pages exported (smoke/testing).
  --recent <n>          Pages in views/recent.json (default: 100).
  --json                Print the result summary as JSON on stdout.
  --help                Show this help.

OUTPUT LAYOUT
  <out>/snapshot/
    current/        the live snapshot (swapped in atomically)
      manifest.json    identity, versions, counts, validation, warnings
      tree.json        folder -> pages tree
      pages-index.json lean per-page rows
      graph.json       nodes + edges from stored links
      search-index.json   lean search docs (title/path/headings/tags)
      views/recent.json   most-recent pages
      pages/<slug>.json   per-page detail (raw markdown, links, headings)
    previous/       the prior snapshot, preserved on each run

NOTES
  - v1 is a FULL export (mode: "full"). Incremental is deferred; the manifest
    carries the incremental-ready primitives (snapshot_id, previous_snapshot_id,
    content_hash).
  - The exporter reads the engine/DB only — it never re-parses the vault.
  - The snapshot can contain everything the brain knows. Treat it as private.
`;

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function runRadar(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : undefined;

  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (sub !== 'export') {
    console.error(`Unknown radar subcommand: ${sub}\n`);
    console.error(HELP);
    process.exit(1);
    return;
  }

  const rest = args.slice(1);

  const out = flagValue(rest, '--out') ?? gbrainPath('radar');
  const sourceId = flagValue(rest, '--source-id') ?? null;
  const scope = flagValue(rest, '--scope') ?? null;
  const includePrivate = rest.includes('--include-private');
  const pretty = rest.includes('--pretty');
  const asJson = rest.includes('--json');

  const maxPagesRaw = flagValue(rest, '--max-pages');
  const recentRaw = flagValue(rest, '--recent');
  const maxPages = maxPagesRaw !== undefined ? Number.parseInt(maxPagesRaw, 10) : undefined;
  const recentLimit = recentRaw !== undefined ? Number.parseInt(recentRaw, 10) : undefined;

  if (maxPages !== undefined && (!Number.isFinite(maxPages) || maxPages <= 0)) {
    console.error(`Error: --max-pages must be a positive integer; got: ${maxPagesRaw}`);
    process.exit(1);
    return;
  }
  if (recentLimit !== undefined && (!Number.isFinite(recentLimit) || recentLimit < 0)) {
    console.error(`Error: --recent must be a non-negative integer; got: ${recentRaw}`);
    process.exit(1);
    return;
  }

  const opts: RadarExportOpts = {
    out,
    sourceId,
    scope,
    includePrivate,
    pretty,
    maxPages,
    recentLimit,
  };

  // Progress on stderr so stdout stays clean for --json / the summary line.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  try {
    const result = await exportSnapshot(engine, opts, {
      onStart: (total) => progress.start('radar.pages', total),
      onTick: () => progress.tick(),
    });
    progress.finish();

    const m = result.manifest;
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            snapshot_id: result.snapshot_id,
            previous_snapshot_id: result.previous_snapshot_id,
            current_dir: result.current_dir,
            previous_dir: result.previous_dir,
            mode: m.mode,
            brain_id: m.brain_id,
            source_ids: m.source_ids,
            counts: m.counts,
            validation: m.validation.status,
            warnings: m.warnings,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`Radar snapshot ${result.snapshot_id} → ${result.current_dir}`);
    console.log(
      `  ${m.counts.pages} pages · ${m.counts.edges} edges ` +
        `(${m.counts.edges_resolved} resolved, ${m.counts.edges_dangling} dangling) · ` +
        `${m.counts.search_docs} search docs`,
    );
    if (m.counts.private_excluded > 0) {
      console.log(`  ${m.counts.private_excluded} private page(s) excluded (use --include-private)`);
    }
    console.log(`  brain=${m.brain_id} sources=[${m.source_ids.join(', ')}] validation=${m.validation.status}`);
    if (result.previous_dir) {
      console.log(`  previous snapshot preserved at ${result.previous_dir}`);
    }
    for (const w of m.warnings) console.log(`  warning: ${w}`);
  } catch (e) {
    progress.finish();
    if (e instanceof RadarValidationError) {
      console.error(`Error: radar export aborted — ${e.message}`);
      console.error('No snapshot was swapped in; the prior snapshot (if any) is untouched.');
      process.exit(1);
      return;
    }
    throw e;
  }
}
