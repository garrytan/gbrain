/**
 * gbrain lint — Deterministic brain page quality checker.
 *
 * Zero LLM calls. Catches common quality issues:
 * - LLM preamble artifacts ("Of course! Here is...")
 * - Placeholder dates (YYYY-MM-DD, XX-XX left unfilled)
 * - Missing required frontmatter fields
 * - Broken citations (unclosed brackets, missing dates)
 * - Empty/stub sections
 * - Wrapping code fences from LLM output
 *
 * Usage:
 *   gbrain lint <dir>              # report issues
 *   gbrain lint <dir> --fix        # auto-fix what's fixable
 *   gbrain lint <dir> --fix --dry-run  # preview fixes
 *   gbrain lint <file.md>          # lint single file
 */

import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { parseMarkdown, type ParseValidationCode } from '../core/markdown.ts';
import {
  assessContentSanity,
  type OperatorLiteral,
  DEFAULT_BYTES_WARN,
} from '../core/content-sanity.ts';
import { loadOperatorLiterals } from '../core/content-sanity-literals.ts';
import { loadConfig, loadConfigWithEngine, gbrainPath } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';

export interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
  fixable: boolean;
}

/** Map of frontmatter validation codes to lint rule names. Stable across
 *  releases — agents and CI consumers can target specific rule names. */
const FRONTMATTER_RULE_NAMES: Record<ParseValidationCode, string> = {
  MISSING_OPEN: 'frontmatter-missing-open',
  MISSING_CLOSE: 'frontmatter-missing-close',
  YAML_PARSE: 'frontmatter-yaml-parse',
  SLUG_MISMATCH: 'frontmatter-slug-mismatch',
  NULL_BYTES: 'frontmatter-null-bytes',
  NESTED_QUOTES: 'frontmatter-nested-quotes',
  EMPTY_FRONTMATTER: 'frontmatter-empty',
};

/** Codes whose lint findings are fixable by `gbrain frontmatter validate --fix`. */
const FRONTMATTER_FIXABLE: ReadonlySet<ParseValidationCode> = new Set<ParseValidationCode>([
  'MISSING_CLOSE',
  'NULL_BYTES',
  'NESTED_QUOTES',
]);

// ── LLM artifact patterns ──────────────────────────────────────────

const LLM_PREAMBLES = [
  /^Of course\.?\s*Here is (?:a |the )?(?:detailed |comprehensive |updated )?(?:brain )?page[^.\n]*\.?\s*\n*/gim,
  /^Certainly\.?\s*Here is[^.\n]*\.?\s*\n*/gim,
  /^Here is (?:a |the )?(?:detailed |comprehensive |updated )?(?:brain )?page[^.\n]*\.?\s*\n*/gim,
  /^I've (?:created|updated|written|prepared) (?:a |the )?(?:detailed |comprehensive )?(?:brain )?page[^.\n]*\.?\s*\n*/gim,
  /^Sure(?:!|,)?\s*Here (?:is|are)[^.\n]*\.?\s*\n*/gim,
  /^Absolutely\.?\s*Here[^.\n]*\.?\s*\n*/gim,
];

// ── Rules ──────────────────────────────────────────────────────────

/**
 * Per-call options for `lintContent`. Tests pass content-sanity opts
 * directly so the linter can be exercised without an engine.
 * Production callers (`runLintCore`) resolve effective config first
 * via the file/env/DB precedence chain and pass through.
 */
export interface LintContentOpts {
  /** v0.41 content-sanity thresholds + operator literals. When omitted,
   *  the assessor uses its built-in defaults (50K warn, 500K block,
   *  built-in junk patterns only). */
  contentSanity?: {
    bytes_warn?: number;
    bytes_block?: number;
    junk_patterns_enabled?: boolean;
    disabled?: boolean;
    operator_literals?: ReadonlyArray<OperatorLiteral>;
  };
}

export function lintContent(content: string, filePath: string, opts: LintContentOpts = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = content.split('\n');

  // ── Frontmatter validation (delegates to parseMarkdown(validate:true)) ──
  // This is the single source of truth for frontmatter shape rules. Each
  // ParseValidationCode maps to a stable lint rule name in
  // FRONTMATTER_RULE_NAMES. Keeps brain-page lint, doctor's
  // frontmatter_integrity subcheck, and the frontmatter CLI in lockstep.
  const parsed = parseMarkdown(content, filePath, { validate: true });
  for (const err of parsed.errors ?? []) {
    // Skip MISSING_OPEN — the legacy `no-frontmatter` rule below covers this
    // exact case with a stable rule name. Emitting both is double-reporting.
    if (err.code === 'MISSING_OPEN') continue;
    issues.push({
      file: filePath,
      line: err.line ?? 1,
      rule: FRONTMATTER_RULE_NAMES[err.code],
      message: err.message,
      fixable: FRONTMATTER_FIXABLE.has(err.code),
    });
  }

  // Rule: LLM preamble artifacts
  for (const pattern of LLM_PREAMBLES) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      issues.push({
        file: filePath, line: 1, rule: 'llm-preamble',
        message: 'LLM preamble artifact detected (e.g., "Of course! Here is...")',
        fixable: true,
      });
    }
  }

  // Rule: Wrapping code fences (```markdown ... ```)
  if (content.match(/^```(?:markdown|md)\s*\n/m) && content.match(/\n```\s*$/m)) {
    issues.push({
      file: filePath, line: 1, rule: 'code-fence-wrap',
      message: 'Page wrapped in ```markdown code fences (LLM artifact)',
      fixable: true,
    });
  }

  // Rule: Placeholder dates
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/\bYYYY-MM-DD\b/) || lines[i].match(/\bXX-XX\b/) || lines[i].match(/\b\d{4}-XX-XX\b/)) {
      issues.push({
        file: filePath, line: i + 1, rule: 'placeholder-date',
        message: `Placeholder date found: ${lines[i].trim().slice(0, 60)}`,
        fixable: false,
      });
    }
  }

  // Rule: Missing frontmatter
  if (content.startsWith('---')) {
    const fmEnd = content.indexOf('---', 3);
    if (fmEnd > 0) {
      const fm = content.slice(3, fmEnd);
      if (!fm.match(/^title:/m)) {
        issues.push({
          file: filePath, line: 1, rule: 'missing-title',
          message: 'Frontmatter missing required field: title',
          fixable: false,
        });
      }
      if (!fm.match(/^type:/m)) {
        issues.push({
          file: filePath, line: 1, rule: 'missing-type',
          message: 'Frontmatter missing required field: type',
          fixable: false,
        });
      }
      if (!fm.match(/^created:/m)) {
        issues.push({
          file: filePath, line: 1, rule: 'missing-created',
          message: 'Frontmatter missing required field: created',
          fixable: false,
        });
      }
    }
  } else {
    // No frontmatter at all
    issues.push({
      file: filePath, line: 1, rule: 'no-frontmatter',
      message: 'Page has no YAML frontmatter',
      fixable: false,
    });
  }

  // Rule: Broken citations (unclosed [Source: ...)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Open [Source: without closing ]
    if (line.match(/\[Source:[^\]]*$/) && !(i + 1 < lines.length && lines[i + 1].match(/^\s*[^\[]*\]/))) {
      issues.push({
        file: filePath, line: i + 1, rule: 'broken-citation',
        message: 'Unclosed [Source: ...] citation',
        fixable: false,
      });
    }
  }

  // Rule: Empty/stub sections
  const sectionPattern = /^##\s+(.+)$/gm;
  let sectionMatch;
  while ((sectionMatch = sectionPattern.exec(content)) !== null) {
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSection = content.indexOf('\n## ', sectionStart);
    const sectionBody = content.slice(sectionStart, nextSection > 0 ? nextSection : undefined).trim();

    if (sectionBody === '' || sectionBody === '[No data yet]' || sectionBody === '*[To be filled by agent]*') {
      const lineNum = content.slice(0, sectionMatch.index).split('\n').length;
      issues.push({
        file: filePath, line: lineNum, rule: 'empty-section',
        message: `Empty section: ## ${sectionMatch[1]}`,
        fixable: false,
      });
    }
  }

  // v0.41 content-sanity rules. Two new lint rules (huge-page +
  // scraper-junk) backed by the shared assessor in
  // src/core/content-sanity.ts so the threshold + pattern set stays
  // in sync with the ingest gate at importFromContent. Kill-switch
  // (contentSanity.disabled) suppresses both.
  //
  // Bytes are measured against the parsed body (compiled_truth +
  // timeline) for parity with doctor's `oversized_pages` check (D2).
  // The earlier file-byte design disagreed with doctor on pages with
  // large frontmatter; pulling from parsed keeps the surfaces aligned
  // on the operationally-meaningful axis (embed pipeline input).
  const cs = opts.contentSanity ?? {};
  if (cs.disabled !== true) {
    const operator_literals = cs.junk_patterns_enabled !== false
      ? (cs.operator_literals ?? [])
      : [];
    const sanity = assessContentSanity({
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline ?? '',
      title: parsed.title,
      bytes_warn: cs.bytes_warn,
      bytes_block: cs.bytes_block,
      extra_literals: operator_literals,
    });
    // Rule: huge-page fires for both oversize_warn (over warn threshold)
    // AND oversize_block (over block threshold). Operator sees the same
    // rule name in both cases; the message names the actual byte count.
    if (sanity.reasons.includes('oversize_warn') || sanity.reasons.includes('oversize_block')) {
      const threshold = sanity.reasons.includes('oversize_block') ? 'block' : 'warn';
      issues.push({
        file: filePath, line: 1, rule: 'huge-page',
        message: `Page body is ${sanity.bytes} bytes (exceeds ${threshold} threshold)`,
        fixable: false,
      });
    }
    // Rule: scraper-junk fires on any built-in pattern or operator literal hit.
    // Message names which pattern(s) matched so the brain-author can
    // either delete the file from their source repo or audit the scraper.
    if (sanity.junk_pattern_matches.length > 0 || sanity.literal_substring_matches.length > 0) {
      const matched = [
        ...sanity.junk_pattern_matches,
        ...sanity.literal_substring_matches,
      ].join(', ');
      issues.push({
        file: filePath, line: 1, rule: 'scraper-junk',
        message: `Matched junk pattern(s): ${matched}`,
        fixable: false,
      });
    }
  }

  return issues;
}

/** Auto-fix fixable issues */
export function fixContent(content: string): string {
  let fixed = content;

  // Fix LLM preambles
  for (const pattern of LLM_PREAMBLES) {
    pattern.lastIndex = 0;
    fixed = fixed.replace(pattern, '');
  }

  // Fix wrapping code fences
  fixed = fixed.replace(/^```(?:markdown|md)\s*\n/, '');
  fixed = fixed.replace(/\n```\s*$/, '');

  // Clean up excessive blank lines left by fixes
  fixed = fixed.replace(/\n{3,}/g, '\n\n');

  return fixed.trim() + '\n';
}

/**
 * Resolve effective content-sanity opts for lint (D1: file/env first,
 * lift DB-plane when an engine is reachable).
 *
 * File/env path is sync via `loadConfig()`; DB-plane lift requires a
 * brief engine open. Best-effort: any engine failure (no brain
 * configured, connection refused, transient error) falls through to
 * the file/env values. CI without `~/.gbrain/` falls through
 * immediately since `loadConfig()` returns minimal config.
 *
 * Also loads the operator literals file (`~/.gbrain/junk-substrings.txt`)
 * once per lint invocation so multi-file lint runs amortize the read.
 */
async function resolveLintContentSanity(
  sharedEngine?: BrainEngine,
): Promise<LintContentOpts['contentSanity']> {
  const base = loadConfig();
  let cs = base?.content_sanity;

  // DB-plane lift. issue #1678: when the caller already holds a live engine
  // (the cycle's lint phase, the Minion lint handler), REUSE it — do NOT
  // create + disconnect our own. A self-created engine here is module-style
  // (createEngine without poolSize wraps the db.ts singleton), so its
  // disconnect() cascades to db.disconnect() and NULLS the shared singleton
  // mid-cycle — which broke every subsequent cycle phase with a misleading
  // "connect() has not been called". Reusing the live engine reads the same
  // 4 config keys with zero connection churn.
  if (sharedEngine) {
    try {
      const lifted = await loadConfigWithEngine(sharedEngine, base);
      cs = lifted?.content_sanity ?? cs;
    } catch {
      // best-effort; fall through to file/env values.
    }
  } else {
    // Standalone path (CLI `gbrain lint`, which is CLI_ONLY and shares no
    // engine): only attempt when the file/env config suggests an engine is
    // configured. Avoids spinning up a fresh PGLite just to read 4 config
    // keys in a CI lint run that has no brain at all. Safe to create +
    // disconnect here because nothing else shares this process's singleton.
    const hasEngineConfig = !!(base?.database_url || base?.database_path);
    if (hasEngineConfig) {
      try {
        const { createEngine } = await import('../core/engine-factory.ts');
        const engine = await createEngine({
          engine: base!.engine,
          database_url: base!.database_url,
          database_path: base!.database_path,
        });
        try {
          await engine.connect({});
          const lifted = await loadConfigWithEngine(engine, base);
          cs = lifted?.content_sanity ?? cs;
        } finally {
          await engine.disconnect().catch(() => { /* best-effort cleanup */ });
        }
      } catch {
        // Engine unreachable or failed mid-probe — fall through to
        // file/env values. Lint should never block on engine state.
      }
    }
  }

  // Operator literals: always attempt to load (cheap FS read; missing
  // file is the common case and returns []). Skip when kill-switch
  // is on or junk patterns explicitly disabled to match the assessor's
  // own bypass logic exactly.
  const operator_literals = cs?.disabled === true || cs?.junk_patterns_enabled === false
    ? []
    : loadOperatorLiterals();

  return {
    ...cs,
    operator_literals,
  };
}

/** Collect markdown files from a directory */
function collectPages(dir: string): string[] {
  const pages: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const full = join(d, entry);
      if (lstatSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) pages.push(full);
    }
  }
  walk(dir);
  return pages.sort();
}

export interface LintOpts {
  target: string;
  fix?: boolean;
  dryRun?: boolean;
  /** v0.41: optional pre-resolved content-sanity opts. When omitted,
   *  `runLintCore` resolves via the file/env/DB chain. Tests inject
   *  this directly to bypass the FS + engine layers. */
  contentSanity?: LintContentOpts['contentSanity'];
  /** issue #1678: a live, already-connected engine to REUSE for the
   *  content-sanity DB-plane config lift. Callers with a shared engine (the
   *  cycle lint phase, Minion lint handlers) MUST pass it so lint doesn't
   *  create + disconnect a competing module-style engine that nulls the
   *  shared db singleton mid-cycle. */
  engine?: BrainEngine;
}

export interface LintResult {
  pages_scanned: number;
  pages_with_issues: number;
  total_issues: number;
  total_fixed: number;
  dryRun: boolean;
  applied_fix: boolean;
}

/**
 * Library-level lint. Throws on validation errors (missing target, target
 * not found); lints otherwise. Does NOT print human-readable details (the
 * CLI wrapper handles that) — returns counts so Minions handlers can
 * report structured results. Safe from the worker — no process.exit.
 */
export async function runLintCore(opts: LintOpts): Promise<LintResult> {
  if (!opts.target) {
    throw new Error('lint: target (dir|file.md) required');
  }
  if (!existsSync(opts.target)) {
    throw new Error(`Not found: ${opts.target}`);
  }

  const isSingleFile = statSync(opts.target).isFile();
  const pages = isSingleFile ? [opts.target] : collectPages(opts.target);

  // Resolve content-sanity config once for this lint run (D1: lift DB
  // config when reachable). Caller can pre-pass via opts.contentSanity
  // (tests, Minion handler) to bypass the engine probe entirely.
  const contentSanity = opts.contentSanity ?? await resolveLintContentSanity(opts.engine);
  const lintOpts: LintContentOpts = { contentSanity };

  let totalIssues = 0;
  let totalFixed = 0;
  let pagesWithIssues = 0;

  for (const page of pages) {
    const content = readFileSync(page, 'utf-8');
    const issues = lintContent(content, isSingleFile ? page : relative(opts.target, page), lintOpts);
    if (issues.length === 0) continue;
    pagesWithIssues++;
    totalIssues += issues.length;

    if (opts.fix && issues.some(i => i.fixable)) {
      const fixed = fixContent(content);
      if (fixed !== content) {
        const fixCount = issues.filter(i => i.fixable).length;
        totalFixed += fixCount;
        if (!opts.dryRun) {
          writeFileSync(page, fixed);
        }
      }
    }
  }

  return {
    pages_scanned: pages.length,
    pages_with_issues: pagesWithIssues,
    total_issues: totalIssues,
    total_fixed: totalFixed,
    dryRun: !!opts.dryRun,
    applied_fix: !!opts.fix,
  };
}

export async function runLint(args: string[]) {
  const target = args.find(a => !a.startsWith('--'));
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');

  if (!target) {
    console.error('Usage: gbrain lint <dir|file.md> [--fix] [--dry-run]');
    console.error('  --fix      Auto-fix fixable issues (LLM preambles, code fences)');
    console.error('  --dry-run  Preview fixes without writing');
    process.exit(1);
  }

  if (!existsSync(target)) {
    console.error(`Not found: ${target}`);
    process.exit(1);
  }

  // Single file or directory — print human detail as we go, then rely on
  // Core for the aggregate numbers at the end.
  const isSingleFile = statSync(target).isFile();
  const pages = isSingleFile ? [target] : collectPages(target);

  // Progress on stderr. Stdout keeps the per-issue human output it always had.
  const { createProgress } = await import('../core/progress.ts');
  const { getCliOptions, cliOptsToProgressOptions } = await import('../core/cli-options.ts');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('lint.pages', pages.length);

  // v0.41 (D1): resolve content-sanity config once for this lint run.
  // Mirrors runLintCore. The two paths must agree because runLint
  // prints human details inline; runLintCore at end computes the
  // aggregate. Sharing the resolved opts keeps both surfaces seeing
  // the same rule firings.
  const contentSanity = await resolveLintContentSanity();
  const lintContentOpts: LintContentOpts = { contentSanity };

  for (const page of pages) {
    const content = readFileSync(page, 'utf-8');
    const relPath = isSingleFile ? page : relative(target, page);
    const issues = lintContent(content, relPath, lintContentOpts);
    progress.tick(1);
    if (issues.length === 0) continue;

    console.log(`\n${relPath}:`);
    for (const issue of issues) {
      const fixLabel = issue.fixable ? ' [fixable]' : '';
      console.log(`  L${issue.line} ${issue.rule}: ${issue.message}${fixLabel}`);
    }

    if (doFix && issues.some(i => i.fixable)) {
      const fixed = fixContent(content);
      if (fixed !== content) {
        const fixCount = issues.filter(i => i.fixable).length;
        if (!dryRun) {
          writeFileSync(page, fixed);
        }
        console.log(`  ${dryRun ? '(dry run) ' : ''}Fixed ${fixCount} issue(s)`);
      }
    }
  }

  progress.finish();

  // Re-run core for the aggregate counts (cheap; re-parses contents but
  // produces canonical numbers for the summary line).
  // Pass contentSanity through so runLintCore skips its own resolve
  // (we already resolved once for the human-detail loop above).
  const result = await runLintCore({ target, fix: doFix, dryRun, contentSanity });
  console.log(`\n${result.pages_scanned} pages scanned. ${result.total_issues} issue(s) in ${result.pages_with_issues} page(s).`);
  if (doFix) {
    console.log(`${dryRun ? '(dry run) ' : ''}${result.total_fixed} auto-fixed.`);
  } else if (result.total_issues > 0) {
    console.log(`Run with --fix to auto-fix fixable issues.`);
  }
}
