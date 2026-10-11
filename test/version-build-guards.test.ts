import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareGeneratedTrees,
  normalizeAdminText,
  normalizeLineEndings,
  textsEquivalentIgnoringLineEndings,
} from '../scripts/normalize-admin-dist.ts';
import { glossaryIsFresh } from '../scripts/check-eval-glossary-fresh.ts';
import { validateVersionContract } from '../scripts/check-version-sync.ts';

describe('release build guards', () => {
  test('normalizes Windows and legacy line endings without changing LF text', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeLineEndings('already\nnormalized\n')).toBe('already\nnormalized\n');
  });

  test('normalizes the cross-platform Vite root/body whitespace without touching scripts', () => {
    const html = '<body>\r\n  <div id="root"></div>\r\n\r\n</body>\r\n';
    expect(normalizeAdminText(html, '.html')).toBe(
      '<body>\n  <div id="root"></div>\n</body>\n',
    );
    expect(normalizeAdminText('const gap = "\\n\\n";\r\n', '.js')).toBe(
      'const gap = "\\n\\n";\n',
    );
  });

  test('accepts a synchronized release version contract', () => {
    expect(validateVersionContract({
      versionFile: '\uFEFF1.2.13\r\n',
      corePackage: '1.2.13',
      desktopPackage: '1.2.13',
      manifestCore: '1.2.13',
      manifestDesktop: '1.2.13',
      manifestSidecar: '1.2.13',
    })).toEqual([]);
  });

  test('treats CRLF and LF generated text as the same artifact', () => {
    expect(textsEquivalentIgnoringLineEndings('alpha\r\nbeta\n', 'alpha\nbeta\n')).toBe(true);
    expect(glossaryIsFresh('line\r\n', 'line\n')).toBe(true);
    expect(glossaryIsFresh('stale\n', 'fresh\n')).toBe(false);
  });

  test('generated tree compare ignores text line endings but not content', () => {
    const left = mkdtempSync(join(tmpdir(), 'pmbrain-gen-left-'));
    const right = mkdtempSync(join(tmpdir(), 'pmbrain-gen-right-'));
    writeFileSync(join(left, 'index.js'), 'export default 1;\r\n');
    writeFileSync(join(right, 'index.js'), 'export default 1;\n');
    expect(compareGeneratedTrees(left, right)).toEqual([]);
    writeFileSync(join(right, 'index.js'), 'export default 2;\n');
    expect(compareGeneratedTrees(left, right)).toEqual(['text differs: index.js']);
    const leftFile = join(left, 'snapshot');
    const rightFile = join(right, 'admin-embedded.ts');
    writeFileSync(leftFile, 'export const x = 1;\r\n');
    writeFileSync(rightFile, 'export const x = 1;\n');
    expect(compareGeneratedTrees(leftFile, rightFile)).toEqual([]);
  });

  test('reports every stale version before packaging starts', () => {
    expect(validateVersionContract({
      versionFile: '1.2.12',
      corePackage: '1.2.13',
      desktopPackage: '1.1.13',
      manifestCore: '1.2.11',
      manifestDesktop: '1.1.12',
      manifestSidecar: '1.2.10',
    })).toEqual([
      'desktop/package.json=1.1.13, VERSION=1.2.12',
      'package.json=1.2.13, VERSION=1.2.12',
      'release-manifest core=1.2.11, VERSION=1.2.12',
      'release-manifest sidecar=1.2.10, VERSION=1.2.12',
      'release-manifest desktop=1.1.12, desktop/package.json=1.1.13',
    ]);
  });
});
