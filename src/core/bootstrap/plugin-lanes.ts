/**
 * bootstrap/plugin-lanes.ts — plugin-lane detection: a Codex or Claude Code
 * plugin that provides the gbrain MCP server (moved out of harness.ts, which
 * re-exports these names). `enabledPluginLanes` is the one list both doctor
 * checks read (`plugin_lane_collision`, `harness_wiring`), so they cannot
 * disagree about whether a harness is covered.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeUserSettingsPath, codexConfigPath } from './host-specs.ts';

// ── Plugin-lane detection (codex/claude plugins provide an MCP server) ─────
//
// Plugin-provided MCP servers never appear in `codex mcp list` or in
// `[mcp_servers.*]` — the only cheap CONFIG signal is the plugin-enable
// entry in the harness's own config. Config is not health (an enabled
// plugin whose launcher can't find the gbrain binary still matches), so
// every consumer pairs the detection with an override path
// (`--mcp-even-if-plugin`) and copy that says "enabled, not necessarily
// healthy". All three detectors below share the read/normalize posture of
// codexBlockOwnsName: fail-open (null/false) on any read or parse error.

/**
 * Marketplace-qualified id (`<name>@<marketplace>`) when an ENABLED codex
 * plugin named `name` exists in the codex config, else null. Line-anchored
 * table-header scan — a commented-out lookalike or an inline mention never
 * matches — followed by `enabled = true` before the next table header.
 */
export function codexPluginProvidesName(configPath: string, name: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const lines = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const prefix = `[plugins."${name}@`;
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].trimEnd();
      if (!head.startsWith(prefix) || !head.endsWith('"]')) continue;
      const marketplace = head.slice(prefix.length, -2);
      if (!marketplace || marketplace.includes('"')) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line.startsWith('[')) break;
        if (/^enabled\s*=\s*true\b/.test(line)) return `${name}@${marketplace}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Marketplace-qualified id when an ENABLED Claude Code plugin named `name`
 * exists in `~/.claude/settings.json` (`enabledPlugins`: `"<name>@<mkt>":
 * true` — the shape verified on a live install), else null. User-level file
 * only; project-scope enablement is out of best-effort scope.
 */
export function claudePluginProvidesName(settingsPath: string, name: string): string | null {
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      enabledPlugins?: Record<string, unknown>;
    };
    const enabled = parsed.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return null;
    const prefix = `${name}@`;
    for (const [key, value] of Object.entries(enabled)) {
      if (key.startsWith(prefix) && value === true) return key;
    }
    return null;
  } catch {
    return null;
  }
}

/** One harness whose config enables a plugin that provides `name`. */
export interface PluginLane {
  harness: 'codex' | 'claude-code';
  /** Marketplace-qualified plugin id, e.g. `gbrain@gbrain`. */
  plugin: string;
}

/** Every harness whose config ENABLES a plugin providing `name` (config, not
 * health: an enabled plugin whose launcher fails still counts). */
export function enabledPluginLanes(name = 'gbrain'): PluginLane[] {
  const lanes: PluginLane[] = [];
  const codex = codexPluginProvidesName(codexConfigPath(), name);
  if (codex) lanes.push({ harness: 'codex', plugin: codex });
  const claude = claudePluginProvidesName(claudeUserSettingsPath(), name);
  if (claude) lanes.push({ harness: 'claude-code', plugin: claude });
  return lanes;
}

/**
 * Doctor-side coexistence scan: does ANY registration for `name` exist in
 * the harness config, regardless of owner? Unlike codexBlockOwnsName this
 * deliberately counts foreign/manual entries — a hand-wired
 * `[mcp_servers.<name>]` next to an enabled plugin is exactly the
 * double-registration the doctor advisory reports. Claude side scans BOTH
 * the user config (`~/.claude.json` mcpServers) and, when a project dir is
 * given, the project-scope `.mcp.json`.
 */
export function codexAnyRegistrationExists(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const lines = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const headers = new Set([`[mcp_servers.${name}]`, `[mcp_servers."${name}"]`]);
    return lines.some(l => headers.has(l.trimEnd()));
  } catch {
    return false;
  }
}

export function claudeAnyRegistrationExists(
  userConfigPath: string,
  name: string,
  projectDir?: string,
): boolean {
  const hasInMcpServers = (servers: unknown): boolean =>
    !!servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, name);
  const readJson = (path: string): Record<string, unknown> | null => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const userCfg = readJson(userConfigPath) as {
    mcpServers?: unknown;
    projects?: Record<string, { mcpServers?: unknown }>;
  } | null;
  if (userCfg) {
    // User scope: top-level mcpServers.
    if (hasInMcpServers(userCfg.mcpServers)) return true;
    // LOCAL scope: `claude mcp add` (README Option 1) defaults here —
    // projects.<cwd>.mcpServers in ~/.claude.json, keyed by the resolved
    // project path. Scan the projectDir entry (and, defensively, any entry —
    // a duplicate under ANY project path is still a real coexistence).
    const projects = userCfg.projects;
    if (projects && typeof projects === 'object') {
      if (projectDir && hasInMcpServers(projects[projectDir]?.mcpServers)) return true;
      for (const entry of Object.values(projects)) {
        if (hasInMcpServers(entry?.mcpServers)) return true;
      }
    }
  }
  // Project-committed .mcp.json.
  if (projectDir) {
    const projCfg = readJson(join(projectDir, '.mcp.json')) as { mcpServers?: unknown } | null;
    if (projCfg && hasInMcpServers(projCfg.mcpServers)) return true;
  }
  return false;
}
