/**
 * extract_atoms completion-marker re-arm (#4735).
 *
 * extract-atoms.ts stamps `atoms_scan_hash` INTO the page's frontmatter
 * (the completion marker) and eligibility is
 *
 *   COALESCE(frontmatter->>'atoms_scan_hash','') <> substring(content_hash from 1 for 16)
 *
 * `contentHash()` hashes frontmatter minus HASH_EPHEMERAL_FRONTMATTER_KEYS.
 * Before this fix `atoms_scan_hash` was NOT in that list, so writing the
 * marker changed the very hash the marker is compared against: the page went
 * eligible again on the next import and stayed eligible forever. Every
 * export -> sync cycle re-armed every scanned page into a fresh LLM
 * extraction, minting paraphrased near-duplicate atoms that
 * content_hash_duplicates cannot see (the wording differs each run).
 *
 * Same bug class as captured_at/ingested_at (CV8) and the content-sanity
 * gate markers (#1699). The invariant asserted here is deliberately phrased
 * without reference to the mechanism: a page mined once must not become
 * eligible again unless its BODY changed.
 *
 * Companion (#1699 part 2): the marker is phase-owned, so an UNTRUSTED
 * remote writer must not be able to plant it (that would silently suppress
 * atom mining for the page). import-file.ts strips it on `remote === true`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  contentHash,
  HASH_EPHEMERAL_FRONTMATTER_KEYS,
  ATOMS_SCAN_HASH_KEY,
} from '../src/core/utils.ts';
import { QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../src/core/quarantine.ts';
import { EMBED_SKIP_KEY } from '../src/core/embed-skip.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

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
  const marker = (page.frontmatter as Record<string, unknown>)?.[ATOMS_SCAN_HASH_KEY] ?? '';
  return String(marker) !== contentHash(page).slice(0, 16);
};

/** What the extract_atoms phase does on completion. */
const stampScanned = (page: Page): Page => ({
  ...page,
  frontmatter: {
    ...(page.frontmatter as Record<string, unknown>),
    [ATOMS_SCAN_HASH_KEY]: contentHash(page).slice(0, 16),
  },
} as Page);

describe('extract_atoms completion marker (#4735)', () => {
  test('atoms_scan_hash is excluded from contentHash', () => {
    expect(HASH_EPHEMERAL_FRONTMATTER_KEYS).toContain(ATOMS_SCAN_HASH_KEY);
  });

  test('no other ephemeral key regressed', () => {
    // Additive change only: every pre-existing ephemeral key stays excluded.
    for (const key of ['captured_at', 'ingested_at', QUARANTINE_KEY, CONTENT_FLAG_KEY, EMBED_SKIP_KEY]) {
      expect(HASH_EPHEMERAL_FRONTMATTER_KEYS).toContain(key);
    }
  });

  test('stamping the marker does not change the hash', () => {
    const page = basePage();
    expect(contentHash(stampScanned(page))).toBe(contentHash(page));
  });

  // The regression itself: pre-fix this page went eligible again immediately
  // after stamping, and stayed eligible through every export -> sync cycle.
  test('a page mined once is NOT eligible again', () => {
    let page = basePage();
    expect(isEligible(page)).toBe(true); // never scanned

    page = stampScanned(page);
    // Re-check across repeated import cycles (the export -> sync round trip
    // recomputes contentHash from the page as written).
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

describe('trust boundary: untrusted writers cannot plant atoms_scan_hash (#1699 part 2)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  const planted = `---
title: Looks Clean
type: note
atoms_scan_hash: deadbeefdeadbeef
---

A perfectly normal note that has never actually been mined for atoms.`;

  test('remote:true strips a planted marker (mining cannot be suppressed)', async () => {
    await importFromContent(engine, 'notes/planted-scan-hash', planted, { noEmbed: true, remote: true });
    const page = await engine.getPage('notes/planted-scan-hash'); // gbrain-allow-unscoped-getpage
    const fm = page!.frontmatter as Record<string, unknown>;
    expect(fm[ATOMS_SCAN_HASH_KEY]).toBeUndefined();
  });

  test('trusted caller (remote unset) preserves the marker (export -> sync round trip)', async () => {
    await importFromContent(engine, 'notes/trusted-scan-hash', planted, { noEmbed: true });
    const page = await engine.getPage('notes/trusted-scan-hash'); // gbrain-allow-unscoped-getpage
    const fm = page!.frontmatter as Record<string, unknown>;
    expect(fm[ATOMS_SCAN_HASH_KEY]).toBe('deadbeefdeadbeef');
  });
});
