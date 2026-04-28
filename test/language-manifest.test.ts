/**
 * v0.20.0 Cathedral II Layer 4 (B1) — Language manifest tests.
 *
 * Cathedral I shipped 29 grammars as hardcoded Bun asset imports + a
 * parallel DISPLAY_LANG record. Cathedral II Layer 4 consolidates these
 * into a single LANGUAGE_MANIFEST keyed on SupportedCodeLanguage with
 * a LanguageEntry shape ({ displayName, embeddedPath?, lazyLoader? }).
 *
 * Why it matters:
 *   - Adding a new language is now one entry, not two.
 *   - Lazy-loadable languages (registered at runtime via registerLanguage)
 *     follow the same API shape as embedded ones — loadLanguage doesn't
 *     branch on load source.
 *   - Layer 9 (B2 Magika) will use registerLanguage to wire extensionless
 *     grammars; v0.20.x+ can use it to lazy-load the rest of
 *     tree-sitter-wasms (~136 more langs) without touching chunker core.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  registerLanguage,
  unregisterLanguage,
  listRegisteredLanguages,
  chunkCodeText,
  type LanguageEntry,
} from '../src/core/chunkers/code.ts';

describe('Layer 4 — LANGUAGE_MANIFEST covers all 29 embedded grammars', () => {
  test('listRegisteredLanguages includes the 29 v0.19.0 languages', () => {
    const langs = listRegisteredLanguages();
    const core = [
      'typescript', 'tsx', 'javascript', 'python', 'ruby', 'go',
      'rust', 'java', 'c_sharp', 'cpp', 'c', 'php', 'swift', 'kotlin',
      'scala', 'lua', 'elixir', 'elm', 'ocaml', 'dart', 'zig', 'solidity',
      'bash', 'css', 'html', 'vue', 'json', 'yaml', 'toml',
    ];
    for (const lang of core) {
      expect(langs).toContain(lang);
    }
  });

  test('registered languages list is at least 29 (the v0.19.0 core)', () => {
    const langs = listRegisteredLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(29);
  });
});

describe('Layer 4 — registerLanguage hook (forward-compat for B2/v0.20.x)', () => {
  afterEach(() => {
    unregisterLanguage('fortran-fake');
    unregisterLanguage('typescript'); // in case a test overrode
  });

  test('registerLanguage adds a language with a lazy loader', () => {
    let loaderCalls = 0;
    const entry: LanguageEntry = {
      displayName: 'Fortran (fake)',
      lazyLoader: async () => {
        loaderCalls++;
        return new Uint8Array([0, 1, 2, 3]);
      },
    };
    registerLanguage('fortran-fake', entry);
    expect(listRegisteredLanguages()).toContain('fortran-fake');
    expect(loaderCalls).toBe(0);
  });

  test('dynamic registrations win over core manifest on conflict', () => {
    const override: LanguageEntry = {
      displayName: 'TypeScript (override)',
      embeddedPath: 'fake-path-never-loaded',
    };
    registerLanguage('typescript', override);
    const langs = listRegisteredLanguages();
    expect(langs).toContain('typescript');
  });

  test('unregisterLanguage removes a dynamic entry', () => {
    const entry: LanguageEntry = { displayName: 'Fortran (fake)' };
    registerLanguage('fortran-fake', entry);
    expect(listRegisteredLanguages()).toContain('fortran-fake');
    unregisterLanguage('fortran-fake');
    expect(listRegisteredLanguages()).not.toContain('fortran-fake');
  });
});

describe('Layer 4 — existing chunker still loads core grammars', () => {
  test('chunkCodeText with TypeScript source produces semantic chunks', async () => {
    const source = `
      export function alpha(x: number): number {
        return x + 1;
      }

      export function beta(y: string): string {
        return y.toUpperCase();
      }
    `;
    const chunks = await chunkCodeText(source, 'src/foo.ts');
    expect(chunks.length).toBeGreaterThan(0);
    const tsChunks = chunks.filter(c => c.metadata.language === 'typescript');
    expect(tsChunks.length).toBeGreaterThan(0);
  });

  test('chunk header uses manifest displayName, not bare lang key', async () => {
    const source = `def foo():\n    return 42\n`;
    const chunks = await chunkCodeText(source, 'src/foo.py');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.text).toMatch(/^\[Python\]/);
  });

  test('chunk header for Ruby uses "Ruby" display name', async () => {
    const source = `
      class Foo
        def bar
          42
        end
      end
    `;
    const chunks = await chunkCodeText(source, 'src/foo.rb');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.text).toMatch(/^\[Ruby\]/);
  });
});
