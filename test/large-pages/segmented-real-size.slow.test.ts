/**
 * Wave B PR 2 fix lane F (N5): the two checks that need a stored segmented page larger than a write or read limit,
 * on a real page of that size. Moved here from segmented-switch.test.ts and segmented-derived-work.test.ts, which
 * faked the size by raising pages.body_bytes; a body whose manifest rows do not reach body_bytes now refuses
 * (page_body_rows_unreadable), as a page that lost rows must.
 *
 * 1. Protects: a stored segmented page over the 32 MiB inline export limit still exports while the switch is off;
 *    Life Chronicle execution judges a segmented page over the single-string ceiling (PAGE_MAX_BYTES) from its lead,
 *    without materializing it.
 * 2. Fails when: export sizes stored segmented pages by the write limit, or chronicle execution skips or materializes
 *    a segmented page over the ceiling.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy, _resetSegmentedWriterGateForTests } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { upsertChronicleRow } from '../../src/core/chronicle/ledger.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runExport } from '../../src/commands/export.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MiB = 1024 * 1024;
const today = new Date().toISOString().slice(0, 10);
const body = conversationBody(1_200_000, { seed: 61 });
const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-real-size-'));
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function quietExport(engine: BrainEngine, out: string): Promise<void> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code} ${messages.join('\n')}`); }) as never;
  try { await runExport(engine, ['--dir', out]); } finally { console.log = log; console.error = error; process.exit = exit; }
}

async function storage(engine: BrainEngine, slug: string): Promise<{ id: number; body_storage: string; content_hash: string }> {
  const [row] = await engine.executeRaw<{ id: number; body_storage: string; content_hash: string }>(
    "SELECT id, body_storage, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  return { ...row!, id: Number(row!.id) };
}

const ledger = (engine: BrainEngine) => engine.executeRaw<{ slug: string; state: string; reason: string | null; scheduled: boolean }>(
  'SELECT slug, state, reason, next_attempt_at IS NOT NULL AS scheduled FROM chronicle_page_state ORDER BY slug, decided_at');

/** A Markdown file of \`head\` then conversation text to about \`bytes\`, written in pieces; imported streamed (switch on). */
async function importLarge(engine: BrainEngine, slug: string, head: string, bytes: number, seed: number) {
  const file = join(home, `${slug}-${engine.kind}.md`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, head);
  for (let written = Buffer.byteLength(head), part = 0; written < bytes; part++) {
    const piece = `\n\n${conversationBody(Math.min(8 * MiB, bytes - written), { seed: seed + part })}`;
    appendFileSync(file, piece);
    written += Buffer.byteLength(piece);
  }
  appendFileSync(file, '\n');
  return importFromFile(engine, file, `${slug}.md`, { noEmbed: true, sourceId: 'default', bodyPolicy: await readPageBodyPolicy(engine) });
}

for (const kind of testBackends()) {
  describe(`segmented pages over a size limit, at that size (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      _resetSegmentedWriterGateForTests();
    }, 120_000);
    afterAll(async () => withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await close(); }));

    test('a stored segmented page over the 32 MiB inline export limit still exports while the switch is off', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const content = conversationPage(40 * MiB, { seed: 61 });
      const file = join(home, `stored-${kind}.md`);
      writeFileSync(file, content);
      expect((await importFromFile(engine, file, 'notes/stored.md', { noEmbed: true, sourceId: 'default', bodyPolicy: await readPageBodyPolicy(engine) })).status).toBe('imported');
      expect((await storage(engine, 'notes/stored')).body_storage).toBe('segmented');
      await engine.setConfig('pages.segmented_storage', 'off');
      const out = join(home, `export-${kind}`);
      await quietExport(engine, out);
      expect(readFileSync(join(out, 'notes/stored.md'), 'utf8')).toContain(content.trimEnd().slice(-120));
    }), 900_000);

    test('execution judges a segmented page over the single-string ceiling from its lead, without materializing it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('chronicle.auto_settle_seconds', '0');
      await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
      const head = `---\ntype: meeting\ntitle: Offsite\ndate: ${today}\n---\n\n${body}`;
      expect((await importLarge(engine, 'meetings/segmented-offsite', head, PAGE_MAX_BYTES + MiB, 62)).status).toBe('imported');
      const page = await storage(engine, 'meetings/segmented-offsite');
      expect(page.body_storage).toBe('segmented');
      await engine.executeRaw('DELETE FROM chronicle_page_state');
      await upsertChronicleRow(engine, { sourceId: 'default', pageId: page.id, contentHash: page.content_hash, slug: 'meetings/segmented-offsite',
        state: 'pending', reason: null, trigger: 'auto', nextAttemptAt: null });
      const [{ body_bytes }] = await engine.executeRaw<{ body_bytes: number }>('SELECT body_bytes FROM pages WHERE id=$1', [page.id]);
      expect(Number(body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      const judged: string[] = [];
      await runPhaseChronicle(engine, { judge: async (input) => { judged.push(input.body); return { events: [] }; } });
      expect(judged).toHaveLength(1);
      expect(judged[0]!.slice(0, 200)).toBe(body.slice(0, 200));
      expect(await ledger(engine)).toEqual([{ slug: 'meetings/segmented-offsite', state: 'extracted', reason: 'no_events', scheduled: false }]);
    }), 900_000);
  });
}
