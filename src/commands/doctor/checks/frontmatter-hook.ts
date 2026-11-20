import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

export interface OutdatedFrontmatterHook { source_id: string; hook_path: string; version: number; fix: string[] }

/** Installed gbrain pre-commit hooks older than this gbrain's script, one per hook file. */
export async function outdatedFrontmatterHooks(engine: BrainEngine, sourceIds?: string[]): Promise<OutdatedFrontmatterHook[]> {
  const { inspectFrontmatterHook } = await import('../../frontmatter-install-hook.ts');
  const rows = await engine.readDoctorSources('paths_scoped', { sourceIds });
  const seen = new Set<string>();
  const out: OutdatedFrontmatterHook[] = [];
  for (const row of rows) {
    const hook = inspectFrontmatterHook(row.local_path, row.id);
    if (!hook || hook.current || seen.has(hook.hookPath)) continue;
    seen.add(hook.hookPath);
    out.push({ source_id: row.id, hook_path: hook.hookPath, version: hook.version, fix: hook.fix! });
  }
  return out;
}

/**
 * #5988 (E24): an installed frontmatter pre-commit hook written by an older
 * gbrain validates working-tree bytes instead of the staged blobs, so a broken
 * staged file can still be committed. Refreshing an installed hook is the
 * operator's earlier decision carried forward: `gbrain frontmatter
 * install-hook --force` rewrites the gbrain script only.
 */
export async function frontmatterHookCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const hooks = await outdatedFrontmatterHooks(engine, sourceIds);
    const details = { count: hooks.length, hooks, docs: 'docs/guides/repair.md#held-files' };
    if (!hooks.length) return { name: 'frontmatter_hook', status: 'ok', message: 'No outdated gbrain frontmatter pre-commit hook is installed.', details };
    return { name: 'frontmatter_hook', status: 'warn', details,
      message: `${hooks.length} gbrain frontmatter pre-commit hook(s) predate this release and check working-tree files instead of what is staged: `
        + `${hooks.map(hook => `${hook.source_id} (${hook.hook_path}, v${hook.version})`).join('; ')}. Refresh with ${hooks.map(hook => hook.fix.join(' ')).join('; ')}.`,
      fix: agentFix(hooks[0]!.fix, 'Rewrites the installed gbrain pre-commit hook with the current script (validates staged blobs in one process); hooks that are not gbrain\'s are never touched.',
        'frontmatter_hook') };
  } catch (error) {
    return { name: 'frontmatter_hook', status: 'warn', fix_unavailable_reason: 'check_errored', details: { count: 'unknown' },
      message: `Frontmatter pre-commit hooks could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
