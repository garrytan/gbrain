/**
 * Sync utilities — pure functions for git diff parsing, filtering, and slug management.
 *
 * SYNC DATA FLOW:
 *   git diff --name-status -M LAST..HEAD
 *       │
 *   buildSyncManifest()  →  parse A/M/D/R lines
 *       │
 *   isSyncable()  →  filter to .md pages only
 *       │
 *   pathToSlug()  →  convert file paths to page slugs
 */

import { SLUG_WORD_CHARS } from './cjk.ts';
// v0.37.7.0 #1169 submodule-detection helpers. Bottom-of-file already
// aliases existsSync as `_existsSync` for other purposes; the top-of-file
// import keeps the pruneDir helper's deps near its callsite.
import { existsSync, statSync, realpathSync } from 'fs';
import { join as pathJoin, resolve as pathResolve } from 'path';
import type { BrainEngine } from './engine.ts';

export interface SyncManifest {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface RawManifestEntry {
  action: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

export type SyncStrategy = 'markdown' | 'code' | 'auto';

interface SyncableOptions {
  strategy?: SyncStrategy;
  include?: string[];
  exclude?: string[];
  /**
   * Repeatable `--include-hidden <glob>` patterns (same glob dialect as
   * `include`/`exclude`, matched against the same path form `classifySync`
   * receives). Waives the leading-dot prune heuristic in `isPathPruned` for
   * paths that match — see that function's doc comment for exactly what is
   * and isn't waivable.
   */
  includeHidden?: string[];
}

// v0.19.0 shipped a 9-extension allowlist (ts/tsx/js/jsx/mjs/cjs/py/rb/go). The
// chunker already supports ~35 extensions via detectCodeLanguage but the sync
// classifier dropped every other language on the floor — Rust/Java/C#/C++/etc.
// files never reached the chunker on a normal repo sync, making v0.19.0's
// "165 languages" claim aspirational (codex F1). v0.20.0 Layer 2 (1a) rewrites
// isCodeFilePath to delegate to detectCodeLanguage so the sync classifier
// matches the chunker's actual coverage.
//
// Kept as-is for now for `isAllowedByStrategy` fast-path + tests that
// structurally reference it. Derived from the chunker's language map at
// module load, not hardcoded.
const CODE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh',
  '.c', '.h',
  '.php',
  '.swift',
  '.kt', '.kts',
  '.scala', '.sc',
  '.lua',
  '.ex', '.exs',
  '.elm',
  '.ml', '.mli',
  '.dart',
  '.zig',
  '.sol',
  '.sh', '.bash',
  '.css',
  '.html', '.htm',
  '.astro', '.svelte',
  '.vue',
  '.json',
  '.yaml', '.yml',
  '.toml',
  // v0.36.x #878: Terraform / HCL. Closes the silent-data-loss bug where
  // Terraform repos were invisible to `gbrain sync --strategy code`.
  // detectCodeLanguage() returns null for these so they chunk via the
  // recursive chunker (no tree-sitter grammar), which is the correct
  // fallback — same path as toml / yaml without language-specific AST.
  '.tf', '.tfvars', '.hcl',
  // v0.41 D2 wave (#1173): SQL via tree-sitter-sql. DerekStride grammar
  // chunks DDL (CREATE TABLE/FUNCTION/VIEW/INDEX) and DML (SELECT/INSERT/
  // UPDATE/DELETE) as one chunk per statement. DDL chunks carry
  // symbol_name + symbol_type populated for code-def; DML chunks emit
  // unnamed so they don't pollute symbol search.
  '.sql',
]);

/**
 * Parse the output of `git diff --name-status -M LAST..HEAD` into structured entries.
 *
 * Input format (tab-separated):
 *   A       path/to/new-file.md
 *   M       path/to/modified-file.md
 *   T       path/to/retyped-file.md      (file <-> symlink; content changed)
 *   D       path/to/deleted-file.md
 *   R100    old/path.md     new/path.md
 *
 * Status coverage, against the options gbrain actually passes (name-status with
 * `-M` only, see `sync-delta.ts` — note NO `-C` copy detection):
 *   A/M/D/R — the everyday statuses.
 *   T       — TYPECHANGE. Reachable in normal operation: replacing a file with
 *             a symlink (or vice versa) emits `T`, and it was silently dropped,
 *             so the change never reached the index until something else
 *             touched the path. Treated as `modified`: the path still exists and
 *             its blob changed, which is exactly what re-import handles. (When a
 *             file becomes a symlink, import-file SKIPS symlinks by design —
 *             the exfil guard — so the old regular-file content stays indexed;
 *             routing the typechange to delete-then-skip is a filed follow-up.)
 *   C       — COPY. Unreachable without `-C`, handled defensively.
 *   U       — UNMERGED. Only in a conflicted worktree, which sync does not run
 *             against; handled defensively so a conflicted tree degrades to
 *             "re-import this path" rather than silently skipping it.
 *
 * NOTE for future editors: git option names appear here WITHOUT the leading
 * double-dash on purpose. The CLI flag-registry generator string-scans module
 * source including comments, so a bare double-dash token in prose registers as
 * a real, accepted CLI flag on every command that imports this file. Pinned by
 * `test/cli-flag-validation.test.ts`.
 */
/**
 * Undo git's C-style path quoting.
 *
 * git quotes any path containing `"`, `\` or a control character, and it does
 * so unconditionally: `core.quotepath=false` (buildGitInvocation in
 * commands/sync.ts, #119) only suppresses octal-escaping of NON-ASCII bytes.
 * A path like `people/Jason "Jay" Strand.md` therefore reaches
 * buildSyncManifest as `"people/Jason \"Jay\" Strand.md"` — surrounding quotes
 * included — so it ends `.md"`, fails isMarkdownFilePath(), and is dropped from
 * the manifest with no error and no counter.
 *
 * Octal escapes are decoded as BYTES and utf-8 decoded once at the end: a
 * single codepoint can span several \NNN escapes, so per-escape decoding
 * produces mojibake.
 *
 * An unquoted path is returned unchanged, so this is a no-op for the common
 * case.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = {
    n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11,
  };
  const bytes: number[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const nxt = body[i + 1];
      if (nxt in simple) {
        bytes.push(simple[nxt]);
        i += 2;
        continue;
      }
      const trio = body.slice(i + 1, i + 4);
      if (trio.length === 3 && /^[0-7]{3}$/.test(trio)) {
        bytes.push(parseInt(trio, 8));
        i += 4;
        continue;
      }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
    i += 1;
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

export function buildSyncManifest(gitDiffOutput: string): SyncManifest {
  const manifest: SyncManifest = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  };

  const lines = gitDiffOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;

    const action = parts[0];

    // Unquote at the single point every path enters the manifest, so the
    // extension filter and every downstream consumer (slug resolution, file
    // reads) all see the real name. (#3897)
    if (action === 'A') {
      manifest.added.push(unquoteGitPath(parts[1]));
    } else if (action === 'M' || action === 'T' || action === 'U') {
      // T (typechange) and U (unmerged) both mean "this path exists and its
      // content is not what we imported" — the same remedy as M.
      manifest.modified.push(unquoteGitPath(parts[1]));
    } else if (action === 'D') {
      manifest.deleted.push(unquoteGitPath(parts[1]));
    } else if (action.startsWith('R') || action.startsWith('C')) {
      // Rename/copy: R100\told-path\tnew-path. Copy is unreachable without -C,
      // but if the flags ever change, the destination must still be imported.
      const oldPath = unquoteGitPath(parts[1]);
      const newPath = unquoteGitPath(parts[2]);
      if (oldPath && newPath) {
        if (action.startsWith('C')) {
          // A copy leaves the source in place — only the destination is new.
          manifest.added.push(newPath);
        } else {
          manifest.renamed.push({ from: oldPath, to: newPath });
        }
      }
    }
  }

  return manifest;
}

export function isCodeFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of CODE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * v0.27.1: image extensions are admitted only when the multimodal config
 * gate is on. The runtime gate flips through `process.env.GBRAIN_EMBEDDING_MULTIMODAL`
 * which loadConfigWithEngine populates from the DB plane after engine connect
 * (or env directly when the operator overrides). When the gate is off,
 * existing brains keep their current "markdown + code only" sync behavior.
 */
export function isImageFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.heic') ||
    lower.endsWith('.heif') ||
    lower.endsWith('.avif')
  );
}

export function isMarkdownFilePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.mdx');
}

function isMultimodalEnabled(): boolean {
  return process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';
}

function isAllowedByStrategy(path: string, strategy: SyncStrategy): boolean {
  // #2683: mirror import.ts's isCollectibleForWalker — the full-sync walker
  // admits images under the (default) 'markdown' strategy when multimodal is
  // on, but this incremental gate used to be markdown-only, so a committed
  // image NEVER imported incrementally (it only landed via `sync --full`).
  // Full and incremental must agree on the admission set.
  if (strategy === 'markdown') {
    return isMarkdownFilePath(path) || (isMultimodalEnabled() && isImageFilePath(path));
  }
  if (strategy === 'code') return isCodeFilePath(path);
  // 'auto' / default: markdown + code, plus images when multimodal is on.
  return (
    isMarkdownFilePath(path) ||
    isCodeFilePath(path) ||
    (isMultimodalEnabled() && isImageFilePath(path))
  );
}

function globToRegex(pattern: string): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        // `**/` matches zero or more path segments (including zero, so `src/**/*.ts`
        // matches `src/foo.ts` as well as `src/a/b/foo.ts`). Collapse `**/` →
        // `(?:.*/)?`. A bare `**` not followed by `/` matches any chars.
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i++;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { regex += '[^/]'; continue; }
    if ('\\.[]{}()+-^$|'.includes(ch)) { regex += `\\${ch}`; continue; }
    regex += ch;
  }
  regex += '$';
  return new RegExp(regex);
}

export function matchesAnyGlob(path: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegex(pattern).test(normalized));
}

/**
 * Directory names that walkers must NEVER descend into. Used at descent
 * time (before recursion) to prune entire subtrees — saves the IO cost of
 * walking thousands of vendor / generated / hidden files only to filter
 * them at file-emit time. Used by every walker in gbrain (sync, extract,
 * transcript-discovery, etc.).
 *
 * Pattern: dirname matching at single path-segment granularity. Walkers
 * call `pruneDir(entry.name)` on each subdirectory before recursing.
 *
 * `node_modules` lacks a leading dot so the dot-prefix exclusion in
 * isSyncable below doesn't catch it; explicit entry here closes the
 * latent walker bug (#923, #202).
 */
const PRUNE_DIR_NAMES = new Set<string>([
  'node_modules',
  // Dependency / build-output trees that are git-ignored on virtually every
  // repo and never contain hand-authored source worth indexing. `vendor`
  // (PHP Composer / Go / Ruby bundle), `dist` + `build` (compiled output).
  // Closes the silent-pollution bug where a Laravel/PHP repo's full code sync
  // walked ~50k `vendor/` files (#1483 / #1159 / maintainer #1942).
  'vendor',
  'dist',
  'build',
  // Python venv: vendored dependency tree, the `node_modules` analogue (#2020).
  // Like `node_modules` it lacks a leading dot so isSyncable's dot-prefix
  // exclusion misses it; explicit entry keeps incremental sync consistent
  // with the first-sync walker in commands/import.ts.
  'venv',
  '.raw',
  // NOTE (#2404): `'ops'` used to be in this list (a v0.2.0-era carve-out for
  // one brain layout). Matching the bare segment pruned EVERY user `ops/`
  // directory at any depth — sync silently deleted `ops/*` pages and never
  // imported `ops/*` files, while the bundled daily-task-manager skill
  // prescribes `ops/tasks` as its canonical page. `ops/` is ordinary content;
  // do NOT re-add it. Only generated/vendored trees belong here.
]);

/**
 * Should this directory be descended into? Returns `false` for vendor / hidden /
 * generated dirs that walkers should skip BEFORE recursing. Catches
 * `node_modules` (latent bug — no leading dot), dot-prefix dirs (`.git`,
 * `.obsidian`, `.raw`, `.cache`, etc. via the leading-dot heuristic), and the
 * explicit `PRUNE_DIR_NAMES` set above.
 *
 * `name` is a single path segment (basename of the directory entry), NOT a
 * full path. Walkers consult this on each subdirectory entry during recursion.
 *
 * v0.37.7.0 #1169: when callers pass `parentDir`, ALSO skip git submodule
 * directories (detected by the presence of `.git` as a FILE — not a
 * directory — inside the candidate dir). The `parentDir` arg is optional so
 * existing callers stay back-compat; new callers (sync walker, extract
 * walker) thread it through.
 */
export function pruneDir(name: string, parentDir?: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return false;
  if (PRUNE_DIR_NAMES.has(name)) return false;
  // `.raw` is the literal directory name; `*.raw` is the gbrain sidecar
  // convention (e.g. `people/pedro.raw/` holds raw source for pedro.md).
  // Both forms should be skipped at descent time.
  if (name.endsWith('.raw')) return false;
  // Submodule detection: a git submodule directory contains `.git` as
  // a FILE (a "gitfile" pointing into the parent's .git/modules/...),
  // not a directory. Best-effort: if we can't stat (e.g. cross-platform
  // permission edge), fall through and treat as a normal dir.
  if (parentDir) {
    try {
      const gitPath = pathJoin(parentDir, name, '.git');
      if (existsSync(gitPath) && statSync(gitPath).isFile()) {
        return false;
      }
    } catch {
      // Stat failed — descend normally rather than silently exclude.
    }
  }
  return true;
}

/**
 * Path-string form of the exclusion `pruneDir` enforces during a live
 * directory descent, evaluated per-segment against a full path — the
 * canonical gate for the two PURE classifiers that never walk a real
 * directory tree: `classifySync` (drives `sync`'s incremental + full-sync
 * dry-run/reconcile paths) and `isCollectibleForWalker` in `commands/
 * import.ts` (drives `import`'s git-ls-files fast path, which is what
 * every git-tracked source — the common case — actually uses). Both used
 * to reimplement this segment loop independently; funnelling them through
 * one function is what keeps a future change from fixing one and leaving
 * the other silently pruning differently, the way #923/#202 drifted before
 * `PRUNE_DIR_NAMES` existed.
 *
 * `includeHidden`: repeatable `--include-hidden <glob>` patterns (same
 * glob dialect as `include`/`exclude`, matched against the full `path`
 * argument as given — callers are responsible for passing the same path
 * form their other include/exclude matching already uses). When a path is
 * pruned ONLY because a segment is dot-prefixed (`.dira/entries/x.md`) and
 * the full path matches one of these globs, the dot-prune is waived. The
 * `PRUNE_DIR_NAMES` / `*.raw` exclusions are NEVER waivable — this flag
 * reaches past the leading-dot heuristic specifically (`.git`, `.dira`,
 * `.obsidian`, …), not past generated/vendored-tree exclusions.
 *
 * SCOPE: this only reaches the two pure-string classifiers above. It does
 * NOT reach `pruneDir`'s other, live-filesystem-walk callers — `import`'s
 * fallback walker for non-git directories, and `storage.ts`'s
 * `walkBrainRepo` — which decide per-directory during real recursive
 * descent and would need prefix-of-a-glob reasoning to honor the same
 * waiver safely (a directory named `.dira` must stay open for descent to
 * reach `.dira/entries/*.md` even though `.dira` alone doesn't match that
 * glob). Every `gbrain sources add`'d git repository — which is virtually
 * all of them, including every hq-shaped brain — goes through the
 * git-listing fast path this function guards, so the gap is scoped to
 * importing a bare (non-git) directory.
 */
export function isPathPruned(path: string, includeHidden?: string[]): boolean {
  const segments = path.split('/');
  if (segments.some((seg) => PRUNE_DIR_NAMES.has(seg) || seg.endsWith('.raw'))) return true;
  const dotPruned = segments.some((seg) => seg.startsWith('.'));
  if (!dotPruned) return false;
  return !(includeHidden && includeHidden.length > 0 && matchesAnyGlob(path, includeHidden));
}

/**
 * Discriminator for WHY a path is not syncable. Returned by `unsyncableReason`
 * so the sync cleanup loop in `commands/sync.ts` can distinguish "metafile we
 * intentionally exclude" from "user removed this file from the strategy".
 *
 * v0.41.13 (#1433): pre-fix, the cleanup loop in performSync treated all
 * unsyncable-modified paths the same and DELETED any pre-existing page for
 * them. That silently dropped `log.md` / `schema.md` / `README.md` pages
 * that had been indexed by older gbrain versions (or via direct put_page).
 * The fix guards that loop on `unsyncableReason(...) === 'metafile'` and
 * preserves those rows.
 */
export type SyncableReason =
  | 'metafile'
  | 'strategy'
  | 'pruned-dir'
  | 'include-glob-miss'
  | 'exclude-glob-hit'
  | 'malformed-path';

/**
 * Path segments that can never be legitimate page filenames: square brackets
 * (the signature of markdown-link syntax leaking into a literal filename —
 * files named `[atoms/foo.md](https:/...)` were minted by misbehaving
 * producers and polluted search because slugifySegment STRIPS brackets
 * instead of rejecting them, yielding plausible-looking slugs) and ASCII
 * control characters. Parentheses are deliberately allowed — `meeting (1).md`
 * is a legitimate filename shape.
 *
 * Two-tier design (cross-model adversarial finding — both reviewers flagged
 * blanket-bracket collateral):
 *   - ADMISSION (hasMalformedPathSegment): control chars reject on ANY path;
 *     brackets reject only on MARKDOWN paths (.md/.mdx). Code-strategy lanes
 *     keep indexing framework paths like `app/[id]/page.tsx`, which are
 *     ubiquitous and legitimate.
 *   - DESTRUCTION (isPoisonedPath): sync's row-DELETING lanes (reconcile,
 *     modified-lane cleanup) act only on the actual injection signature —
 *     `](` or control chars. A bare-bracket markdown file (`notes [draft].md`)
 *     imported by a pre-gate release keeps its indexed row (it just can't
 *     re-import until renamed; doctor's malformed_path_pages carries the
 *     hint). Hard-deleting it on a routine post-upgrade full sync while the
 *     file still exists would be silent data loss.
 *
 * IMPORTANT: these are PATH checks only. `](` inside file BODIES is normal
 * markdown and must never trip them.
 */
export const MALFORMED_PATH_SEGMENT_RE = /[\[\]\x00-\x1f]/;

/** The injection signature that marks a path as sweepable junk. */
export const POISONED_PATH_RE = /\]\(|[\x00-\x1f]/;

/** Admission check: control chars anywhere; brackets on markdown paths. */
export function hasMalformedPathSegment(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return true;
  return /[\[\]]/.test(path) && /\.(md|mdx)$/i.test(path);
}

/** Destruction gate: only paths matching the poison signature may have their DB rows swept. */
export function isPoisonedPath(path: string): boolean {
  return POISONED_PATH_RE.test(path);
}

/**
 * Strip control characters (and cap length) before echoing a malformed path
 * to a terminal — these paths contain control bytes BY DEFINITION, and a
 * crafted filename must not be able to inject ANSI escapes into sync output.
 * Brackets stay: they're printable and the informative part of the name.
 */
export function sanitizePathForDisplay(path: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = path.replace(/[\x00-\x1f\x7f]/g, '\ufffd');
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

/**
 * Canonical metafile basenames the markdown sync strategy intentionally
 * skips. Exported so the cleanup-loop guard in `commands/sync.ts` can
 * surface them in user-facing logs / docs without re-declaring the list.
 *
 * These files are append-only domain logs / index pages / boilerplate
 * READMEs / the master filing decision-tree — not typed brain pages — by
 * convention. A user who genuinely wants to index one of these basenames as
 * a page should rename it.
 *
 * `RESOLVER.md` is the brain's master routing/decision-tree config file. The
 * recommended-schema docs group it with `schema.md` / `index.md` / `log.md`
 * as a structural document ("a document … plus schema.md and RESOLVER.md …
 * that tells the agent how the brain is structured"), NOT searchable content.
 * It was the lone structural sibling missing from this list, so it leaked
 * into the index as a content page (slug `resolver`).
 */
export const SYNC_SKIP_FILES = ['schema.md', 'index.md', 'log.md', 'README.md', 'RESOLVER.md'] as const;

/**
 * Internal classifier. Returns null when the path IS syncable, or a tagged
 * SyncableReason explaining why it isn't. The single source of truth that
 * both `isSyncable` (boolean) and `unsyncableReason` (tagged) call.
 *
 * Codex review caught the drift risk if `unsyncableReason` were an independent
 * re-implementation. Funnelling both public APIs through `classifySync` means
 * TypeScript enforces consistency at the compiler level.
 */
function classifySync(path: string, opts: SyncableOptions = {}): SyncableReason | null {
  const strategy = opts.strategy || 'markdown';

  if (!isAllowedByStrategy(path, strategy)) return 'strategy';

  // Reject filenames that can't be legitimate pages (bracket/control chars —
  // markdown-link syntax as a literal filename). Checked after `strategy` so
  // only files that would otherwise be admitted change classification.
  if (hasMalformedPathSegment(path)) return 'malformed-path';

  // Skip every path segment that pruneDir would block walkers from descending
  // into. Catches hidden dirs (`.git`, `.obsidian`), `.raw/` sidecars, and
  // vendor/generated trees (`node_modules/`, `vendor/`, …) at any depth.
  // `opts.includeHidden` can waive the leading-dot part of this — see
  // `isPathPruned`'s doc comment for exactly what is and isn't waivable.
  if (isPathPruned(path, opts.includeHidden)) return 'pruned-dir';

  // Skip meta files that aren't pages
  const segments = path.split('/');
  const basename = segments[segments.length - 1] || '';
  if ((SYNC_SKIP_FILES as readonly string[]).includes(basename)) return 'metafile';

  if (opts.include && opts.include.length > 0 && !matchesAnyGlob(path, opts.include)) return 'include-glob-miss';
  if (opts.exclude && opts.exclude.length > 0 && matchesAnyGlob(path, opts.exclude)) return 'exclude-glob-hit';

  return null;
}

/**
 * Filter a file path to determine if it should be synced to GBrain.
 * Strategy-aware: 'markdown' (default) = .md/.mdx only, 'code' = code files only, 'auto' = both.
 */
export function isSyncable(path: string, opts: SyncableOptions = {}): boolean {
  return classifySync(path, opts) === null;
}

/**
 * Companion to `isSyncable`. Returns null when the path IS syncable, or a
 * tagged `SyncableReason` explaining why it isn't. Used by the v0.41.13
 * #1433 cleanup guard in `commands/sync.ts` to distinguish metafile
 * exclusions (preserve any pre-existing page) from genuine "file removed
 * from the strategy" cases (delete the now-stale page).
 *
 * Routes through the same `classifySync` as `isSyncable` so the two cannot
 * drift. Identical opts contract — callers pass whatever they pass `isSyncable`.
 */
export function unsyncableReason(path: string, opts: SyncableOptions = {}): SyncableReason | null {
  return classifySync(path, opts);
}

/**
 * Character class for the lowercase-canonical form of a slug segment after
 * slugifySegment() has run. Letters/numbers in any script (lowercase where
 * the script has case — #3417), dots, underscores, hyphens. Uses \p{...}
 * classes, so composed regexes need the `u` flag (this one carries it).
 * Exposed so adjacent code (e.g. takes-fence holder validation,
 * v0.32 EXP-4) can reuse the actual repo slug grammar instead of inventing
 * a stricter parallel one and emitting false-positive warnings on legitimate
 * `companies/acme.io` / `people/foo_bar` slugs (codex review #3).
 *
 * Pattern is the inner character class only (no anchors); callers wrap it
 * in `^...$` or compose it with prefixes like `(?:people|companies)/...`.
 */
export const SLUG_SEGMENT_PATTERN = new RegExp(`[${SLUG_WORD_CHARS}._\\-]+`, 'u');

/**
 * Slugify a single path segment: lowercase, strip special chars, spaces → hyphens.
 * Letters and numbers from EVERY script are preserved (#3417): previously only
 * Latin + CJK survived, so Hebrew/Arabic/Cyrillic/Greek/Thai/... filenames
 * collapsed to empty segments and distinct files silently merged onto one slug.
 * NFC re-normalize after the NFD-strip-accents pass so Hangul Jamo recomposes
 * back into precomposed syllables, and so NFD filenames (macOS) and NFC
 * filenames (Linux/git) of the same name produce the SAME slug.
 */
const SLUGIFY_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}.\\s_\\-]`, 'gu');

export function slugifySegment(segment: string): string {
  return segment
    .normalize('NFD')                     // Decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // Strip accent marks
    // #3700: Hebrew niqqud (vowel points) + cantillation are optional
    // diacritics \u2014 the same word appears pointed and bare across filenames
    // and must land on ONE slug (the Hebrew analog of caf\u00e9 \u2192 cafe). Scoped
    // to U+0591\u2013U+05C7 only; \p{M} stays in SLUG_WORD_CHARS so Devanagari
    // matras, Thai vowels, Arabic text etc. keep their #3417 behavior.
    // Runs in NFD space so precomposed presentation forms (U+FB1D\u2013FB4F)
    // are already decomposed and their points strip too.
    .replace(/[\u0591-\u05c7]/g, '')      // Strip Hebrew niqqud + cantillation
    .normalize('NFC')                     // Recompose Hangul Jamo back to Syllables (v0.32.7)
    .toLowerCase()
    .replace(SLUGIFY_KEEP_RE, '')         // Keep alnum, dots, spaces, _-, and CJK (v0.32.7)
    .replace(/[\s]+/g, '-')              // Spaces → hyphens
    .replace(/-+/g, '-')                 // Collapse multiple hyphens
    .replace(/^-|-$/g, '');              // Strip leading/trailing hyphens
}

/**
 * Slugify a file path: strip .md, normalize separators, slugify each segment.
 *
 * Examples:
 *   Apple Notes/2017-05-03 ohmygreen.md → apple-notes/2017-05-03-ohmygreen
 *   people/alice-smith.md → people/alice-smith
 *   notes/v1.0.0.md → notes/v1.0.0
 */
export function slugifyPath(filePath: string): string {
  let path = filePath.replace(/\.mdx?$/i, '');
  path = path.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path.split('/').map(slugifySegment).filter(Boolean).join('/');
}

/**
 * Slugify a code file path: flatten into a single slug segment with dots → hyphens.
 * e.g. 'src/core/chunkers/code.ts' → 'src-core-chunkers-code-ts'
 */
export function slugifyCodePath(filePath: string): string {
  let path = filePath.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path
    .split('/')
    .map(segment => slugifySegment(segment.replace(/\./g, '-')))
    .filter(Boolean)
    .join('-');
}

/**
 * Convert a repo-relative file path to a GBrain page slug.
 */
export function pathToSlug(
  filePath: string,
  repoPrefix?: string,
  options: { pageKind?: 'markdown' | 'code' } = {},
): string {
  const pageKind = options.pageKind || 'markdown';
  let slug = pageKind === 'code' ? slugifyCodePath(filePath) : slugifyPath(filePath);
  if (repoPrefix) slug = `${repoPrefix}/${slug}`;
  return slug.toLowerCase();
}

/**
 * v0.20.0 Cathedral II Layer 1a (SP-5 fix) — centralized slug dispatcher.
 *
 * Before Cathedral II, `importFromFile` / `importCodeFile` chose between
 * `slugifyPath` and `slugifyCodePath` inline, but the sync delete/rename
 * paths in `performSync` always called `pathToSlug(path)` with the default
 * pageKind='markdown'. For a 9-extension-wide code classifier this was
 * mostly correct (code files were rare), but Layer 1a widens the classifier
 * to ~35 extensions and without this dispatcher, deleting or renaming a
 * Rust/Java/Ruby/etc. file would try to delete the wrong slug (the
 * markdown-style slug) and leave the real code-slug page orphaned forever.
 *
 * Every sync-path caller that used to pick a pageKind manually should now
 * call resolveSlugForPath — it derives the right slug shape from
 * isCodeFilePath(), which in turn derives from the chunker's language map.
 * Central dispatch means new extensions added to the chunker automatically
 * flow through without touching the sync code path.
 */
export function resolveSlugForPath(filePath: string, repoPrefix?: string): string {
  const pageKind = isCodeFilePath(filePath) ? 'code' : 'markdown';
  return pathToSlug(filePath, repoPrefix, { pageKind });
}

// ─────────────────────────────────────────────────────────────────
// Sync failure ledger — moved to ./sync-failure-ledger.ts (issue #1939)
// ─────────────────────────────────────────────────────────────────
//
// The failure store + bounded auto-skip valve now live in a leaf module so
// they can be unit-tested in isolation and shared by both sync gates without
// a circular import. Re-exported here so existing callers that
// `await import('../core/sync.ts')` for these symbols keep working.
export {
  classifyErrorCode,
  summarizeFailuresByCode,
  formatCodeBreakdown,
  formatFailedFileList,
  syncFailuresPath,
  loadSyncFailures,
  unacknowledgedSyncFailures,
  recordSyncFailures,
  acknowledgeSyncFailures,
  recordFailures,
  clearFailures,
  restoreFailures,
  acknowledgeFailures,
  autoSkipFailures,
  withLedgerLock,
  resolveAutoSkipThreshold,
  isSkippablePath,
  decideGateAction,
  EMBEDDING_INFRA_CODES,
  isEmbeddingInfraCode,
  decideSyncFailureSeverity,
  applySyncFailureGate,
  DEFAULT_SOURCE_ID,
  SENTINEL_PREFIX,
  RENAME_SENTINEL_PREFIX,
  renameSentinelPath,
  renameReconcileErrorMessage,
  parseRenameReconcileFrom,
  DEFAULT_AUTOSKIP_AFTER,
} from './sync-failure-ledger.ts';
export type {
  SyncFailure,
  SyncFailureState,
  AcknowledgeResult,
  GateDecision,
  SeverityResult,
  SyncGateInput,
  SyncGateOutcome,
} from './sync-failure-ledger.ts';

/**
 * #2114 — same-directory check for the global sync-anchor ownership guard.
 * Best-effort realpath so symlinked spellings (macOS `/tmp` vs `/private/tmp`)
 * and relative invocations compare as the same repo. `realpathSync.native`
 * first: unlike the JS implementation it canonicalizes path CASE on
 * case-insensitive filesystems (APFS `/users/x` vs `/Users/x`), so a
 * case-variant spelling cannot false-refuse the user's own brain repo.
 */
export function sameRepoDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const abs = pathResolve(p);
    try {
      return realpathSync.native(abs);
    } catch {
      // fall through
    }
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  };
  return norm(a) === norm(b);
}

export interface GlobalAnchorOwnership {
  owns: boolean;
  /** The path ownership was judged against (global key first, else the
   * default source's local_path), or null on a truly fresh brain. */
  configured: string | null;
}

/**
 * #2114 — may an import/sync of `dir` move the GLOBAL sync anchors
 * (`sync.repo_path` / `sync.last_commit`)?
 *
 * The globals describe THE brain repo — the default source's working tree
 * (source-resolver.ts documents `sync.repo_path` as the legacy pre-v0.18
 * default-source key; migration v16 seeds the `default` source row FROM it).
 * Ownership therefore requires BOTH:
 *   1. the operation resolves to the default source (or the legacy
 *      no-sourceId path, which is default-by-definition), AND
 *   2. `dir` matches the brain repo's configured identity — the global key
 *      when set, else the default source row's `local_path` when set
 *      (modern sync writes its anchor THERE, leaving the global unset, so
 *      an unset global alone must not green-light a bootstrap).
 * Only when neither identity exists is this a fresh brain, and bootstrap
 * is allowed.
 */
export async function ownsGlobalSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  dir: string,
): Promise<GlobalAnchorOwnership> {
  if (sourceId && sourceId !== 'default') {
    return { owns: false, configured: null };
  }
  const globalPath = await engine.getConfig('sync.repo_path');
  if (globalPath) {
    return { owns: sameRepoDir(globalPath, dir), configured: globalPath };
  }
  // Global unset — the brain identity may still live on the default source
  // row (modern sync writes anchors there). Best-effort: a query failure
  // falls through to bootstrap, preserving pre-#2114 behavior on exotic
  // engines rather than refusing writes.
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'default'`,
    );
    const defaultLocal = rows[0]?.local_path ?? null;
    if (defaultLocal) {
      return { owns: sameRepoDir(defaultLocal, dir), configured: defaultLocal };
    }
  } catch {
    // sources table unavailable (pre-v0.18 brain mid-upgrade) — treat as fresh.
  }
  return { owns: true, configured: null };
}
