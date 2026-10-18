/**
 * Wave B PR 2 fix lane E (E2): delete_page of a segmented, fenced, managed page whose own facts row is withdrawn.
 *
 * 1. Protects: the drift check reads a segmented page within the single-string ceiling back whole
 *    (materializedSnapshot) and compares it with its canonical file overlaid by the snapshot's withdrawal ledger, as
 *    for an inline page. The read-back body gets the same overlay readPageSnapshot gives an inline body, so the page
 *    soft-deletes and purges exactly as the same page stored inline does, for a withdrawal of its own row (subject =
 *    slug) or a source-wide one ('*'), and its read-back body equals the inline snapshot's byte for byte. A page over
 *    the ceiling (compared by digest, never read back whole) deletes under the same ledger too.
 * 2. Fails when: the read-back body of a segmented page skips the withdrawal overlay, so the unchanged file reads as an
 *    uncoordinated local edit (source_changed) and the page cannot be deleted while its inline twin can.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { materializedSnapshot } from '../../src/core/persistence/segmented-apply.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-withdrawn-delete-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'notes/fenced-ledger';
const WITHDRAWN = 'Door code is 5512';

const ROW = (n: number, claim: string) => '| ' + n + ' | ' + claim + ' | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |';
const FENCE = (rows: string[]) => '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n' + rows.join('\n') + '\n<!--- gbrain:facts:end -->';
// About 2 MiB: segmented with the switch on, inline (under the 24 MiB ceiling) with it off.
const FENCED = '---\ntitle: Fenced ledger\ntype: note\n---\n\n# Fenced ledger\n\n' + FENCE([ROW(1, WITHDRAWN), ROW(2, 'Likes green tea')]) + '\n\n'
  + conversationBody(2 * 1024 * 1024, { seed: 5 });

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

interface Fixture { sourceId: string; root: string; ctx: OperationContext }

async function managedSource(engine: BrainEngine, segmented: boolean): Promise<Fixture> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', segmented ? 'on' : 'off');
  const root = join(home, 'src-' + randomUUID().slice(0, 8));
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = 'ledger-' + randomUUID().slice(0, 8);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, ctx: { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext };
}

async function importPage(engine: BrainEngine, f: Fixture, content: string): Promise<string> {
  writeFileSync(join(f.root, SLUG + '.md'), content);
  expect(await importManagedFile(engine, join(f.root, SLUG + '.md'), SLUG + '.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  await disposePersistenceConsumer(engine);
  const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, SLUG]);
  return row!.body_storage;
}

const withdraw = (engine: BrainEngine, f: Fixture, subject: string, claim = WITHDRAWN) => engine.executeRaw(
  "INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ($1, 'world', $2, gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING", [f.sourceId, subject, claim]);

async function deletion(engine: BrainEngine, f: Fixture, extra: Record<string, unknown> = {}): Promise<string> {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: f.sourceId, includeDeleted: true });
  try {
    const result = await submitPageMutation(f.ctx, { operation: 'delete_page', params: { slug: SLUG, expected_revision: snapshot!.revision, request_id: randomUUID(), ...extra } }) as { status?: string };
    return String(result.status);
  } catch (error) {
    return 'refused ' + (error as { code?: string }).code;
  } finally {
    await disposePersistenceConsumer(engine);
  }
}

test('a segmented page whose own facts row is withdrawn deletes and purges as its inline twin does, and reads back the inline body', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const seen: Record<string, unknown> = {};
    for (const subject of ['slug', '*']) {
      const bodies: Record<string, string> = {};
      for (const storage of ['segmented', 'inline'] as const) {
        const f = await managedSource(engine, storage === 'segmented');
        const purged = await managedSource(engine, storage === 'segmented');
        const stored = [await importPage(engine, f, FENCED), await importPage(engine, purged, FENCED)];
        for (const fixture of [f, purged]) await withdraw(engine, fixture, subject === 'slug' ? SLUG : '*');
        const body = (await materializedSnapshot(engine, await engine.readPageSnapshot(SLUG, { sourceId: f.sourceId })))!.page.compiled_truth;
        bodies[storage] = createHash('sha256').update(body).digest('hex');
        seen[subject + ':' + storage] = { stored, struck: body.includes('~~' + WITHDRAWN + '~~'), deleted: await deletion(engine, f), purged: await deletion(engine, purged, { purge: true }) };
      }
      seen[subject + ':same_body'] = bodies.segmented === bodies.inline;
    }
    const twin = (storage: string) => ({ stored: [storage, storage], struck: true, deleted: 'soft_deleted', purged: 'purged' });
    expect({ engine: engine.kind, seen }).toEqual({ engine: engine.kind, seen: {
      'slug:segmented': twin('segmented'), 'slug:inline': twin('inline'), 'slug:same_body': true,
      '*:segmented': twin('segmented'), '*:inline': twin('inline'), '*:same_body': true } });
  }
}), 900_000);

test('a segmented page over the single-string ceiling deletes under a withdrawal ledger that applies to it', async () => withEnv(env, async () => {
  const huge = conversationPage(PAGE_MAX_BYTES + 512 * 1024, { seed: 98, needles: [{ at: 0.5, word: 'midpointmarker' }] });
  for (const engine of engines) {
    const f = await managedSource(engine, true);
    expect(await importPage(engine, f, huge)).toBe('segmented');
    await withdraw(engine, f, '*');
    await withdraw(engine, f, SLUG, 'Some other withdrawn claim');
    expect({ engine: engine.kind, outcome: await deletion(engine, f) }).toEqual({ engine: engine.kind, outcome: 'soft_deleted' });
  }
}), 900_000);
