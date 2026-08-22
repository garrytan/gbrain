/**
 * `resolveCandidateSources` must distinguish a cross-source drop (target
 * resolves via global_basename to a page that exists only in a source other
 * than the origin's or 'default') from a genuinely missing target/from-slug.
 * Both used to return a bare `null`, making a real multi-source graph
 * sparsity problem indistinguishable from a plain dead link (#2589).
 *
 * This is default-deny by design (source isolation — see CLAUDE.md's
 * "Source isolation" cross-cutting invariant): a cross-source drop still
 * does NOT create the edge. Only the *reason* callers can attribute to the
 * drop changes.
 */

import { describe, expect, test } from 'bun:test';
import { resolveCandidateSources } from '../src/commands/extract.ts';
import type { LinkCandidate } from '../src/core/link-extraction.ts';

function candidate(targetSlug: string, fromSlug?: string): LinkCandidate {
  return { fromSlug, targetSlug, linkType: 'mentions', context: 'ctx' };
}

describe('resolveCandidateSources — reason attribution (#2589)', () => {
  test('resolves when target exists in the origin source', () => {
    const allSlugs = new Set(['origin-page', 'target-page']);
    const slugToSources = new Map<string, string[]>([
      ['origin-page', ['source-a']],
      ['target-page', ['source-a']],
    ]);
    const r = resolveCandidateSources(candidate('target-page'), 'origin-page', 'source-a', allSlugs, slugToSources);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fromSourceId).toBe('source-a');
      expect(r.toSourceId).toBe('source-a');
    }
  });

  test('falls back to default when target only exists there', () => {
    const allSlugs = new Set(['origin-page', 'target-page']);
    const slugToSources = new Map<string, string[]>([
      ['origin-page', ['source-a']],
      ['target-page', ['default']],
    ]);
    const r = resolveCandidateSources(candidate('target-page'), 'origin-page', 'source-a', allSlugs, slugToSources);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toSourceId).toBe('default');
  });

  test('reason=missing_target when the target slug is not in allSlugs at all', () => {
    const allSlugs = new Set(['origin-page']);
    const slugToSources = new Map<string, string[]>([['origin-page', ['source-a']]]);
    const r = resolveCandidateSources(candidate('nonexistent-page'), 'origin-page', 'source-a', allSlugs, slugToSources);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_target');
  });

  test('reason=missing_from when the origin slug is not in allSlugs', () => {
    const allSlugs = new Set(['target-page']);
    const slugToSources = new Map<string, string[]>([['target-page', ['source-a']]]);
    const r = resolveCandidateSources(candidate('target-page'), 'origin-page', 'source-a', allSlugs, slugToSources);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_from');
  });

  test('reason=cross_source when the target exists only in an unrelated source (#2589 repro)', () => {
    // 6-source federated brain: origin in comms-imessage, target only in
    // people-vault. Neither the origin source nor 'default' — exactly the
    // silently-dropped case reported on #2589.
    const allSlugs = new Set(['comms-imessage/thread-1', 'people-vault/alice-example']);
    const slugToSources = new Map<string, string[]>([
      ['comms-imessage/thread-1', ['comms-imessage']],
      ['people-vault/alice-example', ['people-vault']],
    ]);
    const r = resolveCandidateSources(
      candidate('people-vault/alice-example'),
      'comms-imessage/thread-1',
      'comms-imessage',
      allSlugs,
      slugToSources,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cross_source');
  });

  test('cross_source is still a drop, not an edge — never returns fromSlug/toSourceId', () => {
    const allSlugs = new Set(['origin-page', 'target-page']);
    const slugToSources = new Map<string, string[]>([
      ['origin-page', ['source-a']],
      ['target-page', ['source-b']],
    ]);
    const r = resolveCandidateSources(candidate('target-page'), 'origin-page', 'source-a', allSlugs, slugToSources);
    expect(r).not.toHaveProperty('toSourceId');
    expect(r).not.toHaveProperty('fromSourceId');
  });
});
