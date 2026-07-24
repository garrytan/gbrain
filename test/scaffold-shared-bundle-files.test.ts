/**
 * #2759: skillpack scaffold exports only the files listed in
 * openclaw.plugin.json#shared_deps. skills/manifest.json declares a resolver
 * (RESOLVER.md), and several skills reference sibling bundle files
 * (manifest.json, migrations/, _friction-protocol.md), but none of those were
 * in shared_deps, so a scaffolded consumer received a bundle whose own manifest
 * and skills pointed at files that were never installed.
 *
 * These assertions read the REAL bundle config (not a fixture) so the shared_deps
 * list cannot silently drop a manifest-declared or skill-referenced file again.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const plugin = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(join(root, 'skills', 'manifest.json'), 'utf-8'));
const shared = new Set<string>(plugin.shared_deps as string[]);

describe('bundle exports manifest-declared and skill-referenced shared files (#2759)', () => {
  test('the resolver declared in skills/manifest.json is exported via shared_deps', () => {
    expect(manifest.resolver).toBeTruthy();
    expect(shared.has(`skills/${manifest.resolver}`)).toBe(true);
  });

  test('shared_deps exports the manifest registry, migrations, and friction protocol', () => {
    for (const f of ['skills/manifest.json', 'skills/migrations', 'skills/_friction-protocol.md']) {
      expect(shared.has(f)).toBe(true);
    }
  });
});
