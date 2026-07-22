/**
 * Skillpack-distributed IngestionSource loader. Sibling to plugin-loader.ts
 * (which loads subagent definitions); shares the same GBRAIN_PLUGIN_PATH
 * discovery mechanism and gbrain.plugin.json manifest format, but reads a
 * different optional field (`ingestion_sources`) and produces a different
 * shape (factory functions, not subagent definitions).
 *
 * A skillpack that ships an ingestion source adds to its gbrain.plugin.json:
 *
 *   {
 *     "name": "granola-source",
 *     "plugin_version": "gbrain-plugin-v1",
 *     "ingestion_sources": [
 *       {
 *         "kind": "voice-granola",
 *         "module": "./dist/source.js",
 *         "api_version": "gbrain-ingestion-source-v1",
 *         "default_config": { "transcription_model": "whisper-1" },
 *         "permissions": ["network"]
 *       }
 *     ]
 *   }
 *
 * The module's default export MUST be a factory:
 *
 *   export default function createSource(config: Record<string, unknown>):
 *     IngestionSource { return { id, kind, start, stop, healthCheck? }; }
 *
 * Trust model (v1): sources are in-process, evaluated as TS/JS modules in
 * the daemon. The TOFU prompt during `gbrain skillpack scaffold` is the user
 * acknowledging they trust the source's code. Subprocess / VM isolation is
 * a v2 hardening wave — see TODOS.md.
 *
 * Permissions are display-only in v1 (informational during install). The
 * field exists so future v2 isolation can enforce them at runtime without a
 * breaking manifest change.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IngestionSource } from './types.ts';
import { INGESTION_SOURCE_API_VERSION } from './types.ts';

/** Currently-supported api_version values. Reverse aliases for older
 *  versions live here when we ship contract v2 — until then there's just
 *  the canonical v1. */
const COMPATIBLE_API_VERSIONS: ReadonlySet<string> = new Set([
  INGESTION_SOURCE_API_VERSION,
]);

const SUPPORTED_PLUGIN_VERSION = 'gbrain-plugin-v1';

export interface IngestionSourceDeclaration {
  /** Source kind taxonomy. Must be unique across all loaded sources. */
  kind: string;
  /** Relative path within the skillpack root pointing at the factory module. */
  module: string;
  /** Contract version the source was built against. Must match
   *  INGESTION_SOURCE_API_VERSION (or a known back-compat alias). */
  api_version: string;
  /** Default config merged with per-install overrides before passing to
   *  ctx.config in source.start(). Optional. */
  default_config?: Record<string, unknown>;
  /** Display-only in v1; declares the runtime capabilities the source
   *  expects (network, filesystem, etc.) for the TOFU trust prompt. */
  permissions?: string[];
}

interface IngestionSourceManifestSlice {
  name: string;
  plugin_version: string;
  ingestion_sources?: IngestionSourceDeclaration[];
}

/** Factory contract — default export shape every skillpack source module
 *  must conform to. */
export type IngestionSourceFactory =
  (config: Record<string, unknown>) => IngestionSource;

export interface LoadedIngestionSource {
  /** The plugin/skillpack that shipped this source. For error messages
   *  and the doctor surface. */
  plugin_name: string;
  /** Source declaration from the manifest. */
  declaration: IngestionSourceDeclaration;
  /** Resolved factory function. Daemon invokes with config to instantiate. */
  factory: IngestionSourceFactory;
  /** Absolute path to the loaded module file, for debug surfaces. */
  module_path: string;
  /** The plugin root dir the source was loaded from. */
  plugin_root: string;
}

export interface SkillpackSourceLoadResult {
  /** Successfully loaded source factories. */
  sources: LoadedIngestionSource[];
  /** Per-path warnings (rejected, missing, malformed) for non-fatal cases
   *  the doctor surfaces. */
  warnings: string[];
}

export interface LoadSkillpackSourcesOpts {
  /** Override the GBRAIN_PLUGIN_PATH env (for tests). */
  envPath?: string;
  /** Test seam: alternative import() function for stubbing module loads. */
  _import?: (specifier: string) => Promise<unknown>;
}

/**
 * Discover and load every IngestionSource from GBRAIN_PLUGIN_PATH. Iteration
 * order follows the path list (left-to-right); collisions on `kind` are
 * surfaced as warnings and the later one is skipped.
 *
 * Non-fatal failures (missing path, malformed manifest, module load error)
 * land in `warnings` and the offending plugin is skipped. Fatal failures
 * (api_version mismatch on a declared source) abort that plugin's source
 * loading entirely so the user sees the loud-fail message in doctor.
 */
export async function loadSkillpackSources(
  opts: LoadSkillpackSourcesOpts = {},
): Promise<SkillpackSourceLoadResult> {
  const raw = opts.envPath ?? process.env.GBRAIN_PLUGIN_PATH ?? '';
  const paths = raw.split(':').map((s) => s.trim()).filter(Boolean);
  const result: SkillpackSourceLoadResult = { sources: [], warnings: [] };

  // Left-wins collision tracking on `kind`. Two skillpacks declaring the
  // same kind is a real problem — sources are identified by kind in
  // gbrain.yml — and we want the warning to name both sides so the user
  // can pick.
  const kindByPlugin = new Map<string, { pluginName: string; pluginRoot: string }>();

  for (const p of paths) {
    const rejection = rejectIfNotAbsolute(p);
    if (rejection) {
      result.warnings.push(rejection);
      continue;
    }
    if (!fs.existsSync(p)) {
      result.warnings.push(`[ingestion-load] path does not exist, skipping: ${p}`);
      continue;
    }
    if (!fs.statSync(p).isDirectory()) {
      result.warnings.push(`[ingestion-load] not a directory, skipping: ${p}`);
      continue;
    }

    const manifestPath = path.join(p, 'gbrain.plugin.json');
    if (!fs.existsSync(manifestPath)) {
      // Not an error — many plugins ship only subagents and skip the
      // ingestion_sources field. Silently move on.
      continue;
    }

    let manifest: IngestionSourceManifestSlice;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      result.warnings.push(
        `[ingestion-load] invalid manifest JSON at ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    if (manifest.plugin_version !== SUPPORTED_PLUGIN_VERSION) {
      result.warnings.push(
        `[ingestion-load] unsupported plugin_version '${manifest.plugin_version}' at ${manifestPath} ` +
          `(gbrain supports '${SUPPORTED_PLUGIN_VERSION}')`,
      );
      continue;
    }

    if (!manifest.ingestion_sources || manifest.ingestion_sources.length === 0) {
      // No sources declared — fine, the plugin may ship other artifacts.
      continue;
    }

    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      result.warnings.push(
        `[ingestion-load] manifest at ${manifestPath} missing required "name" field; skipping`,
      );
      continue;
    }

    for (const decl of manifest.ingestion_sources) {
      const declErr = validateDeclaration(decl);
      if (declErr) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} declaration rejected: ${declErr}`,
        );
        continue;
      }

      // api_version compatibility check. Loud-fail with paste-ready upgrade
      // hint so users know exactly what to do.
      if (!COMPATIBLE_API_VERSIONS.has(decl.api_version)) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} source '${decl.kind}' declares ` +
            `api_version='${decl.api_version}' but gbrain expects ` +
            `'${INGESTION_SOURCE_API_VERSION}'. The skillpack was built ` +
            `against a different contract version. Fix: upgrade the ` +
            `skillpack (publisher needs to rebuild against the new ` +
            `IngestionSource contract) OR downgrade gbrain. Skillpack docs: ` +
            `https://github.com/garrytan/gbrain/blob/master/docs/ingestion-source-skillpack.md`,
        );
        continue;
      }

      const prior = kindByPlugin.get(decl.kind);
      if (prior) {
        result.warnings.push(
          `[ingestion-load] kind collision: source '${decl.kind}' from ` +
            `'${manifest.name}' at ${p} is shadowed by earlier ` +
            `'${prior.pluginName}' at ${prior.pluginRoot} (first wins)`,
        );
        continue;
      }

      // Resolve the module path inside the plugin root. Prevent ../ escape.
      const modulePath = path.resolve(p, decl.module);
      if (!modulePath.startsWith(p + path.sep) && modulePath !== p) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} source '${decl.kind}' module ` +
            `path '${decl.module}' escapes plugin root; rejected`,
        );
        continue;
      }
      if (!fs.existsSync(modulePath)) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} source '${decl.kind}' module ` +
            `not found at ${modulePath}; rejected`,
        );
        continue;
      }

      // Dynamic import. Errors here are typically syntax errors or missing
      // peer deps in the skillpack — surface them with the file path.
      const importer = opts._import ?? ((spec: string) => import(spec));
      let mod: unknown;
      try {
        mod = await importer(modulePath);
      } catch (e) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} source '${decl.kind}' failed ` +
            `to import: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      // Resolve factory from default export. We accept either:
      //   - `export default function(config) { ... }` (ESM default)
      //   - `module.exports = function(config) { ... }` (CJS default
      //     when interop'd by Bun)
      const factoryCandidate = extractFactory(mod);
      if (!factoryCandidate) {
        result.warnings.push(
          `[ingestion-load] ${manifest.name} source '${decl.kind}' module ` +
            `${modulePath} does not export a factory function as its default. ` +
            `Expected: \`export default function createSource(config) { return { id, kind, start, stop }; }\``,
        );
        continue;
      }

      kindByPlugin.set(decl.kind, { pluginName: manifest.name, pluginRoot: p });
      result.sources.push({
        plugin_name: manifest.name,
        declaration: decl,
        factory: factoryCandidate,
        module_path: modulePath,
        plugin_root: p,
      });
    }
  }

  return result;
}

/**
 * Validate a single source declaration. Returns null on success; error
 * string on failure. Pure function, no I/O.
 */
function validateDeclaration(decl: unknown): string | null {
  if (decl === null || typeof decl !== 'object') {
    return 'declaration must be an object';
  }
  const d = decl as Record<string, unknown>;
  if (typeof d.kind !== 'string' || d.kind.length === 0) {
    return 'kind must be a non-empty string';
  }
  if (typeof d.module !== 'string' || d.module.length === 0) {
    return `source '${d.kind}': module must be a non-empty string`;
  }
  if (typeof d.api_version !== 'string' || d.api_version.length === 0) {
    return `source '${d.kind}': api_version must be a non-empty string`;
  }
  if (d.default_config !== undefined) {
    if (d.default_config === null || typeof d.default_config !== 'object' || Array.isArray(d.default_config)) {
      return `source '${d.kind}': default_config must be a plain object when present`;
    }
  }
  if (d.permissions !== undefined) {
    if (!Array.isArray(d.permissions) || !d.permissions.every((p) => typeof p === 'string')) {
      return `source '${d.kind}': permissions must be an array of strings when present`;
    }
  }
  return null;
}

/** Extract a factory function from a loaded module (ESM or CJS-interop). */
function extractFactory(mod: unknown): IngestionSourceFactory | null {
  if (mod === null || typeof mod !== 'object') return null;
  const m = mod as Record<string, unknown>;
  // ESM default export: `import` produces an object whose `default`
  // property is the value we want.
  if (typeof m.default === 'function') {
    return m.default as IngestionSourceFactory;
  }
  // Some CJS-interop modules surface their default directly as the
  // exports object. Treat the module itself as the factory if callable.
  if (typeof mod === 'function') {
    return mod as IngestionSourceFactory;
  }
  return null;
}

function rejectIfNotAbsolute(p: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    return `[ingestion-load] remote URL rejected: ${p}`;
  }
  if (p.startsWith('~')) {
    return `[ingestion-load] ~-prefixed path rejected (expand explicitly): ${p}`;
  }
  if (!path.isAbsolute(p)) {
    return `[ingestion-load] relative path rejected: ${p}`;
  }
  return null;
}

/** Testing surface. */
export const __testing = {
  COMPATIBLE_API_VERSIONS,
  SUPPORTED_PLUGIN_VERSION,
  validateDeclaration,
  extractFactory,
  rejectIfNotAbsolute,
};
