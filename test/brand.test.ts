/**
 * core/brand.ts: the product's names in one place, and the environment-variable
 * fallback that keeps an existing install's GBRAIN_* settings working after a rename.
 */
import { test, expect, describe } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { join } from 'path';
import { BRAND, LEGACY_ENV_PREFIX, brandEnvName, readBrandEnv } from '../src/core/brand.ts';
import { configDir } from '../src/core/config.ts';
import { MCP_SERVER_NAME, MCP_SERVER_DESCRIPTION } from '../src/mcp/instructions.ts';

describe('BRAND', () => {
  test('is frozen, so no module can rename the product at runtime', () => {
    expect(Object.isFrozen(BRAND)).toBe(true);
  });

  test('the MCP server name and description come from it', () => {
    expect(MCP_SERVER_NAME).toBe(BRAND.name);
    expect(MCP_SERVER_DESCRIPTION).toContain(`search ${BRAND.name} before`);
  });
});

describe('readBrandEnv', () => {
  test('the brand prefix wins; the legacy GBRAIN_ name is the fallback after a rename', () => {
    expect(readBrandEnv({ NEWNAME_HOME: '/a', GBRAIN_HOME: '/b' }, 'HOME', 'NEWNAME_')).toBe('/a');
    expect(readBrandEnv({ GBRAIN_HOME: '/b' }, 'HOME', 'NEWNAME_')).toBe('/b');
    expect(readBrandEnv({}, 'HOME', 'NEWNAME_')).toBeUndefined();
  });

  test('an empty brand value is a value, not a reason to fall back', () => {
    expect(readBrandEnv({ NEWNAME_HOME: '', GBRAIN_HOME: '/b' }, 'HOME', 'NEWNAME_')).toBe('');
  });

  test('with the legacy prefix it reads only that name', () => {
    expect(LEGACY_ENV_PREFIX).toBe('GBRAIN_');
    expect(readBrandEnv({ GBRAIN_HOME: '/b' }, 'HOME', 'GBRAIN_')).toBe('/b');
    expect(brandEnvName('HOME', 'NEWNAME_')).toBe('NEWNAME_HOME');
  });
});

describe('configDir uses the brand', () => {
  test('the home variable is a parent; the brand folder is appended', async () => {
    await withEnv({ GBRAIN_HOME: '/tmp/brand-test-parent' }, () => {
      expect(configDir()).toBe(join('/tmp/brand-test-parent', BRAND.homeDirName));
    });
  });

  test('refusals name the brand variable', async () => {
    await withEnv({ GBRAIN_HOME: 'relative/path' }, () => {
      expect(() => configDir()).toThrow(`${brandEnvName('HOME')} must be an absolute path`);
    });
  });
});
