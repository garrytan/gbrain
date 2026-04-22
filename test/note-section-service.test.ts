import { describe, expect, test } from 'bun:test';
import { buildNoteManifestEntry } from '../src/core/services/note-manifest-service.ts';
import {
  NOTE_SECTION_EXTRACTOR_VERSION,
  buildNoteSectionEntries,
} from '../src/core/services/note-section-service.ts';

describe('note section service', () => {
  test('buildNoteSectionEntries derives stable ids and heading paths', () => {
    const page = {
      type: 'concept' as const,
      title: 'Section Projection',
      compiled_truth: [
        '# Overview',
        'Intro with [[systems/mbrain]].',
        '',
        '## Runtime',
        'Details with https://example.com/runtime.',
        '[Source: User, direct message, 2026-04-20 05:00 PM KST]',
      ].join('\n'),
      timeline: '',
      frontmatter: {
        aliases: ['Section Projection'],
      },
      content_hash: 'a'.repeat(64),
    };

    const manifest = buildNoteManifestEntry({
      page_id: 7,
      slug: 'concepts/section-projection',
      path: 'concepts/section-projection.md',
      tags: ['phase2', 'sections'],
      page,
    });

    const sections = buildNoteSectionEntries({
      page_id: 7,
      page_slug: 'concepts/section-projection',
      page_path: 'concepts/section-projection.md',
      page,
      manifest: {
        ...manifest,
        last_indexed_at: new Date('2026-04-20T08:00:00.000Z'),
      },
    });

    expect(sections.map((entry) => entry.section_id)).toEqual([
      'concepts/section-projection#overview',
      'concepts/section-projection#overview/runtime',
    ]);
    expect(sections.map((entry) => entry.parent_section_id)).toEqual([
      null,
      'concepts/section-projection#overview',
    ]);
    expect(sections.map((entry) => entry.heading_path)).toEqual([
      ['overview'],
      ['overview', 'runtime'],
    ]);
    expect(sections[1]?.outgoing_urls).toEqual(['https://example.com/runtime']);
    expect(sections[1]?.source_refs).toEqual([
      'User, direct message, 2026-04-20 05:00 PM KST',
    ]);
    expect(sections[0]?.extractor_version).toBe(NOTE_SECTION_EXTRACTOR_VERSION);
  });
});
