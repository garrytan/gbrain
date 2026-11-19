/**
 * core/brand.ts: the product is Foresights; the stored names stay.
 *
 * - The command is `foresights`; `gbrain` stays a second bin (package.json) and
 *   isBrandCommand recognises both, bare or as a binary path.
 * - Environment variables keep their stored `GBRAIN_` names; `FORESIGHTS_*`
 *   is an alias (readBrandEnv, adoptAliasEnv) and never overrides a set GBRAIN_*.
 * - The home folder stays `~/.gbrain`.
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { BRAND, LEGACY, adoptAliasEnv, brandEnvName, isBrandCommand, readBrandEnv } from '../src/core/brand.ts';
import { configDir } from '../src/core/config.ts';
import { MCP_SERVER_NAME, MCP_SERVER_DESCRIPTION } from '../src/mcp/instructions.ts';

describe('BRAND', () => {
  test('names the product Foresights and keeps the stored names', () => {
    expect(Object.isFrozen(BRAND)).toBe(true);
    expect([BRAND.name, BRAND.displayName]).toEqual(['foresights', 'Foresights']);
    expect([BRAND.envPrefix, BRAND.envAliasPrefix, BRAND.homeDirName]).toEqual(['GBRAIN_', 'FORESIGHTS_', '.gbrain']);
    expect(LEGACY.name).toBe('gbrain');
  });

  test('the MCP server name and description come from it', () => {
    expect(MCP_SERVER_NAME).toBe('foresights');
    expect(MCP_SERVER_DESCRIPTION).toContain('search foresights before');
  });

  test('both commands are bins of the package', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin.foresights).toBe('src/cli.ts');
    expect(pkg.bin.gbrain).toBe('src/cli.ts');
  });
});

describe('isBrandCommand', () => {
  test('matches either name, bare or as a binary path', () => {
    for (const w of ['foresights', 'gbrain', '/usr/local/bin/gbrain', '/home/u/.bun/bin/foresights', 'C:\\bin\\foresights.exe', 'gbrain.exe']) {
      expect(isBrandCommand(w)).toBe(true);
    }
    for (const w of ['', undefined, null, 'gbrain-coding', 'node', '/usr/bin/foresights2', 'xgbrain']) expect(isBrandCommand(w)).toBe(false);
  });
});

describe('environment aliases', () => {
  test('readBrandEnv reads GBRAIN_<key>, then FORESIGHTS_<key>', () => {
    expect(readBrandEnv({ GBRAIN_HOME: '/a', FORESIGHTS_HOME: '/b' }, 'HOME')).toBe('/a');
    expect(readBrandEnv({ FORESIGHTS_HOME: '/b' }, 'HOME')).toBe('/b');
    expect(readBrandEnv({}, 'HOME')).toBeUndefined();
    expect(readBrandEnv({ GBRAIN_HOME: '', FORESIGHTS_HOME: '/b' }, 'HOME')).toBe(''); // set-but-empty is a choice
    expect(brandEnvName('HOME')).toBe('GBRAIN_HOME');
  });

  test('adoptAliasEnv copies FORESIGHTS_X into an unset GBRAIN_X and never overrides', () => {
    const env: Record<string, string | undefined> = { FORESIGHTS_HOME: '/new', FORESIGHTS_SOURCE: 'notes', GBRAIN_SOURCE: 'wiki', OTHER: 'x' };
    expect(adoptAliasEnv(env).sort()).toEqual(['GBRAIN_HOME']);
    expect(env).toEqual({ FORESIGHTS_HOME: '/new', FORESIGHTS_SOURCE: 'notes', GBRAIN_SOURCE: 'wiki', OTHER: 'x', GBRAIN_HOME: '/new' });
    expect(adoptAliasEnv(env)).toEqual([]);
  });
});

describe('configDir keeps the stored home folder', () => {
  test('the home variable is a parent; .gbrain is appended', async () => {
    await withEnv({ GBRAIN_HOME: '/tmp/brand-test-parent' }, () => {
      expect(configDir()).toBe(join('/tmp/brand-test-parent', '.gbrain'));
    });
  });

  test('FORESIGHTS_HOME works when GBRAIN_HOME is unset', async () => {
    await withEnv({ GBRAIN_HOME: undefined, FORESIGHTS_HOME: '/tmp/brand-alias-parent' }, () => {
      expect(configDir()).toBe(join('/tmp/brand-alias-parent', '.gbrain'));
    });
  });

  test('refusals name the stored variable', async () => {
    await withEnv({ GBRAIN_HOME: 'relative/path' }, () => {
      expect(() => configDir()).toThrow('GBRAIN_HOME must be an absolute path');
    });
  });
});
