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
  console.log(`gbrain frontmatter — frontmatter validation, audit, and auto-repair

Usage:
  gbrain frontmatter validate <path> [--json] [--fix] [--dry-run]
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
