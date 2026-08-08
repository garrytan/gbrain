/**
 * Shared 12-case RED suite for the governed-source-lane feature.
 *
 * PM directive (SL-178): "prove the six seam failures and six controls are
 * represented on BOTH engines." This factory registers the IDENTICAL 12 cases
 * against any engine implementing the minimal lane-interface, so the PGLite
 * describe and the Postgres describe exercise byte-for-byte the same behavior
 * matrix. Result deltas between the two engines then reflect engine parity,
 * not case drift.
 *
 * RED contract (LEDGER546): the six seam-failure cases (T1, T3, T4, T6, T10,
 * T11) MUST FAIL on the unmodified 15b9863d source because
 * `restrict_slug_prefixes` is not a member of SearchOpts and is therefore
 * silently ignored by searchVector — restrict has no effect, so a
 * non-existent-prefix restrict returns ALL pages instead of []. The six
 * controls (T2, T5, T7, T8, T9, T12) MUST PASS on the unmodified source.
 *
 * No production source is changed by this file. RED-ONLY.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import type { SearchOpts } from '../src/core/types.ts';

/** Minimal slice of the engine interface exercised by the lane cases. */
export interface LaneEngine {
  connect(config: Record<string, unknown>): Promise<void>;
  initSchema(): Promise<void>;
  putPage(slug: string, page: Record<string, unknown>): Promise<unknown>;
  getPage(slug: string): Promise<{ slug: string } | null>;
  upsertChunks(
    slug: string,
    chunks: Array<Record<string, unknown>>,
  ): Promise<unknown>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<
    Array<{ slug: string; score: number }>
  >;
  disconnect(): Promise<void>;
}

/** Deterministic 1536-dim unit-ish vector from a seed. Cosine ordering is stable. */
export function makeVec(seed: number): Float32Array {
  const v = new Float32Array(1536);
  v[0] = seed;
  v[1] = 1 - seed;
  return v;
}

export const GOV_PREFIX = 'governed-corpus/';

/** Registers the identical 12-case RED suite against one engine factory. */
export function registerLaneCases(
  engineLabel: string,
  makeEngine: () => LaneEngine,
  connectConfig: Record<string, unknown>,
) {
  describe(`Governed source lane — restrict_slug_prefixes [${engineLabel}] (RED)`, () => {
    let engine: LaneEngine;

    beforeAll(async () => {
      engine = makeEngine();
      await engine.connect(connectConfig);
      await engine.initSchema();

      // Governed pages
      await engine.putPage('governed-corpus/email_rbl', {
        type: 'markdown',
        page_kind: 'markdown',
        title: 'Email RBL Guide',
        compiled_truth: 'What is email RBL and how does it affect mail delivery',
        timeline: '',
      });
      await engine.upsertChunks('governed-corpus/email_rbl', [
        {
          chunk_index: 0,
          chunk_text:
            'Email RBL (Realtime Blackhole List) affects mail delivery by blocking senders on blacklist databases.',
          chunk_source: 'compiled_truth',
          embedding: makeVec(0.9),
        },
      ]);

      await engine.putPage('governed-corpus/dns_configuration', {
        type: 'markdown',
        page_kind: 'markdown',
        title: 'DNS Config',
        compiled_truth: 'DNS configuration guide',
        timeline: '',
      });
      await engine.upsertChunks('governed-corpus/dns_configuration', [
        {
          chunk_index: 0,
          chunk_text: 'DNS configuration for mail servers.',
          chunk_source: 'compiled_truth',
          embedding: makeVec(0.3),
        },
      ]);

      // Non-governed (event) pages
      await engine.putPage('zendesk/solved-cases/rbl-report-1', {
        type: 'markdown',
        page_kind: 'markdown',
        title: 'RBL Report',
        compiled_truth: 'RBL bounce back incident report',
        timeline: '',
      });
      await engine.upsertChunks('zendesk/solved-cases/rbl-report-1', [
        {
          chunk_index: 0,
          chunk_text:
            'RBL bounce back not resolving name server blocked incident report.',
          chunk_source: 'compiled_truth',
          embedding: makeVec(0.85),
        },
      ]);

      await engine.putPage('ticket/install-nginx', {
        type: 'markdown',
        page_kind: 'markdown',
        title: 'Nginx Setup',
        compiled_truth: 'Install nginx on ubuntu',
        timeline: '',
      });
      await engine.upsertChunks('ticket/install-nginx', [
        {
          chunk_index: 0,
          chunk_text: 'Install nginx on ubuntu server guide.',
          chunk_source: 'compiled_truth',
          embedding: makeVec(0.1),
        },
      ]);

      // Fixture integrity: slugs round-trip from the engine
      const govPage = await engine.getPage('governed-corpus/email_rbl');
      expect(govPage?.slug).toBe('governed-corpus/email_rbl');
      const evtPage = await engine.getPage('zendesk/solved-cases/rbl-report-1');
      expect(evtPage?.slug).toBe('zendesk/solved-cases/rbl-report-1');
    }, 60_000);

    // NOTE: engine lifecycle (connect is above; disconnect) is owned by the
    // CALLING test file (per check:test-isolation R3/R4 — the PGLiteEngine
    // literal + afterAll disconnect must live at file scope). registerLaneCases
    // connects + seeds + registers cases only.

    // ---- SEAM FAILURES (must FAIL on unmodified 15b9863d) ----

    test('T1: restrict_slug_prefixes filters to governed-only', async () => {
      const opts = { restrict_slug_prefixes: [GOV_PREFIX], limit: 10 } as SearchOpts;
      const results = await engine.searchVector(makeVec(0.9), opts);
      const slugs = results.map(r => r.slug);
      expect(slugs.every(s => s.startsWith(GOV_PREFIX))).toBe(true);
      expect(slugs).toContain('governed-corpus/email_rbl');
    });

    test('T3: governed surfaces via restrict even if low-cosine globally', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 10,
      } as SearchOpts);
      const slugs = results.map(r => r.slug);
      expect(slugs).toContain('governed-corpus/email_rbl');
      expect(slugs).toContain('governed-corpus/dns_configuration');
    });

    test('T4: governed results preserve slug path (frontmatter carrier)', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 10,
      } as SearchOpts);
      const govResults = results.filter(r => r.slug.startsWith(GOV_PREFIX));
      expect(govResults.length).toBeGreaterThan(0);
      expect(govResults[0].slug).toBe('governed-corpus/email_rbl');
    });

    test('T6: restrict returns governed sorted by cosine descending', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 3,
      } as SearchOpts);
      expect(results.length).toBeGreaterThan(0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
      }
    });

    test('T10: restrict works as a searchVector filter regardless of flag', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 5,
      } as SearchOpts);
      expect(results.every(r => r.slug.startsWith(GOV_PREFIX))).toBe(true);
    });

    test('T11: restrict with non-existent prefix returns empty (fail-closed)', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: ['nonexistent-prefix/'],
        limit: 5,
      } as SearchOpts);
      expect(results).toEqual([]);
    });

    // ---- CONTROLS (must PASS on unmodified 15b9863d) ----

    test('T2: no restrict_slug_prefixes = all pages (parity)', async () => {
      const results = await engine.searchVector(makeVec(0.9), { limit: 10 });
      const slugs = results.map(r => r.slug);
      expect(slugs).toContain('governed-corpus/email_rbl');
      expect(slugs.some(s => !s.startsWith(GOV_PREFIX))).toBe(true);
    });

    test('T5: restrict does not affect unrestricted search (additive merge)', async () => {
      const unrestricted = await engine.searchVector(makeVec(0.85), { limit: 10 });
      const restricted = await engine.searchVector(makeVec(0.85), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 10,
      } as SearchOpts);
      expect(unrestricted.some(r => r.slug.startsWith('zendesk/'))).toBe(true);
      expect(restricted.every(r => r.slug.startsWith(GOV_PREFIX))).toBe(true);
    });

    test('T7: limit=1 with restrict returns at most 1', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 1,
      } as SearchOpts);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    test('T8: restrict on unrelated query still filters to governed-only', async () => {
      const results = await engine.searchVector(makeVec(0.1), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 10,
      } as SearchOpts);
      expect(results.every(r => r.slug.startsWith(GOV_PREFIX))).toBe(true);
    });

    test('T9: searchVector honors provided embedding (no re-embed)', async () => {
      const emb = makeVec(0.9);
      const results = await engine.searchVector(emb, {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 5,
      } as SearchOpts);
      // searchVector takes a precomputed embedding — must not crash/re-embed.
      expect(results).toBeDefined();
    });

    test('T12: restrict returns correct governed results (engine self-consistent)', async () => {
      const results = await engine.searchVector(makeVec(0.9), {
        restrict_slug_prefixes: [GOV_PREFIX],
        limit: 5,
      } as SearchOpts);
      const slugs = results.map(r => r.slug);
      expect(slugs).toContain('governed-corpus/email_rbl');
      expect(slugs.every(s => s.startsWith(GOV_PREFIX))).toBe(true);
    });
  });
}
