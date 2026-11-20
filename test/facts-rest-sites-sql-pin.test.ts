/**
 * The four quote and slot-history read members (engine-sql/facts-recall.ts: listFactsFromQuotedPages,
 * listFactIdsAtTrustFloor, readPageTypesByIds, listReadablePageSlugs) send Postgres the statement text and binds their
 * callers sent through `executeRaw` before the move, in the same order. A drift here changes a query plan or a result on
 * Postgres alone, which PGLite parity cannot see.
 *
 * This file holds only the quote-read pins ported from 11323729c8 (rust-engine/memory-records-rest). The full file on that
 * branch also pins the facts write-path and recall pool members, which this branch does not have.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member's recorded statements (text and params, in order) equal what its caller sent at c33606182c
 *    (search/transcript-quote.ts, search/slot-history.ts). Static texts are copied from those callers. The read-policy
 *    text of listReadablePageSlugs is the text the caller rendered, captured by running it against a recording engine;
 *    one over 3000 characters is pinned by its length and SHA-256. On this branch, factsFromQuotedPages and
 *    slot-history.ts entityKeys sent the same text before the move; pageTypesById and ownerTierFacts read through
 *    listPageRefsByIds and listFactIdsAtTrustRank, so readPageTypesByIds and listFactIdsAtTrustFloor have no caller here.
 *  - Regression: a member that reorders a clause, renumbers a placeholder, binds a value differently or drops a cast
 *    changes what Postgres answers while the parity cases may still pass on a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts)
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and params; no database runs.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

type Responder = Parameters<typeof makeFakeSql>[0];

function recordingEngine(responder?: Responder) {
  const fake = makeFakeSql(responder);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

interface Stmt {
  /** The exact statement text, or its length and SHA-256 when it is too long to copy. */
  text?: string;
  digest?: { length: number; sha256: string };
  /** The params the statement was bound with (undefined: none). */
  params?: unknown[];
}
interface Pin {
  /** The caller site(s) the statement came from. */
  from: string;
  member: string;
  label?: string;
  run: (e: PostgresEngine) => Promise<unknown>;
  responder?: Responder;
  /** Every statement the member sends, in order. */
  statements: Stmt[];
}

const scopeB = { sourceIds: ['s1', 's2'], worldOnly: true, excludePrivate: true, minTrust: 'verified_user', suppressFlagged: true } as never;

const PINS: Pin[] = [
  {
    from: 'src/core/search/transcript-quote.ts:135 factsFromQuotedPages (at c33606182c)',
    member: 'listFactsFromQuotedPages',
    run: e => e.listFactsFromQuotedPages([3, 1, 3], ['chat', 'transcript'], [['sync:import', 'sync:'], ['mcp:put_page', 'put_page:']]),
    statements: [{ text: `SELECT f.id FROM facts f WHERE f.id = ANY($1::bigint[]) AND (
       EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages p ON p.id = (CASE WHEN d.input_id ~ '^[0-9]{1,18}$' THEN d.input_id::bigint END)
         WHERE d.derived_table = 'facts' AND d.derived_id = f.id::text AND d.input_table = 'pages' AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.type = ANY($2::text[]) AND p.slug = (CASE
         WHEN f.source = $3::text AND left(f.source_session, length($4::text)) = $4::text THEN substr(f.source_session, length($4::text) + 1)
         WHEN f.source = $5::text AND left(f.source_session, length($6::text)) = $6::text THEN substr(f.source_session, length($6::text) + 1) END)))`, params: [[3, 1], ['chat', 'transcript'], 'sync:import', 'sync:', 'mcp:put_page', 'put_page:'] }],
  },
  {
    from: 'src/core/search/transcript-quote.ts:510 ownerTierFacts (at c33606182c)',
    member: 'listFactIdsAtTrustFloor',
    run: e => e.listFactIdsAtTrustFloor([3, 1, 3], 'agent_written'),
    statements: [{ text: `SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND (CASE trust_tier WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) >= $2`, params: [[3, 1], 3] }],
  },
  {
    from: 'src/core/search/transcript-quote.ts:111 pageTypesById (at c33606182c)',
    member: 'readPageTypesByIds',
    run: e => e.readPageTypesByIds([7, 2, 7]),
    statements: [{ text: 'SELECT id, type FROM pages WHERE id = ANY($1::bigint[])', params: [[7, 2]] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'local scope',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], { sourceId: 's1', worldOnly: false, excludePrivate: false } as never, 2),
    statements: [{ text: `SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine') AND EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = p.source_id AND NOT read_source.archived) LIMIT 2`, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
  {
    from: 'src/core/search/slot-history.ts:88 entityKeys (at c33606182c)',
    member: 'listReadablePageSlugs',
    label: 'remote scope, trust floor, two sources (the source filter is not applied)',
    run: e => e.listReadablePageSlugs('s1', ['people/carol', 'companies/carol'], scopeB, 2),
    statements: [{ digest: { length: 7741, sha256: '480b13fa66dd499685d723c5b26d6aecc8408de3ea76282ef1f801b84f435046' }, params: ['s1', ['people/carol', 'companies/carol']] }],
  },
];

describe('the quote and slot-history read members keep their callers\' Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.member}${pin.label ? ` (${pin.label})` : ''} <- ${pin.from}`, async () => {
      const { engine, statements } = recordingEngine(pin.responder);
      await pin.run(engine);
      const sent = statements();
      expect(sent.length).toBe(pin.statements.length);
      pin.statements.forEach((want, i) => {
        if (want.digest) {
          expect(sent[i]!.text.length).toBe(want.digest.length);
          expect(createHash('sha256').update(sent[i]!.text).digest('hex')).toBe(want.digest.sha256);
        } else expect(sent[i]!.text).toBe(want.text!);
        if (want.params !== undefined) expect(sent[i]!.params).toEqual(want.params);
        else expect(sent[i]!.params.length).toBe(0);
      });
    });
  }
});
