// v0.42 Type Unification (T28) — inferTypeAndSubtypeFromPack tests.
//
// Coverage: prefix match wins; subtype rule fires from frontmatter +
// path_pattern; back-compat with empty pack falls back to gbrain-base
// hardcoded behavior; legacy inferTypeFromPack signature unchanged.

import { describe, expect, it } from 'bun:test';
import { inferTypeAndSubtypeFromPack, inferTypeFromPack } from '../src/core/markdown.ts';

describe('inferTypeAndSubtypeFromPack', () => {
  it('returns concept for missing path', () => {
    expect(inferTypeAndSubtypeFromPack(undefined, { page_types: [{ name: 'media', path_prefixes: ['/media/'] }] })).toEqual({ type: 'concept' });
  });

  it('returns concept fallback when no prefix matches', () => {
    expect(inferTypeAndSubtypeFromPack('foo/bar.md', {
      page_types: [{ name: 'media', path_prefixes: ['/media/'] }],
    })).toEqual({ type: 'concept' });
  });

  it('matches prefix → returns canonical type', () => {
    expect(inferTypeAndSubtypeFromPack('media/x.md', {
      page_types: [{ name: 'media', path_prefixes: ['/media/'] }],
    })).toEqual({ type: 'media' });
  });

  it('fires subtype rule from path_pattern (D5)', () => {
    expect(inferTypeAndSubtypeFromPack('videos/x.md', {
      page_types: [{
        name: 'media',
        path_prefixes: ['/videos/'],
        subtypes: [{ name: 'video', when: { path_pattern: '^videos/' } }],
      }],
    })).toEqual({ type: 'media', subtype: 'video' });
  });

  it('fires subtype rule from frontmatter (D5)', () => {
    expect(inferTypeAndSubtypeFromPack('tweets/a.md', {
      page_types: [{
        name: 'tweet',
        path_prefixes: ['/tweets/'],
        subtypes: [
          { name: 'bundle', when: { frontmatter_field: 'bundle', frontmatter_value: true } },
          { name: 'single', when: { frontmatter_field: 'thread_length', frontmatter_value: 1 } },
        ],
      }],
    }, { bundle: true })).toEqual({ type: 'tweet', subtype: 'bundle' });
  });

  it('returns canonical-only when no subtype rule matches', () => {
    expect(inferTypeAndSubtypeFromPack('tweets/a.md', {
      page_types: [{
        name: 'tweet',
        path_prefixes: ['/tweets/'],
        subtypes: [{ name: 'bundle', when: { frontmatter_field: 'bundle', frontmatter_value: true } }],
      }],
    }, { bundle: false })).toEqual({ type: 'tweet' });
  });

  it('first-prefix-wins ordering', () => {
    expect(inferTypeAndSubtypeFromPack('wiki/concepts/foo.md', {
      page_types: [
        { name: 'concept', path_prefixes: ['/wiki/concepts/'] },
        { name: 'wiki-anything', path_prefixes: ['/wiki/'] },
      ],
    })).toEqual({ type: 'concept' });
  });

  it('malformed regex in path_pattern is silently skipped', () => {
    expect(inferTypeAndSubtypeFromPack('foo/x.md', {
      page_types: [{
        name: 'media',
        path_prefixes: ['/foo/'],
        subtypes: [{ name: 'broken', when: { path_pattern: '[invalid(regex' } }],
      }],
    })).toEqual({ type: 'media' });
  });
});

describe('inferTypeFromPack (legacy back-compat)', () => {
  it('preserves the original signature; returns just the type', () => {
    expect(inferTypeFromPack('media/x.md', {
      page_types: [{ name: 'media', path_prefixes: ['/media/'] }],
    })).toBe('media');
  });
});
