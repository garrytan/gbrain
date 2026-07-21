import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('root OpenClaw plugin manifest', () => {
  it('declares the id required by OpenClaw plugin installs', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openclaw.plugin.json'), 'utf8'));
    const entrySource = readFileSync(join(import.meta.dir, '..', 'src', 'openclaw-context-engine.ts'), 'utf8');
    const entryId = entrySource.match(/id:\s*'([^']+)'/)?.[1];

    expect(manifest.id).toBe(entryId);
    expect(manifest.configSchema).toBeDefined();
    expect(typeof manifest.configSchema).toBe('object');
    expect(manifest.contracts?.contextEngines).toContain('gbrain-context');
    expect(entrySource).toContain('export function register');
  });
});
