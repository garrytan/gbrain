/**
 * #8859 follow-up: facts that purges before the #8859 fix left behind (page-extraction rows filed on no page whose
 * context head names a page that no longer exists) are reported by a read-only doctor check and retired only by a
 * previewed, hash-bound, consented apply. By default only rows of a page the purge ledger records are retired; rows of
 * a page gone with no purge record need --include-ambiguous. Withdrawn, superseded and referenced rows, rows of a live
 * page and non-extraction rows stay active, and a row that was not in the preview is never touched. Runs on a managed
 * brain (PGLite and Postgres, one receipted request per batch) and an unmanaged PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { purgedPageFactsCheck } from '../src/commands/doctor/checks/purged-page-facts.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const PURGED = 'atoms/2026-09-30/example-claim';
const EXPIRED = 'meetings/example-meeting';
const LIVE = 'notes/live-example';

interface RepairJson { results: Array<{ residuals?: Record<string, number>; listing?: Array<{ item: string; class: string }>; apply_command: string; applied?: number }> }

async function capture(run: () => Promise<unknown>): Promise<{ out: string; exitCode: number | string | undefined }> {
  const lines: string[] = [];
  const { log, error } = console;
  const stdout = process.stdout.write.bind(process.stdout);
  const previous = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  console.error = () => {};
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await run(); return { out: lines.join('\n'), exitCode: process.exitCode }; }
  finally { console.log = log; console.error = error; process.stdout.write = stdout; process.exitCode = previous ?? 0; _resetCliExitVerdictForTests(); }
}
async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const { out } = await capture(() => runRepairCommand(engine, ['purged-page-facts', ...args, '--json']));
  return JSON.parse(out) as RepairJson;
}
const hashOf = (json: RepairJson) => json.results[0]!.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;
const active = async (engine: BrainEngine, ids: number[]) => (await engine.executeRaw<{ id: number }>(
  'SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND expired_at IS NULL ORDER BY id', [ids])).map(r => Number(r.id));

/** Rows as an older gbrain left them: written under replica role, so no current writer guard applies. */
const legacy = <T>(engine: BrainEngine, sql: string, params: unknown[]) => engine.transaction(async tx => {
  await tx.executeRaw('SET LOCAL session_replication_role = replica');
  return tx.executeRaw<T>(sql, params);
});
async function fact(engine: BrainEngine, text: string, context: string, opts: { source?: string; superseded_by?: number } = {}) {
  const [row] = await legacy<{ id: number }>(engine, `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, context, valid_from, superseded_by)
    VALUES ('default', NULL, $1, 'fact', 'private', 'high', $3, $2, now(), $4) RETURNING id`, [text, context, opts.source ?? 'mcp:put_page', opts.superseded_by ?? null]);
  return Number(row!.id);
}

interface Seeded { purged: number; noted: number; expired: number; live: number; remembered: number; superseded: number }

/** Two gone pages (one purged, recorded in page_purges; one expired by retention, no record) and their leftover rows. */
async function seed(engine: BrainEngine, gone: (slug: string, purge: boolean) => Promise<void>): Promise<Seeded> {
  await gone(PURGED, true);
  await gone(EXPIRED, false);
  const purged = await fact(engine, 'Example claim one from the atom', PURGED);
  const noted = await fact(engine, 'Example claim two from the atom', `${PURGED} — entity inferred from text`);
  const expired = await fact(engine, 'Alice Example joined a new team', EXPIRED);
  const live = await fact(engine, 'A live page claim', LIVE);
  const remembered = await fact(engine, 'A remembered example claim', PURGED, { source: 'mcp:remember' });
  const superseded = await fact(engine, 'An older example claim', PURGED, { superseded_by: live });
  return { purged, noted, expired, live, remembered, superseded };
}

async function exercise(engine: BrainEngine, s: Seeded) {
  const all = Object.values(s);
  const check = await purgedPageFactsCheck(engine, ['default']);
  expect(check.status).toBe('warn');
  expect(check.details).toMatchObject({ evidenced: 2, ambiguous: 1 });

  const preview = await repair(engine, []);
  expect(preview.results[0]!.residuals).toMatchObject({ evidenced: 2, ambiguous: 1, excluded: 1 });
  expect(preview.results[0]!.listing!.map(l => [l.item, l.class]).sort()).toEqual([
    [`default:${PURGED}#${s.noted}`, 'evidenced'], [`default:${PURGED}#${s.purged}`, 'evidenced'],
    [`default:${PURGED}#${s.superseded}`, 'excluded:superseded'], [`default:${EXPIRED}#${s.expired}`, 'ambiguous']].sort());
  expect(await active(engine, all)).toEqual([...all].sort((a, b) => a - b));

  // A leftover row written after the preview is not in the approved set and stays active.
  const late = await fact(engine, 'A late example claim', PURGED);
  const hash = hashOf(preview);
  const unconsented = await capture(() => runRepairCommand(engine, ['purged-page-facts', '--apply', '--expect', hash, '--json']));
  expect(unconsented.exitCode).toBe(3);
  expect(await active(engine, [s.purged, s.noted])).toEqual([s.purged, s.noted].sort((a, b) => a - b));
  const wrong = await capture(() => runRepairCommand(engine, ['purged-page-facts', '--apply', '--expect', 'f'.repeat(64), '--yes', '--json'])).catch((e: Error) => ({ out: e.message }));
  expect(wrong.out).toContain('preview changed');

  await repair(engine, ['--apply', '--expect', hash, '--yes']);
  expect(await active(engine, [...all, late])).toEqual([s.expired, s.live, s.remembered, s.superseded, late].sort((a, b) => a - b));

  const widened = await repair(engine, ['--include-ambiguous']);
  expect(widened.results[0]!.residuals).toMatchObject({ evidenced: 1, ambiguous: 1 });
  await repair(engine, ['--include-ambiguous', '--apply', '--expect', hashOf(widened), '--yes']);
  expect(await active(engine, [...all, late])).toEqual([s.live, s.remembered, s.superseded].sort((a, b) => a - b));
  expect((await purgedPageFactsCheck(engine, ['default'])).status).toBe('ok');
}

async function putPage(ctx: OperationContext, slug: string) {
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: 'default', request_id: randomUUID(),
    content: `---\ntype: note\ntitle: Example\n---\nA synthetic page at ${slug}.\n` } });
}

for (const backend of testBackends()) {
  describe(`#8859 purged-page-facts repair, managed (${backend})`, () => {
    const opts = backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {};
    test('doctor reports, preview lists, apply retires only the approved rows', () => managedBrain(async ({ engine, ctx }) => {
      await putPage(ctx, LIVE);
      const seeded = await seed(engine, async (slug, purge) => {
        await putPage(ctx, slug);
        const live = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, source_id: 'default', request_id: randomUUID(), expected_revision: live!.revision } });
        if (purge) {
          const snap = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
          await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, source_id: 'default', purge: true, request_id: randomUUID(), expected_revision: snap!.revision } });
        } else await purgeDeletedPagesCoordinated(engine, 0);
      });
      await exercise(engine, seeded);
    }, opts), 240_000);
  });
}

describe('#8859 purged-page-facts repair, unmanaged PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(() => engine.disconnect());
  test('the same flow under the page keys', async () => {
    {
      await engine.putPage(LIVE, { type: 'note', title: 'Live', compiled_truth: 'A synthetic page.' });
      const seeded = await seed(engine, async (slug, purge) => {
        await engine.putPage(slug, { type: 'note', title: 'Gone', compiled_truth: `A synthetic page at ${slug}.` });
        await legacy(engine, "DELETE FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
        if (purge) await legacy(engine, "INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', $1, $2)", ['0'.repeat(64), slug]);
      });
      await exercise(engine, seeded);
    }
  }, 120_000);
});
