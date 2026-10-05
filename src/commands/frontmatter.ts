import { assertManagedFilesystemWrite, managedFilesystemRootFor } from '../core/persistence/filesystem-guard.ts';
/**
 * gbrain frontmatter — Frontmatter validation, audit, and auto-repair.
 *
 * Subcommands:
 *   gbrain frontmatter validate <path> [--json] [--importable] [--fix [--include-ambiguous]] [--dry-run]
 *   gbrain frontmatter validate --stdin|- [--path <source-relative path>] [--importable] [--json]
 *   gbrain frontmatter validate --staged [<path>...] [--importable] [--json]
 *     Validate one file, a directory, piped content, or staged git blobs.
 *     Strict producer rule by default (any error fails); --importable is the
 *     ingestion hold view. --fix writes centralized backups under
 *     ~/.gbrain/backups/frontmatter/... then rewrites in place and
 *     re-validates. --dry-run previews without writing.
 *
 *   gbrain frontmatter audit [--source <id>] [--json]
 *     Read-only scan across all registered sources (or one with --source).
 *     Returns AuditReport-shaped JSON with --json.
 *
 * The audit subcommand is intentionally read-only; --fix only exists on
 * validate. Pass an explicit path to validate a non-source-registered tree.
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, readdirSync } from 'fs';
import { execFileSync } from '../core/spawn.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { join, relative, resolve, basename, dirname, isAbsolute, posix } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { parseMarkdown, type ParseValidationCode, type ParseWarningCode } from '../core/markdown.ts';
import { MAX_FILE_SIZE, screenImportContent, type ContentRefusal } from '../core/import-screen.ts';
import { readStdinBounded } from '../core/interaction.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { shellQuote } from '../core/shell-quote.ts';
import {
  autoFixFrontmatter,
  repairRecoverableFrontmatter,
  createFrontmatterBackup,
  isFrontmatterScannablePath,
  makeFrontmatterBackupRunId,
  scanBrainSources,
  type AuditReport,
  type AuditFix,
} from '../core/brain-writer.ts';
import { collectGitVisibleFiles } from '../core/git-visible-files.ts';
import { isMarkdownFilePath, pruneDir, slugifyPath } from '../core/sync.ts';
import { isPathContained } from '../core/path-confine.ts';

/** Test seams: the stream `validate --stdin` reads, and the directory `--staged` runs git in. */
export interface FrontmatterIo {
  stdin?: NodeJS.ReadableStream;
  cwd?: string;
}

export async function runFrontmatter(args: string[], io: FrontmatterIo = {}): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  const rest = args.slice(1);

  if (sub === 'validate') {
    await runValidate(rest, io);
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
  setCliExitVerdict(1);
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
  gbrain frontmatter validate <path> [--json] [--importable] [--fix [--include-ambiguous]] [--dry-run]
  gbrain frontmatter validate --stdin [--path <source-relative path>] [--importable] [--json]
  gbrain frontmatter validate --staged [<path>...] [--importable] [--json]
  gbrain frontmatter generate <path> [--fix] [--dry-run] [--json] [--include-catch-all]
  gbrain frontmatter audit [--source <id>] [--json]
  gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]

validate
  Validate one .md file or recursively a directory. Each file is parsed via
  parseMarkdown(..., {validate:true}); errors are reported by code:
    MISSING_OPEN, MISSING_CLOSE, YAML_PARSE, SLUG_MISMATCH,
    NULL_BYTES, NESTED_QUOTES, EMPTY_FRONTMATTER
  Producer rule (default): exits 1 on any error, including YAML_PARSE that
  gbrain could still import by quoting a value. Use it before committing
  generated files.

  --importable   Ingestion view instead: exit 1 only for what import/sync
                 would hold (invalid_frontmatter, frontmatter_slug_conflict,
                 file_too_large). Recovered and #-comment values are reported.
  --stdin, -     Validate content piped on stdin (nothing is written).
  --path <p>     With --stdin: the source-relative path the content would
                 live at, so the declared slug is checked. Without it the
                 slug check is skipped (and says so).
  --staged       Validate the staged (git index) version of each staged
                 .md/.mdx file, or of the named paths, in one process. This
                 is what the pre-commit hook runs.
  --fix          Auto-repair: NULL_BYTES, MISSING_CLOSE, NESTED_QUOTES,
                 SLUG_MISMATCH, and YAML gbrain reads by quoting (only the
                 recovered lines change; line endings and BOM kept). Writes a
                 backup under ~/.gbrain/backups/frontmatter/... first, then
                 re-validates: exit 1 when errors remain. In a git repo,
                 restage the fixed files afterwards (git add). On a managed
                 brain use gbrain repair frontmatter --source <id> instead.
  --include-ambiguous
                 With --fix: also apply interpretations (fold unquoted
                 continuation lines into the value, keep the later of a
                 duplicated key, quote an unclosed [ or {, quote a #-leading
                 title). Preview them with --dry-run first.
  --dry-run      Preview --fix without writing.
  --json         Emit a JSON envelope on stdout.

generate
  Synthesize frontmatter for files that have none (MISSING_OPEN). Uses
  directory-aware rules to infer type, title, date, source, and tags from
  the filesystem path and file content. Zero LLM calls, fully deterministic.

  Without --fix: dry-run preview showing what would be generated.
  With --fix: writes frontmatter to files with centralized safety backups.
  Unknown/catch-all files are skipped by default so GBrain does not stamp
  meaningless "type: note" metadata onto arbitrary workspace documents. Pass
  --include-catch-all to opt into the legacy catch-all note behavior.

  Rules are defined in src/core/frontmatter-inference.ts DIRECTORY_RULES.
  Add new directory conventions by adding rules to the table.

  Examples:
    gbrain frontmatter generate /path/to/brain              # preview all
    gbrain frontmatter generate /path/to/brain --fix        # write all
    gbrain frontmatter generate /path/to/brain/people/ --fix # just people/

  --fix      Write generated frontmatter to files with centralized backups.
  --dry-run  Preview without writing (default when --fix is omitted).
  --json     Emit JSON output.
  --include-catch-all
             Also write the default catch-all rule ("type: note") for paths
             that do not match a more specific directory rule.

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
  importable: boolean;
  includeAmbiguous: boolean;
  stdin: boolean;
  staged: boolean;
  /** --stdin only: the source-relative path the content would live at (enables the slug check). */
  path?: string;
}

interface ValidationIssue {
  code: ParseValidationCode;
  message: string;
  line?: number;
  /** YAML_PARSE only: ingestion reads it by quoting; producer checks still fail on it. */
  recoverable?: boolean;
}

interface FileValidation {
  path: string;
  errors: ValidationIssue[];
  /** Local only: FRONTMATTER_RECOVERED carries the original line and its quoted replacement. */
  warnings?: Array<{ code: ParseWarningCode; message: string; key: string; line: number; original?: string; replacement?: string }>;
  /** --importable: the hold ingestion would record; null when the file imports. */
  hold?: ContentRefusal | null;
  /** The strict check fails only on YAML gbrain reads by quoting. */
  importable_but_not_canonical?: boolean;
  fixesApplied?: AuditFix[];
  backupPath?: string;
  /** --fix: what still fails once the fixes are applied (re-validated). */
  remaining_errors?: ValidationIssue[];
  remaining_hold?: ContentRefusal | null;
  /** --staged: whether the working-tree copy passes the same check (false when absent or failing). */
  working_copy_ok?: boolean;
  /** Why the file could not be checked at all. */
  note?: string;
  failed: boolean;
}

interface ContentCheck {
  errors: ValidationIssue[];
  warnings: NonNullable<FileValidation['warnings']>;
  hold: ContentRefusal | null;
  failed: boolean;
  canonicalOnly: boolean;
}

/**
 * Producer rule by default: any error fails, including YAML_PARSE ingestion
 * could recover. `importable` switches to the ingestion view: only what
 * `screenImportContent` refuses (the hold codes) fails. `slugPath` is the
 * path the slug derives from; without it the slug check is skipped.
 */
function checkContent(content: string, slugPath: string | undefined, importable: boolean): ContentCheck {
  const expectedSlug = slugPath ? slugifyPath(slugPath) : undefined;
  const parsed = parseMarkdown(content, slugPath, { validate: true, ...(expectedSlug ? { expectedSlug } : {}) });
  const errors = (parsed.errors ?? []).map(e => ({ code: e.code, message: e.message, line: e.line, ...(e.recoverable ? { recoverable: true } : {}) }));
  const warnings = (parsed.warnings ?? []).map(w => ({ code: w.code, message: w.message, key: w.key, line: w.line,
    ...(w.original !== undefined ? { original: w.original } : {}), ...(w.replacement !== undefined ? { replacement: w.replacement } : {}) }));
  const screen = importable ? screenImportContent({ content, path: slugPath ?? 'stdin.md', expectedSlug }) : null;
  const hold = screen?.status === 'refused' ? screen.refusal : null;
  return {
    errors, warnings, hold,
    failed: importable ? hold !== null : errors.length > 0,
    canonicalOnly: !importable && errors.length > 0 && errors.every(e => e.code === 'YAML_PARSE' && e.recoverable),
  };
}

/**
 * Walk up from `start` (file or dir) to the brain root — the nearest ancestor
 * containing a `.git` marker — so slug derivation is brain-root-relative,
 * matching how sync/extract compute slugs. Falls back to the start's own
 * directory when no marker is found. Fixes #565: for a single-file target,
 * `relative(resolve(target), file)` was empty (target === file) and fell back
 * to the ABSOLUTE path, yielding bogus "root/brain/..." slugs and false
 * SLUG_MISMATCH — which the install-hook pre-commit hook hits on every commit.
 */
function findBrainRoot(start: string): string {
  const startDir = lstatSync(start).isDirectory() ? start : dirname(start);
  let candidate = startDir;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(candidate, '.git'))) return candidate;
    const parent = resolve(candidate, '..');
    if (parent === candidate) break;
    candidate = parent;
  }
  return startDir;
}

/**
 * The staged blob of each path (`git show :<path>` for all of them in one
 * `ls-files` and one `cat-file --batch`), root-relative. No paths: every
 * added, copied or modified staged Markdown file. A path with no index entry
 * comes back with `content: null`.
 */
function readStagedBlobs(paths: string[], cwd = process.cwd()): { root: string; files: Array<{ rel: string; content: string | null }> } {
  const git = (args: string[], input?: string): Buffer =>
    execFileSync('git', ['--literal-pathspecs', ...args], { cwd, input, maxBuffer: 1 << 30, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const root = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const listed = paths.length > 0
    ? git(['ls-files', '--stage', '--full-name', '-z', '--', ...paths])
    : (() => {
      const names = git(['-C', root, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACM']).toString('utf8').split('\0').filter(isMarkdownFilePath);
      return names.length > 0 ? git(['-C', root, 'ls-files', '--stage', '-z', '--', ...names]) : Buffer.alloc(0);
    })();
  const entries = listed.toString('utf8').split('\0').filter(Boolean)
    .map(record => /^\d+ ([0-9a-f]+) (\d)\t(.*)$/s.exec(record))
    .filter((m): m is RegExpExecArray => m !== null && m[2] === '0' && isMarkdownFilePath(m[3]!))
    .map(m => ({ oid: m[1]!, rel: m[3]! }));
  const files: Array<{ rel: string; content: string | null }> = [];
  if (entries.length > 0) {
    const out = git(['-C', root, 'cat-file', '--batch'], entries.map(e => e.oid).join('\n') + '\n');
    let pos = 0;
    for (const entry of entries) {
      const eol = out.indexOf(10, pos);
      const header = out.subarray(pos, eol).toString('utf8').split(' ');
      if (header[1] !== 'blob') { files.push({ rel: entry.rel, content: null }); pos = eol + 1; continue; }
      const size = Number(header[2]);
      files.push({ rel: entry.rel, content: out.subarray(eol + 1, eol + 1 + size).toString('utf8') });
      pos = eol + 1 + size + 1;
    }
  }
  if (paths.length > 0) {
    const prefix = git(['rev-parse', '--show-prefix']).toString('utf8').trim();
    for (const p of paths) {
      const full = isAbsolute(p) ? relative(root, p) : posix.normalize(prefix + p);
      if (!files.some(f => f.rel === full || f.rel.startsWith(full.replace(/\/$/, '') + '/'))) files.push({ rel: full, content: null });
    }
  }
  return { root, files };
}

/** `validate --fix` on a managed brain: name the coordinated repair instead of a bare coordinator error. */
function managedFixRefusal(file: string, error: OperationError): OperationError {
  const sourceId = managedFilesystemRootFor(file)?.sourceId;
  return opError('writer_coordinator_required',
    `${file} is in a managed brain${sourceId ? ` (source ${sourceId})` : ''}, so frontmatter validate --fix cannot rewrite it in place.`,
    `Preview the repair with gbrain repair frontmatter${sourceId ? ` --source ${sourceId}` : ''}; it writes through the persistence coordinator, and only after the preview hash is approved.`,
    {
      why: 'Files in a managed canonical worktree change only through the persistence coordinator, so the page and its file stay in step.',
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
      fix: {
        argv: ['gbrain', 'repair', 'frontmatter', ...(sourceId ? ['--source', sourceId] : [])],
        consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Previews every frontmatter repair with its diff and a hash; nothing is written until that hash is applied.',
      },
    });
}

function usage(message: string): void {
  console.error(`error: ${message}`);
  setCliExitVerdict(1);
}

async function runValidate(rest: string[], io: FrontmatterIo): Promise<void> {
  const flags: ValidateFlags = { json: false, fix: false, dryRun: false, importable: false, includeAmbiguous: false, stdin: false, staged: false };
  const targets: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') { targets.push(...rest.slice(i + 1)); break; }
    if (a === '--json') flags.json = true;
    else if (a === '--fix') flags.fix = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--importable') flags.importable = true;
    else if (a === '--include-ambiguous') flags.includeAmbiguous = true;
    else if (a === '--stdin' || a === '-') flags.stdin = true;
    else if (a === '--staged') flags.staged = true;
    else if (a === '--path') flags.path = rest[++i];
    else if (a.startsWith('--path=')) flags.path = a.slice('--path='.length);
    else if (!a.startsWith('--')) targets.push(a);
  }
  if (flags.path !== undefined && (!flags.stdin || !flags.path)) {
    usage('--path names where --stdin content would live (source-relative, e.g. --path people/alice-example.md); it needs --stdin and a value.');
    return;
  }
  if (flags.fix && (flags.stdin || flags.staged)) {
    usage(`--fix rewrites working-tree files, not ${flags.stdin ? 'stdin' : 'staged blobs'}. Run: gbrain frontmatter validate <file> --fix${flags.staged ? ', then git add <file>' : ''}`);
    return;
  }
  if (flags.stdin && flags.staged) {
    usage('pass either --stdin or --staged, not both.');
    return;
  }

  const results: FileValidation[] = [];
  let scanned = 0;
  let targetLabel: string;
  let slugCheckSkipped = false;
  const fixedInGit: string[] = [];

  if (flags.stdin) {
    const read = await readStdinBounded({ maxBytes: 2 * MAX_FILE_SIZE, ...(io.stdin ? { stream: io.stdin } : {}) });
    if (read.kind !== 'data' && read.kind !== 'empty') {
      usage(`could not read stdin (${read.kind === 'error' ? read.error.message : read.kind}). Pipe the content in: cat <file> | gbrain frontmatter validate --stdin --path <source-relative path>`);
      return;
    }
    const content = read.kind === 'data' ? read.text : '';
    targetLabel = flags.path ?? '<stdin>';
    slugCheckSkipped = flags.path === undefined;
    const check = checkContent(content, flags.path, flags.importable);
    results.push(toResult(targetLabel, check));
    scanned = 1;
  } else if (flags.staged) {
    let staged: ReturnType<typeof readStagedBlobs>;
    try {
      staged = readStagedBlobs(targets, io.cwd);
    } catch (error) {
      usage(`--staged reads the git index, which failed here (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Run it inside the repository: cd <repo> && gbrain frontmatter validate --staged`);
      return;
    }
    targetLabel = staged.root;
    for (const file of staged.files) {
      scanned++;
      if (file.content === null) {
        results.push({ path: file.rel, errors: [], failed: true, note: `No staged version of ${file.rel}. Stage it first: git add ${file.rel}` });
        continue;
      }
      const check = checkContent(file.content, file.rel, flags.importable);
      const result = toResult(file.rel, check);
      if (check.failed) {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- file.rel is a staged path from git diff --cached; isPathContained rejects anything outside the work tree
        const working = join(staged.root, file.rel);
        result.working_copy_ok = isPathContained(working, staged.root) && lstatSync(working).isFile()
          && !checkContent(readFileSync(working, 'utf8'), file.rel, flags.importable).failed;
      }
      results.push(result);
    }
  } else {
    const target = targets[targets.length - 1];
    if (!target) {
      usage('gbrain frontmatter validate requires a <path> argument (or --stdin, or --staged)');
      return;
    }
    const resolved = resolve(target);
    if (!existsSync(resolved)) {
      usage(`path not found: ${target}`);
      return;
    }
    if (lstatSync(resolved).isFile() && !isMarkdownFilePath(resolved)) {
      usage(`frontmatter validation supports only .md and .mdx files: ${target}`);
      return;
    }
    targetLabel = resolved;

    const brainRoot = findBrainRoot(resolved);
    const inGit = existsSync(join(brainRoot, '.git'));
    const files = collectFiles(resolved);
    if (flags.fix && !flags.dryRun) {
      for (const file of files) {
        try {
          assertManagedFilesystemWrite(file);
        } catch (error) {
          if (error instanceof OperationError && error.code === 'writer_coordinator_required') throw managedFixRefusal(file, error);
          throw error;
        }
      }
    }
    const backupRunId = makeFrontmatterBackupRunId();
    scanned = files.length;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const rel = relative(brainRoot, file);
      // Files above/outside the brain root fall back to basename rather than
      // emitting a "../"-prefixed slug for non-brain files.
      const slugPath = rel && !rel.startsWith('..') ? rel : basename(file);
      const check = checkContent(content, slugPath, flags.importable);
      const result = toResult(file, check);
      const rescuable = flags.includeAmbiguous && check.warnings.some(w => w.code === 'FRONTMATTER_COMMENT_VALUE');

      if (flags.fix && (check.errors.length > 0 || rescuable)) {
        // #5053: the fixer derives the slug from the same path validate used;
        // the absolute path re-keyed every declared slug as a mismatch.
        const auto = autoFixFrontmatter(content, { filePath: slugPath });
        const repaired = repairRecoverableFrontmatter(auto.content, { includeAmbiguous: flags.includeAmbiguous });
        result.fixesApplied = [...auto.fixes, ...repaired.fixes];
        if (result.fixesApplied.length > 0 && !flags.dryRun) {
          assertManagedFilesystemWrite(file);
          result.backupPath = createFrontmatterBackup(file, { sourcePath: resolved, runId: backupRunId });
          writeFileSync(file, repaired.content, 'utf8');
          if (inGit) fixedInGit.push(relative(brainRoot, file));
        }
        const after = result.fixesApplied.length > 0 ? checkContent(repaired.content, slugPath, flags.importable) : check;
        result.remaining_errors = after.errors;
        if (flags.importable) result.remaining_hold = after.hold;
        result.failed = after.failed;
      }
      results.push(result);
    }
  }

  const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
  const filesWithErrors = results.filter(r => r.errors.length > 0).length;
  const filesFixed = results.filter(r => (r.fixesApplied?.length ?? 0) > 0).length;
  const failed = results.filter(r => r.failed);

  if (flags.json) {
    console.log(JSON.stringify({
      ok: failed.length === 0,
      mode: flags.importable ? 'importable' : 'strict',
      target: targetLabel,
      ...(flags.stdin ? { stdin: true, slug_check: slugCheckSkipped ? 'skipped' : 'checked' } : {}),
      ...(flags.staged ? { staged: true } : {}),
      total_files: scanned,
      files_with_errors: filesWithErrors,
      total_errors: totalErrors,
      files_failed: failed.length,
      files_fixed: flags.fix ? filesFixed : undefined,
      dry_run: flags.dryRun || undefined,
      restage: fixedInGit.length > 0 ? fixedInGit : undefined,
      results,
    }, null, 2));
  } else {
    printValidateReport(results, { flags, scanned, totalErrors, filesWithErrors, filesFixed, slugCheckSkipped, fixedInGit });
  }

  setCliExitVerdict(failed.length > 0 ? 1 : 0);
}

function toResult(path: string, check: ContentCheck): FileValidation {
  return {
    path,
    errors: check.errors,
    ...(check.warnings.length > 0 ? { warnings: check.warnings } : {}),
    ...(check.hold !== null || check.failed ? { hold: check.hold } : {}),
    ...(check.canonicalOnly ? { importable_but_not_canonical: true } : {}),
    failed: check.failed,
  };
}

function printValidateReport(results: FileValidation[], ctx: {
  flags: ValidateFlags; scanned: number; totalErrors: number; filesWithErrors: number; filesFixed: number;
  slugCheckSkipped: boolean; fixedInGit: string[];
}): void {
  const { flags } = ctx;
  if (ctx.slugCheckSkipped) console.log('Slug check skipped: pass --path <source-relative path> to check a declared slug against its path.');
  const noisy = results.filter(r => r.errors.length > 0 || (r.warnings?.length ?? 0) > 0 || r.failed);
  if (noisy.length === 0) {
    console.log(`OK — ${ctx.scanned} ${flags.staged ? 'staged ' : ''}file(s) scanned, no frontmatter issues`);
    return;
  }
  if (ctx.totalErrors > 0) console.log(`Found ${ctx.totalErrors} issue(s) across ${ctx.filesWithErrors} file(s) (scanned ${ctx.scanned})`);
  else console.log(`${ctx.scanned} file(s) scanned; ${noisy.length} carry warnings only`);
  for (const r of noisy) {
    const label = flags.staged ? `${r.path} (staged version)` : r.path;
    console.log(`\n${label}`);
    if (r.note) console.log(`  ${r.note}`);
    for (const e of r.errors) {
      const lineHint = e.line !== undefined ? `:${e.line}` : '';
      console.log(`  [${e.code}]${lineHint} ${e.message}${e.recoverable ? ' (gbrain reads it by quoting; still not valid YAML)' : ''}`);
    }
    for (const w of r.warnings ?? []) {
      console.log(`  [${w.code}]:${w.line} ${w.message}`);
      if (w.original !== undefined && w.replacement !== undefined) {
        console.log(`      line ${w.line}: ${w.original}`);
        console.log(`      quoted: ${w.replacement}`);
      }
    }
    if (flags.importable) {
      if (!r.hold) console.log('  importable: gbrain imports this file as it is');
      else {
        console.log(`  held on import: ${r.hold.code}${r.hold.reason ? ` (${r.hold.reason})` : ''}${r.hold.line !== undefined ? ` at line ${r.hold.line}` : ''}`);
        console.log(`    ${r.hold.message}`);
        if (r.hold.reason === 'needs_interpretation' && !flags.stdin && !flags.staged) {
          console.log(`    Preview gbrain's interpretation: gbrain frontmatter validate ${r.path} --fix --include-ambiguous --dry-run`);
        }
      }
    }
    if (r.fixesApplied && r.fixesApplied.length > 0) {
      const verb = flags.dryRun ? 'would fix' : 'fixed';
      for (const f of r.fixesApplied) console.log(`  ${verb}: ${f.description}`);
    }
    if (r.remaining_errors && r.failed) {
      for (const e of r.remaining_errors) console.log(`  still failing: [${e.code}]${e.line !== undefined ? `:${e.line}` : ''} ${e.message}`);
      if (r.remaining_errors.some(e => e.code === 'YAML_PARSE') && !flags.includeAmbiguous) {
        console.log(`  Fix that line by hand (one line per key, the whole value quoted), or preview gbrain's interpretation: gbrain frontmatter validate ${r.path} --fix --include-ambiguous --dry-run`);
      }
    }
    if (r.importable_but_not_canonical && !r.fixesApplied) {
      console.log(`  importable but not canonical; run gbrain frontmatter validate ${flags.stdin ? (flags.path ?? '<file>') : r.path} --fix (quoting only)`);
    }
    if (flags.staged && r.failed && !r.note) {
      console.log(r.working_copy_ok
        ? `  the staged version of ${r.path} is broken; the working copy passes. Review it and git add ${r.path}`
        : `  the staged version of ${r.path} is broken; fix the file (gbrain frontmatter validate ${r.path} --fix), then git add ${r.path}`);
    }
  }
  if (flags.fix && !flags.dryRun && ctx.filesFixed > 0) {
    console.log(`\nWrote centralized backups for ${ctx.filesFixed} file(s) under ~/.gbrain/backups/frontmatter/.`);
  }
  if (ctx.fixedInGit.length > 0) {
    console.log(`Review the changes, then restage them: git add -- ${ctx.fixedInGit.map(p => shellQuote(p)).join(' ')}`);
  }
}

/**
 * Recursively collect every syncable `.md` file under `target`.
 *
 * Uses the canonical `pruneDir(name, parentDir)` gate (sync.ts:258) to
 * skip vendor / hidden / generated subtrees at descent time. Pre-v0.38.2.0
 * this walker descended into every subtree and let `isSyncable` filter at
 * the leaf — paying the IO cost of stat'ing every entry under node_modules,
 * .git, .obsidian, etc. That was the second instance of the v0.38.2.0 hang
 * class (the first being brain-writer.ts:walkDir). Codex outside-voice
 * caught it during plan-eng-review — fixing only walkDir would have left
 * `gbrain frontmatter validate` (doctor's own remediation hint) hanging
 * users in the same way.
 *
 * Optional `visitDir(dir)` is the test-observability hook: fired once per
 * directory the walker descends into (post-pruneDir). Production callers
 * don't pass it; the regression suite uses it to assert descent-time
 * pruning directly.
 */
export function collectFiles(
  target: string,
  visitDir?: (dirPath: string) => void,
): string[] {
  const st = lstatSync(target);
  if (st.isFile()) {
    // An explicit Markdown target is operator intent, even for structural
    // basenames that bulk scans intentionally skip.
    return isMarkdownFilePath(basename(target)) ? [target] : [];
  }

  const gitFiles = collectGitVisibleFiles(target, isFrontmatterScannablePath);
  if (gitFiles) {
    if (visitDir) visitDir(target);
    return gitFiles;
  }

  const out: string[] = [];
  const stack = [target];
  if (visitDir) visitDir(target);
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
        // Descent-time prune — the actual fix for the second walker bug
        // class (codex outside-voice C5).
        if (!pruneDir(name, dir)) continue;
        if (visitDir) visitDir(full);
        stack.push(full);
      } else if (entryStat.isFile()) {
        const rel = relative(target, full);
        if (isFrontmatterScannablePath(rel)) {
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
  console.log(`Frontmatter audit — ${report.total} malformed issue(s) across ${report.per_source.length} source(s) (scanned at ${report.scanned_at})`);
  if (report.ignored_missing_open) {
    console.log(`Missing frontmatter ignored: ${report.ignored_missing_open} file(s). Use \`frontmatter validate\` for strict per-file checks or \`frontmatter generate\` to add meaningful metadata.`);
  }
  for (const src of report.per_source) {
    console.log(`\n[${src.source_id}] ${src.source_path}`);
    if (src.total === 0) {
      console.log('  clean');
      continue;
    }
    console.log(`  ${src.total} issue(s)`);
    for (const [code, n] of Object.entries(src.errors_by_code)) {
      const split = src.recoverability_by_code?.[code as ParseValidationCode];
      console.log(`    ${code}: ${n}${split ? ` (${split.recoverable} imported anyway, ${split.unrecoverable} held on import)` : ''}`);
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
    console.log(`\nFix with: gbrain frontmatter validate <source-path> --fix (on a managed brain: gbrain repair frontmatter --source <id>)`);
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
  const includeCatchAll = args.includes('--include-catch-all') || args.includes('--allow-catch-all');

  if (!targetPath) {
    console.error('error: gbrain frontmatter generate requires a <path> argument');
    console.error('usage: gbrain frontmatter generate <path> [--fix] [--dry-run] [--json]');
    setCliExitVerdict(1);
    return;
  }

  const { inferFrontmatter, serializeFrontmatter } = await import('../core/frontmatter-inference.ts');
  const { resolve, relative, join, basename } = await import('path');
  const { readFileSync, writeFileSync, statSync, lstatSync } = await import('fs');

  const rootPath = resolve(targetPath);
  const isDir = statSync(rootPath).isDirectory();
  if (!isDir && !isMarkdownFilePath(rootPath)) {
    console.error(`error: frontmatter generation supports only .md and .mdx files: ${targetPath}`);
    setCliExitVerdict(1);
    return;
  }

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
  let skippedCatchAll = 0;
  let generated = 0;
  let written = 0;
  const backupRunId = makeFrontmatterBackupRunId();

  function processFile(absPath: string, relPath: string) {
    scanned++;
    if (!isFrontmatterScannablePath(relPath)) return;

    // Skip symlinks
    try { if (lstatSync(absPath).isSymbolicLink()) return; } catch { return; }

    let content: string;
    // #4798: strip a UTF-8 BOM so heading-title inference (and --fix's
    // written body) match what `gbrain sync` / `import` produce.
    try { content = readFileSync(absPath, 'utf-8').replace(/^\uFEFF/, ''); } catch { return; }

    const inferred = inferFrontmatter(relPath, content);
    if (inferred.skipped) {
      skipped++;
      return;
    }
    if (!includeCatchAll && inferred.matchedRule === '(default)') {
      skippedCatchAll++;
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
      // Safety: write a centralized backup first.
      createFrontmatterBackup(absPath, { sourcePath: brainRoot, runId: backupRunId });
      assertManagedFilesystemWrite(absPath);
      writeFileSync(absPath, newContent, 'utf-8');
      written++;
    }
  }

  if (isDir) {
    for (const absPath of collectFiles(rootPath)) {
      processFile(absPath, relative(brainRoot, absPath));
    }
  } else {
    const relPath = relative(brainRoot, rootPath) || basename(rootPath);
    processFile(rootPath, relPath);
  }

  // Output
  if (jsonOut) {
    console.log(JSON.stringify({
      scanned,
      skipped,
      skippedCatchAll,
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
  if (skippedCatchAll > 0) {
    console.log(`  Skipped catch-all/unknown: ${skippedCatchAll} (pass --include-catch-all to write type: note)`);
  }
  console.log(`  Would generate: ${generated}`);
  if (doFix && !dryRun) {
    console.log(`  Written: ${written} (with centralized backups)`);
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
