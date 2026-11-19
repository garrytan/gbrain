/**
 * The coordinated write context statement (engine-sql/transaction-settings.ts `SET_WRITE_CONTEXT_SQL`) is static text
 * so the engine-sql dynamic-SQL guard accepts its placeholders. This file pins that text to what it was composed from.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the trust rank comparisons are trustRankSql (trust/tier.ts) over the enclosing tier and over $5, and the
 *    enclosing reads are one COALESCE(current_setting(...)) column per WRITE_CONTEXT_SETTINGS entry, in order.
 *  - Regression: a new or reordered trust tier, or a new write-context setting, left out of the static text makes a
 *    nested coordinated write rank trust wrongly or return the enclosing values in the wrong slots.
 *  - Why existing coverage misses it: the parity cases check the behaviour of today's tiers and settings, not that the
 *    static text follows their source lists.
 *  - Seam: none. Pure string comparison, no engine.
 */
import { describe, expect, test } from 'bun:test';
import { SET_WRITE_CONTEXT_SQL, WRITE_CONTEXT_SETTINGS } from '../src/core/engine-sql/transaction-settings.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';

describe('SET_WRITE_CONTEXT_SQL', () => {
  test('ranks trust with trustRankSql and reads every write-context setting in order', () => {
    const rank = `CASE WHEN ${trustRankSql('prev.s4')}>0 AND ${trustRankSql('prev.s4')}<${trustRankSql('$5::text')} THEN prev.s4 ELSE $5::text END`;
    const enclosing = `FROM (SELECT ${WRITE_CONTEXT_SETTINGS.map((name, index) => `COALESCE(current_setting('${name}',true),'') AS s${index}`).join(',')} OFFSET 0) prev`;
    expect({ rank: SET_WRITE_CONTEXT_SQL.includes(rank), enclosing: SET_WRITE_CONTEXT_SQL.includes(enclosing) })
      .toEqual({ rank: true, enclosing: true });
  });
});
