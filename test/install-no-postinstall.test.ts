import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');

describe('GST-2732: installing gbrain runs no lifecycle script', () => {
  test('package.json declares no preinstall, install or postinstall script', () => {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
    expect(Object.keys(scripts).filter(name => ['preinstall', 'install', 'postinstall'].includes(name))).toEqual([]);
  });

  test('scripts/postinstall.ts is gone, so nothing can wire it back in', () => {
    expect(existsSync(join(root, 'scripts/postinstall.ts'))).toBe(false);
  });
});
