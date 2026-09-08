/**
 * Pack-declared `frontmatter_links` run even when the caller suppresses the
 * built-in frontmatter field map (`skipFrontmatter: true`): the sweep, the
 * cycle extract phase, and `gbrain extract links` without
 * `--include-frontmatter` all pass that flag, and pre-fix a DB-born page
 * (extract_atoms writing `concepts: [...]`) was stamped `links_extracted_at`
 * with body links only, so the pack's edges never appeared.
 */
import { describe, test, expect } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/index.ts';

const PACK = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1',
  name: 'pack-fm-always',
  version: '0.1.0',
  extends: null,
  page_types: [],
  link_types: [{ name: 'discusses' }],
  frontmatter_links: [{ page_type: 'atom', fields: ['concepts'], link_type: 'discusses' }],
});

// Bare-name lookup, the way the batch resolver finds a page by title.
const KNOWN: Record<string, string> = { 'cloud-drift': 'concepts/cloud-drift', 'alice-example': 'people/alice-example' };
const resolver: SlugResolver = { resolve: async (name) => KNOWN[name] ?? null };

describe('pack frontmatter_links with skipFrontmatter', () => {
  test('pack-declared field still yields its edge', async () => {
    const r = await extractPageLinks(
      'atoms/2026-09-08/example', 'body with no links', { concepts: ['cloud-drift'] }, 'atom' as never,
      resolver, { skipFrontmatter: true, pack: PACK },
    );
    expect(r.candidates.map((c) => [c.targetSlug, c.linkType])).toEqual([['concepts/cloud-drift', 'discusses']]);
  });

  test('built-in field map stays suppressed', async () => {
    // `attendees` is a FRONTMATTER_LINK_MAP rule (meeting → attended); with
    // skipFrontmatter it must not fire even though a pack is present.
    const r = await extractPageLinks(
      'meetings/2026-09-08', 'body', { attendees: ['alice-example'] }, 'meeting' as never,
      resolver, { skipFrontmatter: true, pack: PACK },
    );
    expect(r.candidates).toEqual([]);
  });

  test('no pack rules → no frontmatter pass at all', async () => {
    const r = await extractPageLinks(
      'atoms/2026-09-08/example', 'body', { concepts: ['cloud-drift'] }, 'atom' as never,
      resolver, { skipFrontmatter: true, pack: null },
    );
    expect(r.candidates).toEqual([]);
  });
});
