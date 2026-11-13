/**
 * GST-363: the harness config this machine holds, read for the
 * unscoped_multi_user_token warning (detection and notice in
 * src/core/grants/shared-exposure.ts): Claude Code's enabled chat-channel
 * plugins and the bot harness whose home holds a workspace. CLI-side, so the
 * embeddable core reads no file or environment for it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { claudeConfigDir } from '../core/bootstrap/host-specs.ts';
import { CHANNEL_PLUGINS } from '../core/grants/shared-exposure.ts';

/** The chat-channel plugins Claude Code has enabled (settings.json `enabledPlugins`, `<name>@<marketplace>: true`). */
export function claudeCodeChannelPlugins(configDir = claudeConfigDir()): string[] {
  const path = join(configDir, 'settings.json');
  if (!existsSync(path)) return [];
  try {
    const enabled = (JSON.parse(readFileSync(path, 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {};
    return Object.entries(enabled).filter(([key, on]) => on === true && CHANNEL_PLUGINS.includes(key.split('@')[0]!.toLowerCase())).map(([key]) => key);
  } catch {
    return [];
  }
}

/** The bot harness whose home holds this workspace (OpenClaw's ~/.openclaw*, Hermes's $HERMES_HOME or ~/.hermes), or null. */
export function botHarnessForWorkspace(workspace: string | null | undefined, home = homedir()): string | null {
  if (!workspace) return null;
  const path = resolve(workspace);
  const under = (dir: string) => path === dir || path.startsWith(dir + sep);
  const hermesHome = process.env.HERMES_HOME?.trim() ? resolve(process.env.HERMES_HOME.trim().replace(/^~(?=$|\/)/, home)) : join(home, '.hermes');
  if (under(hermesHome)) return 'hermes';
  const first = relative(home, path).split(sep)[0] ?? '';
  return first === '.openclaw' || first.startsWith('.openclaw-') ? 'openclaw' : null;
}
