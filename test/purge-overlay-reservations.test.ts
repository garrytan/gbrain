/**
 * The purge overlay re-renders a takes fence without the purged rows. It must
 * keep the fence's existing reservation rows (W9F item 4) and reserve the
 * purged rows' numbers, so no later take reuses a purged number.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dropPurgedFenceRows } from '../src/core/facts/purge-overlay.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, renderTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a purged take row leaves a reservation and existing reservations survive', async () => {
  const take = (rowNum: number, claim: string) => ({ ...parseTakesFence(`${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| ${rowNum} | ${claim} | take | alice-example | 0.5 |  | chat |\n${TAKES_FENCE_END}`).takes[0]! });
  const fence = renderTakesFence([take(1, 'Keep this claim'), take(3, 'Purge this claim'), take(4, 'Keep this one too')], [2]);
  const body = `# Page\n\n${fence}\n`;
  expect(parseTakesFence(body).reservedRowNums).toEqual([2]);
  await engine.executeRaw(`INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ('default', '*', gbrain_fact_fingerprint($1))`, ['Purge this claim']);

  const out = await dropPurgedFenceRows(engine, 'default', body, 'people/alice-example');
  const parsed = parseTakesFence(out);
  expect(parsed.warnings).toEqual([]);
  expect(parsed.takes.map(t => [t.rowNum, t.claim])).toEqual([[1, 'Keep this claim'], [4, 'Keep this one too']]);
  expect(parsed.reservedRowNums.sort()).toEqual([2, 3]);
  expect(out).not.toContain('Purge this claim');
});
