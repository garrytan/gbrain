/**
 * advisor/collect-uninstalled-bundled.ts — recommended bundled skills not yet
 * installed in this workspace.
 *
 * The generalized successor to post-install-advisory's hardcoded set: reads the
 * single current-state RECOMMENDED list and compares against what's installed.
 * workspace_dependent (A1): needs the agent's workspace, so it no-ops over MCP.
 */

import { currentRecommendedSet } from './recommended-set.ts';
import { detectInstalledSlugs } from './../skillpack/post-install-advisory.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectUninstalledBundled: AdvisorCollector = {
  id: 'uninstalled-bundled',
  collect: async (ctx) => {
    if (ctx.remote) return []; // A1: no workspace over MCP
    if (!ctx.workspace || !ctx.skillsDir) return [];

    let installed: Set<string>;
    try {
      installed = detectInstalledSlugs(ctx.skillsDir, ctx.workspace);
    } catch {
      return [];
    }
    const missing = currentRecommendedSet().filter((s) => !installed.has(s.slug));
    if (missing.length === 0) return [];

    const findings: AdvisorFinding[] = [
      {
        id: 'uninstalled_bundled_skills',
        severity: 'info',
        title: `${missing.length} recommended skill${missing.length === 1 ? ' is' : 's are'} not installed in this workspace.`,
        detail: missing.map((s) => s.slug).join(', '),
        fix: { command_argv: ['gbrain', 'skillpack', 'scaffold', ...missing.map((s) => s.slug)] },
        collector: 'uninstalled-bundled',
        ask_user: true,
        workspace_dependent: true,
      },
    ];
    return findings;
  },
};
