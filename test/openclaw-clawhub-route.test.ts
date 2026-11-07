import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BundleError, loadBundleManifest } from '../src/core/skillpack/bundle.ts';

describe('OpenClaw ClawHub install guidance', () => {
  it('marks the bundle route unavailable and points users to the supported MCP route', () => {
    const root = join(import.meta.dir, '..');
    const guide = readFileSync(join(root, 'docs', 'mcp', 'OPENCLAW.md'), 'utf8');
    const optionOneStart = guide.indexOf('## Option 1: ClawHub bundle plugin');
    const optionTwoStart = guide.indexOf('## Option 2: `openclaw mcp add`');
    const optionOne = guide.slice(optionOneStart, optionTwoStart);

    expect(optionOne).toContain('unavailable');
    expect(optionOne).toContain('Option 2');
    expect(guide).toContain('openclaw mcp add gbrain');
  });

  it('rejects an OpenClaw bundle manifest that omits its required id', () => {
    const root = join(import.meta.dir, '..');
    const fixtureRoot = mkdtempSync(join(root, 'test', '.openclaw-manifest-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'openclaw.plugin.json'),
        JSON.stringify({
          name: 'fixture',
          version: '0.0.0',
          mcpServers: { gbrain: {} },
          skills: [],
          shared_deps: [],
        }),
      );
      expect(() => loadBundleManifest(fixtureRoot)).toThrow(BundleError);
      expect(() => loadBundleManifest(fixtureRoot)).toThrow(/non-empty "id"/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
