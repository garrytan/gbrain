/**
 * Tests for src/core/skillpack/bootstrap-display.ts — display-only
 * runbook handler (codex T1).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildBootstrapDisplay } from '../src/core/skillpack/bootstrap-display.ts';
import { SKILLPACK_API_VERSION, type SkillpackManifest } from '../src/core/skillpack/manifest-v1.ts';

function makeManifest(over: Partial<SkillpackManifest> = {}): SkillpackManifest {
  return {
    api_version: SKILLPACK_API_VERSION,
    name: 'p',
    version: '0.1.0',
    description: 'd',
    author: 'a',
    license: 'MIT',
    homepage: 'https://example.com',
    gbrain_min_version: '0.36.0',
    skills: ['skills/foo'],
    ...over,
  };
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bootstrap-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildBootstrapDisplay', () => {
  test('returns shown=false when manifest has no runbooks.bootstrap declared', () => {
    const r = buildBootstrapDisplay({
      packRoot: tmp,
      manifest: makeManifest(),
      workspace: '/ws',
    });
    expect(r.shown).toBe(false);
    expect(r.text).toBe('');
    expect(r.bootstrapPath).toBeNull();
  });

  test('returns shown=false when bootstrap.md is declared but missing on disk', () => {
    const r = buildBootstrapDisplay({
      packRoot: tmp,
      manifest: makeManifest({
        runbooks: { bootstrap: 'runbooks/bootstrap.md' },
      }),
      workspace: '/ws',
    });
    expect(r.shown).toBe(false);
    expect(r.bootstrapPath).toContain('runbooks/bootstrap.md');
  });

  test('returns shown=false when bootstrap.md is empty (whitespace only)', () => {
    const packRoot = join(tmp, 'empty-bootstrap');
    mkdirSync(join(packRoot, 'runbooks'), { recursive: true });
    writeFileSync(join(packRoot, 'runbooks/bootstrap.md'), '   \n   \n');
    const r = buildBootstrapDisplay({
      packRoot,
      manifest: makeManifest({ runbooks: { bootstrap: 'runbooks/bootstrap.md' } }),
      workspace: '/ws',
    });
    expect(r.shown).toBe(false);
  });

  test('returns shown=true with framed text when bootstrap.md has content', () => {
    const packRoot = join(tmp, 'with-bootstrap');
    mkdirSync(join(packRoot, 'runbooks'), { recursive: true });
    writeFileSync(
      join(packRoot, 'runbooks/bootstrap.md'),
      '1. agent: gbrain put_page wiki/example\n2. show user: "All set."\n',
    );
    const r = buildBootstrapDisplay({
      packRoot,
      manifest: makeManifest({ runbooks: { bootstrap: 'runbooks/bootstrap.md' } }),
      workspace: '/ws',
    });
    expect(r.shown).toBe(true);
    expect(r.text).toContain('BOOTSTRAP STEPS');
    expect(r.text).toContain('agent decides what to run');
    expect(r.text).toContain('deliberately does NOT auto-execute');
    expect(r.text).toContain('1. agent: gbrain put_page wiki/example');
    expect(r.text).toContain('2. show user: "All set."');
    expect(r.text).toContain('End of bootstrap steps');
  });

  test('frames the content with horizontal rules above and below', () => {
    const packRoot = join(tmp, 'rules-bootstrap');
    mkdirSync(join(packRoot, 'runbooks'), { recursive: true });
    writeFileSync(join(packRoot, 'runbooks/bootstrap.md'), 'do the thing');
    const r = buildBootstrapDisplay({
      packRoot,
      manifest: makeManifest({ runbooks: { bootstrap: 'runbooks/bootstrap.md' } }),
      workspace: '/ws',
    });
    expect(r.shown).toBe(true);
    expect(r.text).toMatch(/═{20,}/);
  });
});
