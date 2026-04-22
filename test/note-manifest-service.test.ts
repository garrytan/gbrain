import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  NOTE_MANIFEST_EXTRACTOR_VERSION,
  buildNoteManifestEntry,
} from '../src/core/services/note-manifest-service.ts';

describe('note manifest service', () => {
  test('buildNoteManifestEntry extracts deterministic structural fields', () => {
    const entry = buildNoteManifestEntry({
      page_id: 42,
      slug: 'concepts/note-manifest',
      path: 'concepts/note-manifest.md',
      tags: ['phase2', 'manifest'],
      page: {
        type: 'concept',
        title: 'Note Manifest',
        compiled_truth: [
          '# Overview',
          'Reference [[People/Sarah Chen|Sarah]] and [[systems/mbrain#note-manifest]].',
          '[Source: User, direct message, 2026-04-20 09:00 AM KST]',
          '',
          '## Details',
          'Visit https://example.com/docs and https://example.com/docs.',
        ].join('\n'),
        timeline: [
          '### Timeline',
          '- Reviewed in planning sync.',
          '[Source: Meeting notes, design sync, 2026-04-20 10:00 AM KST]',
        ].join('\n'),
        frontmatter: {
          aliases: ['Context Manifest', 'Structural Index'],
          repo: 'meghendra6/mbrain',
        },
      },
    });

    expect(entry.scope_id).toBe(DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    expect(entry.extractor_version).toBe(NOTE_MANIFEST_EXTRACTOR_VERSION);
    expect(entry.slug).toBe('concepts/note-manifest');
    expect(entry.path).toBe('concepts/note-manifest.md');
    expect(entry.page_type).toBe('concept');
    expect(entry.aliases).toEqual(['Context Manifest', 'Structural Index']);
    expect(entry.tags).toEqual(['manifest', 'phase2']);
    expect(entry.outgoing_wikilinks).toEqual(['people/sarah-chen', 'systems/mbrain']);
    expect(entry.outgoing_urls).toEqual(['https://example.com/docs']);
    expect(entry.source_refs).toEqual([
      'User, direct message, 2026-04-20 09:00 AM KST',
      'Meeting notes, design sync, 2026-04-20 10:00 AM KST',
    ]);
    expect(entry.heading_index).toEqual([
      { slug: 'overview', text: 'Overview', depth: 1, line_start: 1 },
      { slug: 'details', text: 'Details', depth: 2, line_start: 5 },
      { slug: 'timeline', text: 'Timeline', depth: 3, line_start: 10 },
    ]);
    expect(entry.content_hash).toHaveLength(64);
  });

  test('buildNoteManifestEntry computes a stable fallback hash from canonical note inputs', () => {
    const base = {
      page_id: 7,
      slug: 'concepts/hash-test',
      path: 'concepts/hash-test.md',
      tags: ['alpha'],
      page: {
        type: 'concept' as const,
        title: 'Hash Test',
        compiled_truth: '# Heading\nSame content.',
        timeline: '',
        frontmatter: {
          aliases: ['Hash Alias'],
        },
      },
    };

    const first = buildNoteManifestEntry(base);
    const second = buildNoteManifestEntry(base);
    const changed = buildNoteManifestEntry({
      ...base,
      tags: ['alpha', 'beta'],
    });

    expect(first.content_hash).toBe(second.content_hash);
    expect(first.content_hash).not.toBe(changed.content_hash);
  });

  test('buildNoteManifestEntry canonicalizes tag order for deterministic rebuilds', () => {
    const entry = buildNoteManifestEntry({
      page_id: 9,
      slug: 'concepts/tag-order',
      path: 'concepts/tag-order.md',
      tags: ['phase2', 'manifest', 'phase2'],
      page: {
        type: 'concept',
        title: 'Tag Order',
        compiled_truth: '# Heading',
        timeline: '',
        frontmatter: {},
      },
    });

    expect(entry.tags).toEqual(['manifest', 'phase2']);
  });
});
