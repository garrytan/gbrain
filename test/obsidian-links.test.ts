import { describe, expect, test } from 'bun:test';
import {
  buildVaultIndex,
  desiredLinksForFile,
  extractObsidianLinks,
  OBSIDIAN_EMBED_TYPE,
  OBSIDIAN_LINK_TYPE,
  resolveObsidianLink,
} from '../src/core/obsidian-links.ts';

describe('extractObsidianLinks', () => {
  test('extracts wikilinks, aliases, headings, block refs, embeds, and markdown links', () => {
    const links = extractObsidianLinks([
      'See [[People/Alice|Alice]] and [[Projects/GBrain#Plan]].',
      'Block [[Notes/Day#^abc123]].',
      'Embed ![[Concepts/Testing]].',
      'Markdown [Bob](People/Bob.md#Intro).',
    ].join('\n'));

    expect(links.map(l => l.target)).toEqual([
      'People/Alice',
      'Projects/GBrain',
      'Notes/Day',
      'Concepts/Testing',
      'People/Bob.md',
    ]);
    expect(links[0].display).toBe('Alice');
    expect(links[1].heading).toBe('Plan');
    expect(links[2].heading).toBe('^abc123');
    expect(links[3].embed).toBe(true);
    expect(links[4].markdown).toBe(true);
  });

  test('ignores links in frontmatter, fenced code, inline code, and comments', () => {
    const links = extractObsidianLinks([
      '---',
      'related: "[[Frontmatter]]"',
      '---',
      'Real [[Visible]].',
      '`[[InlineCode]]`',
      '```',
      '[[FencedCode]]',
      '```',
      '<!-- [[Commented]] -->',
    ].join('\n'));

    expect(links.map(l => l.target)).toEqual(['Visible']);
  });
});

describe('resolveObsidianLink', () => {
  test('resolves exact paths, same-folder paths, basenames, and unambiguous case fallback', () => {
    const index = buildVaultIndex([
      'People/Alice Smith.md',
      'People/Bob.md',
      'Projects/GBrain.md',
    ]);

    expect(resolveObsidianLink('People/Bob.md', extractObsidianLinks('[[Alice Smith]]')[0], index).toSlug)
      .toBe('people/alice-smith');
    expect(resolveObsidianLink('People/Bob.md', extractObsidianLinks('[[Projects/GBrain]]')[0], index).toSlug)
      .toBe('projects/gbrain');
    expect(resolveObsidianLink('People/Bob.md', extractObsidianLinks('[[alice smith]]')[0], index).toSlug)
      .toBe('people/alice-smith');
  });

  test('reports ambiguous basenames and non-markdown embeds', () => {
    const index = buildVaultIndex([
      'People/Alice.md',
      'Archive/Alice.md',
    ]);

    const ambiguous = resolveObsidianLink('Home.md', extractObsidianLinks('[[Alice]]')[0], index);
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.candidates).toEqual(['People/Alice.md', 'Archive/Alice.md']);

    const fileEmbed = resolveObsidianLink('Home.md', extractObsidianLinks('![[image.png]]')[0], index);
    expect(fileEmbed.status).toBe('file_embed');
  });

  test('detects slug collisions', () => {
    const index = buildVaultIndex([
      'Notes/A B.md',
      'Notes/A-B.md',
    ]);

    expect(index.slugCollisions.get('notes/a-b')).toEqual(['Notes/A B.md', 'Notes/A-B.md']);
  });
});

describe('desiredLinksForFile', () => {
  test('groups desired links by Obsidian link type', () => {
    const index = buildVaultIndex([
      'Home.md',
      'People/Alice.md',
      'Concepts/Testing.md',
    ]);

    const desired = desiredLinksForFile(
      'Home.md',
      '[[Alice]] and ![[Concepts/Testing]]',
      index,
    );

    expect(desired.linksByType.get(OBSIDIAN_LINK_TYPE)).toEqual([
      { to_slug: 'people/alice', context: '[[Alice]]' },
    ]);
    expect(desired.linksByType.get(OBSIDIAN_EMBED_TYPE)).toEqual([
      { to_slug: 'concepts/testing', context: '![[Concepts/Testing]]' },
    ]);
  });
});
