/**
 * gbrain frontmatter install-hook — Install a pre-commit hook in a brain
 * source's git repo that runs `gbrain frontmatter validate` against staged
 * .md/.mdx files. Skips sources outside any git repo with a one-line note.
 *
 * Usage:
 *   gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]
 *
 *   --source <id>  Limit to one registered source. Default: all sources.
 *   --force        Overwrite an existing pre-commit hook (writes <hook>.bak).
 *   --uninstall    Remove the hook; restore <hook>.bak if present.
 *
 * Hook contract:
 *   - Located at <git root>/.githooks/pre-commit. The root is discovered the
 *     way `gbrain sync` does (#4600): a source registered as a SUBDIRECTORY of
 *     a host repo (the `<workspace>/brain` layout bootstrap creates) gets ONE
 *     hook at the host root, pathspec-scoped to that subdirectory; several
 *     nested sources union their scopes; a source registered at the root
 *     renders the unscoped whole-repo script. We `git config core.hooksPath
 *     .githooks` only when `hooksPathBlocker` finds nothing: core.hooksPath
 *     unset (one already resolving to `.githooks` is left alone; one pointing
 *     elsewhere — global/corporate templates — is theirs to keep and reported
 *     as unwired, since git never reads `.githooks/` then), no foreign
 *     executable under `.githooks/` (wiring would start running it) and no
 *     active hook in the repo's own hooks dir (`.git/hooks` — wiring makes git
 *     ignore it for EVERY hook type). Either way the hook is written and the
 *     reason + manual wiring step printed.
 *   - When the gbrain binary is missing, the hook prints a one-line warning
 *     and exits 0 (don't break commits if a developer uninstalls gbrain).
 *   - Bypass via `git commit --no-verify`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, copyFileSync, realpathSync, readdirSync, statSync, lstatSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { discoverGitRoot } from '../core/sync-git.ts';

const HOOK_BANNER = '# gbrain frontmatter pre-commit hook (v0.22.4+)';
/** One line per guarded subdirectory (root-relative, trailing slash). No lines = whole repo. */
const SCOPE_MARKER = '# gbrain-scope: ';

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * A scope is rendered into a `#` comment line and a `'…'` pathspec: a line
 * terminator inside it would end the comment early and run the rest of the
 * path as hook code. Refused at the seam (path → scope) and again at render.
 */
function assertNoLineTerminator(scope: string): void {
  if (/[\n\r\0]/.test(scope)) {
    throw new Error(`source path contains a line terminator; refusing to install hook: ${JSON.stringify(scope)}`);
  }
}

/**
 * Run git in `root`; trimmed stdout, throws on non-zero. `env: process.env`
 * keeps the child on the LIVE environment (Bun's default is a startup
 * snapshot, Node's is live) so a caller's `GIT_CONFIG_*` overrides are honored.
 */
const git = (root: string, args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: process.env }).trim();

/**
 * Render the hook script. Empty `scopes` = the whole repo (byte-identical to
 * the pre-#4600 script); otherwise `git diff --cached` is limited to the
 * listed pathspecs. Git runs hooks from the worktree root, so the
 * root-relative paths it lists resolve as-is for `gbrain frontmatter validate`.
 */
function renderHookScript(scopes: string[]): string {
  scopes.forEach(assertNoLineTerminator);
  const marker = scopes.map((s) => `${SCOPE_MARKER}${s}\n`).join('');
  const pathspec = scopes.length > 0 ? ` -- ${scopes.map(shellQuote).join(' ')}` : '';
  return `#!/bin/sh
${HOOK_BANNER}
${marker}# Validates YAML frontmatter on staged .md / .mdx files. Bypass with
# 'git commit --no-verify'. Uninstall with 'gbrain frontmatter install-hook --uninstall'.

set -e

if ! command -v gbrain >/dev/null 2>&1; then
  echo "gbrain not on PATH; skipping frontmatter pre-commit (install gbrain to re-enable)." >&2
  exit 0
fi

# One path per line: -z disables git's quoting (a non-ASCII name would print
# as "caf\\303\\251.md"), tr turns the NUL terminators into newlines, and the
# read loop keeps spaces intact (a newline INSIDE a name is the one unsupported
# shape). The heredoc keeps the loop in this shell so 'failed' survives it.
staged=$(git diff --cached --name-only -z --diff-filter=ACM${pathspec} | tr '\\0' '\\n' | grep -E '\\.mdx?$' || true)
[ -z "$staged" ] && exit 0

failed=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if ! gbrain frontmatter validate "$f" >/dev/null 2>&1; then
    gbrain frontmatter validate "$f" >&2
    failed=1
  fi
done <<EOF
$staged
EOF

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "Frontmatter validation failed. Run 'gbrain frontmatter validate <file> --fix' to repair, or 'git commit --no-verify' to bypass." >&2
  exit 1
fi
`;
}

function parseScopes(hook: string): string[] {
  return hook
    .split('\n')
    .filter((l) => l.startsWith(SCOPE_MARKER))
    .map((l) => l.slice(SCOPE_MARKER.length));
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

export async function runFrontmatterInstallHook(args: string[]): Promise<void> {
  let force = false;
  let uninstall = false;
  let sourceId: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--force') force = true;
    else if (a === '--uninstall') uninstall = true;
    else if (a === '--source') sourceId = args[++i];
    else if (a.startsWith('--source=')) sourceId = a.slice('--source='.length);
  }

  if (help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config) {
    throw new Error('No brain configured. Run: gbrain init');
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    const sources = await listSources(engine, sourceId);
    if (sources.length === 0) {
      console.log(sourceId
        ? `Source "${sourceId}" not found.`
        : 'No registered sources. Run `gbrain sources list` to inspect.');
      return;
    }

    let installed = 0;
    let skipped = 0;
    for (const src of sources) {
      if (!src.local_path || !existsSync(src.local_path)) {
        console.log(`[${src.id}] skipped — local_path missing on disk`);
        skipped++;
        continue;
      }
      let target: HookTarget;
      try {
        target = resolveHookTarget(src.local_path);
      } catch (err) {
        // Outside any git repo, or a path the hook script cannot carry safely.
        console.log(`[${src.id}] ${src.local_path} — skipped, ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
        continue;
      }
      if (uninstall) {
        let removed: boolean;
        try {
          removed = uninstallHook(src.local_path);
        } catch (err) {
          // Same refusal class as install (symlinked .githooks/ or hook): this
          // source is reported and skipped, the remaining sources still run.
          console.log(`[${src.id}] skipped — ${err instanceof Error ? err.message : String(err)}`);
          skipped++;
          continue;
        }
        if (removed) {
          console.log(`[${src.id}] hook removed`);
          installed++;
        } else {
          console.log(`[${src.id}] no gbrain pre-commit hook found; nothing to uninstall`);
        }
        continue;
      }
      let result: InstallResult;
      try {
        result = installHook(src.local_path, force);
      } catch (err) {
        // e.g. a symlinked .githooks/ — refused, the other sources still run.
        console.log(`[${src.id}] skipped — ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
        continue;
      }
      if (result === 'installed') {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- target.root is the git root discovered with `git rev-parse` for a registered source path; the tail is a fixed literal
        const where = join(target.root, '.githooks', 'pre-commit');
        console.log(`[${src.id}] hook installed at ${where}${target.scope ? ` (scoped to ${target.scope})` : ''}`);
        installed++;
      } else if (result === 'installed_unwired') {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- target.root is the discovered git root of a registered source; fixed literal tail
        const where = join(target.root, '.githooks', 'pre-commit');
        console.log(`[${src.id}] hook written at ${where}; core.hooksPath left unset — ${hooksPathBlocker(target.root)}`);
        installed++;
      } else if (result === 'skipped_existing') {
        console.log(`[${src.id}] existing pre-commit hook found; pass --force to overwrite (.bak created)`);
        skipped++;
      } else {
        console.log(`[${src.id}] hook already up to date`);
      }
    }

    console.log(`\nDone. ${installed} ${uninstall ? 'removed' : 'installed/updated'}, ${skipped} skipped.`);
  } finally {
    await engine.disconnect();
  }
}

function printHelp() {
  console.log(`gbrain frontmatter install-hook — install pre-commit hook in source git repos

Usage:
  gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]

The hook runs \`gbrain frontmatter validate\` against staged .md/.mdx files,
blocking commits with malformed frontmatter. Bypass with 'git commit --no-verify'.
A source registered as a subdirectory of a host repo gets the hook at the host
root, scoped to that subdirectory.

Options:
  --source <id>  Limit to one registered source. Default: all sources.
  --force        Overwrite an existing pre-commit hook (writes <hook>.bak).
  --uninstall    Remove the hook; restore <hook>.bak if present.
`);
}

async function listSources(engine: BrainEngine, sourceId?: string): Promise<SourceRow[]> {
  if (sourceId) {
    return engine.executeRaw<SourceRow>(`SELECT id, local_path FROM sources WHERE id = $1`, [sourceId]);
  }
  // #3880: all-source hook installation skips archived sources (v34 legacy
  // fallback, house style per pickSoleNonDefaultSource). Explicit --source
  // targeting above stays deliberate.
  try {
    return await engine.executeRaw<SourceRow>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id`,
    );
  } catch {
    return engine.executeRaw<SourceRow>(`SELECT id, local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id`);
  }
}

interface HookTarget {
  /** Realpath of the enclosing git worktree root. */
  root: string;
  /** Root-relative subdirectory the hook guards, trailing slash ('' when local_path IS the root). */
  scope: string;
}

/**
 * Discover the git root enclosing `localPath` (the same helper `gbrain sync`
 * uses, so both commands accept the same shapes) and the root-relative scope.
 * Both sides are realpath'd: `git rev-parse --show-toplevel` returns the
 * resolved path, and an unresolved /tmp on macOS (/private/tmp) would
 * otherwise yield a `..` scope. Throws when `localPath` is outside any repo.
 */
function resolveHookTarget(localPath: string): HookTarget {
  const root = realpathSync(discoverGitRoot(localPath));
  const rel = relative(root, realpathSync(localPath));
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`Not inside a git repository: ${localPath} resolves outside its git root ${root}`);
  }
  assertNoLineTerminator(rel);
  return { root, scope: rel ? `${rel}/` : '' };
}

type InstallResult = 'installed' | 'installed_unwired' | 'skipped_existing' | 'unchanged';

/**
 * `.githooks/` and its `pre-commit` under `root`. Refuses a symlink at either
 * level: a committed link in a host repo would redirect our write/chmod/rm to
 * wherever it points (lstat, so a dangling link is refused too).
 */
function hookPaths(root: string): { hooksDir: string; hookPath: string } {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- root is the discovered git root of a registered source; fixed literal tail
  const hooksDir = join(root, '.githooks');
  const hookPath = join(hooksDir, 'pre-commit');
  for (const p of [hooksDir, hookPath]) {
    let link = false;
    try { link = lstatSync(p).isSymbolicLink(); } catch { /* absent — fine */ }
    if (link) throw new Error(`Refusing to write through a symlink: ${p}`);
  }
  return { hooksDir, hookPath };
}

/**
 * Hooks git would run from the repo's own hooks dir today: executable,
 * non-`*.sample` files (git skips both non-executable files and samples).
 * The dir is `<git common dir>/hooks` (worktree-safe — `.git` is a FILE in
 * linked worktrees, and hooks live in the shared common dir). NOT
 * `rev-parse --git-path hooks`: that honors core.hooksPath, so under a global
 * hooksPath it would list the FOREIGN dir instead of the one wiring sidelines.
 */
export function activeGitHooks(root: string): string[] {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- root is the discovered git root; fixed literal tail
  let dir = join(root, '.git', 'hooks');
  try {
    const p = git(root, ['rev-parse', '--git-common-dir']);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- p is `git rev-parse --git-path hooks` output for that same root (the operator's own repo layout), not caller input
    if (p) dir = join(isAbsolute(p) ? p : join(root, p), 'hooks');
  } catch { /* classic layout fallback */ }
  return executableHooks(dir);
}

/** Executable, non-`*.sample` files in `dir` — what git runs from a hooks dir. */
function executableHooks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    if (f.endsWith('.sample')) return false;
    try {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir is the resolved hooks directory above and f is a directory entry read from it
      const st = statSync(join(dir, f));
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch { return false; }
  }).sort();
}

/**
 * Where `core.hooksPath` points today (any scope — a global/corporate value
 * counts, git reads it), resolved against the worktree root the way git does a
 * relative value, `~` expanded via `--type=path`; '' when unset.
 */
function currentHooksPath(root: string): string {
  try {
    const p = git(root, ['config', '--type=path', '--get', 'core.hooksPath']);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- p is the repo's own core.hooksPath config value, resolved against its git root to compare with `.githooks`
    return p ? resolve(root, p) : '';
  } catch {
    return ''; // git config exits non-zero when the key is unset — the normal case.
  }
}

const samePath = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};

/**
 * Why `.githooks` is not wired as `core.hooksPath` (an operator-facing sentence
 * with the manual step), or null when it already is / safely can be. A
 * hooksPath already pointing ELSEWHERE is theirs to keep — git never reads
 * `.githooks/` then, so "installed" would lie. Wiring makes git run EVERY
 * executable script in `.githooks/` — third-party clones commit hooks there as
 * a convention — and ignore `.git/hooks/*` for every hook type, so a foreign
 * `.githooks/<hook>` or a live `.git/hooks/<hook>` both block it too.
 */
export function hooksPathBlocker(root: string): string | null {
  const current = currentHooksPath(root);
  if (current) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- fixed literal tail under the discovered git root
    if (samePath(current, join(root, '.githooks'))) return null;
    return `core.hooksPath already points at ${current} (git reads hooks only from there); copy .githooks/pre-commit into it, or run: git -C ${root} config core.hooksPath .githooks`;
  }
  const wire = `then run: git -C ${root} config core.hooksPath .githooks`;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- fixed literal tail under the discovered git root
  const foreign = executableHooks(join(root, '.githooks')).filter((f) => f !== 'pre-commit');
  if (foreign.length > 0) return `.githooks/ holds other hook scripts git would start running (${foreign.join(', ')}); review them, ${wire}`;
  const live = activeGitHooks(root);
  if (live.length > 0) return `active hooks in .git/hooks (${live.join(', ')}) would stop running; move them into .githooks/, ${wire}`;
  return null;
}

export function installHook(localPath: string, force: boolean): InstallResult {
  const { root, scope } = resolveHookTarget(localPath);
  const { hooksDir, hookPath } = hookPaths(root);
  mkdirSync(hooksDir, { recursive: true });

  let next = renderHookScript(scope ? [scope] : []);
  let changed = true;
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_BANNER)) {
      // Already a gbrain hook — refresh it, keeping every scope it guards.
      // One hook per root: a nested source joins the pathspec union; a
      // whole-repo hook (root source, or no marker) already covers everything.
      const prior = parseScopes(existing);
      const wholeRepo = !scope || prior.length === 0;
      next = renderHookScript(wholeRepo ? [] : [...new Set([...prior, scope])].sort());
      changed = next !== existing;
    } else if (!force) {
      return 'skipped_existing';
    } else {
      copyFileSync(hookPath, hookPath + '.bak');
    }
  }
  writeFileSync(hookPath, next);
  chmodSync(hookPath, 0o755);

  // Every branch that leaves a hook on disk reaches the wiring step: the hook
  // FILE travels with the repo, core.hooksPath is per-clone config, so a fresh
  // clone of a repo that committed the hook has the script but git never runs
  // it. A blocker (hooksPath set elsewhere — theirs to keep — or hooks that
  // wiring would activate/sideline) leaves it unset; the CLI prints the reason.
  if (hooksPathBlocker(root)) return 'installed_unwired';
  if (currentHooksPath(root)) return changed ? 'installed' : 'unchanged'; // already resolves to .githooks
  try {
    git(root, ['config', 'core.hooksPath', '.githooks']);
  } catch {
    // Best-effort. Hook still exists; user can configure manually.
  }
  return 'installed';
}

export function uninstallHook(localPath: string): boolean {
  const { root, scope } = resolveHookTarget(localPath);
  const { hookPath } = hookPaths(root);
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf8');
  if (!content.includes(HOOK_BANNER)) return false;
  if (scope) {
    // Nested source: only its own pathspec is ours to drop — a whole-repo hook
    // (root-registered source) or other nested sources' scopes stay.
    const prior = parseScopes(content);
    if (!prior.includes(scope)) return false;
    const remaining = prior.filter((s) => s !== scope);
    if (remaining.length > 0) {
      writeFileSync(hookPath, renderHookScript(remaining));
      chmodSync(hookPath, 0o755);
      return true;
    }
  }
  rmSync(hookPath);
  if (existsSync(hookPath + '.bak')) {
    copyFileSync(hookPath + '.bak', hookPath);
    rmSync(hookPath + '.bak');
  }
  return true;
}
