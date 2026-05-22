/**
 * Skillpack-distributed IngestionSource discovery tests.
 *
 * Uses tmp dirs + the _import stub seam so we exercise the manifest
 * parsing + path validation + module-load contract without actually
 * loading arbitrary code from the filesystem. CLAUDE.md rule R1
 * forbids process.env mutation; we use withEnv from helpers/with-env.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withEnv } from '../helpers/with-env.ts';
import {
  loadSkillpackSources,
  __testing,
} from '../../src/core/ingestion/skillpack-load.ts';
import type { IngestionSource } from '../../src/core/ingestion/types.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-skillpack-load-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makePluginDir(opts: {
  name?: string;
  pluginVersion?: string;
  sources?: Array<{
    kind: string;
    module?: string;
    api_version?: string;
    default_config?: Record<string, unknown>;
    permissions?: string[];
  }>;
  moduleBody?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'plugin-'));
  const manifest: Record<string, unknown> = {
    name: opts.name ?? 'test-plugin',
    version: '1.0.0',
    plugin_version: opts.pluginVersion ?? 'gbrain-plugin-v1',
  };
  if (opts.sources && opts.sources.length > 0) {
    manifest.ingestion_sources = opts.sources.map((s) => ({
      kind: s.kind,
      module: s.module ?? './source.js',
      api_version: s.api_version ?? 'gbrain-ingestion-source-v1',
      default_config: s.default_config,
      permissions: s.permissions,
    }));
  }
  fs.writeFileSync(path.join(dir, 'gbrain.plugin.json'), JSON.stringify(manifest));
  if (opts.sources && opts.sources.length > 0) {
    fs.writeFileSync(path.join(dir, 'source.js'), opts.moduleBody ?? '// noop');
  }
  return dir;
}

function makeFactoryFn(): (config: Record<string, unknown>) => IngestionSource {
  return (_config) => ({
    id: 'stub-source-1',
    kind: 'stub',
    async start() {},
    async stop() {},
  });
}

describe('loadSkillpackSources — discovery', () => {
  test('empty GBRAIN_PLUGIN_PATH returns empty result', async () => {
    const result = await loadSkillpackSources({ envPath: '' });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('relative path is rejected with warning', async () => {
    const result = await loadSkillpackSources({ envPath: './relative/path' });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('relative path rejected'))).toBe(true);
  });

  test('home-prefixed path is rejected with warning', async () => {
    const result = await loadSkillpackSources({ envPath: '~/some/path' });
    expect(result.warnings.some((w) => w.includes('~-prefixed'))).toBe(true);
  });

  test('rejectIfNotAbsolute helper rejects remote URLs (defense-in-depth)', () => {
    // GBRAIN_PLUGIN_PATH is colon-separated paths ($PATH style), so URL
    // values get split into bogus segments before this branch fires. The
    // branch exists as defense-in-depth for any future code path that
    // hands a raw URL string to the validator (e.g. a future --plugin-dir
    // CLI flag that bypasses the split).
    expect(__testing.rejectIfNotAbsolute('https://evil.example.com/plugin')).toContain('remote URL');
    expect(__testing.rejectIfNotAbsolute('file:///etc/passwd')).toContain('remote URL');
  });

  test('missing directory yields a warning, not a throw', async () => {
    const result = await loadSkillpackSources({
      envPath: path.join(tmpRoot, 'does-not-exist'),
    });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('does not exist'))).toBe(true);
  });

  test('directory with no gbrain.plugin.json is silently skipped (not a warning)', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-manifest-'));
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('directory with manifest but no ingestion_sources is silently skipped', async () => {
    const dir = makePluginDir({});
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('loadSkillpackSources — manifest validation', () => {
  test('rejects invalid manifest JSON', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'bad-json-'));
    fs.writeFileSync(path.join(dir, 'gbrain.plugin.json'), '{ not valid');
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.warnings.some((w) => w.includes('invalid manifest JSON'))).toBe(true);
  });

  test('rejects unsupported plugin_version', async () => {
    const dir = makePluginDir({ pluginVersion: 'gbrain-plugin-v99' });
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.warnings.some((w) => w.includes('unsupported plugin_version'))).toBe(true);
  });

  test('rejects missing name field', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-name-'));
    fs.writeFileSync(
      path.join(dir, 'gbrain.plugin.json'),
      JSON.stringify({
        plugin_version: 'gbrain-plugin-v1',
        ingestion_sources: [{ kind: 'x', module: './source.js', api_version: 'gbrain-ingestion-source-v1' }],
      }),
    );
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.warnings.some((w) => w.includes('missing required "name"'))).toBe(true);
  });
});

describe('loadSkillpackSources — source declaration validation', () => {
  test('rejects missing kind field', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'no-kind-'));
    fs.writeFileSync(
      path.join(dir, 'gbrain.plugin.json'),
      JSON.stringify({
        name: 'p',
        plugin_version: 'gbrain-plugin-v1',
        ingestion_sources: [{ module: './source.js', api_version: 'gbrain-ingestion-source-v1' }],
      }),
    );
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.warnings.some((w) => w.includes('kind must be'))).toBe(true);
  });

  test('rejects array-shaped default_config', async () => {
    const err = __testing.validateDeclaration({
      kind: 'x',
      module: './source.js',
      api_version: 'gbrain-ingestion-source-v1',
      default_config: [1, 2, 3],
    });
    expect(err).toContain('default_config must be a plain object');
  });

  test('rejects non-string-array permissions', async () => {
    const err = __testing.validateDeclaration({
      kind: 'x',
      module: './source.js',
      api_version: 'gbrain-ingestion-source-v1',
      permissions: [1, 2, 3],
    });
    expect(err).toContain('permissions must be an array of strings');
  });
});

describe('loadSkillpackSources — api_version compatibility', () => {
  test('current api_version loads successfully', async () => {
    const dir = makePluginDir({ sources: [{ kind: 'stub' }] });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => ({ default: makeFactoryFn() }),
    });
    expect(result.sources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test('api_version mismatch fails loudly with upgrade hint', async () => {
    const dir = makePluginDir({
      sources: [{ kind: 'stub', api_version: 'gbrain-ingestion-source-v99' }],
    });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => ({ default: makeFactoryFn() }),
    });
    expect(result.sources).toHaveLength(0);
    const warning = result.warnings.find((w) => w.includes('api_version'));
    expect(warning).toBeDefined();
    expect(warning).toContain('rebuild against the new');
    expect(warning).toContain('docs/ingestion-source-skillpack.md');
  });
});

describe('loadSkillpackSources — module loading', () => {
  test('valid module with default export factory is loaded', async () => {
    const dir = makePluginDir({ sources: [{ kind: 'stub' }] });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => ({ default: makeFactoryFn() }),
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.declaration.kind).toBe('stub');
    expect(result.sources[0]?.plugin_name).toBe('test-plugin');
    // Verify the factory is callable.
    const source = result.sources[0]?.factory({});
    expect(source?.kind).toBe('stub');
  });

  test('module load failure produces a warning', async () => {
    const dir = makePluginDir({ sources: [{ kind: 'stub' }] });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => { throw new Error('syntax error in source.js'); },
    });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('failed to import'))).toBe(true);
  });

  test('module without default export factory produces a warning', async () => {
    const dir = makePluginDir({ sources: [{ kind: 'stub' }] });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => ({ someOtherExport: 42 }),
    });
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('does not export a factory function'))).toBe(true);
  });

  test('missing module file is rejected', async () => {
    const dir = makePluginDir({
      sources: [{ kind: 'stub', module: './does-not-exist.js' }],
    });
    // Remove the auto-created source.js so we hit the missing-file branch.
    fs.rmSync(path.join(dir, 'source.js'));
    const result = await loadSkillpackSources({ envPath: dir });
    expect(result.warnings.some((w) => w.includes('module not found'))).toBe(true);
  });

  test('module path escaping the plugin root is rejected', async () => {
    const dir = makePluginDir({
      sources: [{ kind: 'stub', module: '../escape.js' }],
    });
    const result = await loadSkillpackSources({
      envPath: dir,
      _import: async () => ({ default: makeFactoryFn() }),
    });
    expect(result.warnings.some((w) => w.includes('escapes plugin root'))).toBe(true);
  });
});

describe('loadSkillpackSources — collision policy', () => {
  test('two plugins declaring the same kind: first wins with warning', async () => {
    const dirA = makePluginDir({ name: 'plugin-a', sources: [{ kind: 'shared' }] });
    const dirB = makePluginDir({ name: 'plugin-b', sources: [{ kind: 'shared' }] });
    const result = await loadSkillpackSources({
      envPath: `${dirA}:${dirB}`,
      _import: async () => ({ default: makeFactoryFn() }),
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.plugin_name).toBe('plugin-a'); // first
    expect(result.warnings.some((w) => w.includes('kind collision') && w.includes('shared'))).toBe(true);
  });
});

describe('loadSkillpackSources — env var path', () => {
  test('reads GBRAIN_PLUGIN_PATH from process.env when envPath is not passed', async () => {
    const dir = makePluginDir({ sources: [{ kind: 'env-stub' }] });
    await withEnv({ GBRAIN_PLUGIN_PATH: dir }, async () => {
      const result = await loadSkillpackSources({
        _import: async () => ({ default: makeFactoryFn() }),
      });
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]?.declaration.kind).toBe('env-stub');
    });
  });
});

describe('__testing helpers', () => {
  test('rejectIfNotAbsolute accepts absolute paths', () => {
    expect(__testing.rejectIfNotAbsolute('/abs/path')).toBeNull();
  });

  test('extractFactory pulls from .default of an ESM-shaped module object', () => {
    const f = makeFactoryFn();
    expect(__testing.extractFactory({ default: f })).toBe(f);
  });

  test('extractFactory returns null when no default export', () => {
    expect(__testing.extractFactory({ named: 'value' })).toBeNull();
  });

  test('extractFactory returns null for non-object', () => {
    expect(__testing.extractFactory(null)).toBeNull();
    expect(__testing.extractFactory('string')).toBeNull();
  });
});
