/**
 * BrainEngine parity — the page hard delete's slug-keyed stores (src/core/engine-sql/purge-slug-stores.ts), which
 * src/core/persistence/purge-slug-stores.ts ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: deletePurgedSlugStoreRows deletes the purged slugs' rows, in their source only, from the six stores keyed
 *    to a page by slug with no foreign key (take_proposals, open_loops, core_edit_notices, page_aliases, slug_aliases by
 *    canonical slug, slug_rename_history by new slug), reports rows per store and whether the secret store exists;
 *    listPageSecretOccurrences returns only uncommitted occurrences of the named pages; deletePurgedSlugHolds deletes a
 *    slug's write-gate holds (only those last seen up to `deletedAt` when given) and the holds' receipts. Same result on
 *    every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: a purge that leaves a row in one of these stores keeps a copy of a purged page's slug or text (a core
 *    edit notice keeps the page body), and a store scrubbed across sources deletes another source's rows.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), and test/page-purge.test.ts runs one engine at a time.
 *  - Seam: the first case seeds through typed members only. Stores with no typed writer (core edit notices, slug
 *    aliases, rename history, secret store) are seeded through `executeRaw` in the raw_sql case.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other-src';
const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, frontmatter: {} });
const proposal = (engine: BrainEngine, sourceId: string, pageSlug: string) => engine.insertTakeProposal({
  sourceId, pageSlug, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText: `claim on ${pageSlug}`,
  kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model',
});
const loop = (engine: BrainEngine, sourceId: string, pageSlug: string, dedupKey: string) => engine.upsertOpenLoop({
  sourceId, dedupKey, loopType: 'unanswered_inbound', counterpartyEmail: 'a@example.com', pageSlug, summary: 'waiting',
  evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: dedupKey, detector: 'deterministic_thread',
  lastActivityAt: '2026-01-01T00:00:00.000Z', openedAt: '2026-01-01T00:00:00.000Z',
});
const hold = (engine: BrainEngine, sourceId: string, slug: string, fingerprint: string) => engine.upsertWriteGateHold({
  kind: 'fact', source_id: sourceId, slug, fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'],
  reasons: ['ignore previous instructions'], detector_error: false, payload: { fact: 'x', kind: 'preference' }, write_origin: null, request_id: null,
});
const receipt = (engine: BrainEngine, sourceId: string, holdId: number) => engine.upsertWriteGateReceipt({
  target_table: 'write_gate_holds', target_id: String(holdId), source_id: sourceId, content_hash: `h-${holdId}`, tier: 'agent_written',
  detector_version: 1, verdict: 'flag', reason_families: ['prompt_injection'], reasons: ['x'], detector_error: false, request_id: null,
});

describe('engine parity: purge slug stores', () => {
  parityTest(
    'deletePurgedSlugStoreRows and deletePurgedSlugHolds remove the purged slug in its source only',
    { methods: ['deletePurgedSlugStoreRows', 'listPageSecretOccurrences', 'deletePurgedSlugHolds'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      for (const [src, slug] of [[SRC, 'notes/gone'], [SRC, 'notes/kept'], [OTHER, 'notes/gone']] as const) {
        await engine.putPage(slug, note(slug), { sourceId: src });
        await proposal(engine, src, slug);
        await loop(engine, src, slug, `${src}:${slug}`);
        await engine.setPageAliases(slug, src, [`alias ${src} ${slug}`]);
      }
      const gone = await engine.getPage('notes/gone', { sourceId: SRC });
      const kept = await engine.getPage('notes/kept', { sourceId: SRC });
      const holds = {
        gone: await hold(engine, SRC, 'notes/gone', 'fp-1'),
        kept: await hold(engine, SRC, 'notes/kept', 'fp-2'),
        elsewhere: await hold(engine, OTHER, 'notes/gone', 'fp-3'),
      };
      for (const [src, id] of [[SRC, holds.gone], [SRC, holds.kept], [OTHER, holds.elsewhere]] as const) await receipt(engine, src, id);
      const seen = {
        empty: await engine.deletePurgedSlugStoreRows(SRC, []),
        noPages: await engine.listPageSecretOccurrences([]),
        noSecrets: await engine.listPageSecretOccurrences([Number(gone!.id)]),
        removed: await engine.deletePurgedSlugStoreRows(SRC, ['notes/gone']),
        again: await engine.deletePurgedSlugStoreRows(SRC, ['notes/gone'], { ifPresent: true }),
        noHolds: await engine.deletePurgedSlugHolds(SRC, []),
        olderThanHold: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/gone', id: Number(gone!.id), deletedAt: '2000-01-01T00:00:00.000000Z' }]),
        holds: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/gone', id: Number(gone!.id) }]),
        holdsAgain: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/gone', id: Number(gone!.id), deletedAt: null }]),
        keptStores: await engine.deletePurgedSlugStoreRows(OTHER, ['notes/gone']),
        keptHolds: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/kept', id: Number(kept!.id) }]),
      };
      // Whether the database has the secret store is the one answer that differs by engine: the Rust store keeps none.
      const hasSecretStore = [seen.empty, seen.removed, seen.again, seen.keptStores].map(r => r.secretStore);
      expect(hasSecretStore).toEqual(Array(4).fill(backend !== 'rust'));
      const out = { ...seen, empty: seen.empty.removed, removed: seen.removed.removed, again: seen.again.removed, keptStores: seen.keptStores.removed };
      const stores = { take_proposals: 1, open_loops: 1, core_edit_notices: 0, page_aliases: 1, slug_aliases: 0, slug_rename_history: 0 };
      const none = { take_proposals: 0, open_loops: 0, core_edit_notices: 0, page_aliases: 0, slug_aliases: 0, slug_rename_history: 0 };
      expect(out).toEqual({
        empty: {},
        noPages: [],
        noSecrets: [],
        removed: stores,
        again: none,
        noHolds: { write_gate_holds: 0, write_gate_receipts: 0 },
        olderThanHold: { write_gate_holds: 0, write_gate_receipts: 0 },
        holds: { write_gate_holds: 1, write_gate_receipts: 1 },
        holdsAgain: { write_gate_holds: 0, write_gate_receipts: 0 },
        keptStores: stores,
        keptHolds: { write_gate_holds: 1, write_gate_receipts: 1 },
      });
      return out;
    },
  );

  parityTest(
    'deletePurgedSlugHolds drops the holds of several slugs at once, up to each page\'s deletedAt, with the receipts of those holds only',
    { methods: ['deletePurgedSlugHolds'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      for (const slug of ['notes/one', 'notes/two', 'notes/three']) await engine.putPage(slug, note(slug));
      const one = await engine.getPage('notes/one');
      const two = await engine.getPage('notes/two');
      const three = await engine.getPage('notes/three');
      const first = await hold(engine, SRC, 'notes/one', 'fp-a');
      const second = await hold(engine, SRC, 'notes/one', 'fp-b');
      const twoHold = await hold(engine, SRC, 'notes/two', 'fp-c');
      const threeHold = await hold(engine, SRC, 'notes/three', 'fp-d');
      const elsewhere = await hold(engine, OTHER, 'notes/one', 'fp-e');
      for (const [src, id] of [[SRC, first], [SRC, second], [SRC, twoHold], [SRC, threeHold], [OTHER, elsewhere]] as const) await receipt(engine, src, id);
      // A receipt of another table whose target id spells a hold id is not the hold's receipt.
      await engine.upsertWriteGateReceipt({
        target_table: 'facts', target_id: String(first), source_id: SRC, content_hash: 'h-fact', tier: 'agent_written',
        detector_version: 1, verdict: 'flag', reason_families: ['prompt_injection'], reasons: ['x'], detector_error: false, request_id: null,
      });
      const future = '2999-01-01T00:00:00.000000Z';
      const out = {
        // Two pages purged in one call: one bounded by a deletedAt after its holds, one unbounded; the third page's hold stays.
        both: await engine.deletePurgedSlugHolds(SRC, [
          { slug: 'notes/one', id: Number(one!.id), deletedAt: future },
          { slug: 'notes/two', id: Number(two!.id), deletedAt: null },
        ]),
        again: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/one', id: Number(one!.id), deletedAt: future }, { slug: 'notes/two', id: Number(two!.id) }]),
        unknownSlug: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/never', id: 987654 }]),
        other: await engine.deletePurgedSlugHolds(OTHER, [{ slug: 'notes/three', id: Number(three!.id) }]),
        third: await engine.deletePurgedSlugHolds(SRC, [{ slug: 'notes/three', id: Number(three!.id) }]),
        elsewhere: await engine.deletePurgedSlugHolds(OTHER, [{ slug: 'notes/one', id: Number(one!.id) }]),
      };
      expect(out).toEqual({
        both: { write_gate_holds: 3, write_gate_receipts: 3 },
        again: { write_gate_holds: 0, write_gate_receipts: 0 },
        unknownSlug: { write_gate_holds: 0, write_gate_receipts: 0 },
        other: { write_gate_holds: 0, write_gate_receipts: 0 },
        third: { write_gate_holds: 1, write_gate_receipts: 1 },
        elsewhere: { write_gate_holds: 1, write_gate_receipts: 1 },
      });
      return out;
    },
  );

  parityTest(
    'the stores with no typed writer: core edit notices, slug aliases, rename history and page secret occurrences',
    { methods: ['executeRaw', 'deletePurgedSlugStoreRows', 'listPageSecretOccurrences'], requires: 'raw_sql' },
    async (engine) => {
      await engine.putPage('notes/gone', note('Gone'));
      await engine.putPage('notes/kept', note('Kept'));
      const id = Number((await engine.getPage('notes/gone'))!.id);
      const kept = Number((await engine.getPage('notes/kept'))!.id);
      for (const slug of ['notes/gone', 'notes/kept']) {
        await engine.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, base_text, actor) VALUES ($1, $2, 'the page text', 'alice-example')`, [SRC, slug]);
        await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)`, [SRC, `${slug}-old`, slug]);
        await engine.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2, $3)`, [SRC, `${slug}-old`, slug]);
      }
      // A redirect from the purged slug to another page, and a rename that starts at it, stay.
      await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, 'notes/gone', 'notes/kept')`, [SRC]);
      await engine.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, 'notes/gone', 'notes/kept')`, [SRC]);
      await engine.executeRaw(`INSERT INTO secret_store (id, source_id, rule, ciphertext, nonce, tag, key_id, value_mac)
        VALUES ('ss_0123456789ad', $1, 'api_key', 'sealed', 'nonce', 'tag', '0123456789abcdef', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')`, [SRC]);
      for (const [pageId, commit] of [[id, null], [id, 'abc123'], [kept, null]] as const) {
        await engine.executeRaw(`INSERT INTO secret_store_occurrence (entry_id, source_id, page_id, slug, field, origin, commit_sha)
          VALUES ('ss_0123456789ad', $1, $2, 'notes/x', 'compiled_truth', 'repair', $3)`, [SRC, pageId, commit]);
      }
      const occurrences = await engine.listPageSecretOccurrences([id]);
      const out = {
        occurrences: occurrences.map(o => ({ page: o.page_id === id ? 'gone' : o.page_id, idIsText: typeof o.id === 'string' && /^\d+$/.test(o.id) })),
        removed: await engine.deletePurgedSlugStoreRows(SRC, ['notes/gone'], { ifPresent: true }),
        left: await engine.executeRaw<{ t: string; n: number }>(`SELECT 'notices' AS t, count(*)::int AS n FROM core_edit_notices
          UNION ALL SELECT 'aliases', count(*)::int FROM slug_aliases UNION ALL SELECT 'renames', count(*)::int FROM slug_rename_history ORDER BY 1`),
      };
      expect(out).toEqual({
        occurrences: [{ page: 'gone', idIsText: true }],
        removed: { removed: { take_proposals: 0, open_loops: 0, core_edit_notices: 1, page_aliases: 0, slug_aliases: 1, slug_rename_history: 1 }, secretStore: true },
        left: [{ t: 'aliases', n: 2 }, { t: 'notices', n: 1 }, { t: 'renames', n: 2 }],
      });
      return out;
    },
  );
});
