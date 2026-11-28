/**
 * The typed 7-day extract rollup read (`readExtractRollup7d`, engine-sql/doctor-derived.ts) must count days on the UTC
 * calendar, as the doctor's own rollup query does (commands/doctor/checks/extraction-sync.ts, #10356): a session whose
 * time zone has moved to the next or previous day must not shift a halt's age or the seven-day window.
 *
 * Protects: a halt written on today's UTC day reads age 0 in both statement variants (with and without
 * expected_limit_count) and a row 8 UTC days old stays outside the window, while the transaction's TimeZone differs
 * from UTC by a calendar day.
 * Fails when either variant counts days with CURRENT_DATE (the session calendar).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readExtractRollup7d } from '../src/core/engine-sql/doctor-derived.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

for (const withExpected of [true, false]) {
  test(`readExtractRollup7d (withExpected=${withExpected}) counts days on the UTC calendar`, async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
    await engine.transaction(async tx => {
      const [clock] = await tx.executeRaw<{ utc_day: string; zone: string }>(
        `SELECT (now() AT TIME ZONE 'UTC')::date::text AS utc_day,
                CASE WHEN (now() AT TIME ZONE 'Pacific/Kiritimati')::date <> (now() AT TIME ZONE 'UTC')::date
                     THEN 'Pacific/Kiritimati' ELSE 'Pacific/Pago_Pago' END AS zone`, []);
      await tx.executeRaw("SELECT set_config('TimeZone', $1, true)", [clock!.zone]);
      const [session] = await tx.executeRaw<{ day: string }>('SELECT CURRENT_DATE::text AS day', []);
      expect(session!.day).not.toBe(clock!.utc_day);
      await tx.executeRaw(
        `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
         VALUES ('atoms', 'default', $1::date, 1.00, 0, 0, 9, 1, 0, NOW()),
                ('old', 'default', $1::date - 8, 1.00, 0, 0, 9, 1, 0, NOW())`, [clock!.utc_day]);
      const rows = await readExtractRollup7d(tx.executeRaw.bind(tx), withExpected);
      expect(rows.map(r => r.kind)).toEqual(['atoms']);
      expect(Number(rows[0]!.last_halt_age_days)).toBe(0);
    });
  });
}
