import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;

test('OpenClaw manifest stays aligned with package metadata and uses the portable source runner', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'openclaw.plugin.json'), 'utf-8'));
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

  expect(manifest.version).toBe(pkg.version);
  expect(manifest.description).toBe(pkg.description);
  expect(manifest.mcpServers.mbrain.command).toBe('bun');
  expect(manifest.mcpServers.mbrain.args).toEqual(['run', 'src/cli.ts', 'serve']);
  expect(pkg.scripts['prepublish:clawhub'].split('&&').map((part: string) => part.trim()))
    .toEqual(['bun run build:all']);
});

test('OpenClaw manifest keeps managed Postgres optional for local-first installs', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'openclaw.plugin.json'), 'utf-8'));

  expect(manifest.configSchema.database_url.required).toBe(false);
  expect(manifest.configSchema.database_url.description.toLowerCase()).toContain('optional');
});
