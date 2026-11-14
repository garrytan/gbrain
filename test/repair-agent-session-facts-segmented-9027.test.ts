/**
 * #9027: `gbrain repair agent-session-facts --apply` on a page stored in segments (`body_storage = 'segmented'`).
 *
 * Protects: the fenced facts of a segmented page are re-attributed (`attributed_to: other` plus the speaker note) and
 * its fenced `kind: fact` / `holder: self` takes retired, as on an inline page: the page is read back whole and
 * published by one revision-bound put_page, so the projection rewrites the rows and the page stays segmented. Covered
 * on an unmanaged repo-less brain (the put writes the database) and a managed one whose content root is a plain
 * directory (the put goes through the coordinated writer and the file).
 * Fails when: the apply skips a segmented page, so every previewed row reports changed_since_preview and stays as it was.
 * PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { speakerContextNote, writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { randomUUID } from 'node:crypto';
import { conversationBody } from './helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const ALICE = 'people/alice-example';
const FACTS = ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| 1 | Prefers terse status updates | preference | 0.9 | private | low | 2026-10-01 | | hook:writeback | |',
  '| 2 | Prefers async standups | preference | 0.9 | private | low | 2026-10-01 | | hook:writeback | |',
  '<!--- gbrain:facts:end -->'].join('\n');
const TAKES = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |', '|---|---|---|---|---|---|---|',
  '| 1 | Prefers terse async updates | fact | self | 0.8 | 2026-10-01 | hook:writeback |', '<!--- gbrain:takes:end -->'].join('\n');
const page = (fence: string) => `---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\n## Notes\n\n${fence}\n\n${conversationBody(1_200_000, { seed: 9027 })}\n`;

interface RepairJson { results: Array<{ apply_command: string; residuals: Record<string, number>; outcomes?: Record<string, number> }> }
async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['agent-session-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
/** Writes the page by put_page, as an agent would; the put projects its fences (an import of the file alone does not). */
async function putPage(engine: BrainEngine, fence: string, ctx?: OperationContext) {
  await engine.setConfig('pages.segmented_storage', 'on');
  await submitPageMutation(ctx ?? { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } }, { operation: 'put_page', params: { slug: ALICE, content: page(fence), request_id: randomUUID() } });
  expect(await storage(engine)).toBe('segmented');
}
const applyArgs = (json: RepairJson) => json.results[0]!.apply_command.split(' ').slice(3);
const storage = async (engine: BrainEngine) => (await engine.executeRaw<{ body_storage: string }>(
  "SELECT body_storage FROM pages WHERE source_id='default' AND slug=$1", [ALICE]))[0]!.body_storage;
const raw = (engine: BrainEngine, sql: string, params: unknown[]) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const facts = (engine: BrainEngine) => engine.executeRaw<{ id: number; fact: string; attributed_to: string | null; context: string | null; active: boolean }>(
  "SELECT id, fact, attributed_to, context, expired_at IS NULL AND superseded_by IS NULL AS active FROM facts WHERE source_id='default' AND entity_slug=$1 ORDER BY id", [ALICE]);

/** The fenced facts of the page, given the sidecar session the capture lane records. */
async function captureFacts(engine: BrainEngine): Promise<number[]> {
  const rows = (await facts(engine)).filter(f => f.active);
  expect(rows.map(f => f.fact)).toEqual(['Prefers terse status updates', 'Prefers async standups']);
  const ids = rows.map(f => Number(f.id));
  await raw(engine, "UPDATE facts SET source_session='sess-sidecar', attributed_to='user' WHERE id=ANY($1::bigint[])", [ids]);
  return ids;
}

/** The page's fenced take, consolidated from two database-only capture-lane facts of the sidecar session. */
async function consolidatedTake(engine: BrainEngine): Promise<number> {
  const [take] = await engine.executeRaw<{ id: number }>('SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND t.active', [ALICE]);
  expect(take).toBeDefined();
  for (const fact of ['Prefers terse updates', 'Prefers async updates']) {
    await raw(engine, `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to, consolidated_into, consolidated_at)
      VALUES ('default', $1, $2, 'preference', 'private', 'hook:writeback', 'sess-sidecar', 'user', $3, now() - interval '1 minute')`, [ALICE, fact, take!.id]);
  }
  return Number(take!.id);
}

async function expectReattributed(engine: BrainEngine, ids: number[]) {
  const preview = await repair(engine, []);
  expect(preview.results[0]!.residuals).toMatchObject({ evidenced: 2 });
  const applied = await repair(engine, applyArgs(preview));
  expect(applied.results[0]!.outcomes).toEqual({ reattributed: 1 });
  for (const row of (await facts(engine)).filter(f => ids.includes(Number(f.id)))) {
    expect(row).toMatchObject({ attributed_to: 'other', active: true, context: speakerContextNote('worker-a') });
  }
  expect((await facts(engine)).filter(f => f.active && f.attributed_to !== 'other')).toEqual([]);
  expect(await storage(engine)).toBe('segmented');
}

async function expectRetired(engine: BrainEngine, take: number) {
  const preview = await repair(engine, []);
  expect(preview.results[0]!.residuals).toMatchObject({ evidenced: 2, takes_to_retire: 1 });
  const applied = await repair(engine, applyArgs(preview));
  expect(applied.results[0]!.outcomes).toEqual({ reattributed: 1, retired: 1 });
  expect((await engine.executeRaw<{ active: boolean }>('SELECT active FROM takes WHERE id=$1', [take]))[0]!.active).toBe(false);
  expect(await storage(engine)).toBe('segmented');
}

let base: string;
let corpus: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-agent-session-segmented-'));
  corpus = join(base, 'corpus');
  mkdirSync(join(corpus, 'sourced'), { recursive: true });
  writeFileSync(join(corpus, 'sess-sidecar.txt'), '[user]\nPlease triage the open issues for the docs lane.\n\n[assistant]\nOn it.');
  writeSpeakerSidecar(corpus, 'sess-sidecar', { principal: 'worker-a', source: 'env' }, 'claude');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

for (const kind of testBackends()) {
  describe(`repair agent-session-facts on a segmented page, unmanaged repo-less brain (${kind})`, () => {
    /** A fresh brain with segmented storage on, the corpus configured and the page imported (stored in segments). */
    const withPage = async (fence: string, run: (engine: BrainEngine) => Promise<void>) => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        await putPage(engine, fence);
        await run(engine);
      } finally { await close(); }
    };

    test('apply re-attributes fenced facts on a segmented page', async () => {
      await withPage(FACTS, async engine => expectReattributed(engine, await captureFacts(engine)));
    }, 300_000);

    test('apply retires fenced takes on a segmented page', async () => {
      await withPage(TAKES, async engine => expectRetired(engine, await consolidatedTake(engine)));
    }, 300_000);
  });

  describe(`repair agent-session-facts on a segmented page, managed repo-less brain (${kind})`, () => {
    /** As the unmanaged arm, through the coordinated writer; the page's file then holds the repaired row (`fileHolds`). */
    const withPage = (fence: string, fileHolds: string, run: (engine: BrainEngine) => Promise<void>) => managedBrain(async ({ engine, ctx, root }) => {
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
      await putPage(engine, fence, ctx);
      await run(engine);
      expect(readFileSync(join(root, `${ALICE}.md`), 'utf8')).toContain(fileHolds);
    }, kind === 'postgres' ? { databaseUrl: process.env.DATABASE_URL! } : {});

    test('apply re-attributes fenced facts on a segmented page', async () => {
      await withPage(FACTS, `| ${speakerContextNote('worker-a')} |`, async engine => expectReattributed(engine, await captureFacts(engine)));
    }, 300_000);

    test('apply retires fenced takes on a segmented page', async () => {
      await withPage(TAKES, '~~Prefers terse async updates~~', async engine => expectRetired(engine, await consolidatedTake(engine)));
    }, 300_000);
  });
}
