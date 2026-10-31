/**
 * #7043 (reported by @mikez93): `gbrain repair duplicate-facts` retires exact
 * copies of one active fact. In each group of active facts of one source and
 * visibility with one fingerprint, the oldest fenced row (else the oldest row) is kept and the others are
 * superseded by it (expired_at set, superseded_by the kept row; never a
 * withdrawal). Copies on other entities are listed apart and retired only
 * with --include-cross-entity; near duplicates are never touched; a fenced
 * copy is struck in its page as "superseded by #N" when the kept row is in the
 * same fence and kept otherwise. G4: a fenced copy is kept over an older
 * database-only one, so a legacy copy of a fenced claim is retired instead of
 * holding the fence row. Explicit-only and preview-bound.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { withEnv } from './helpers/with-env.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { randomUUID } from 'node:crypto';

let engine: BrainEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-duplicate-facts-'));

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return JSON.parse(res.content[0]!.text!) as Record<string, any>;
}

async function fact(text: string, entity: string, day: string, visibility: 'world' | 'private' = 'world'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from, created_at)
    VALUES ('default', $1, $2, 'fact', $3, 'test', $4::timestamptz, $4::timestamptz) RETURNING id`, [entity, text, visibility, `${day}T12:00:00Z`]);
  return Number(row!.id);
}

/** `ownHome`: keep the caller's GBRAIN_HOME (a managed brain's worktree claim lives there). */
async function repair(args: string[], ownHome = false): Promise<Record<string, any>> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  const run = () => runRepairCommand(engine, ['duplicate-facts', ...args, '--json']);
  try { await (ownHome ? run() : withEnv({ GBRAIN_HOME: home }, run)); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')).results[0];
}

async function state(ids: number[]) {
  const rows = await engine.executeRaw<{ id: number; expired_at: unknown; superseded_by: number | null; entity_slug: string | null }>(
    'SELECT id, expired_at, superseded_by, entity_slug FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  return rows.map(r => ({ id: Number(r.id), active: r.expired_at === null, superseded_by: r.superseded_by === null ? null : Number(r.superseded_by) }));
}

const fencePage = (title: string, claim: string) => [
  '---', `title: ${title}`, 'type: person', '---', `# ${title}`, '', '## Facts', '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  `| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`,
  `| 2 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`,
  '<!--- gbrain:facts:end -->', '',
].join('\n');

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await template?.dispose(); await pglite?.disconnect(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      for (const [slug, title] of [['people/alice-example', 'Alice Example'], ['people/bob-example', 'Bob Example']]) {
        await call('put_page', { slug, content: `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nA person.\n` });
      }
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('same-entity copies are superseded by the oldest row; cross-entity copies wait for the flag; near duplicates stay', async () => {
      const email = [await fact('Alice Example prefers email.', 'people/alice-example', '2026-01-01'),
        await fact('Alice Example prefers email.', 'people/alice-example', '2026-01-02'),
        await fact('alice example prefers email', 'people/alice-example', '2026-01-03')];
      const privateCopy = await fact('Alice Example prefers email.', 'people/alice-example', '2026-01-04', 'private');
      const near = await fact('Alice Example prefers e-mail.', 'people/alice-example', '2026-01-05');
      const team = [await fact('The team ships on Fridays.', 'people/alice-example', '2026-01-01'), await fact('The team ships on Fridays.', 'people/bob-example', '2026-01-02')];

      const preview = await repair([]);
      expect(preview.residuals).toMatchObject({ same_entity_groups: 1, cross_entity_groups: 1, copies_to_retire: 2, cross_entity_copies_held: 1 });
      expect(preview.listing.map((l: { class: string }) => l.class).sort()).toEqual(['cross_entity_held', 'same_entity']);
      expect(preview.apply_command).toContain('--yes');
      expect(await state(email)).toEqual(email.map(id => ({ id, active: true, superseded_by: null })));

      const applied = await repair(['--apply', '--expect', preview.preview_hash, '--yes']);
      expect(applied.applied).toBe(1);
      expect(await state(email)).toEqual([{ id: email[0], active: true, superseded_by: null },
        { id: email[1], active: false, superseded_by: email[0] }, { id: email[2], active: false, superseded_by: email[0] }]);
      expect(await state([privateCopy, near, ...team])).toEqual([privateCopy, near, ...team].map(id => ({ id, active: true, superseded_by: null })));
      // Supersession is not a withdrawal: the claim stays rememberable.
      expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals')).toHaveLength(0);

      const cross = await repair(['--include-cross-entity']);
      expect(cross.residuals).toMatchObject({ cross_entity_groups: 1, copies_to_retire: 1, cross_entity_copies_held: 0 });
      await repair(['--include-cross-entity', '--apply', '--expect', cross.preview_hash, '--yes']);
      expect(await state(team)).toEqual([{ id: team[0], active: true, superseded_by: null }, { id: team[1], active: false, superseded_by: team[0] }]);
      expect((await repair([])).affected).toBe(0);
    });

    test('apply refuses a hash from another selection and keeps a copy that changed since the preview', async () => {
      const ids = [await fact('Bob Example uses vim.', 'people/bob-example', '2026-01-01'), await fact('Bob Example uses vim.', 'people/bob-example', '2026-01-02'),
        await fact('Bob Example uses vim.', 'people/bob-example', '2026-01-03')];
      const preview = await repair([]);
      await expect(withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, ['duplicate-facts', '--include-cross-entity', '--apply', '--expect', preview.preview_hash, '--yes', '--json'])))
        .rejects.toThrow();
      await engine.executeRaw('UPDATE facts SET expired_at = now() WHERE id = $1', [ids[2]]);
      const applied = await repair(['--apply', '--expect', preview.preview_hash, '--yes']);
      expect(applied.outcomes).toEqual({ partially_superseded: 1 });
      expect(await state(ids)).toEqual([{ id: ids[0], active: true, superseded_by: null }, { id: ids[1], active: false, superseded_by: ids[0] },
        { id: ids[2], active: false, superseded_by: null }]);
    });

    test('a managed brain retires database-only copies in a coordinated write and fenced copies through put_page', async () => {
      const outer = engine;
      try {
        await managedBrain(async (brain) => {
          engine = brain.engine;
          await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug: 'people/carol-example', request_id: randomUUID(),
            content: fencePage('Carol Example', 'Carol Example likes jazz.') } });
          const carol = (await engine.executeRaw<{ id: number }>(
            "SELECT id FROM facts WHERE source_markdown_slug='people/carol-example' AND expired_at IS NULL ORDER BY row_num")).map(r => Number(r.id));
          const db = (await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact='Erin Example runs marathons.' ORDER BY created_at, id")).map(r => Number(r.id));
          const preview = await repair([], true);
          expect(preview.residuals).toMatchObject({ same_entity_groups: 2, copies_to_retire: 2 });
          const applied = await repair(['--apply', '--expect', preview.preview_hash, '--yes'], true);
          expect(applied.stopped).toBeUndefined();
          expect(applied.outcomes).toEqual({ superseded: 2 });
          expect(await state(db)).toEqual([{ id: db[0], active: true, superseded_by: null }, { id: db[1], active: false, superseded_by: db[0] }]);
          expect(await state(carol)).toEqual([{ id: carol[0], active: true, superseded_by: null }, { id: carol[1], active: false, superseded_by: carol[0] }]);
          await disposePersistenceConsumer(engine);
        }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined, setup: async ({ engine: e }) => {
          for (const day of ['2026-01-01', '2026-01-02']) await e.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from, created_at)
            VALUES ('default', 'people/erin-example', 'Erin Example runs marathons.', 'fact', 'world', 'test', $1::timestamptz, $1::timestamptz)`, [`${day}T12:00:00Z`]);
        } });
      } finally { engine = outer; }
    }, 120_000);

    test('a fenced copy is struck in its page when the kept row shares the fence, and kept when it does not', async () => {
      await call('put_page', { slug: 'people/carol-example', content: fencePage('Carol Example', 'Carol Example likes jazz.') });
      const carol = (await engine.executeRaw<{ id: number; row_num: number }>(
        "SELECT id, row_num FROM facts WHERE source_markdown_slug='people/carol-example' AND expired_at IS NULL ORDER BY row_num")).map(r => ({ id: Number(r.id), row: Number(r.row_num) }));
      expect(carol.map(r => r.row)).toEqual([1, 2]);
      // G4: an older database-only legacy copy of a fenced claim is retired onto the fence row, never kept over it.
      const dana = await fact('Dana Example plays chess.', 'people/dana-example', '2020-01-01');
      await call('put_page', { slug: 'people/dana-example', content: fencePage('Dana Example', 'Dana Example plays chess.').replace(/\n\| 2 \|[^\n]*/, '') });
      const [danaFenced] = (await engine.executeRaw<{ id: number }>(
        "SELECT id FROM facts WHERE source_markdown_slug='people/dana-example' AND row_num=1 AND expired_at IS NULL")).map(r => Number(r.id));
      // A fenced copy on another page cannot name the kept row, so it is kept.
      await call('put_page', { slug: 'people/erin-example', content: fencePage('Erin Example', 'Dana Example plays chess.').replace(/\n\| 2 \|[^\n]*/, '') });

      const preview = await repair(['--include-cross-entity']);
      expect(preview.residuals.fence_kept_elsewhere).toBe(1);
      expect(preview.listing.some((l: { class: string; item: string }) => l.class === 'fence_kept_elsewhere' && l.item.endsWith(`fact#${danaFenced}`))).toBe(true);
      await repair(['--include-cross-entity', '--apply', '--expect', preview.preview_hash, '--yes']);
      expect(await state([dana, danaFenced!])).toEqual([{ id: dana, active: false, superseded_by: danaFenced }, { id: danaFenced, active: true, superseded_by: null }]);

      expect(await state(carol.map(r => r.id))).toEqual([{ id: carol[0]!.id, active: true, superseded_by: null }, { id: carol[1]!.id, active: false, superseded_by: carol[0]!.id }]);
      const page = await call('get_page', { slug: 'people/carol-example', include_content: true });
      const rows = parseFactsFence(String(page.content ?? page.compiled_truth)).facts;
      expect(rows.find(r => r.rowNum === 2)).toMatchObject({ active: false, supersededBy: 1 });
      expect(rows.find(r => r.rowNum === 1)?.active).toBe(true);
      const danaFence = await engine.executeRaw("SELECT 1 FROM facts WHERE source_markdown_slug='people/dana-example' AND expired_at IS NULL");
      expect(danaFence).toHaveLength(1);
    });

    test('a fenced copy on a segmented page is kept as segmented_page, in the preview and in an apply that finds the page segmented since', async () => {
      const segment = (slug: string) => engine.executeRaw(
        "UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_bytes = 1 WHERE source_id = 'default' AND slug = $1", [slug]);
      const fenceRows = async (slug: string) => (await engine.executeRaw<{ id: number }>(
        'SELECT id FROM facts WHERE source_markdown_slug = $1 AND expired_at IS NULL ORDER BY row_num', [slug])).map(r => Number(r.id));
      await call('put_page', { slug: 'people/erin-example', content: fencePage('Erin Example', 'Erin Example keeps bees.') });
      await call('put_page', { slug: 'people/frank-example', content: fencePage('Frank Example', 'Frank Example builds boats.') });
      const erin = await fenceRows('people/erin-example');
      const frank = await fenceRows('people/frank-example');
      await segment('people/erin-example');

      const preview = await repair([]);
      expect(preview.residuals).toMatchObject({ segmented_page: 1, copies_to_retire: 1 });
      expect(preview.listing.some((l: { class: string; item: string }) => l.class === 'segmented_page' && l.item.endsWith(`fact#${erin[0]}`))).toBe(true);
      await segment('people/frank-example');
      const applied = await repair(['--apply', '--expect', preview.preview_hash, '--yes']);

      expect(applied.outcomes).toEqual({ segmented_page: 1 });
      expect(applied.outcome_items[0]).toMatchObject({ outcome: 'segmented_page', detail: { kept: frank[0], superseded: 0, segmented_page: 1 } });
      expect(applied.outcome_items[0].reason).toContain('segmented page');
      expect(await state([...erin, ...frank])).toEqual([...erin, ...frank].map(id => ({ id, active: true, superseded_by: null })));
    });
  });
}
