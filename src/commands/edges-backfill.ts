/**
 * v0.34 W6 — gbrain edges-backfill CLI.
 *
 * Operator escape hatch for the symbol-resolution backfill chain. Calls
 * `resolveSymbolEdgesIncremental` from src/core/chunkers/symbol-resolver.ts
 * with explicit control over source + resume semantics.
 *
 * Resumable via `content_chunks.edges_backfilled_at` (the W0c watermark).
 * SIGINT-clean — the underlying resolver commits per-batch so partial
 * work persists and a re-run picks up where it left off.
 *
 * Each batch of BATCH_SIZE (200) chunks is its own transaction; the
 * caller can Ctrl-C at any time and re-run safely.
 */
import type { BrainEngine } from '../core/engine.ts';
import { resolveSymbolEdgesIncremental } from '../core/chunkers/symbol-resolver.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

interface BackfillOpts {
  source?: string;
  allSources?: boolean;
  maxChunks?: number;
  json?: boolean;
}

function parseFlags(args: string[]): BackfillOpts {
  const opts: BackfillOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') {
      opts.source = args[++i];
    } else if (a === '--all-sources') {
      opts.allSources = true;
    } else if (a === '--max-chunks') {
      opts.maxChunks = parseInt(args[++i] ?? '', 10);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      // help printed by caller
    }
  }
  return opts;
}

function printHelp(): void {
  process.stderr.write(
    `Usage: gbrain edges-backfill [--source <id> | --all-sources] [--max-chunks N] [--json]\n\n` +
      `Resumable symbol-resolution backfill. Walks every content_chunks row whose\n` +
      `edges_backfilled_at is NULL or older than EDGE_EXTRACTOR_VERSION_TS, and\n` +
      `resolves its emitted edges against same-page symbol_name_qualified candidates.\n\n` +
      `Flags:\n` +
      `  --source <id>     scope to one source (default: 'default')\n` +
      `  --all-sources     iterate every registered source\n` +
      `  --max-chunks N    cap on chunks walked per source (default: 2000)\n` +
      `  --json            emit JSON result on stdout\n`,
  );
}

export async function runEdgesBackfill(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const opts = parseFlags(args);

  // Build the sourceId list.
  let sourceIds: string[];
  if (opts.allSources) {
    try {
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE archived = false ORDER BY id`,
        [],
      );
      sourceIds = rows.map((r) => r.id);
      if (sourceIds.length === 0) sourceIds = ['default'];
    } catch {
      sourceIds = ['default'];
    }
  } else if (opts.source) {
    sourceIds = [opts.source];
  } else {
    sourceIds = [await resolveSourceId(engine, null).catch(() => 'default')];
  }

  const summary: { source_id: string; chunks_walked: number; edges_resolved: number; edges_ambiguous: number; edges_unmatched: number; batches: number; ms: number }[] = [];

  for (const sourceId of sourceIds) {
    if (!opts.json) {
      process.stderr.write(`[edges-backfill] source=${sourceId} starting...\n`);
    }
    try {
      const stats = await resolveSymbolEdgesIncremental(engine, {
        sourceId,
        maxChunks: opts.maxChunks,
      });
      summary.push({
        source_id: sourceId,
        chunks_walked: stats.chunks_walked,
        edges_resolved: stats.edges_resolved,
        edges_ambiguous: stats.edges_ambiguous,
        edges_unmatched: stats.edges_unmatched,
        batches: stats.batches,
        ms: stats.ms,
      });
      if (!opts.json) {
        process.stderr.write(
          `[edges-backfill] source=${sourceId} done: ${stats.chunks_walked} chunks walked, ${stats.edges_resolved} resolved, ${stats.edges_ambiguous} ambiguous, ${stats.edges_unmatched} unmatched, ${stats.ms}ms\n`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      process.stderr.write(`[edges-backfill] source=${sourceId} failed: ${msg}\n`);
      summary.push({
        source_id: sourceId,
        chunks_walked: 0,
        edges_resolved: 0,
        edges_ambiguous: 0,
        edges_unmatched: 0,
        batches: 0,
        ms: 0,
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ schema_version: 1, summary }, null, 2) + '\n');
  }
}
