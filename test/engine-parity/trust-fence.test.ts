/**
 * BrainEngine parity — the fence guard's read of a page's fact rows (engine-sql/trust-fence.ts `listFenceFactRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listFenceFactRows returns the same live fence rows of a page, in row-number order, that the writer's trust
 *    tier, a held widening proposal or an opened row keeps from being superseded, on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers this differently (a stricter or looser rank test, an extractor row nobody claims
 *    guarded, a struck row guarded) lets a lower-trust page publish expire a row it may not, or blocks an ordinary
 *    re-publish; the Rust engine has no SQL, so the read has to exist as a typed member.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside trust/fence-guard.ts, which the
 *    parity cases cannot call (D18).
 *  - Seam: none in the parity case. Typed members only (no executeRaw: D18). The writer's tier and the opened ids are
 *    transaction-local settings (`gbrain.write_trust_tier`, `gbrain.write_open_facts`), and a typed member cannot set
 *    them on the Rust arm, so the parity case runs in the default context (no writer tier, nothing opened): there every
 *    stored row is `unknown` and none is above the writer, so the answer is empty on both arms. The arms that decide a row
 *    (above the writer, opened, held) are pinned by the PGLite-only case below and, on the Rust store, by
 *    rust/crates/gbrain-store/tests/fence_reads.rs.
 */
import { describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/fence-example';
const at = (s: string) => new Date(s);

const fenceRow = (n: number, fact: string, extra: Record<string, unknown> = {}) => ({
  row_num: n, source_markdown_slug: SLUG, fact, entity_slug: SLUG, source: 'fence', kind: 'fact' as const, visibility: 'world' as const,
  valid_from: at(`2026-02-0${n}T01:02:03.250Z`), ...extra,
});

const incomingOf = (rows: Array<{ row_num: number; fact: string; visibility: string }>) => JSON.stringify(rows);

describe('engine parity: the fence guard read of a page\'s fact rows', () => {
  parityTest('listFenceFactRows answers the guard\'s question in the default context: no writer tier, nothing opened', {
    methods: ['insertFacts', 'listFenceFactRows'],
  }, async (engine) => {
    const rows = [
      fenceRow(3, 'Gamma'),
      fenceRow(2, 'Beta'),
      fenceRow(1, 'Alpha', { visibility: 'private' }),
      fenceRow(4, 'Delta extracted', { source: 'cli:extract-conversation-facts:session-1' }),
      { ...fenceRow(1, 'Alpha elsewhere'), source_markdown_slug: 'people/other-fence' },
    ];
    const { ids } = await engine.insertFacts(rows as never, { source_id: SRC });
    expect(ids).toHaveLength(rows.length);
    const incoming = incomingOf([
      { row_num: 1, fact: 'Alpha', visibility: 'world' },
      { row_num: 2, fact: 'Beta changed', visibility: 'world' },
      { row_num: 4, fact: 'Delta claimed', visibility: 'world' },
    ]);
    const answer = await engine.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming });
    const empty = await engine.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming: '[]' });
    const otherSource = await engine.listFenceFactRows({ sourceId: 'parity-missing', slug: SLUG, incoming });
    const otherSlug = await engine.listFenceFactRows({ sourceId: SRC, slug: 'people/nobody', incoming });
    // Every stored row is `unknown` and the writer is undeclared (`unknown`): nothing is above the writer, held or opened.
    expect({ answer, empty, otherSource, otherSlug }).toEqual({ answer: [], empty: [], otherSource: [], otherSlug: [] });
    return { answer, empty, otherSource, otherSlug };
  });
});

// The writer's tier and the opened ids are transaction settings, which only the TypeScript engines can set today.
describe('listFenceFactRows with a declared writer tier (PGLite)', () => {
  test('a row above the writer, or opened, is listed in row order with its stored tier; a row the fence states as it is, is not', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      // The trust trigger stamps a row with its writer's declared tier, so the tiers are set by writing under them.
      const write = (tier: string, rows: Array<ReturnType<typeof fenceRow>>) => engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier'], [tier]);
        return (await tx.insertFacts(rows as never, { source_id: SRC })).ids as number[];
      });
      const [gamma, alpha] = await write('operator_curated', [fenceRow(3, 'Gamma'), fenceRow(1, 'Alpha')]);
      const [beta] = await write('external_untrusted', [fenceRow(2, 'Beta')]);
      const [, epsilon, zeta] = await write('', [
        fenceRow(4, 'Delta extracted', { source: 'cli:extract-conversation-facts:session-1' }),
        fenceRow(5, 'Epsilon', { visibility: 'private' }),
        fenceRow(6, 'Zeta', { visibility: 'private' }),
      ]);
      expect([gamma, alpha, beta, epsilon, zeta].every((id) => typeof id === 'number')).toBe(true);
      // A widening proposal that stored Epsilon narrower and is still pending holds it while the fence asks for world.
      await engine.executeRaw(
        `INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, before_state, proposer)
         VALUES ('confirm', $1, 'facts', $2, 'facts', $2, '{"visibility":"world"}'::jsonb, 'test')`, [SRC, epsilon]);
      const incoming = incomingOf([
        { row_num: 1, fact: 'Alpha', visibility: 'world' },
        { row_num: 2, fact: 'Beta changed', visibility: 'world' },
        { row_num: 3, fact: 'Gamma changed', visibility: 'world' },
        { row_num: 5, fact: 'Epsilon', visibility: 'world' },
        { row_num: 6, fact: 'Zeta', visibility: 'world' },
      ]);
      const read = (tier: string, opened: string) => engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_open_facts'], [tier, opened]);
        return (await tx.listFenceFactRows({ sourceId: SRC, slug: SLUG, incoming })).map((r) => ({
          row_num: Number(r.row_num), fact: r.fact, trust_tier: r.trust_tier, above: r.above, opened: r.opened,
        }));
      });
      const row = (row_num: number, fact: string, trust_tier: string, above: boolean, opened = false) => ({ row_num, fact, trust_tier, above, opened });
      // Rank, most trusted first: operator_curated, unknown, external_untrusted. An external writer is below Gamma (row 3) and
      // below the unknown Epsilon and Zeta, and level with Beta; Alpha is stated as it is, and the extractor row is nobody's claim.
      expect(await read('external_untrusted', '')).toEqual([
        row(3, 'Gamma', 'operator_curated', true), row(5, 'Epsilon', 'unknown', true), row(6, 'Zeta', 'unknown', true),
      ]);
      // An operator-curated writer is above nothing: only Epsilon (held by the pending proposal) and Zeta (opened) are listed.
      expect(await read('operator_curated', `${zeta}`)).toEqual([
        row(5, 'Epsilon', 'unknown', false), row(6, 'Zeta', 'unknown', false, true),
      ]);
      // An undeclared writer is `unknown`: it is below Gamma, and the proposal still holds Epsilon.
      expect(await read('', '')).toEqual([row(3, 'Gamma', 'operator_curated', true), row(5, 'Epsilon', 'unknown', false)]);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);
});
