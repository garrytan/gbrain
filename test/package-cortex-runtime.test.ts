import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildRuntimePackage, readArgs } from '../scripts/package-cortex-runtime.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortex-runtime-package-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
  mkdirSync(join(root, 'docs', 'deploy'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(join(root, 'cortex.plugin.json'), JSON.stringify({
    name: 'cortex',
    skills: ['skills/legacy/SKILL.md'],
    sharedDeps: ['skills/legacy-shared.md'],
  }));
  writeFileSync(join(root, 'cortex.yml'), 'storage:\n  db_tracked: []\n');
  writeFileSync(join(root, 'INSTALL_FOR_AGENTS.md'), '# Install\n');
  mkdirSync(join(root, 'skills', 'setup'), { recursive: true });
  mkdirSync(join(root, 'skills', 'schema-author'), { recursive: true });
  writeFileSync(join(root, 'skills', '_AGENT_README.md'), '# Agent onboarding\n');
  writeFileSync(join(root, 'skills', 'setup', 'SKILL.md'), '# Setup Cortex\n');
  writeFileSync(join(root, 'skills', 'schema-author', 'SKILL.md'), '# Schema Author\n');
  writeFileSync(join(root, 'docs', 'guides', 'agent-to-cortex.md'), '# Agent Guide\n');
  writeFileSync(join(root, 'docs', 'deploy', 'saas-runtime-packaging.md'), '# Runtime Packaging\n');
  writeFileSync(join(root, 'bin', 'cortex'), '#!/usr/bin/env sh\necho cortex\n');
  writeFileSync(join(root, 'bin', 'gbrain.exe'), 'legacy binary\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('package-cortex-runtime', () => {
  test('parses packaging flags', () => {
    expect(readArgs(['--out-dir', 'dist/runtime', '--public-url', 'https://tenant.example.com', '--json'])).toEqual({
      outDir: 'dist/runtime',
      publicUrl: 'https://tenant.example.com',
      skipBinaries: false,
      clean: true,
      json: true,
      help: false,
    });
  });

  test('assembles a secret-free runtime bundle with manifest, plugin, skills, and checksums', async () => {
    const index = await buildRuntimePackage({
      rootDir: root,
      outDir: 'dist/runtime',
      publicUrl: 'https://tenant.example.com',
      generatedAt: '2026-05-28T00:00:00.000Z',
      skipBinaries: false,
      clean: true,
      json: false,
      help: false,
    });

    const out = join(root, 'dist', 'runtime');
    expect(index.schema).toBe('cortex.runtime-package.v1');
    expect(index.product.version).toBe('9.9.9');
    expect(existsSync(join(out, 'cortex.plugin.json'))).toBe(true);
    expect(existsSync(join(out, 'skills', 'manifest.json'))).toBe(true);
    expect(existsSync(join(out, 'skills', 'setup', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(out, 'skills', 'schema-author', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(out, 'skills', '_AGENT_README.md'))).toBe(true);
    expect(existsSync(join(out, 'bin', 'cortex'))).toBe(true);
    expect(existsSync(join(out, 'bin', 'gbrain.exe'))).toBe(false);
    expect(existsSync(join(out, 'runtime-package.json'))).toBe(true);
    expect(existsSync(join(out, 'checksums.sha256'))).toBe(true);

    const runtimeManifest = JSON.parse(readFileSync(join(out, 'runtime-manifest.json'), 'utf-8'));
    expect(runtimeManifest.schema).toBe('cortex.runtime-manifest.v1');
    expect(runtimeManifest.endpoints.mcp_url).toBe('https://tenant.example.com/mcp');
    expect(JSON.stringify(runtimeManifest)).not.toContain('client_secret');

    const checksums = readFileSync(join(out, 'checksums.sha256'), 'utf-8');
    expect(checksums).toContain('runtime-manifest.json');
    expect(index.files.some(file => file.path === 'runtime-manifest.json')).toBe(true);

    const plugin = JSON.parse(readFileSync(join(out, 'cortex.plugin.json'), 'utf-8'));
    expect(plugin.skills).toEqual(['skills/setup/SKILL.md', 'skills/schema-author/SKILL.md']);
    expect(plugin.sharedDeps).toEqual(['skills/_AGENT_README.md']);
  });

  test('requires binaries unless explicitly skipped', async () => {
    rmSync(join(root, 'bin'), { recursive: true, force: true });
    await expect(buildRuntimePackage({
      rootDir: root,
      outDir: 'dist/runtime',
      skipBinaries: false,
      clean: true,
      json: false,
      help: false,
    })).rejects.toThrow('Missing Cortex binaries');

    const index = await buildRuntimePackage({
      rootDir: root,
      outDir: 'dist/runtime',
      skipBinaries: true,
      clean: true,
      json: false,
      help: false,
    });
    expect(index.schema).toBe('cortex.runtime-package.v1');
    expect(existsSync(join(root, 'dist', 'runtime', 'bin'))).toBe(false);
  });

  test('fails when an included runtime skill carries legacy copy', async () => {
    writeFileSync(join(root, 'skills', 'setup', 'SKILL.md'), 'Run gbrain setup\n');

    await expect(buildRuntimePackage({
      rootDir: root,
      outDir: 'dist/runtime',
      skipBinaries: true,
      clean: true,
      json: false,
      help: false,
    })).rejects.toThrow('Runtime package contains legacy copy');
  });
});
