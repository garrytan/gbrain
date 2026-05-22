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

export function lintContent(content: string, filePath: string): LintIssue[] {
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

  let totalIssues = 0;
  let totalFixed = 0;
  let pagesWithIssues = 0;

  for (const page of pages) {
    const content = readFileSync(page, 'utf-8');
    const issues = lintContent(content, isSingleFile ? page : relative(opts.target, page));
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

  for (const page of pages) {
    const content = readFileSync(page, 'utf-8');
    const relPath = isSingleFile ? page : relative(target, page);
    const issues = lintContent(content, relPath);
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
  const result = await runLintCore({ target, fix: doFix, dryRun });
  console.log(`\n${result.pages_scanned} pages scanned. ${result.total_issues} issue(s) in ${result.pages_with_issues} page(s).`);
  if (doFix) {
    console.log(`${dryRun ? '(dry run) ' : ''}${result.total_fixed} auto-fixed.`);
  } else if (result.total_issues > 0) {
    console.log(`Run with --fix to auto-fix fixable issues.`);
  }
}
