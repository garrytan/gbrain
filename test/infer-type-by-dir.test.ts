/**
 * Tests for inferTypeByDir — directory-based link-type inference for the
 * fs-source path.
 *
 * Fixes issue #3466: the people→companies adjacency no longer asserts
 * `works_at` without evidence. Default is now `mentions` when no
 * frontmatter signals an employment relationship.
 */

import { describe, test, expect } from 'bun:test';
import { inferTypeByDir } from '../src/commands/extract.ts';

describe('inferTypeByDir', () => {
  describe('people → companies', () => {
    test('defaults to mentions when no frontmatter', () => {
      // issue #3466 regression: previously returned 'works_at' without evidence
      expect(inferTypeByDir('people/alice', 'companies/acme')).toBe('mentions');
    });

    test('defaults to mentions when frontmatter is empty', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {})).toBe('mentions');
    });

    test('defaults to mentions when frontmatter has unrelated fields', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        bio: 'Alice is a hacker',
        location: 'NYC',
      })).toBe('mentions');
    });

    test('returns founded when frontmatter has founded array', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        founded: ['acme'],
      })).toBe('founded');
    });

    test('returns works_at when frontmatter has role', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        role: 'Engineer',
      })).toBe('works_at');
    });

    test('returns works_at when frontmatter has title', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        title: 'CTO',
      })).toBe('works_at');
    });

    test('returns works_at when frontmatter has position', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        position: 'Senior Engineer',
      })).toBe('works_at');
    });

    test('returns works_at when frontmatter has company', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        company: 'Acme Corp',
      })).toBe('works_at');
    });

    test('returns works_at when frontmatter has employer', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        employer: 'Acme Corp',
      })).toBe('works_at');
    });

    test('returns works_at when frontmatter has employee flag', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        employee: true,
      })).toBe('works_at');
    });

    test('founded takes precedence over employment signals', () => {
      expect(inferTypeByDir('people/alice', 'companies/acme', {
        founded: ['acme'],
        role: 'CTO',
      })).toBe('founded');
    });
  });

  describe('other adjacencies', () => {
    test('people → deals returns involved_in', () => {
      expect(inferTypeByDir('people/alice', 'deals/series-a')).toBe('involved_in');
    });

    test('deals → companies returns deal_for', () => {
      expect(inferTypeByDir('deals/series-a', 'companies/acme')).toBe('deal_for');
    });

    test('meetings → people returns attended', () => {
      expect(inferTypeByDir('meetings/standup', 'people/alice')).toBe('attended');
    });

    test('unrecognized adjacency returns mentions', () => {
      expect(inferTypeByDir('concepts/rag', 'concepts/embeddings')).toBe('mentions');
    });

    test('people → companies with subdir paths still works', () => {
      expect(inferTypeByDir('people/team/alice', 'companies/tech/acme')).toBe('mentions');
    });
  });
});
