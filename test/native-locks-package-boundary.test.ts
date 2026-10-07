/**
 * #6026: plugin hosts that derive a native-addon namespace from the nearest
 * package.json above a `.node` file treated the whole checkout as one
 * namespace (OpenClaw 2026.9.7+ took ~228 s to load the plugin from a
 * checkout root, ~26 s with this boundary). `native/locks/package.json` is
 * that boundary. It must stay private and inert, outside the prebuild input
 * digest, and out of `prebuilds/` (verify requires exactly the eight addons).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildInputs } from '../scripts/native/build.ts';

const ROOT = join(import.meta.dir, '..');
const BOUNDARY = join(ROOT, 'native/locks/package.json');

describe('native/locks package boundary (#6026)', () => {
  test('exists, is private, and declares nothing that changes resolution or publishing', () => {
    expect(existsSync(BOUNDARY)).toBe(true);
    const pkg = JSON.parse(readFileSync(BOUNDARY, 'utf8')) as Record<string, unknown>;
    expect(pkg.private).toBe(true);
    for (const key of ['main', 'exports', 'type', 'module', 'imports', 'bin', 'scripts', 'dependencies', 'optionalDependencies', 'version', 'workspaces', 'files']) {
      expect(key in pkg).toBe(false);
    }
  });

  test('stays out of the prebuild input digest and out of prebuilds/', () => {
    expect(buildInputs.some((f) => f.endsWith('package.json'))).toBe(false);
    const prebuilds = readdirSync(join(ROOT, 'native/locks/prebuilds')).sort();
    expect(prebuilds.every((f) => f.endsWith('.node'))).toBe(true);
    expect(prebuilds).toHaveLength(8);
  });
});
