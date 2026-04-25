/**
 * plugin-loader tests. Exercise the full path/manifest/validation surface
 * using ephemeral tmp dirs so no repo content is touched.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadPluginsFromEnv,
  loadSinglePlugin,
  SUPPORTED_PLUGIN_VERSION,
  __testing,
} from '../src/core/minions/plugin-loader.ts';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-loader-test-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpRoot)) {
    fs.rmSync(path.join(tmpRoot, f), { recursive: true, force: true });
  }
});

// Helper: build a plugin directory with a manifest + a subagents/ tree.
function writePlugin(
  name: string,
  opts: {
    plugin_version?: string;
    subagents?: Record<string, string>;
    subagents_field?: string;
    omit_manifest?: boolean;
    bad_manifest_json?: boolean;
  } = {},
): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });

  if (!opts.omit_manifest) {
    const manifest = {
      name,
      version: '1.0.0',
      plugin_version: opts.plugin_version ?? SUPPORTED_PLUGIN_VERSION,
      ...(opts.subagents_field ? { subagents: opts.subagents_field } : {}),
    };
    fs.writeFileSync(
      path.join(dir, 'gbrain.plugin.json'),
      opts.bad_manifest_json ? '{not valid json' : JSON.stringify(manifest, null, 2),
    );
  }

  if (opts.subagents) {
    const sadir = path.join(dir, opts.subagents_field ?? 'subagents');
    fs.mkdirSync(sadir, { recursive: true });
    for (const [file, content] of Object.entries(opts.subagents)) {
      fs.writeFileSync(path.join(sadir, file), content);
    }
  }

  return dir;
}

describe('path policy', () => {
  test('relative paths rejected', () => {
    expect(__testing.rejectIfNotAbsolute('relative/path')).toMatch(/relative path rejected/);
  });

  test('~-prefixed paths rejected (no implicit expansion)', () => {
    expect(__testing.rejectIfNotAbsolute('~/subagents')).toMatch(/~-prefixed/);
  });

  test('remote URLs rejected', () => {
    expect(__testing.rejectIfNotAbsolute('https://example.com/plugins')).toMatch(/remote URL/);
    expect(__testing.rejectIfNotAbsolute('file:///abs/p')).toMatch(/remote URL/);
  });

  test('absolute POSIX path accepted', () => {
    expect(__testing.rejectIfNotAbsolute('/abs/path')).toBeNull();
  });
});

describe('loadSinglePlugin', () => {
  test('loads a minimal manifest + one subagent def', () => {
    const dir = writePlugin('openclaw-ref', {
      subagents: {
        'meeting-ingestion.md': `---\nname: meeting-ingestion\nmodel: sonnet\n---\n\nYou are a meeting ingester.\n`,
      },
    });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.manifest.name).toBe('openclaw-ref');
    expect(res.subagents.length).toBe(1);
    expect(res.subagents[0]!.name).toBe('meeting-ingestion');
    expect(res.subagents[0]!.body.trim()).toBe('You are a meeting ingester.');
  });

  test('missing manifest returns error', () => {
    const dir = writePlugin('empty', { omit_manifest: true });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/missing gbrain\.plugin\.json/);
  });

  test('invalid manifest JSON returns error', () => {
    const dir = writePlugin('bad-json', { bad_manifest_json: true });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/invalid manifest JSON/);
  });

  test('unsupported plugin_version rejected', () => {
    const dir = writePlugin('future', { plugin_version: 'gbrain-plugin-v999' });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/unsupported plugin_version/);
  });

  test('escape-attempt subagents field rejected', () => {
    const dir = writePlugin('escape', { subagents_field: '../../../etc' });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/escapes plugin root/);
  });

  test('falls back to file basename when frontmatter.name is missing', () => {
    const dir = writePlugin('nameless', {
      subagents: {
        'implicit-name.md': `---\nmodel: sonnet\n---\nbody\n`,
      },
    });
    const res = loadSinglePlugin(dir);
    if ('error' in res) throw new Error(res.error);
    expect(res.subagents[0]!.name).toBe('implicit-name');
  });

  test('allowed_tools frontmatter list of strings survives round-trip', () => {
    const dir = writePlugin('tools', {
      subagents: {
        'researcher.md': `---\nname: researcher\nallowed_tools:\n  - brain_search\n  - brain_get_page\n---\nbody\n`,
      },
    });
    const res = loadSinglePlugin(dir);
    if ('error' in res) throw new Error(res.error);
    expect(res.subagents[0]!.allowed_tools).toEqual(['brain_search', 'brain_get_page']);
  });

  test('allowed_tools referencing unknown tool names fails load', () => {
    const dir = writePlugin('rogue', {
      subagents: {
        'typo.md': `---\nname: typo\nallowed_tools:\n  - brain_seerch\n---\nbody\n`,
      },
    });
    const res = loadSinglePlugin(dir, {
      validAgentToolNames: new Set(['brain_search', 'brain_get_page']),
    });
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/unknown tools: brain_seerch/);
  });

  test('validation passes when allowed_tools are all in the registry', () => {
    const dir = writePlugin('clean', {
      subagents: {
        'ok.md': `---\nname: ok\nallowed_tools:\n  - brain_search\n---\nbody\n`,
      },
    });
    const res = loadSinglePlugin(dir, {
      validAgentToolNames: new Set(['brain_search']),
    });
    expect('error' in res).toBe(false);
  });

  test('skipping validation (no validAgentToolNames) allows any allowed_tools', () => {
    const dir = writePlugin('no-validate', {
      subagents: {
        'anything.md': `---\nname: anything\nallowed_tools:\n  - tool_we_have_not_shipped_yet\n---\nbody\n`,
      },
    });
    const res = loadSinglePlugin(dir);
    expect('error' in res).toBe(false);
  });
});

describe('loadPluginsFromEnv', () => {
  test('empty env returns no plugins, no warnings', () => {
    const r = loadPluginsFromEnv({ envPath: '' });
    expect(r.plugins).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('multi-path: colon-separated PATH loads both', () => {
    const a = writePlugin('a', { subagents: { 'x.md': `---\nname: x\n---\nbody` } });
    const b = writePlugin('b', { subagents: { 'y.md': `---\nname: y\n---\nbody` } });
    const r = loadPluginsFromEnv({ envPath: `${a}:${b}` });
    expect(r.plugins.length).toBe(2);
    expect(r.plugins[0]!.manifest.name).toBe('a');
    expect(r.plugins[1]!.manifest.name).toBe('b');
  });

  test('collision: left-wins with a warning', () => {
    const left = writePlugin('left', { subagents: { 'shared.md': `---\nname: shared\n---\nleft body` } });
    const right = writePlugin('right', { subagents: { 'shared.md': `---\nname: shared\n---\nright body` } });
    const r = loadPluginsFromEnv({ envPath: `${left}:${right}` });
    expect(r.plugins.length).toBe(2);
    // Only the left plugin contributes the `shared` subagent.
    const leftSubs = r.plugins[0]!.subagents.map(s => s.name);
    const rightSubs = r.plugins[1]!.subagents.map(s => s.name);
    expect(leftSubs).toContain('shared');
    expect(rightSubs).not.toContain('shared');
    expect(r.warnings.some(w => /collision.*shared/.test(w))).toBe(true);
  });

  test('non-existent path is warned + skipped', () => {
    const r = loadPluginsFromEnv({ envPath: '/definitely/does/not/exist/here' });
    expect(r.plugins.length).toBe(0);
    expect(r.warnings.some(w => /does not exist/.test(w))).toBe(true);
  });

  test('relative path in env is warned + skipped', () => {
    const r = loadPluginsFromEnv({ envPath: 'relative/dir' });
    expect(r.plugins.length).toBe(0);
    expect(r.warnings.some(w => /relative path rejected/.test(w))).toBe(true);
  });

  test('a file (not a directory) is warned + skipped', () => {
    const file = path.join(tmpRoot, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x');
    const r = loadPluginsFromEnv({ envPath: file });
    expect(r.plugins.length).toBe(0);
    expect(r.warnings.some(w => /not a directory/.test(w))).toBe(true);
  });

  test('trims whitespace around paths', () => {
    const a = writePlugin('trimmed', { subagents: { 'x.md': `---\nname: x\n---\nbody` } });
    const r = loadPluginsFromEnv({ envPath: `  ${a}  ` });
    expect(r.plugins.length).toBe(1);
  });

  test('manifest rejection shows up as a warning (not a throw)', () => {
    const bad = writePlugin('futurep', { plugin_version: 'gbrain-plugin-v999' });
    const r = loadPluginsFromEnv({ envPath: bad });
    expect(r.plugins.length).toBe(0);
    expect(r.warnings.some(w => /unsupported plugin_version/.test(w))).toBe(true);
  });
});
