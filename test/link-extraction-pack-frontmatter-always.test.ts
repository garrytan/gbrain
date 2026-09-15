/**
 * Pack-declared `frontmatter_links` run even when the caller suppresses the
 * built-in frontmatter field map (`skipFrontmatter: true` on the DB path,
 * `includeFrontmatter: false` on the FS path): the sweep, the cycle extract
 * phase, and `gbrain extract links` without `--include-frontmatter` all pass
 * that flag, and pre-fix a DB-born page (extract_atoms writing
 * `concepts: [...]`) was stamped `links_extracted_at` with body links only,
 * so an operator-added pack rule never produced its edges.
 *
 * Only operator-added rules fire in that mode. A pack rule that mirrors a
 * FRONTMATTER_LINK_MAP entry (the shipped base pack re-declares every
 * built-in as `page_type + field`) stays gated exactly like the built-in it
 * copies — otherwise the sweep would materialize person/company/deal/meeting
 * frontmatter edges on every brain, in the wrong direction (#3190 pack
 * mappings are always outgoing; the built-ins they mirror are incoming).
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';
import { extractLinksFromFile } from '../src/commands/extract.ts';
import { parseSchemaPackManifest, loadPackFromFile } from '../src/core/schema-pack/index.ts';

const PACK = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1',
  name: 'pack-fm-always',
  version: '0.1.0',
  extends: null,
  page_types: [],
  link_types: [{ name: 'discusses' }],
  frontmatter_links: [
    { page_type: 'atom', fields: ['concepts'], link_type: 'discusses' },
    // FS-path page types are dir-guessed (`notes/` → concept).
    { page_type: 'concept', fields: ['concepts'], link_type: 'discusses' },
  ],
});

const BASE_PACK = loadPackFromFile(
  join(import.meta.dir, '..', 'src', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
);

// Bare-name lookup, the way the batch resolver finds a page by title.
const KNOWN: Record<string, string> = { 'cloud-drift': 'concepts/cloud-drift', 'alice-example': 'people/alice-example' };
const resolver: SlugResolver = { resolve: async (name) => KNOWN[name] ?? null };

describe('pack frontmatter_links with skipFrontmatter (DB path)', () => {
  test('operator-added pack rule still yields its edge', async () => {
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

  test('base-pack rule mirroring a built-in stays gated like the built-in', async () => {
    // gbrain-base.yaml declares `meeting.attendees → attended`, the same
    // field FRONTMATTER_LINK_MAP maps. Under skipFrontmatter the mirror must
    // not fire either — only rules the built-in map does not know about run.
    expect(BASE_PACK.frontmatter_links.some((fl) => fl.page_type === 'meeting' && fl.fields.includes('attendees'))).toBe(true);
    const gated = await extractPageLinks(
      'meetings/2026-09-08', 'body', { attendees: ['alice-example'] }, 'meeting' as never,
      resolver, { skipFrontmatter: true, pack: BASE_PACK },
    );
    expect(gated.candidates).toEqual([]);
    // The un-gated (`skipFrontmatter: false`) pass is deliberately not
    // asserted here: the built-in is `incoming` and the pack mirror is
    // `outgoing`, so they emit two rows — the open #3190 direction item.
  });
});

describe('pack frontmatter_links without includeFrontmatter (FS path)', () => {
  test('operator-added pack rule yields its edge from extractLinksFromFile', async () => {
    // Pack mappings carry no dirHint, so the synthetic FS resolver only
    // accepts already-slug-shaped values (step 1 of makeResolver).
    const content = '---\nconcepts:\n  - concepts/cloud-drift\n---\nbody with no links\n';
    const allSlugs = new Set(['notes/example', 'concepts/cloud-drift']);
    const links = await extractLinksFromFile(content, 'notes/example.md', allSlugs, { includeFrontmatter: false, pack: PACK });
    expect(links.map((l) => [l.to_slug, l.link_type])).toEqual([['concepts/cloud-drift', 'discusses']]);
  });
});
