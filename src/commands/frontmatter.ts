/**
 * gbrain frontmatter — Frontmatter validation, audit, and auto-repair.
 *
 * Subcommands:
 *   gbrain frontmatter validate <path> [--json] [--fix] [--dry-run]
 *     Validate one file or recursively a directory. --fix writes .bak then
 *     rewrites in place. --dry-run previews without writing.
 *
 *   gbrain frontmatter audit [--source <id>] [--json]
 *     Read-only scan across all registered sources (or one with --source).
 *     Returns AuditReport-shaped JSON with --json.
 *
 * The audit subcommand is intentionally read-only; --fix only exists on
 * validate. Pass an explicit path to validate a non-source-registered tree.
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, copyFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { parseMarkdown, type ParseValidationCode } from '../core/markdown.ts';
import {
  autoFixFrontmatter,
  scanBrainSources,
  type AuditReport,
  type AuditFix,
} from '../core/brain-writer.ts';
import { isSyncable, slugifyPath } from '../core/sync.ts';

export async function runFrontmatter(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  const rest = args.slice(1);

  if (sub === 'validate') {
    await runValidate(rest);
    return;
  }
  if (sub === 'audit') {
    const engine = await connectEngineForAudit();
    try {
      await runAudit(engine, rest);
    } finally {
      await engine.disconnect();
    }
    return;
  }
  if (sub === 'generate') {
    await runGenerate(rest);
    return;
  }
  if (sub === 'install-hook') {
    const { runFrontmatterInstallHook } = await import('./frontmatter-install-hook.ts');
    await runFrontmatterInstallHook(rest);
    return;
  }
  console.error(`Unknown frontmatter subcommand: ${sub}\n`);
  printHelp();
  process.exitCode = 1;
}

async function connectEngineForAudit(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    throw new Error('No brain configured. Run: gbrain init');
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  return engine;
}

function printHelp() {
  console.log(`gbrain frontmatter — frontmatter validation, audit, auto-repair, and generation

Usage:
  gbrain frontmatter validate <path> [--json] [--fix] [--dry-run]
  gbrain frontmatter generate <path> [--fix] [--dry-run] [--json]
  gbrain frontmatter audit [--source <id>] [--json]
  gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]

validate
  Validate one .md file or recursively a directory. Each file is parsed via
  parseMarkdown(..., {validate:true}); errors are reported by code:
    MISSING_OPEN, MISSING_CLOSE, YAML_PARSE, SLUG_MISMATCH,
    NULL_BYTES, NESTED_QUOTES, EMPTY_FRONTMATTER

  --fix      Auto-repair the fixable subset (NULL_BYTES, MISSING_CLOSE,
             NESTED_QUOTES, SLUG_MISMATCH). Writes <file>.bak before any
             in-place rewrite. .bak is the safety contract; works for both
             git and non-git brain repos.
  --dry-run  Preview --fix without writing.
  --json     Emit a JSON envelope on stdout.

generate
  Synthesize frontmatter for files that have none (MISSING_OPEN). Uses
  directory-aware rules to infer type, title, date, source, and tags from
  the filesystem path and file content. Zero LLM calls, fully deterministic.

  Without --fix: dry-run preview showing what would be generated.
  With --fix: writes frontmatter to files (with .bak safety backups).

  Rules are defined in src/core/frontmatter-inference.ts DIRECTORY_RULES.
  Add new directory conventions by adding rules to the table.

  Examples:
    gbrain frontmatter generate /path/to/brain              # preview all
    gbrain frontmatter generate /path/to/brain --fix        # write all
    gbrain frontmatter generate /path/to/brain/people/ --fix # just people/

  --fix      Write generated frontmatter to files (.bak safety backups).
  --dry-run  Preview without writing (default when --fix is omitted).
  --json     Emit JSON output.

audit
  Read-only scan across all registered sources (or one with --source <id>).
  Reports per-source counts grouped by error code. Use this in CI or doctor
  pipelines. Exits 0 even when issues are found — the count is the signal.

  --source <id>  Limit scan to one registered source.
  --json         Emit AuditReport-shaped JSON on stdout.
`);
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

interface ValidateFlags {
  json: boolean;
  fix: boolean;
  dryRun: boolean;
}

interface FileValidation {
  path: string;
  errors: { code: ParseValidationCode; message: string; line?: number }[];
  fixesApplied?: AuditFix[];
}

async function runValidate(rest: string[]): Promise<void> {
  const flags: ValidateFlags = { json: false, fix: false, dryRun: false };
  let target: string | null = null;
  for (const a of rest) {
    if (a === '--json') flags.json = true;
    else if (a === '--fix') flags.fix = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (!a.startsWith('--')) target = a;
  }
  if (!target) {
    console.error('error: gbrain frontmatter validate requires a <path> argument');
    process.exitCode = 1;
    return;
  }

  const resolved = resolve(target);
  if (!existsSync(resolved)) {
    console.error(`error: path not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const files = collectFiles(resolved);
  const results: FileValidation[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const expectedSlug = slugifyPath(relative(resolve(target), file) || file);
    const parsed = parseMarkdown(content, file, { validate: true, expectedSlug });
    const errs = parsed.errors ?? [];
    const result: FileValidation = {
      path: file,
      errors: errs.map(e => ({ code: e.code, message: e.message, line: e.line })),
    };

    if (flags.fix && errs.length > 0) {
      const { content: fixed, fixes } = autoFixFrontmatter(content, { filePath: file });
      result.fixesApplied = fixes;
      if (fixes.length > 0 && !flags.dryRun) {
        copyFileSync(file, file + '.bak');
        writeFileSync(file, fixed, 'utf8');
      }
    }

    results.push(result);
  }

  const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
  const filesWithErrors = results.filter(r => r.errors.length > 0).length;
  const filesFixed = results.filter(r => (r.fixesApplied?.length ?? 0) > 0).length;

  if (flags.json) {
    const envelope = {
      ok: totalErrors === 0,
      target: resolved,
      total_files: files.length,
      files_with_errors: filesWithErrors,
      total_errors: totalErrors,
      files_fixed: flags.fix ? filesFixed : undefined,
      dry_run: flags.dryRun || undefined,
      results,
    };
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    if (totalErrors === 0) {
      console.log(`OK — ${files.length} file(s) scanned, no frontmatter issues`);
    } else {
      console.log(`Found ${totalErrors} issue(s) across ${filesWithErrors} file(s) (scanned ${files.length})`);
      for (const r of results) {
        if (r.errors.length === 0) continue;
        console.log(`\n${r.path}`);
        for (const e of r.errors) {
          const lineHint = e.line !== undefined ? `:${e.line}` : '';
          console.log(`  [${e.code}]${lineHint} ${e.message}`);
        }
        if (r.fixesApplied && r.fixesApplied.length > 0) {
          const verb = flags.dryRun ? 'would fix' : 'fixed';
          for (const f of r.fixesApplied) {
            console.log(`  ${verb}: ${f.description}`);
          }
        }
      }
      if (flags.fix && !flags.dryRun) {
        console.log(`\nWrote .bak backups for ${filesFixed} file(s).`);
      }
    }
  }

  process.exitCode = totalErrors > 0 && !flags.fix ? 1 : 0;
}

function collectFiles(target: string): string[] {
  const st = lstatSync(target);
  if (st.isFile()) {
    return [target];
  }
  const out: string[] = [];
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let entryStat: ReturnType<typeof lstatSync>;
      try {
        entryStat = lstatSync(full);
      } catch {
        continue;
      }
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        stack.push(full);
      } else if (entryStat.isFile()) {
        const rel = relative(target, full);
        if (isSyncable(rel, { strategy: 'markdown' })) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

async function runAudit(engine: BrainEngine, rest: string[]): Promise<void> {
  let json = false;
  let sourceId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') json = true;
    else if (a === '--source') sourceId = rest[++i];
    else if (a.startsWith('--source=')) sourceId = a.slice('--source='.length);
  }

  const report = await scanBrainSources(engine, { sourceId });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printAuditHumanReport(report);
}

function printAuditHumanReport(report: AuditReport): void {
  if (report.per_source.length === 0) {
    console.log('No registered sources to audit. Run `gbrain sources list` to inspect.');
    return;
  }
  console.log(`Frontmatter audit — ${report.total} issue(s) across ${report.per_source.length} source(s) (scanned at ${report.scanned_at})`);
  for (const src of report.per_source) {
    console.log(`\n[${src.source_id}] ${src.source_path}`);
    if (src.total === 0) {
      console.log('  clean');
      continue;
    }
    console.log(`  ${src.total} issue(s)`);
    for (const [code, n] of Object.entries(src.errors_by_code)) {
      console.log(`    ${code}: ${n}`);
    }
    if (src.sample.length > 0) {
      console.log(`  sample:`);
      for (const s of src.sample.slice(0, 5)) {
        console.log(`    ${s.path} — ${s.codes.join(', ')}`);
      }
      if (src.sample.length > 5) console.log(`    (+ ${src.sample.length - 5} more)`);
    }
  }
  if (report.total > 0) {
    console.log(`\nFix with: gbrain frontmatter validate <source-path> --fix`);
  }
}

// ---------------------------------------------------------------------------
// generate — synthesize frontmatter for files that have none
// ---------------------------------------------------------------------------

async function runGenerate(args: string[]): Promise<void> {
  const targetPath = args.find(a => !a.startsWith('-'));
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  const jsonOut = args.includes('--json');

  if (!targetPath) {
    console.error('error: gbrain frontmatter generate requires a <path> argument');
    console.error('usage: gbrain frontmatter generate <path> [--fix] [--dry-run] [--json]');
    process.exitCode = 1;
    return;
  }

  const { inferFrontmatter, serializeFrontmatter } = await import('../core/frontmatter-inference.ts');
  const { resolve, relative, join, basename } = await import('path');
  const { readFileSync, writeFileSync, copyFileSync, statSync, readdirSync, lstatSync } = await import('fs');

  const rootPath = resolve(targetPath);
  const isDir = statSync(rootPath).isDirectory();

  // Find the brain root — walk up from targetPath looking for .git or known brain markers.
  // Inference rules match against brain-root-relative paths (e.g., "people/alice.md").
  let brainRoot = rootPath;
  if (isDir) {
    let candidate = rootPath;
    for (let i = 0; i < 10; i++) {
      try {
        statSync(join(candidate, '.git'));
        brainRoot = candidate;
        break;
      } catch {
        const parent = resolve(candidate, '..');
        if (parent === candidate) break;
        candidate = parent;
      }
    }
  }

  interface GenerateResult {
    path: string;
    type: string;
    title: string;
    date?: string;
    rule: string;
  }

  const results: GenerateResult[] = [];
  let scanned = 0;
  let skipped = 0;
  let generated = 0;
  let written = 0;

  function processFile(absPath: string, relPath: string) {
    scanned++;
    if (!absPath.endsWith('.md')) return;

    // Skip symlinks
    try { if (lstatSync(absPath).isSymbolicLink()) return; } catch { return; }

    let content: string;
    try { content = readFileSync(absPath, 'utf-8'); } catch { return; }

    const inferred = inferFrontmatter(relPath, content);
    if (inferred.skipped) {
      skipped++;
      return;
    }

    generated++;
    results.push({
      path: relPath,
      type: inferred.type,
      title: inferred.title,
      date: inferred.date,
      rule: inferred.matchedRule || '(default)',
    });

    if (doFix && !dryRun) {
      const fm = serializeFrontmatter(inferred);
      const newContent = fm + '\n' + content;
      // Safety: write .bak first
      copyFileSync(absPath, absPath + '.bak');
      writeFileSync(absPath, newContent, 'utf-8');
      written++;
    }
  }

  function walkDir(dir: string, rootForRel: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === '.obsidian') continue;
      const abs = join(dir, entry);
      try {
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          walkDir(abs, rootForRel);
        } else if (stat.isFile() && entry.endsWith('.md')) {
          processFile(abs, relative(rootForRel, abs));
        }
      } catch { /* skip unreadable */ }
    }
  }

  if (isDir) {
    walkDir(rootPath, brainRoot);
  } else {
    const relPath = relative(brainRoot, rootPath) || basename(rootPath);
    processFile(rootPath, relPath);
  }

  // Output
  if (jsonOut) {
    console.log(JSON.stringify({
      scanned,
      skipped,
      generated,
      written,
      dryRun: !doFix || dryRun,
      results: results.slice(0, 100), // Cap JSON output
      totalResults: results.length,
    }, null, 2));
    return;
  }

  // Human-readable output
  const mode = doFix && !dryRun ? 'WRITE' : 'DRY-RUN';
  console.log(`\nFrontmatter generation (${mode})`);
  console.log(`  Scanned: ${scanned} files`);
  console.log(`  Already have frontmatter: ${skipped}`);
  console.log(`  Would generate: ${generated}`);
  if (doFix && !dryRun) {
    console.log(`  Written: ${written} (with .bak backups)`);
  }

  // Show sample by type
  const byType: Record<string, number> = {};
  for (const r of results) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  if (Object.keys(byType).length > 0) {
    console.log(`\n  By type:`);
    for (const [type, count] of Object.entries(byType).sort(([, a], [, b]) => b - a)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  // Show first 10 examples
  if (results.length > 0 && (!doFix || dryRun)) {
    console.log(`\n  Examples:`);
    for (const r of results.slice(0, 10)) {
      console.log(`    ${r.path}`);
      console.log(`      → type: ${r.type}, title: "${r.title}"${r.date ? `, date: ${r.date}` : ''} [rule: ${r.rule}]`);
    }
    if (results.length > 10) {
      console.log(`    ... and ${results.length - 10} more`);
    }
    if (!doFix) {
      console.log(`\n  To write: gbrain frontmatter generate ${targetPath} --fix`);
    }
  }
}
