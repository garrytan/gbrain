/**
 * gbrain extract-links — Promote wiki-link edges from local files into the graph.
 *
 * Bypasses sync's git-diff gate. Reuses Phase-0-bugfixed extractLinksForSlugs.
 *
 * Modes:
 *   --path <file>                Single-file mode.
 *   --dir <dir> --since <ISO> --filename-prefix <prefix>   Directory mode.
 *   --dry-run                    Replicate extraction loop; emit would_create_edge
 *                                diagnostics; do not call addLink.
 *
 * Special commands (no engine required):
 *   abi-version                  Emit "1\n" to stdout, exit 0.
 *   --help / -h                  Emit usage text to stdout, exit 0.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, basename, join, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { pathToSlug } from '../core/sync.ts';
import { enumerateFilteredSince } from '../core/file-enum.ts';
import {
  walkMarkdownFiles,
  extractLinksFromFile,
  extractLinksForSlugs,
} from './extract.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';

export const EXTRACT_LINKS_ABI_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI ABI
// ---------------------------------------------------------------------------

export function runExtractLinksAbi(): number {
  process.stdout.write(`${EXTRACT_LINKS_ABI_VERSION}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Usage: gbrain extract-links --path <file> [--dry-run] [diagnostics]
       gbrain extract-links --dir <dir> --since <ISO8601> --filename-prefix <prefix> [--dry-run] [diagnostics]
       gbrain extract-links abi-version
       gbrain extract-links --help

Promote wiki-link edges from local files into the graph, bypassing
sync's git-diff gate. Reuses the bugfixed extractLinksForSlugs.

Flags:
  --path <file>                Single absolute path.
  --dir <dir>                  Directory to scan (non-recursive).
  --since <ISO8601>            mtime > since.
  --filename-prefix <prefix>   Basename starts with prefix.
  --dry-run                    Replicate extraction loop; emit would_create_edge
                               diagnostics; do not call addLink.
  --json-diagnostics           One JSON event per line on stderr.
  --verbose-diagnostics        One human-readable line per event on stderr.

Exit codes:
  0 success
  2 usage error
  3 engine unavailable (retry next run)
`);
}

// ---------------------------------------------------------------------------
// Diagnostics types (local — no linkify coupling)
// ---------------------------------------------------------------------------

type ExtractLinksDiagnostic =
  | { kind: 'would_create_edge'; from_slug: string; to_slug: string; link_type: string }
  | { kind: 'outside_brain_dir'; file: string }
  | { kind: 'icloud_placeholder_skipped'; file: string }
  | { kind: 'enoent'; file: string };

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type SingleFileOpts = {
  mode: 'single';
  file: string;
  dryRun: boolean;
  jsonDiagnostics: boolean;
  verboseDiagnostics: boolean;
};

type DirOpts = {
  mode: 'dir';
  dir: string;
  since: string;
  filenamePrefix: string;
  dryRun: boolean;
  jsonDiagnostics: boolean;
  verboseDiagnostics: boolean;
};

type ParsedOpts = SingleFileOpts | DirOpts;
type ParseResult = ParsedOpts | { usage: string };

export function parseArgs(args: string[]): ParseResult {
  let filePath: string | undefined;
  let dir: string | undefined;
  let since: string | undefined;
  let filenamePrefix: string | undefined;
  let dryRun = false;
  let jsonDiagnostics = false;
  let verboseDiagnostics = false;

  const iter = args[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === '--path') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'extract-links: --path requires a file argument' };
      filePath = next.value as string;
    } else if (arg === '--dir') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'extract-links: --dir requires a directory argument' };
      dir = next.value as string;
    } else if (arg === '--since') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'extract-links: --since requires a timestamp argument' };
      since = next.value as string;
    } else if (arg === '--filename-prefix') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'extract-links: --filename-prefix requires a prefix argument' };
      filenamePrefix = next.value as string;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json-diagnostics') {
      jsonDiagnostics = true;
    } else if (arg === '--verbose-diagnostics') {
      verboseDiagnostics = true;
    } else {
      return { usage: `extract-links: unknown argument: ${arg}` };
    }
  }

  // Mutual exclusion: --path and --dir cannot be combined
  if (filePath !== undefined && dir !== undefined) {
    return { usage: 'extract-links: --path and --dir are mutually exclusive' };
  }

  // --since or --filename-prefix without --dir are usage errors
  if (since !== undefined && dir === undefined) {
    return { usage: 'extract-links: --since requires --dir' };
  }
  if (filenamePrefix !== undefined && dir === undefined) {
    return { usage: 'extract-links: --filename-prefix requires --dir' };
  }

  // Dir mode validation
  if (dir !== undefined) {
    if (since === undefined) {
      return { usage: 'extract-links: --dir requires --since' };
    }
    if (filenamePrefix === undefined) {
      return { usage: 'extract-links: --dir requires --filename-prefix' };
    }
    return { mode: 'dir', dir: resolve(dir), since, filenamePrefix, dryRun, jsonDiagnostics, verboseDiagnostics };
  }

  // Single-file mode validation
  if (filePath !== undefined) {
    return { mode: 'single', file: resolve(filePath), dryRun, jsonDiagnostics, verboseDiagnostics };
  }

  return { usage: 'extract-links: no --path or --dir specified. Run `gbrain extract-links --help`.' };
}

// ---------------------------------------------------------------------------
// iCloud placeholder detection
// ---------------------------------------------------------------------------

export function isICloudPlaceholder(absPath: string): boolean {
  return existsSync(join(dirname(absPath), '.' + basename(absPath) + '.icloud'));
}

// ---------------------------------------------------------------------------
// Path validation: file must be inside repoPath
// ---------------------------------------------------------------------------

function isOutsideBrain(repoPath: string, file: string): boolean {
  const rel = relative(repoPath, file);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Diagnostics emission
// ---------------------------------------------------------------------------

interface Totals {
  filesProcessed: number;
  edgesCreated: number;
  dryRun: boolean;
}

function emitDiagnostics(
  diagnostics: ExtractLinksDiagnostic[],
  totals: Totals,
  opts: { jsonDiagnostics: boolean; verboseDiagnostics: boolean },
): void {
  if (opts.jsonDiagnostics) {
    for (const d of diagnostics) {
      process.stderr.write(JSON.stringify(d) + '\n');
    }
    process.stderr.write(JSON.stringify({ kind: 'summary', ...totals }) + '\n');
  } else if (opts.verboseDiagnostics) {
    for (const d of diagnostics) {
      process.stderr.write(diagnosticToLine(d) + '\n');
    }
    process.stderr.write(
      `extract-links: files=${totals.filesProcessed} edges=${totals.edgesCreated} dry_run=${totals.dryRun}\n`,
    );
  } else {
    // Counts-only summary
    process.stderr.write(
      `extract-links: files=${totals.filesProcessed} edges=${totals.edgesCreated} dry_run=${totals.dryRun}\n`,
    );
  }
}

function diagnosticToLine(d: ExtractLinksDiagnostic): string {
  switch (d.kind) {
    case 'would_create_edge':
      return `would_create_edge: ${d.from_slug} → ${d.to_slug} [${d.link_type}]`;
    case 'outside_brain_dir':
      return `outside_brain_dir: ${d.file}`;
    case 'icloud_placeholder_skipped':
      return `icloud placeholder skipped: ${d.file}`;
    case 'enoent':
      return `file not found: ${d.file}`;
    default:
      return JSON.stringify(d);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runExtractLinks(args: string[]): Promise<number> {
  if (args.length === 0) { printHelp(); return 2; }
  const first = args[0];
  if (first === '--help' || first === '-h') { printHelp(); return 0; }
  if (first === 'abi-version') return runExtractLinksAbi();

  const parsed = parseArgs(args);
  if ('usage' in parsed) {
    process.stderr.write(parsed.usage + '\n');
    return 2;
  }

  // Engine connection (exit 3 on failure — "retry later" semantic)
  let engine: Awaited<ReturnType<typeof createEngine>>;
  try {
    const cfg = loadConfig();
    if (!cfg) {
      process.stderr.write('extract-links: no gbrain config — run `gbrain init` first\n');
      return 3;
    }
    const engineConfig = toEngineConfig(cfg);
    engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
  } catch (e) {
    process.stderr.write(`extract-links: engine unavailable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }

  try {
    // Resolve repoPath from the brain's configured source
    const repoPath = await getDefaultSourcePath(engine);
    if (!repoPath) {
      process.stderr.write(
        'extract-links: no brain directory configured. ' +
        'Run `gbrain sources add default --path <brain-dir>` to register one.\n',
      );
      return 3;
    }

    // Enumerate input files
    let candidateFiles: string[];
    if (parsed.mode === 'single') {
      candidateFiles = [parsed.file];
    } else {
      candidateFiles = await enumerateFilteredSince(parsed.dir, parsed.since, parsed.filenamePrefix);
    }

    // Validate files: reject those outside repoPath
    const allDiagnostics: ExtractLinksDiagnostic[] = [];
    const validFiles: string[] = [];

    for (const file of candidateFiles) {
      if (isOutsideBrain(repoPath, file)) {
        if (parsed.mode === 'single') {
          process.stderr.write(
            `extract-links: file "${file}" is outside the brain directory "${repoPath}"\n`,
          );
          return 2;
        } else {
          allDiagnostics.push({ kind: 'outside_brain_dir', file });
          continue;
        }
      }

      if (isICloudPlaceholder(file)) {
        allDiagnostics.push({ kind: 'icloud_placeholder_skipped', file });
        continue;
      }

      try {
        statSync(file);
      } catch {
        allDiagnostics.push({ kind: 'enoent', file });
        continue;
      }

      validFiles.push(file);
    }

    // Compute slugs for valid files
    const slugs = validFiles.map(f => pathToSlug(relative(repoPath, f)));

    if (slugs.length === 0) {
      emitDiagnostics(allDiagnostics, { filesProcessed: 0, edgesCreated: 0, dryRun: parsed.dryRun }, parsed);
      return 0;
    }

    let edgesCreated = 0;

    if (parsed.dryRun) {
      // Dry-run: replicate the extraction loop without calling addLink
      const allFiles = walkMarkdownFiles(repoPath);
      const slugToFile = new Map<string, string>();
      for (const f of allFiles) slugToFile.set(pathToSlug(f.relPath), f.path);
      const allSlugs = new Set(slugToFile.keys());

      for (const slug of slugs) {
        const filePath = slugToFile.get(slug);
        if (!filePath) continue;
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const link of await extractLinksFromFile(content, slug + '.md', allSlugs)) {
            allDiagnostics.push({
              kind: 'would_create_edge',
              from_slug: link.from_slug,
              to_slug: link.to_slug,
              link_type: link.link_type,
            });
            edgesCreated++;
          }
        } catch { /* skip unreadable files */ }
      }
    } else {
      // Live path: single batch call to Phase-0-bugfixed extractLinksForSlugs
      edgesCreated = await extractLinksForSlugs(engine, repoPath, slugs);
    }

    emitDiagnostics(
      allDiagnostics,
      { filesProcessed: validFiles.length, edgesCreated, dryRun: parsed.dryRun },
      parsed,
    );
    return 0;
  } finally {
    await engine.disconnect();
  }
}
