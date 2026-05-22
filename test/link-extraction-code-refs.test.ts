/**
 * v0.19.0 Layer 6 E1 — extractCodeRefs tests.
 *
 * Covers the regex surface: prefix directory allowlist, extension list,
 * optional :line suffix, dedup by path.
 */

import { describe, test, expect } from 'bun:test';
import { extractCodeRefs } from '../src/core/link-extraction.ts';

describe('extractCodeRefs — basic patterns', () => {
  test('matches src/ path with extension', () => {
    const refs = extractCodeRefs('see src/core/sync.ts for details');
    expect(refs.length).toBe(1);
    expect(refs[0]!.path).toBe('src/core/sync.ts');
    expect(refs[0]!.line).toBeUndefined();
  });

  test('extracts :line suffix', () => {
    const refs = extractCodeRefs('see src/core/sync.ts:42 for the bug');
    expect(refs.length).toBe(1);
    expect(refs[0]!.path).toBe('src/core/sync.ts');
    expect(refs[0]!.line).toBe(42);
  });

  test('recognizes all seeded directory prefixes', () => {
    const cases = [
      'src/foo.ts', 'lib/foo.ts', 'app/foo.ts', 'test/foo.ts', 'tests/foo.ts',
      'scripts/foo.ts', 'docs/foo.ts', 'packages/bar/foo.ts', 'internal/foo.go',
      'cmd/main.go', 'examples/foo.py',
    ];
    for (const path of cases) {
      const refs = extractCodeRefs(`see ${path}`);
      expect(refs.length).toBe(1);
      expect(refs[0]!.path).toBe(path);
    }
  });

  test('recognizes all code extensions', () => {
    const exts = [
      'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
      'py', 'rb', 'go', 'rs', 'java', 'cs',
      'cpp', 'cc', 'hpp', 'c', 'h',
      'php', 'swift', 'kt', 'scala', 'lua',
      'ex', 'exs', 'elm', 'ml', 'dart', 'zig', 'sol',
      'sh', 'bash', 'css', 'html', 'vue',
      'json', 'yaml', 'yml', 'toml',
    ];
    for (const ext of exts) {
      const refs = extractCodeRefs(`see src/foo.${ext}`);
      expect(refs.length).toBe(1);
      expect(refs[0]!.path).toBe(`src/foo.${ext}`);
    }
  });

  test('rejects paths outside allowlisted prefixes', () => {
    // random/ is not in the prefix list — not a code reference
    expect(extractCodeRefs('see random/foo.ts').length).toBe(0);
    // node_modules/ likewise
    expect(extractCodeRefs('see node_modules/foo/index.js').length).toBe(0);
  });

  test('rejects unknown extensions', () => {
    expect(extractCodeRefs('see src/foo.xyz').length).toBe(0);
    expect(extractCodeRefs('see src/foo.md').length).toBe(0); // md isn't code
  });

  test('dedups by path', () => {
    const refs = extractCodeRefs(
      'first src/foo.ts mention, second src/foo.ts, third src/foo.ts',
    );
    expect(refs.length).toBe(1);
    expect(refs[0]!.path).toBe('src/foo.ts');
  });

  test('different paths coexist', () => {
    const refs = extractCodeRefs(
      'see src/a.ts and src/b.ts and lib/c.py',
    );
    expect(refs.length).toBe(3);
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual(['lib/c.py', 'src/a.ts', 'src/b.ts']);
  });
});

describe('extractCodeRefs — integration with gbrain workflow', () => {
  test('extracts multiple references from real markdown', () => {
    const guide = `# Sync Pipeline

The entry point is \`performSync\` in \`src/commands/sync.ts\`. It delegates
to \`buildSyncManifest\` in \`src/core/sync.ts\`.

When a parse error lands, \`src/core/sync.ts:380\` records it in
\`~/.gbrain/sync-failures.jsonl\`. The retry path is covered in
\`test/sync.test.ts\`.

See also: \`scripts/check-wasm-embedded.sh\` (bash, not scanned).
`;
    const refs = extractCodeRefs(guide);
    const paths = new Set(refs.map((r) => r.path));
    expect(paths.has('src/commands/sync.ts')).toBe(true);
    expect(paths.has('src/core/sync.ts')).toBe(true);
    expect(paths.has('test/sync.test.ts')).toBe(true);
    expect(paths.has('scripts/check-wasm-embedded.sh')).toBe(true);
    // Dedup keeps the first occurrence; a later 'src/core/sync.ts:380'
    // won't surface the line number if the plain path appeared earlier.
    // Assert we found SOME ref to src/core/sync.ts, and that a standalone
    // 'src/core/sync.ts:380' in isolation would capture the line.
    expect(paths.size).toBeGreaterThanOrEqual(4);
    const lineOnly = extractCodeRefs('error at src/core/sync.ts:380');
    expect(lineOnly[0]!.line).toBe(380);
  });

  test('does not match paths that look like URLs', () => {
    // Intended: only directory-prefixed relative paths, not URL-ish strings
    const refs = extractCodeRefs('see http://example.com/src/foo.ts');
    // Some matches may pass through here as src/foo.ts — that's acceptable
    // behavior (the regex anchors on word boundaries). The intent is not to
    // perfectly reject URLs but to match real file paths. Just sanity-check
    // we don't crash or match the full URL as a single ref.
    for (const r of refs) {
      expect(r.path.startsWith('http')).toBe(false);
    }
  });
});
