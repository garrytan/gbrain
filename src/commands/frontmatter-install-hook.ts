/**
 * gbrain frontmatter install-hook — Install a pre-commit hook in a brain
 * source's git repo that runs `gbrain frontmatter validate` against staged
 * .md/.mdx files. Skips non-git sources with a one-line note.
 *
 * Usage:
 *   gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]
 *
 *   --source <id>  Limit to one registered source. Default: all sources.
 *   --force        Overwrite an existing pre-commit hook (writes <hook>.bak).
 *   --uninstall    Remove the hook; restore <hook>.bak if present.
 *
 * Hook contract:
 *   - Located at <source>/.githooks/pre-commit. We `git config core.hooksPath
 *     .githooks` if no other hooksPath is set.
 *   - When the gbrain binary is missing, the hook prints a one-line warning
 *     and exits 0 (don't break commits if a developer uninstalls gbrain).
 *   - Bypass via `git commit --no-verify`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';

const HOOK_BANNER = '# gbrain frontmatter pre-commit hook (v0.22.4+)';

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_BANNER}
# Validates YAML frontmatter on staged .md / .mdx files. Bypass with
# 'git commit --no-verify'. Uninstall with 'gbrain frontmatter install-hook --uninstall'.

set -e

if ! command -v gbrain >/dev/null 2>&1; then
  echo "gbrain not on PATH; skipping frontmatter pre-commit (install gbrain to re-enable)." >&2
  exit 0
fi

staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\\\.mdx?$' || true)
[ -z "$staged" ] && exit 0

failed=0
for f in $staged; do
  [ -f "$f" ] || continue
  if ! gbrain frontmatter validate "$f" >/dev/null 2>&1; then
    gbrain frontmatter validate "$f" >&2
    failed=1
  fi
done

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "Frontmatter validation failed. Run 'gbrain frontmatter validate <file> --fix' to repair, or 'git commit --no-verify' to bypass." >&2
  exit 1
fi
`;

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
      if (!isGitRepo(src.local_path)) {
        console.log(`[${src.id}] ${src.local_path} — skipped, not a git repo`);
        skipped++;
        continue;
      }
      if (uninstall) {
        if (uninstallHook(src.local_path)) {
          console.log(`[${src.id}] hook removed`);
          installed++;
        } else {
          console.log(`[${src.id}] no gbrain pre-commit hook found; nothing to uninstall`);
        }
        continue;
      }
      const result = installHook(src.local_path, force);
      if (result === 'installed') {
        console.log(`[${src.id}] hook installed at .githooks/pre-commit`);
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
  return engine.executeRaw<SourceRow>(`SELECT id, local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id`);
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

type InstallResult = 'installed' | 'skipped_existing' | 'unchanged';

export function installHook(repoPath: string, force: boolean): InstallResult {
  const hooksDir = join(repoPath, '.githooks');
  const hookPath = join(hooksDir, 'pre-commit');
  mkdirSync(hooksDir, { recursive: true });

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_BANNER)) {
      // Already a gbrain hook — refresh the script content silently.
      writeFileSync(hookPath, HOOK_SCRIPT);
      chmodSync(hookPath, 0o755);
      return 'unchanged';
    }
    if (!force) return 'skipped_existing';
    copyFileSync(hookPath, hookPath + '.bak');
  }

  writeFileSync(hookPath, HOOK_SCRIPT);
  chmodSync(hookPath, 0o755);

  // Set core.hooksPath unless the user has set it to something else already.
  try {
    const current = execFileSync('git', ['-C', repoPath, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    if (current && current !== '.githooks') return 'installed';
  } catch {
    // git config returns non-zero when the key is unset; that's the normal case.
  }
  try {
    execFileSync('git', ['-C', repoPath, 'config', 'core.hooksPath', '.githooks']);
  } catch {
    // Best-effort. Hook still exists; user can configure manually.
  }
  return 'installed';
}

export function uninstallHook(repoPath: string): boolean {
  const hookPath = join(repoPath, '.githooks', 'pre-commit');
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf8');
  if (!content.includes(HOOK_BANNER)) return false;
  rmSync(hookPath);
  if (existsSync(hookPath + '.bak')) {
    copyFileSync(hookPath + '.bak', hookPath);
    rmSync(hookPath + '.bak');
  }
  return true;
}
