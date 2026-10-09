/**
 * W9F item 4 (Decision 3): a removed take's row number is never handed out
 * again. `takes remove` leaves a reservation row in the fence; every new row
 * number comes from GBRA-54's `nextFreeRowNum` (fence rows, reservations
 * included, plus stored rows), and the reservation survives adds,
 * supersessions, rebuild and import while projecting no take.
 *
 * Protects: `slug#N` citations and `take_proposals.promoted_row_num` never
 * start pointing at an unrelated take after a removal.
 * Fails when: remove drops the row and the next add reuses its number (the
 * pre-fix `max(fence)+1` allocation), or a re-render drops the reservation.
 * Runs on PGLite, and on Postgres too when DATABASE_URL is set (the e2e lane
 * registers it through test/e2e/takes-row-reservation-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { registerLocalWriter, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { parseTakesFence, renderTakesFence, supersedeRow, upsertTakeRow } from '../src/core/takes-fence.ts';
import { reservationCases } from './helpers/takes-reservation-contract.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`takes row reservation through the coordinated takes path (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let cli: LocalRegistration;
    let repo: string;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined));
      cli = await registerLocalWriter(engine, 'cli');
      repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-reserve-'));
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
      await claimWorktree(engine, 'default', repo);
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      rmSync(repo, { recursive: true, force: true });
    });
    for (const [name, run] of Object.entries(reservationCases(() => ({ engine, cli, repo })))) test(name, run, 60_000);
  });
}

describe('takes row reservation in the fence helpers', () => {
  const body = `x\n\n## Takes\n\n${renderTakesFence([
    { rowNum: 1, claim: 'One', kind: 'take', holder: 'world', weight: 0.5, active: true },
    { rowNum: 3, claim: 'Three', kind: 'bet', holder: 'brain', weight: 0.7, active: true, resolvedQuality: 'correct', resolvedAt: '2026-10-01' },
  ], [2, 4])}\n`;

  test('the fence round-trips with reservations in row order, also in the wide resolution shape', () => {
    const parsed = parseTakesFence(body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.reservedRowNums).toEqual([2, 4]);
    expect(parsed.takes.map(t => t.rowNum)).toEqual([1, 3]);
    expect(renderTakesFence(parsed.takes, parsed.reservedRowNums)).toBe(body.slice(body.indexOf('<!---'), body.lastIndexOf('-->') + 3));
    const rows = body.split('\n').filter(l => /^\| \d/.test(l)).map(l => Number(l.split('|')[1]));
    expect(rows).toEqual([1, 2, 3, 4]);
  });

  test('upsertTakeRow and supersedeRow keep every reservation and never reuse a reserved number', () => {
    const added = upsertTakeRow(body, { claim: 'Five', kind: 'take', holder: 'world', weight: 0.5, active: true });
    expect(added.rowNum).toBe(5);
    const superseded = supersedeRow(added.body, 1, { claim: 'One, revised', kind: 'take', holder: 'world', weight: 0.4 });
    expect(superseded.newRowNum).toBe(6);
    const parsed = parseTakesFence(superseded.body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.reservedRowNums).toEqual([2, 4]);
    expect(parsed.takes.map(t => t.rowNum)).toEqual([1, 3, 5, 6]);
  });

  test('a user row that merely says "removed" is still a take', () => {
    const parsed = parseTakesFence(`${renderTakesFence([{ rowNum: 1, claim: '(removed)', kind: 'take', holder: 'world', weight: 0.5, source: 'removed', active: true }])}`);
    expect(parsed.reservedRowNums).toEqual([]);
    expect(parsed.takes.map(t => t.claim)).toEqual(['(removed)']);
  });
});
