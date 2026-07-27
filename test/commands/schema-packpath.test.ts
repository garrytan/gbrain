import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _testHelpers } from '../../src/commands/schema.ts';
import { withEnv } from '../helpers/with-env.ts';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('schema packPathByName', () => {
  test('resolves all bundled schema pack names to bundled YAML files', () => {
    for (const name of ['gbrain-base', 'gbrain-recommended', 'gbrain-base-v2']) {
      const path = _testHelpers.packPathByName(name);
      expect(path).toBeTruthy();
      expect(path!.endsWith(`src/core/schema-pack/base/${name}.yaml`)).toBe(true);
      expect(existsSync(path!)).toBe(true);
    }
  });

  test('returns null for an unknown non-bundled pack name', async () => {
    const home = tempDir('gbrain-packpath-home-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      expect(_testHelpers.packPathByName('definitely-not-a-pack')).toBeNull();
    });
  });

  test('resolves a user-installed pack by name', async () => {
    const home = tempDir('gbrain-packpath-home-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const packDir = join(home, '.gbrain', 'schema-packs', 'custom-pack');
      mkdirSync(packDir, { recursive: true });
      const packPath = join(packDir, 'pack.yaml');
      writeFileSync(packPath, 'name: custom-pack\n', 'utf-8');

      expect(_testHelpers.packPathByName('custom-pack')).toBe(packPath);
    });
  });
});
