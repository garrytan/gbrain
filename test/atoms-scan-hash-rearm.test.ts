/**
 * extract_atoms re-arms every page it has already mined.
 *
 * `extract-atoms.ts` stamps `atoms_scan_hash` INTO the page's frontmatter
 * (the completion marker), and eligibility is
 *
 *   COALESCE(frontmatter->>'atoms_scan_hash','') <> substring(content_hash from 1 for 16)
 *
 * `contentHash()` hashes frontmatter minus HASH_EPHEMERAL_FRONTMATTER_KEYS.
 * `atoms_scan_hash` was NOT in that list, so writing the marker changed the
 * very hash the marker is compared against: the page went eligible again on
 * the next import, and stayed eligible forever.
 *
 * Same bug class as `captured_at`/`ingested_at` (v0.39.3.0 CV8) and the
 * content-sanity gate markers (v0.42 #1699), both fixed by adding the key
 * here. The #1699 comment describes the symptom as re-chunking and
 * re-embedding "forever ... real, unbounded embedding spend"; this consumer
 * instead re-runs an LLM extraction, so the cost lands as duplicate atoms.
 *
 * Measured on a live brain before the fix: all 24 pages that had ever been
 * scanned were eligible again, and three drains in one day re-mined the SAME
 * 23 sources, producing ~9 paraphrased atoms per source (205 of that day's
 * 208 atoms sat on re-extracted sources). Paraphrases defeat
 * `content_hash_duplicates`, so nothing surfaced it.
 *
 * The invariant asserted here is deliberately phrased without reference to
 * the marker: a page mined once must not become eligible again unless its
 * BODY changed. That also covers brains where the marker is never persisted,
 * where excluding the key alone would be a no-op.
 */

import { describe, test, expect } from 'bun:test';
import { contentHash, HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../src/core/utils.ts';

type Page = Parameters<typeof contentHash>[0];

const basePage = (): Page => ({
  title: 'Wedge product and first beachhead',
  type: 'note',
  compiled_truth: 'Pick the narrowest problem you can own completely.',
  timeline: '',
  frontmatter: { status: 'active' },
  tags: ['strategy'],
} as Page);

/** The eligibility predicate, verbatim from extract-atoms.ts. */
const isEligible = (page: Page): boolean => {
  const marker = (page.frontmatter as Record<string, unknown>)?.atoms_scan_hash ?? '';
  return String(marker) !== contentHash(page).slice(0, 16);
};

/** What the extract_atoms phase does on completion. */
const stampScanned = (page: Page): Page => ({
  ...page,
  frontmatter: {
    ...(page.frontmatter as Record<string, unknown>),
    atoms_scan_hash: contentHash(page).slice(0, 16),
  },
} as Page);

describe('extract_atoms completion marker', () => {
  test('atoms_scan_hash is excluded from contentHash', () => {
    expect(HASH_EPHEMERAL_FRONTMATTER_KEYS).toContain('atoms_scan_hash');
  });

  test('stamping the marker does not change the hash', () => {
    const page = basePage();
    expect(contentHash(stampScanned(page))).toBe(contentHash(page));
  });

  test('two different marker values hash identically', () => {
    const a = { ...basePage(), frontmatter: { status: 'active', atoms_scan_hash: 'a'.repeat(16) } } as Page;
    const b = { ...basePage(), frontmatter: { status: 'active', atoms_scan_hash: 'b'.repeat(16) } } as Page;
    expect(contentHash(a)).toBe(contentHash(b));
  });

  // The regression itself: pre-fix this page is eligible again immediately,
  // and stays eligible through every subsequent export -> sync cycle.
  test('a page mined once is NOT eligible again', () => {
    let page = basePage();
    expect(isEligible(page)).toBe(true); // never scanned

    page = stampScanned(page);
    expect(isEligible(page)).toBe(false);

    // Re-import the page as written (the export -> sync round trip). Pre-fix
    // the recomputed hash differed from the stamped marker and this flipped
    // back to true, which is what re-mined the same sources every cycle.
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(isEligible(page)).toBe(false);
    }
  });

  test('a page IS eligible again when its body actually changes', () => {
    const scanned = stampScanned(basePage());
    expect(isEligible(scanned)).toBe(false);

    const edited = { ...scanned, compiled_truth: 'Rewritten body: start with a narrow beachhead.' } as Page;
    expect(isEligible(edited)).toBe(true);
  });
});
