/**
 * Which harness a bootstrap render targets (#7470). OpenClaw 2026.10.6+ retired
 * its own HEARTBEAT.md: `openclaw doctor --fix` imports a workspace file by that
 * name into its heartbeat monitor and removes it, so an OpenClaw render writes
 * gbrain's due-job list under another name (assets.ts `openclawDest`).
 */

import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Whether a workspace belongs to OpenClaw, from OpenClaw's own layout: the
 * configured workspace (OPENCLAW_WORKSPACE_DIR, or gbrain's OPENCLAW_WORKSPACE),
 * or a `workspace` tree under the state directory (OPENCLAW_STATE_DIR,
 * ~/.openclaw, or a profile's ~/.openclaw-<profile>). A workspace elsewhere
 * that OpenClaw was pointed at by config alone needs `render --host openclaw`.
 */
export function detectOpenClawWorkspace(
  workspaceDir: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): boolean {
  const ws = resolve(workspaceDir);
  for (const configured of [env.OPENCLAW_WORKSPACE_DIR, env.OPENCLAW_WORKSPACE]) {
    if (configured && resolve(configured) === ws) return true;
  }
  const underWorkspaceOf = (stateDir: string): boolean => {
    const rel = relative(resolve(stateDir), ws);
    const first = rel.split(sep)[0] ?? '';
    return rel !== '' && !rel.startsWith('..') && /^workspace(-.+)?$/.test(first);
  };
  if (env.OPENCLAW_STATE_DIR && underWorkspaceOf(env.OPENCLAW_STATE_DIR)) return true;
  const profile = relative(resolve(home), ws).split(sep)[0] ?? '';
  return /^\.openclaw(-.+)?$/.test(profile) && underWorkspaceOf(join(home, profile));
}

/** `bootstrap render --host`: 'openclaw' forces OpenClaw, 'generic' declines
 * it, 'auto' detects it (never in minimal mode). Any other value is null. */
export function resolveRenderHost(workspaceDir: string, flag: string, minimal: boolean): 'openclaw' | undefined | null {
  if (flag === 'openclaw') return 'openclaw';
  if (flag === 'generic') return undefined;
  if (flag !== 'auto') return null;
  return !minimal && detectOpenClawWorkspace(workspaceDir) ? 'openclaw' : undefined;
}

export const OPENCLAW_RENDER_NOTE =
  'OpenClaw workspace: the due-job list renders as SCHEDULES.md, and AGENTS.md points there. OpenClaw 2026.10.6+ ' +
  'retired HEARTBEAT.md, and its doctor migration imports and removes any workspace file by that name. ' +
  'Pass --host generic to keep HEARTBEAT.md.';
