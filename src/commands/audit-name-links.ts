/**
 * gbrain audit-name-links — Detect AI-mediated misnames in producer markdown.
 *
 * Scans [Display](people/Slug) markdown links and [[people/Slug|Display]]
 * qualified wikilinks, validates Display against the canonical-name set for
 * Slug (same rules as linkify's buildAliasMap), emits diagnostics for
 * mismatches. Optionally auto-fixes Mode 1 (display mismatch) with
 * --fix-display-names.
 *
 * Default mode is detective-only: mismatches emit diagnostics but exit 0
 * so the producer pipeline keeps running. --strict exits 1 on
 * name_mismatch or unknown_target (NOT malformed_target — that's a gbrain
 * data-quality issue, not a producer bug).
 *
 * Modes:
 *   --path <file>                                            Single-file mode.
 *   --dir <dir> --since <ISO> --filename-prefix <prefix>     Directory scan.
 *   --dir <dir> --all                                        All .md files (no mtime/prefix filter).
 *   --fix-display-names                                      Mode 1 auto-fix.
 *   --dry-run                                                With --fix-display-names: preview only.
 *
 * Special commands (no engine required):
 *   abi-version                  Emit "1\n" to stdout, exit 0.
 *   --help / -h                  Emit usage text to stdout, exit 0.
 *
 * Exit codes:
 *   0 success (mismatches found but pipeline continues)
 *   1 --strict failure (name_mismatch or unknown_target emitted)
 *   2 usage error
 *   3 engine unavailable
 *
 * See: docs/superpowers/specs/2026-05-16-gbrain-audit-name-links-design.md
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { enumerateFilteredSince } from '../core/file-enum.ts';
import {
  buildCanonicalNameSets,
  findOccurrences,
  classifyOccurrences,
  applyDisplayFixes,
  type AuditDiagnostic,
  type AuditMismatch,
} from '../core/audit-name-links.ts';
import { atomicWriteSameDir, isICloudPlaceholder } from './linkify.ts';

export const AUDIT_NAME_LINKS_ABI_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI ABI
// ---------------------------------------------------------------------------

export function runAuditNameLinksAbi(): number {
  process.stdout.write(`${AUDIT_NAME_LINKS_ABI_VERSION}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Usage: gbrain audit-name-links --path <file> [flags]
       gbrain audit-name-links --dir <dir> --since <ISO8601> --filename-prefix <prefix> [flags]
       gbrain audit-name-links --dir <dir> --all [flags]
       gbrain audit-name-links abi-version
       gbrain audit-name-links --help

Scans [Display](people/Slug) markdown links and [[people/Slug|Display]]
qualified wikilinks and validates Display against the canonical name set
for Slug. Detective-only by default — mismatches emit diagnostics but
exit 0 so the producer pipeline keeps running.

Flags:
  --path <file>                Single absolute file path.
  --dir <dir>                  Directory to scan (non-recursive).
  --since <ISO8601>            mtime > since (with --dir).
  --filename-prefix <prefix>   Basename starts with prefix (with --dir).
  --all                        Shorthand for --since 1970-01-01T00:00:00Z --filename-prefix "".
                               Only valid with --dir.
  --fix-display-names          Rewrite Mode-1 (name_mismatch) display strings
                               to the page's canonical name. Idempotent.
  --dry-run                    With --fix-display-names: emit display_fixed
                               diagnostics without writing files.
  --strict                     Exit 1 if any name_mismatch or unknown_target
                               diagnostic is emitted. malformed_target is
                               always informational and never trips --strict.
  --json-diagnostics           One JSON event per line on stderr.
  --verbose-diagnostics        One human-readable line per event on stderr.
  (default: counts-only summary on stderr)

Exit codes:
  0 success
  1 --strict failure (post-fix name_mismatch or unknown_target present)
  2 usage error
  3 engine unavailable (retry next run)
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type SingleFileOpts = {
  mode: 'single';
  file: string;
  fixDisplayNames: boolean;
  dryRun: boolean;
  strict: boolean;
  jsonDiagnostics: boolean;
  verboseDiagnostics: boolean;
};

type DirOpts = {
  mode: 'dir';
  dir: string;
  since: string;
  filenamePrefix: string;
  fixDisplayNames: boolean;
  dryRun: boolean;
  strict: boolean;
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
  let all = false;
  let fixDisplayNames = false;
  let dryRun = false;
  let strict = false;
  let jsonDiagnostics = false;
  let verboseDiagnostics = false;

  const iter = args[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === '--path') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'audit-name-links: --path requires a file argument' };
      filePath = next.value as string;
    } else if (arg === '--dir') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'audit-name-links: --dir requires a directory argument' };
      dir = next.value as string;
    } else if (arg === '--since') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'audit-name-links: --since requires a timestamp argument' };
      since = next.value as string;
    } else if (arg === '--filename-prefix') {
      const next = iter.next();
      if (next.done || !next.value) return { usage: 'audit-name-links: --filename-prefix requires a prefix argument' };
      filenamePrefix = next.value as string;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--fix-display-names') {
      fixDisplayNames = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--json-diagnostics') {
      jsonDiagnostics = true;
    } else if (arg === '--verbose-diagnostics') {
      verboseDiagnostics = true;
    } else {
      return { usage: `audit-name-links: unknown argument: ${arg}` };
    }
  }

  // Mutual exclusion: --path and --dir cannot be combined
  if (filePath !== undefined && dir !== undefined) {
    return { usage: 'audit-name-links: --path and --dir are mutually exclusive' };
  }

  // --since / --filename-prefix / --all require --dir
  if (since !== undefined && dir === undefined) {
    return { usage: 'audit-name-links: --since requires --dir' };
  }
  if (filenamePrefix !== undefined && dir === undefined) {
    return { usage: 'audit-name-links: --filename-prefix requires --dir' };
  }
  if (all && dir === undefined) {
    return { usage: 'audit-name-links: --all requires --dir' };
  }

  // Dir mode validation
  if (dir !== undefined) {
    if (all) {
      // --all is incompatible with explicit --since / --filename-prefix
      if (since !== undefined || filenamePrefix !== undefined) {
        return { usage: 'audit-name-links: --all is mutually exclusive with --since and --filename-prefix' };
      }
      since = '1970-01-01T00:00:00Z';
      filenamePrefix = '';
    } else {
      if (since === undefined) {
        return { usage: 'audit-name-links: --dir requires --since (or --all)' };
      }
      if (filenamePrefix === undefined) {
        return { usage: 'audit-name-links: --dir requires --filename-prefix (or --all)' };
      }
    }
    return {
      mode: 'dir',
      dir: resolve(dir),
      since,
      filenamePrefix,
      fixDisplayNames,
      dryRun,
      strict,
      jsonDiagnostics,
      verboseDiagnostics,
    };
  }

  // Single-file mode validation
  if (filePath !== undefined) {
    return {
      mode: 'single',
      file: resolve(filePath),
      fixDisplayNames,
      dryRun,
      strict,
      jsonDiagnostics,
      verboseDiagnostics,
    };
  }

  return { usage: 'audit-name-links: no --path or --dir specified. Run `gbrain audit-name-links --help`.' };
}

// ---------------------------------------------------------------------------
// Diagnostic emission
// ---------------------------------------------------------------------------

interface Totals {
  filesProcessed: number;
  nameMismatch: number;
  unknownTarget: number;
  malformedTarget: number;
  displayFixed: number;
  dryRun: boolean;
}

/**
 * Map an AuditDiagnostic from internal camelCase to the snake_case wire
 * format defined in the design spec. TS types stay camelCase (idiomatic);
 * only the JSON emit boundary translates. Consumers (Phase 2/3 producers,
 * third-party tools) read these field names against the spec, so the wire
 * format must match it.
 *
 * See: docs/superpowers/specs/2026-05-16-gbrain-audit-name-links-design.md
 * (Diagnostic types section).
 */
export function serializeDiagnostic(d: AuditDiagnostic): Record<string, unknown> {
  switch (d.kind) {
    case 'name_mismatch':
      return {
        kind: d.kind,
        file: d.file,
        line: d.line,
        slug: d.slug,
        display: d.display,
        canonical_names: d.canonicalNames,
        link_form: d.linkForm,
        occurrences: d.occurrences,
      };
    case 'unknown_target':
      return {
        kind: d.kind,
        file: d.file,
        line: d.line,
        slug: d.slug,
        display: d.display,
        canonical_names: d.canonicalNames,
        link_form: d.linkForm,
        occurrences: d.occurrences,
      };
    case 'malformed_target':
      return {
        kind: d.kind,
        file: d.file,
        line: d.line,
        slug: d.slug,
        display: d.display,
        canonical_names: d.canonicalNames,
        link_form: d.linkForm,
        reason: d.malformedReason,
        occurrences: d.occurrences,
      };
    case 'display_fixed':
      return {
        kind: d.kind,
        file: d.file,
        line: d.line,
        slug: d.slug,
        old_display: d.oldDisplay,
        new_display: d.newDisplay,
        link_form: d.linkForm,
      };
    case 'concurrent_modification_skipped':
      return { kind: d.kind, file: d.file };
    case 'icloud_placeholder_skipped':
      return { kind: d.kind, file: d.file };
    case 'enoent':
      return { kind: d.kind, file: d.file };
  }
}

/**
 * Map the counts-totals to the snake_case summary wire format. Mirrors the
 * counts-only stderr text format (`files=N name_mismatch=K ...`) so JSON
 * consumers see the same field names.
 */
export function serializeSummary(totals: Totals): Record<string, unknown> {
  return {
    kind: 'summary',
    files: totals.filesProcessed,
    name_mismatch: totals.nameMismatch,
    unknown_target: totals.unknownTarget,
    malformed_target: totals.malformedTarget,
    display_fixed: totals.displayFixed,
    dry_run: totals.dryRun,
  };
}

function emitDiagnostics(
  diagnostics: AuditDiagnostic[],
  totals: Totals,
  opts: { jsonDiagnostics: boolean; verboseDiagnostics: boolean },
): void {
  const summaryLine =
    `audit-name-links: files=${totals.filesProcessed} ` +
    `name_mismatch=${totals.nameMismatch} ` +
    `unknown_target=${totals.unknownTarget} ` +
    `malformed_target=${totals.malformedTarget} ` +
    `display_fixed=${totals.displayFixed} ` +
    `dry_run=${totals.dryRun}\n`;

  if (opts.jsonDiagnostics) {
    for (const d of diagnostics) {
      process.stderr.write(JSON.stringify(serializeDiagnostic(d)) + '\n');
    }
    process.stderr.write(JSON.stringify(serializeSummary(totals)) + '\n');
  } else if (opts.verboseDiagnostics) {
    for (const d of diagnostics) {
      process.stderr.write(diagnosticToLine(d) + '\n');
    }
    process.stderr.write(summaryLine);
  } else {
    process.stderr.write(summaryLine);
  }
}

function diagnosticToLine(d: AuditDiagnostic): string {
  switch (d.kind) {
    case 'name_mismatch':
      return `[name_mismatch] ${d.file}:${d.line} [${d.display}](${d.slug}) — canonical: [${d.canonicalNames.join(', ')}] [${d.occurrences}x]`;
    case 'unknown_target':
      return `[unknown_target] ${d.file}:${d.line} [${d.display}](${d.slug}) — slug not found [${d.occurrences}x]`;
    case 'malformed_target':
      return `[malformed_target] ${d.file}:${d.line} [${d.display}](${d.slug}) — ${d.malformedReason ?? 'page missing name'} [${d.occurrences}x]`;
    case 'display_fixed':
      return `[display_fixed] ${d.file}:${d.line} ${d.slug} "${d.oldDisplay}" -> "${d.newDisplay}" (${d.linkForm})`;
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

/**
 * Injectable options for runAuditNameLinks. When `engine` is provided, the
 * config/createEngine/connect path is skipped (used by integration tests).
 */
export interface RunAuditNameLinksOpts {
  engine?: BrainEngine;
}

export async function runAuditNameLinks(args: string[], opts?: RunAuditNameLinksOpts): Promise<number> {
  if (args.length === 0) { printHelp(); return 2; }
  const first = args[0];
  if (first === '--help' || first === '-h') { printHelp(); return 0; }
  if (first === 'abi-version') return runAuditNameLinksAbi();

  const parsed = parseArgs(args);
  if ('usage' in parsed) {
    process.stderr.write(parsed.usage + '\n');
    return 2;
  }

  // Engine connection: use injected engine (tests) or connect via config (CLI)
  let engine: BrainEngine;
  let ownsEngine = false;
  if (opts?.engine) {
    engine = opts.engine;
  } else {
    ownsEngine = true;
    try {
      const cfg = loadConfig();
      if (!cfg) {
        process.stderr.write('audit-name-links: no gbrain config — run `gbrain init` first\n');
        return 3;
      }
      const engineConfig = toEngineConfig(cfg);
      engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
    } catch (e) {
      process.stderr.write(`audit-name-links: engine unavailable: ${e instanceof Error ? e.message : String(e)}\n`);
      return 3;
    }
  }

  try {
    // Build canonical-name sets from every non-deleted person page.
    let rows: Array<{ slug: string; frontmatter: Record<string, unknown> }>;
    try {
      rows = await engine.queryPersonsForAudit();
    } catch (e) {
      process.stderr.write(`audit-name-links: engine query failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 3;
    }
    const { sets, pageNames, malformedSlugs } = buildCanonicalNameSets(rows);

    // Enumerate input files
    let candidateFiles: string[];
    if (parsed.mode === 'single') {
      candidateFiles = [parsed.file];
    } else {
      candidateFiles = await enumerateFilteredSince(parsed.dir, parsed.since, parsed.filenamePrefix);
    }

    const allDiagnostics: AuditDiagnostic[] = [];
    let nameMismatchCount = 0;
    let unknownTargetCount = 0;
    let malformedTargetCount = 0;
    let displayFixedCount = 0;
    let filesProcessed = 0;

    for (const file of candidateFiles) {
      // iCloud placeholder check (before any read).
      if (isICloudPlaceholder(file)) {
        allDiagnostics.push({ kind: 'icloud_placeholder_skipped', file });
        continue;
      }

      // Pre-stat for concurrent-modification guard. Also serves as the ENOENT probe.
      let preStat: ReturnType<typeof statSync>;
      try {
        preStat = statSync(file);
      } catch {
        allDiagnostics.push({ kind: 'enoent', file });
        continue;
      }

      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        allDiagnostics.push({ kind: 'enoent', file });
        continue;
      }

      filesProcessed++;

      const occurrences = findOccurrences(content, file);
      const mismatches = classifyOccurrences(occurrences, sets, malformedSlugs);

      // Apply Mode-1 auto-fix first (if requested), then count remaining
      // diagnostics — --strict is evaluated against the post-fix state.
      let postFixMismatches: AuditMismatch[] = mismatches;
      let newContent: string | null = null;

      if (parsed.fixDisplayNames) {
        const fixResult = applyDisplayFixes(content, occurrences, mismatches, pageNames);
        if (fixResult.appliedFixes.length > 0) {
          newContent = fixResult.newContent;
          for (const fix of fixResult.appliedFixes) {
            allDiagnostics.push({
              kind: 'display_fixed',
              file,
              line: fix.line,
              slug: fix.slug,
              oldDisplay: fix.oldDisplay,
              newDisplay: fix.newDisplay,
              linkForm: fix.linkForm,
            });
            displayFixedCount++;
          }

          // Re-classify against the post-fix content so --strict sees only
          // mismatches that survived the auto-fix pass.
          const postOccurrences = findOccurrences(fixResult.newContent, file);
          postFixMismatches = classifyOccurrences(postOccurrences, sets, malformedSlugs);
        }
      }

      // Emit the surviving mismatches (Mode-1 only when fix-display-names
      // was applied; full set otherwise).
      for (const mm of postFixMismatches) {
        allDiagnostics.push(mm);
        if (mm.kind === 'name_mismatch') nameMismatchCount += mm.occurrences;
        else if (mm.kind === 'unknown_target') unknownTargetCount += mm.occurrences;
        else if (mm.kind === 'malformed_target') malformedTargetCount += mm.occurrences;
      }

      // Atomic write the fixed content if we have one and we're not in dry-run.
      if (newContent !== null && parsed.fixDisplayNames && !parsed.dryRun) {
        // Concurrent-modification guard: re-stat before writing. If the file
        // changed between pre-stat and now, skip the write — do NOT retry
        // within this audit pass.
        let postStat: ReturnType<typeof statSync>;
        try {
          postStat = statSync(file);
        } catch {
          allDiagnostics.push({ kind: 'enoent', file });
          continue;
        }
        if (postStat.mtimeMs !== preStat.mtimeMs) {
          allDiagnostics.push({ kind: 'concurrent_modification_skipped', file });
          continue;
        }
        atomicWriteSameDir(file, newContent);
      }
    }

    emitDiagnostics(
      allDiagnostics,
      {
        filesProcessed,
        nameMismatch: nameMismatchCount,
        unknownTarget: unknownTargetCount,
        malformedTarget: malformedTargetCount,
        displayFixed: displayFixedCount,
        dryRun: parsed.dryRun,
      },
      parsed,
    );

    // --strict semantics: exit 1 on any name_mismatch OR unknown_target
    // diagnostic that survived the fix pass. malformed_target stays
    // informational (gbrain data-quality issue, not a producer bug).
    if (parsed.strict && (nameMismatchCount > 0 || unknownTargetCount > 0)) {
      return 1;
    }

    return 0;
  } finally {
    if (ownsEngine) await engine.disconnect();
  }
}
