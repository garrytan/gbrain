/**
 * gbrain linkify — Rewrite bare person mentions into [[people/slug|Display]] wikilinks.
 *
 * Mode-flag decision table:
 *
 * Single-file mode (<file> positional, no --dir):
 *   <file>                     Write linkified content to STDOUT, leave file unchanged.
 *   <file> --in-place          Rewrite file in place (atomic).
 *   <file> --in-place --dry-run Write linkified content to STDOUT (preview).
 *   <file> --dry-run           Same as <file> alone — STDOUT only.
 *
 * Directory mode (--dir + --since + --filename-prefix):
 *   --dir ...                  Rewrite each matching file in place.
 *   --dir ... --dry-run        No writes anywhere; diagnostics to stderr only.
 *
 * Special commands (no engine connection required):
 *   abi-version                Emit "1\n" to stdout, exit 0.
 *   --help / -h                Emit usage text to stdout, exit 0.
 */

import {
  readFileSync,
  statSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { linkifyMarkdown, buildAliasMap, type LinkifyConfig, type Diagnostic } from '../core/linkify.ts';
import { enumerateFilteredSince } from '../core/file-enum.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';

export const LINKIFY_ABI_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI ABI
// ---------------------------------------------------------------------------

export function runLinkifyAbi(): number {
  process.stdout.write(`${LINKIFY_ABI_VERSION}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Usage: gbrain linkify <file> [--in-place] [--dry-run] [diagnostics flags]
       gbrain linkify --dir <dir> --since <ISO8601> --filename-prefix <prefix> [--dry-run] [diagnostics flags]
       gbrain linkify abi-version
       gbrain linkify --help

Rewrites bare person mentions into [[people/slug|Display]] wikilinks.

Single-file mode:
  <file>                       Path to a markdown file. Writes linkified content
                               to stdout by default; use --in-place to rewrite.
  --in-place                   Rewrite the file in place (atomic).
  --dry-run                    With --in-place, writes to stdout instead of file.

Directory mode:
  --dir <dir>                  Directory to scan (non-recursive).
  --since <ISO8601>            Only files with mtime > since.
  --filename-prefix <prefix>   Only files whose basename starts with prefix.
  --dry-run                    Emit diagnostics only; no writes anywhere.

Diagnostics:
  --json-diagnostics           One JSON event per line on stderr.
  --verbose-diagnostics        One human-readable line per event on stderr.
  (default: counts-only summary on stderr)

Exit codes:
  0 success
  2 usage error
  3 engine unavailable (retry later)
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type SingleFileOpts = {
  mode: 'single';
  file: string;
  inPlace: boolean;
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
  let file: string | undefined;
  let dir: string | undefined;
  let since: string | undefined;
  let filenamePrefix: string | undefined;
  let inPlace = false;
  let dryRun = false;
  let jsonDiagnostics = false;
  let verboseDiagnostics = false;

  const iter = args[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === '--dir') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'linkify: --dir requires a directory argument' };
      dir = next.value as string;
    } else if (arg === '--since') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'linkify: --since requires a timestamp argument' };
      since = next.value as string;
    } else if (arg === '--filename-prefix') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'linkify: --filename-prefix requires a prefix argument' };
      filenamePrefix = next.value as string;
    } else if (arg === '--in-place') {
      inPlace = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json-diagnostics') {
      jsonDiagnostics = true;
    } else if (arg === '--verbose-diagnostics') {
      verboseDiagnostics = true;
    } else if (!arg.startsWith('--')) {
      // Positional argument — treat as <file>
      file = arg;
    } else {
      return { usage: `linkify: unknown flag: ${arg}` };
    }
  }

  // Mutual exclusion: <file> and --dir cannot be combined
  if (file !== undefined && dir !== undefined) {
    return { usage: 'linkify: <file> and --dir are mutually exclusive' };
  }

  // --since or --filename-prefix without --dir are usage errors
  if (since !== undefined && dir === undefined) {
    return { usage: 'linkify: --since requires --dir' };
  }
  if (filenamePrefix !== undefined && dir === undefined) {
    return { usage: 'linkify: --filename-prefix requires --dir' };
  }

  // Dir mode validation
  if (dir !== undefined) {
    if (since === undefined) {
      return { usage: 'linkify: --dir requires --since' };
    }
    if (filenamePrefix === undefined) {
      return { usage: 'linkify: --dir requires --filename-prefix' };
    }
    return { mode: 'dir', dir: resolve(dir), since, filenamePrefix, dryRun, jsonDiagnostics, verboseDiagnostics };
  }

  // Single-file mode validation
  if (file !== undefined) {
    return { mode: 'single', file: resolve(file), inPlace, dryRun, jsonDiagnostics, verboseDiagnostics };
  }

  return { usage: 'linkify: no <file> or --dir specified. Run `gbrain linkify --help`.' };
}

// ---------------------------------------------------------------------------
// iCloud placeholder detection
// ---------------------------------------------------------------------------

export function isICloudPlaceholder(absPath: string): boolean {
  return existsSync(join(dirname(absPath), '.' + basename(absPath) + '.icloud'));
}

// ---------------------------------------------------------------------------
// Atomic write (same-directory temp + fsync + rename)
// ---------------------------------------------------------------------------

export function atomicWriteSameDir(file: string, content: string): void {
  const dir = dirname(file);
  const base = basename(file);
  const tmp = join(dir, `.${base}.linkify-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Diagnostics emission
// ---------------------------------------------------------------------------

interface Totals {
  filesProcessed: number;
  totalLinked: number;
  totalAmbiguous: number;
  uniquePeople: number;
}

function emitDiagnostics(diagnostics: Diagnostic[], totals: Totals, opts: { jsonDiagnostics: boolean; verboseDiagnostics: boolean }): void {
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
      `linkify: processed ${totals.filesProcessed} files, ` +
      `linked ${totals.totalLinked} mention(s) for ${totals.uniquePeople} person(s), ` +
      `${totals.totalAmbiguous} ambiguous (unresolved)\n`,
    );
  } else {
    // Counts-only summary
    process.stderr.write(
      `linkify: processed ${totals.filesProcessed} files, ` +
      `linked ${totals.totalLinked} mention(s) for ${totals.uniquePeople} person(s), ` +
      `${totals.totalAmbiguous} ambiguous (unresolved)\n`,
    );
  }
}

function diagnosticToLine(d: Diagnostic): string {
  switch (d.kind) {
    case 'resolved_by_default_domain':
      return `resolved: "${d.match}" → ${d.chosen} (rejected: ${d.rejected.join(', ')}) [${d.occurrences}x]`;
    case 'ambiguous_unresolved':
      return `ambiguous: "${d.match}" candidates: ${d.candidates.join(', ')} [${d.occurrences}x]`;
    case 'auto_stub_excluded_total':
      return `auto-stub excluded: ${d.count} pages`;
    case 'stopword_dropped_all_keys':
      return `stopword dropped all keys for ${d.slug} ("${d.name}")`;
    case 'malformed_frontmatter':
      return `malformed frontmatter: ${d.slug} field=${d.field} reason=${d.reason}`;
    case 'concurrent_modification_skipped':
      return `concurrent modification skipped: ${d.file}`;
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

export async function runLinkify(args: string[]): Promise<number> {
  if (args.length === 0) { printHelp(); return 2; }
  const first = args[0];
  if (first === '--help' || first === '-h') { printHelp(); return 0; }
  if (first === 'abi-version') return runLinkifyAbi();

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
      process.stderr.write('linkify: no gbrain config — run `gbrain init` first\n');
      return 3;
    }
    const engineConfig = toEngineConfig(cfg);
    engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
  } catch (e) {
    process.stderr.write(`linkify: engine unavailable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }

  try {
    // Build config from gbrain config file (linkify section is optional)
    const cfg = loadConfig();
    const linkifyCfg: LinkifyConfig = {
      defaultDomains: (cfg?.linkify?.default_domains as string[] | undefined) ?? [],
      stopwords: new Set((cfg?.linkify?.stopwords as string[] | undefined) ?? []),
      firstMentionOnly: (cfg?.linkify?.first_mention_only as boolean | undefined) ?? false,
    };

    const { aliasMap, pageMeta, startupDiagnostics } = await buildAliasMap(engine, linkifyCfg);

    // Enumerate files
    let files: string[];
    if (parsed.mode === 'single') {
      files = [parsed.file];
    } else {
      files = await enumerateFilteredSince(parsed.dir, parsed.since, parsed.filenamePrefix);
    }

    // Per-file processing loop
    const allDiagnostics: Diagnostic[] = [...startupDiagnostics];
    let totalLinked = 0;
    let totalAmbiguous = 0;
    const uniquePeople = new Set<string>();

    for (const file of files) {
      if (isICloudPlaceholder(file)) {
        allDiagnostics.push({ kind: 'icloud_placeholder_skipped', file });
        continue;
      }

      let preStat: ReturnType<typeof statSync>;
      try { preStat = statSync(file); }
      catch { allDiagnostics.push({ kind: 'enoent', file }); continue; }

      const content = readFileSync(file, 'utf-8');
      const result = linkifyMarkdown(content, aliasMap, pageMeta, linkifyCfg);
      allDiagnostics.push(...result.diagnostics);
      totalLinked += result.counts.linked;
      totalAmbiguous += result.counts.ambiguous;
      for (const slug of result.counts.uniquePeople) uniquePeople.add(slug);

      // Determine whether to write vs emit to stdout
      const shouldWrite =
        parsed.mode === 'dir'
          ? !parsed.dryRun
          : parsed.inPlace && !parsed.dryRun;

      if (shouldWrite && result.text !== content) {
        // Concurrent-modification guard: stat again before write
        const postStat = statSync(file);
        if (postStat.mtimeMs !== preStat.mtimeMs) {
          allDiagnostics.push({ kind: 'concurrent_modification_skipped', file });
          continue;
        }
        atomicWriteSameDir(file, result.text);
      } else if (parsed.mode === 'single') {
        // Single-file stdout path:
        //   <file>                       → always stdout
        //   <file> --dry-run             → stdout (same as no flag)
        //   <file> --in-place --dry-run  → stdout (preview of what would be written)
        // NOTE: <file> --in-place (no dry-run) is handled by shouldWrite above.
        // We only reach here when NOT in shouldWrite path, i.e. not (inPlace && !dryRun).
        if (!(parsed.inPlace && !parsed.dryRun)) {
          process.stdout.write(result.text);
        }
      }
      // Dir + dryRun: no writes, no stdout output of file contents — diagnostics only.
    }

    emitDiagnostics(
      allDiagnostics,
      { filesProcessed: files.length, totalLinked, totalAmbiguous, uniquePeople: uniquePeople.size },
      parsed,
    );
    return 0;
  } finally {
    await engine.disconnect();
  }
}
