/**
 * GBRAIN_PLUGIN_PATH loader for host-repo subagent definitions (v0.15).
 *
 * Your OpenClaw (and future downstream agents) ship custom subagent defs
 * from their own repos. gbrain discovers them at worker startup via
 * GBRAIN_PLUGIN_PATH = colon-separated absolute paths (like $PATH). Each
 * path must contain a gbrain.plugin.json manifest describing the plugin
 * and a subagents/ subdirectory holding `*.md` definition files.
 *
 * Path policy is strict on purpose:
 *   - ABSOLUTE paths only. Relative paths and `~` prefixes are rejected
 *     (no implicit cwd or home expansion — too easy to pick up a tampered
 *     sibling directory).
 *   - Remote URLs (http://, https://, file://) rejected. Plugin loading
 *     must go through the filesystem so the user controls what's there.
 *   - Non-existent paths logged and skipped (do not fail worker startup).
 *
 * Collision policy: left-to-right wins. A warning goes to stderr naming
 * both sides of the collision.
 *
 * Trust policy: plugins ship subagent *defs* only. They cannot declare
 * new tools, cannot extend the brain-allowlist, cannot override
 * agent-safe flags. The `allowed_tools:` frontmatter field of a subagent
 * def must subset the derived registry — validation happens at plugin
 * load time, NOT at subagent dispatch time, so a typo in a plugin skill
 * fails loudly at worker startup instead of silently disabling a tool.
 *
 * Manifest version (`plugin_version`) locks the contract shape. Unknown
 * versions are rejected so the authoritative definition is whatever this
 * version of gbrain understands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

export const SUPPORTED_PLUGIN_VERSION = 'gbrain-plugin-v1';

export interface PluginManifest {
  name: string;
  version: string;
  plugin_version: string;
  subagents?: string;
  description?: string;
}

export interface SubagentDefinition {
  /** The plugin that shipped this def. */
  plugin_name: string;
  /** Stable agent name used as `subagent_def` by CLI callers. */
  name: string;
  /** Full path to the .md file on disk, for debug surfaces. */
  source_path: string;
  frontmatter: Record<string, unknown>;
  /** Markdown body (system prompt content). */
  body: string;
  /** Optional allowed_tools list (frontmatter). Subset of registry. */
  allowed_tools?: string[];
}

export interface PluginLoadResult {
  /** Successfully loaded plugins with their subagents. */
  plugins: Array<{ manifest: PluginManifest; rootDir: string; subagents: SubagentDefinition[] }>;
  /** Per-path warnings (rejected, missing, malformed) collected during load. */
  warnings: string[];
}

export interface LoadOpts {
  /**
   * Registry names the plugin's subagent `allowed_tools` must subset. When
   * present, any frontmatter entry not in this set fails the plugin load.
   * Pass `undefined` to skip validation (early worker startup before the
   * registry is built — but production callers should always pass it).
   */
  validAgentToolNames?: ReadonlySet<string>;
  /** Override the PATH env (for tests). */
  envPath?: string;
}

/** Public entry point: load every plugin directory from GBRAIN_PLUGIN_PATH. */
export function loadPluginsFromEnv(opts: LoadOpts = {}): PluginLoadResult {
  const raw = opts.envPath ?? process.env.GBRAIN_PLUGIN_PATH ?? '';
  const paths = raw.split(':').map(s => s.trim()).filter(Boolean);
  const result: PluginLoadResult = { plugins: [], warnings: [] };

  // Left-wins collision tracking.
  const subagentByName = new Map<string, { pluginName: string; pathLeft: string }>();

  for (const p of paths) {
    const rejection = rejectIfNotAbsolute(p);
    if (rejection) { result.warnings.push(rejection); continue; }
    if (!fs.existsSync(p)) {
      result.warnings.push(`[plugin-loader] path does not exist, skipping: ${p}`);
      continue;
    }
    if (!fs.statSync(p).isDirectory()) {
      result.warnings.push(`[plugin-loader] not a directory, skipping: ${p}`);
      continue;
    }

    try {
      const loaded = loadSinglePlugin(p, opts);
      if ('error' in loaded) {
        result.warnings.push(`[plugin-loader] rejected ${p}: ${loaded.error}`);
        continue;
      }

      const accepted: SubagentDefinition[] = [];
      for (const sa of loaded.subagents) {
        const prior = subagentByName.get(sa.name);
        if (prior) {
          result.warnings.push(
            `[plugin-loader] collision: subagent '${sa.name}' from '${loaded.manifest.name}' at ${p} ` +
            `shadowed by earlier '${prior.pluginName}' at ${prior.pathLeft} (first wins)`,
          );
          continue;
        }
        subagentByName.set(sa.name, { pluginName: loaded.manifest.name, pathLeft: p });
        accepted.push(sa);
      }

      result.plugins.push({ manifest: loaded.manifest, rootDir: p, subagents: accepted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.warnings.push(`[plugin-loader] unexpected error loading ${p}: ${msg}`);
    }
  }

  return result;
}

function rejectIfNotAbsolute(p: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    return `[plugin-loader] remote URL rejected: ${p}`;
  }
  if (p.startsWith('~')) {
    return `[plugin-loader] ~-prefixed path rejected (expand explicitly): ${p}`;
  }
  if (!path.isAbsolute(p)) {
    return `[plugin-loader] relative path rejected: ${p}`;
  }
  return null;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  subagents: SubagentDefinition[];
}

/**
 * Load one plugin directory. Returns a union so callers can differentiate
 * rejection (loud but non-fatal) from an empty plugin (fatal-ish — the
 * manifest parsed but contributes nothing).
 */
export function loadSinglePlugin(
  rootDir: string,
  opts: LoadOpts = {},
): LoadedPlugin | { error: string } {
  const manifestPath = path.join(rootDir, 'gbrain.plugin.json');
  if (!fs.existsSync(manifestPath)) {
    return { error: 'missing gbrain.plugin.json' };
  }

  let manifest: PluginManifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as PluginManifest;
  } catch (e) {
    return { error: `invalid manifest JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    return { error: 'manifest missing required "name" field' };
  }
  if (manifest.plugin_version !== SUPPORTED_PLUGIN_VERSION) {
    return {
      error: `unsupported plugin_version "${manifest.plugin_version}" (gbrain supports "${SUPPORTED_PLUGIN_VERSION}")`,
    };
  }

  const subagentsDirRel = manifest.subagents ?? 'subagents';
  const subagentsDir = path.resolve(rootDir, subagentsDirRel);
  // Prevent `../` escape via the manifest's `subagents` field.
  if (!subagentsDir.startsWith(rootDir + path.sep) && subagentsDir !== rootDir) {
    return { error: `subagents path escapes plugin root: ${subagentsDirRel}` };
  }

  const subagents: SubagentDefinition[] = [];
  if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
    for (const entry of fs.readdirSync(subagentsDir)) {
      if (!entry.endsWith('.md')) continue;
      const sourcePath = path.join(subagentsDir, entry);
      try {
        const raw = fs.readFileSync(sourcePath, 'utf8');
        const parsed = matter(raw);
        const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
        const body = parsed.content ?? '';
        const name = typeof frontmatter.name === 'string'
          ? frontmatter.name
          : entry.replace(/\.md$/, '');
        const allowed = Array.isArray(frontmatter.allowed_tools)
          ? (frontmatter.allowed_tools as unknown[]).filter(x => typeof x === 'string') as string[]
          : undefined;

        if (allowed && opts.validAgentToolNames) {
          const missing = allowed.filter(t => !opts.validAgentToolNames!.has(t));
          if (missing.length > 0) {
            return {
              error: `subagent '${name}' allowed_tools references unknown tools: ${missing.join(', ')}`,
            };
          }
        }

        subagents.push({
          plugin_name: manifest.name,
          name,
          source_path: sourcePath,
          frontmatter,
          body,
          allowed_tools: allowed,
        });
      } catch (e) {
        return { error: `could not parse ${sourcePath}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  return { manifest, subagents };
}

/** Testing surface. */
export const __testing = {
  rejectIfNotAbsolute,
  SUPPORTED_PLUGIN_VERSION,
};
