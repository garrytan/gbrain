import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { ADMIN_ASSETS } from '../src/admin-embedded.ts';

describe('#7126 embedded admin manifest', () => {
  test('every asset admin/dist/index.html loads is embedded', () => {
    const html = readFileSync('admin/dist/index.html', 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="(\/admin\/[^"]+)"/g)].map(m => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter(p => !(p in ADMIN_ASSETS))).toEqual([]);
  });
});
