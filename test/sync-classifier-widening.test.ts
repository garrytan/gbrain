/**
 * v0.20.0 Cathedral II Layer 2 (1a) — file-classifier widening.
 *
 * Codex F1 caught that v0.19.0's sync.ts classified only 9 extensions as
 * code, so B1's "165 languages" claim was aspirational — anything beyond
 * TS/JS/Python/Ruby/Go dropped on the sync floor. Layer 2 widens the
 * classifier so every extension the chunker knows about reaches the
 * chunker during normal sync.
 *
 * Layer 2 also ships resolveSlugForPath — a central dispatcher that picks
 * between slugifyCodePath and pathToSlug based on isCodeFilePath. Sync
 * delete/rename paths now go through this so widening the classifier
 * doesn't break deletes (SP-5).
 *
 * Layer 2 additionally adds a setLanguageFallback hook on
 * chunkers/code.ts that Layer 9 (B2 Magika) will wire in. This test
 * covers the hook contract.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { isCodeFilePath, resolveSlugForPath, slugifyCodePath, slugifyPath } from '../src/core/sync.ts';
import { detectCodeLanguage, setLanguageFallback, type SupportedCodeLanguage } from '../src/core/chunkers/code.ts';

describe('Layer 2 — isCodeFilePath widening', () => {
  test('v0.19.0 floor still classified as code', () => {
    // The 9 extensions that v0.19.0 shipped with.
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go']) {
      expect(isCodeFilePath('foo' + ext)).toBe(true);
    }
  });

  test('Rust now classified as code (codex F1)', () => {
    expect(isCodeFilePath('src/main.rs')).toBe(true);
  });

  test('Java now classified as code (codex F1)', () => {
    expect(isCodeFilePath('src/Main.java')).toBe(true);
  });

  test('C# now classified as code (codex F1)', () => {
    expect(isCodeFilePath('src/Main.cs')).toBe(true);
  });

  test('C++ variants now classified as code', () => {
    expect(isCodeFilePath('src/main.cpp')).toBe(true);
    expect(isCodeFilePath('src/main.cc')).toBe(true);
    expect(isCodeFilePath('src/main.hpp')).toBe(true);
    expect(isCodeFilePath('src/main.h')).toBe(true);
  });

  test('Swift / Kotlin / Scala / PHP now classified as code', () => {
    expect(isCodeFilePath('ios/App.swift')).toBe(true);
    expect(isCodeFilePath('android/Main.kt')).toBe(true);
    expect(isCodeFilePath('src/Main.scala')).toBe(true);
    expect(isCodeFilePath('web/index.php')).toBe(true);
  });

  test('Shell / Lua / Elixir / Dart / Zig / Solidity now classified as code', () => {
    expect(isCodeFilePath('scripts/deploy.sh')).toBe(true);
    expect(isCodeFilePath('scripts/deploy.bash')).toBe(true);
    expect(isCodeFilePath('src/init.lua')).toBe(true);
    expect(isCodeFilePath('lib/worker.ex')).toBe(true);
    expect(isCodeFilePath('lib/test.exs')).toBe(true);
    expect(isCodeFilePath('flutter/main.dart')).toBe(true);
    expect(isCodeFilePath('src/main.zig')).toBe(true);
    expect(isCodeFilePath('contracts/Token.sol')).toBe(true);
  });

  test('Web + config extensions (CSS, HTML, Vue, JSON, YAML, TOML)', () => {
    expect(isCodeFilePath('src/app.css')).toBe(true);
    expect(isCodeFilePath('public/index.html')).toBe(true);
    expect(isCodeFilePath('src/App.vue')).toBe(true);
    expect(isCodeFilePath('package.json')).toBe(true);
    expect(isCodeFilePath('config.yaml')).toBe(true);
    expect(isCodeFilePath('config.yml')).toBe(true);
    expect(isCodeFilePath('Cargo.toml')).toBe(true);
  });

  test('markdown is NOT classified as code', () => {
    expect(isCodeFilePath('docs/README.md')).toBe(false);
    expect(isCodeFilePath('docs/note.mdx')).toBe(false);
  });

  test('extensionless files are NOT classified as code via name alone (Magika fallback, Layer 9)', () => {
    // Layer 2's classifier is extension-based only. Layer 9 wires up
    // setLanguageFallback for extensionless-via-content classification.
    expect(isCodeFilePath('Dockerfile')).toBe(false);
    expect(isCodeFilePath('Makefile')).toBe(false);
    expect(isCodeFilePath('.envrc')).toBe(false);
  });
});

describe('Layer 2 — resolveSlugForPath dispatches by extension (SP-5)', () => {
  test('markdown path → markdown-style slug (slugifyPath)', () => {
    expect(resolveSlugForPath('people/alice-smith.md'))
      .toBe(slugifyPath('people/alice-smith.md').toLowerCase());
  });

  test('code path → code-style slug (slugifyCodePath)', () => {
    // slugifyCodePath replaces dots with hyphens and flattens
    // slashes to hyphens: src/core/sync.ts → src-core-sync-ts
    expect(resolveSlugForPath('src/core/sync.ts'))
      .toBe(slugifyCodePath('src/core/sync.ts').toLowerCase());
  });

  test('Rust file uses code-slug (previously fell through to markdown, SP-5)', () => {
    expect(resolveSlugForPath('crates/worker/src/main.rs'))
      .toBe(slugifyCodePath('crates/worker/src/main.rs').toLowerCase());
  });

  test('repoPrefix is applied before lowercasing', () => {
    expect(resolveSlugForPath('src/foo.ts', 'my-repo'))
      .toMatch(/^my-repo\//);
  });

  test('round-trip: same path in → same slug out', () => {
    const path = 'crates/worker/src/lib.rs';
    expect(resolveSlugForPath(path)).toBe(resolveSlugForPath(path));
  });
});

describe('Layer 2 — detectCodeLanguage Magika fallback hook', () => {
  afterEach(() => {
    setLanguageFallback(null);
  });

  test('no fallback installed + extensionless path → null', () => {
    expect(detectCodeLanguage('Dockerfile')).toBe(null);
    expect(detectCodeLanguage('Dockerfile', '# syntax=docker/dockerfile:1')).toBe(null);
  });

  test('fallback fires only on unknown-extension + content provided', () => {
    let calls = 0;
    setLanguageFallback((path, content) => {
      calls++;
      if (path === 'Dockerfile' && content.includes('FROM')) return 'bash';
      return null;
    });
    // Known extension — fallback NOT consulted.
    expect(detectCodeLanguage('app.ts', 'const x = 1')).toBe('typescript');
    expect(calls).toBe(0);
    // Unknown extension + no content — fallback NOT consulted.
    expect(detectCodeLanguage('Dockerfile')).toBe(null);
    expect(calls).toBe(0);
    // Unknown extension + content — fallback consulted.
    expect(detectCodeLanguage('Dockerfile', 'FROM alpine')).toBe('bash');
    expect(calls).toBe(1);
  });

  test('fallback throw is swallowed → null result', () => {
    setLanguageFallback(() => {
      throw new Error('Magika model load failed');
    });
    expect(detectCodeLanguage('Dockerfile', 'FROM alpine')).toBe(null);
  });

  test('fallback returning null passes through as null', () => {
    setLanguageFallback(() => null);
    expect(detectCodeLanguage('weird.file.xyz', 'some content')).toBe(null);
  });

  test('fallback returning a supported language passes through', () => {
    const targetLang: SupportedCodeLanguage = 'python';
    setLanguageFallback(() => targetLang);
    expect(detectCodeLanguage('run', '#!/usr/bin/env python3\nprint("hi")')).toBe('python');
  });
});
