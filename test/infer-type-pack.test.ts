// v0.38 T7a: pack-aware inferType parity + extension tests.
//
// Parity gate: `inferTypeFromPack(path, gbrain-base)` must produce
// IDENTICAL output to the legacy `inferType(path)` for every known
// path prefix. If this drifts, gbrain-base.yaml is out of sync with
// the GBRAIN_BASE_PATH_PREFIXES table in markdown.ts.
//
// Extension test: a user pack adding `paper: { path_prefixes:
// ['papers/'] }` must route `papers/foo.md` to 'paper' (the pack
// declaration), bypassing the gbrain-base fallback.

import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { join } from 'node:path';

const GBRAIN_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');

// Representative paths covering every gbrain-base path-prefix entry.
const PARITY_FIXTURES: ReadonlyArray<{ path: string; expected: string; reason: string }> = [
  { path: 'people/alice.md', expected: 'person', reason: 'people/ prefix' },
  { path: 'companies/acme.md', expected: 'company', reason: 'companies/ prefix' },
  { path: 'deals/acme-seed.md', expected: 'deal', reason: 'deals/ prefix' },
  { path: 'yc/w24.md', expected: 'yc', reason: 'yc/ prefix' },
  { path: 'civic/policy/sf.md', expected: 'civic', reason: 'civic/ prefix' },
  { path: 'projects/blog/index.md', expected: 'project', reason: 'projects/ prefix' },
  { path: 'wiki/concepts/inversion.md', expected: 'concept', reason: 'wiki/concepts/ prefix' },
  { path: 'sources/article.md', expected: 'source', reason: 'sources/ prefix' },
  { path: 'media/books/x.md', expected: 'media', reason: 'media/ prefix' },
  { path: 'writing/essay.md', expected: 'writing', reason: 'writing/ prefix' },
  { path: 'wiki/analysis/foo.md', expected: 'analysis', reason: 'wiki/analysis/ wins over wiki/' },
  { path: 'wiki/guides/setup.md', expected: 'guide', reason: 'wiki/guides/ prefix' },
  { path: 'wiki/hardware/x.md', expected: 'hardware', reason: 'wiki/hardware/ prefix' },
  { path: 'wiki/architecture/x.md', expected: 'architecture', reason: 'wiki/architecture/ prefix' },
  { path: 'meetings/2026-04-03.md', expected: 'meeting', reason: 'meetings/ prefix' },
  { path: 'notes/random.md', expected: 'note', reason: 'notes/ prefix' },
  { path: 'emails/em-0001.md', expected: 'email', reason: 'emails/ prefix' },
  { path: 'slack/sl-0037.md', expected: 'slack', reason: 'slack/ prefix' },
  { path: 'cal/2026-05-20.md', expected: 'calendar-event', reason: 'cal/ prefix' },
  // v0.42.x — Life Chronicle (#2390): timeline events + thought diary.
  { path: 'life/events/2026-06-18-002-sync.md', expected: 'event', reason: 'life/events/ prefix' },
  { path: 'life/diary/2026-06-18-am.md', expected: 'diary', reason: 'life/diary/ prefix' },
  // Stronger-signal wins: writing/ inside projects/
  { path: 'projects/blog/writing/essay.md', expected: 'writing', reason: 'writing/ wins over projects/' },
  // Fallback: paths not matching any prefix
  { path: 'random/path.md', expected: 'concept', reason: 'no prefix match → concept default' },
];

describe('inferTypeFromPack (T7a) — gbrain-base parity', () => {
  test('parity: every known path maps to the same type via pack as via legacy', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    for (const { path, expected, reason } of PARITY_FIXTURES) {
      const actual = inferTypeFromPack(path, pack);
      // For parity, the pack result MUST match the legacy hardcoded result.
      // Verify by parsing markdown — parseMarkdown calls the legacy inferType
      // when frontmatter doesn't override.
      const md = `# ${path}\nbody`;
      const parsed = parseMarkdown(md, path);
      expect(parsed.type).toBe(expected);
      expect(actual).toBe(expected);
      // Sanity: the reason annotation isn't a test assertion but documents
      // why each fixture exists. Surface unused-variable lint via toBeTruthy.
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test('user pack extends gbrain-base with researcher type', () => {
    // Synthetic pack declaring a new type with its own prefix.
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'research-test',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'researcher', primitive: 'entity', path_prefixes: ['researchers/'], aliases: [], extractable: true, expert_routing: true },
        { name: 'paper', primitive: 'media', path_prefixes: ['papers/'], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
    });
    expect(inferTypeFromPack('researchers/alice.md', pack)).toBe('researcher');
    expect(inferTypeFromPack('papers/smith-2024.md', pack)).toBe('paper');
    // Paths NOT in the pack's prefixes default to 'concept'.
    expect(inferTypeFromPack('people/alice.md', pack)).toBe('concept');
  });

  test('pack with empty page_types falls back to gbrain-base defaults', () => {
    // E.g. a pack mid-construction with no page_types declared — should
    // not crash, should match gbrain-base behavior.
    const emptyPack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'empty',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(inferTypeFromPack('people/alice.md', emptyPack)).toBe('person');
    expect(inferTypeFromPack('media/foo.md', emptyPack)).toBe('media');
  });

  test('undefined filePath returns concept default', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    expect(inferTypeFromPack(undefined, pack)).toBe('concept');
  });

  test('case-insensitive matching', () => {
    const pack = loadPackFromFile(GBRAIN_BASE_PATH);
    expect(inferTypeFromPack('PEOPLE/Alice.md', pack)).toBe('person');
    expect(inferTypeFromPack('Companies/ACME.md', pack)).toBe('company');
  });
});
