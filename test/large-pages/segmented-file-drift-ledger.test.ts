/**
 * Wave B PR 2 fix lane C2 (D5): the file drift check of a segmented page over
 * the single-string ceiling when its source has withdrawals.
 *
 * 1. Protects: a file holding a facts fence, under a withdrawal ledger that
 *    applies (any '*' withdrawal or purge in the source applies to every
 *    page), is compared overlaid instead of refused: each complete fence block
 *    of the file is overlaid alone, as the stored side overlays each segment,
 *    so the overlaid file digests equal the stored digests of the same body
 *    (also with a fence across a 1 MiB read boundary and a withdrawn row), and
 *    a file edited on disk to add a fence is refused as drift (source_changed,
 *    the refusal an inline page gets), not as page_body_segmented, also when
 *    the fence is longer than 8 MiB. A fence block longer than FENCE_MAX_BYTES
 *    still refuses page_body_segmented (fail closed), before the file's digest
 *    holds more than the bound and one read (`bodyDigestWork.largestHeld`).
 * 2. Fails when: the check refuses every fenced file whenever the source has
 *    any withdrawal (page_body_segmented), or the file overlay differs from the
 *    stored overlay.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { FENCE_MAX_BYTES, SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { bodyDigestWork, fileBodyDigests, overlaidFileBodyDigests, storedBodyDigests } from '../../src/core/page-body/body-digests.ts';
import { readBodyLedger } from '../../src/core/page-body/segment-ledger.ts';
import { overlayCanonicalBodies } from '../../src/core/page-state/snapshot.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-file-drift-ledger-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
// Over the single-string ceiling, under the 25 MiB pre-push scan cap a restored file must fit.
const huge = conversationPage(PAGE_MAX_BYTES + 512 * 1024, { seed: 97, needles: [{ at: 0.5, word: 'midpointmarker' }] });

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

async function managedSource(engine: BrainEngine): Promise<Fixture> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `drift-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  return { sourceId, root, ctx };
}

async function importHuge(engine: BrainEngine, f: Fixture, slug: string): Promise<string> {
  const file = join(f.root, `${slug}.md`);
  writeFileSync(file, huge);
  expect(await importManagedFile(engine, file, `${slug}.md`, { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: string }>('SELECT body_storage, body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, slug]);
  expect(row?.body_storage).toBe('segmented');
  expect(Number(row?.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
  return file;
}


const revisionOf = async (engine: BrainEngine, f: Fixture, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true }))!.revision;

/** One write to its settled outcome: a reply past the bounded wait is `write_pending`, and the same request is replayed, as a caller does. */
async function submit(engine: BrainEngine, f: Fixture, operation: 'delete_page' | 'restore_page', slug: string, extra: Record<string, unknown> = {}) {
  const params = { slug, expected_revision: await revisionOf(engine, f, slug), request_id: randomUUID(), ...extra };
  for (let replay = 0; ; replay++) {
    try {
      return await submitPageMutation(f.ctx, { operation, params }) as Record<string, any>;
    } catch (error) {
      if ((error as { code?: string }).code !== 'write_pending' || replay >= 20) throw error;
    }
  }
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await p; } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  throw new Error('expected a refusal');
}


const ROW = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const FENCE = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const withdraw = (engine: BrainEngine, sourceId: string, claim: string) => engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
  VALUES ($1, 'world', '*', gbrain_fact_fingerprint($2)) ON CONFLICT DO NOTHING`, [sourceId, claim]);

test('a fenced file under withdrawals is overlaid block by block to the stored digests of the same body', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await managedSource(engine);
    const slug = 'notes/overlay-parity';
    // A fence near the top of the truth, one straddling the timeline's 1 MiB read boundary, a withdrawn row in each.
    const line = 'Notes on planning, pricing and the roadmap review.\n\n';
    const lead = line.repeat(Math.floor((1024 * 1024 - 400) / line.length));
    const content = `---\ntitle: Overlay parity\ntype: note\n---\n\n# Overlay parity\n\n${FENCE([ROW(1, 'Door code is 5512'), ROW(2, 'Likes green tea')])}\n\n${line.repeat(20_000)}\n<!-- timeline -->\n\n${lead}`
      + `${FENCE([ROW(3, 'Vault code is 8841'), ROW(4, 'Walks to work'), ROW(5, 'Reads on the train')])}\n\n${line.repeat(20_000)}`;
    writeFileSync(join(f.root, `${slug}.md`), content);
    expect(await importManagedFile(engine, join(f.root, `${slug}.md`), `${slug}.md`, { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    await disposePersistenceConsumer(engine);
    const [page] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, slug]);
    expect(page!.body_storage).toBe('segmented');
    await withdraw(engine, f.sourceId, 'Door code is 5512');
    await withdraw(engine, f.sourceId, 'Vault code is 8841');
    const ledger = await readBodyLedger(engine, f.sourceId, slug);
    expect(ledger.withdrawals.length).toBeGreaterThanOrEqual(2);
    const bytes = Buffer.from(content, 'utf8');
    // The timeline fence straddles the file side's first 1 MiB read boundary in its region.
    const timeline = Buffer.from(parseMarkdown(content, `${slug}.md`).timeline, 'utf8');
    expect(timeline.indexOf('gbrain:facts:begin')).toBeLessThan(SEGMENT_MAX_BYTES);
    expect(timeline.indexOf('gbrain:facts:end')).toBeGreaterThan(SEGMENT_MAX_BYTES);
    const reading = { prefix: new Uint8Array(0), skip: 0 };
    const file = fileBodyDigests(bytes, reading, `${slug}.md`, {});
    if (file.kind !== 'ok') throw new Error(file.reason);
    expect(file.factsFence).toBe(true);
    const overlays: string[] = [];
    const overlaid = await overlaidFileBodyDigests(bytes, reading, file.regions, async text => {
      overlays.push(text);
      return (await overlayCanonicalBodies(engine.executeRaw.bind(engine), text, '', ledger.withdrawals, { sourceId: f.sourceId, marker: ledger.globalPurges })).compiled_truth;
    }, () => new Error('refused'));
    // Without the ledger the file is the stored body byte for byte; with it, both sides strike the same rows.
    expect(file.digests).toEqual(await storedBodyDigests(engine, Number(page!.id), { withdrawals: [] }));
    const stored = await storedBodyDigests(engine, Number(page!.id), ledger);
    const [forced] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND cut_kind='forced'`, [page!.id]);
    expect(Number(forced!.n)).toBe(0);
    expect(overlaid).toEqual(stored);
    expect(overlaid.truth).not.toBe(file.digests.truth);
    // Each overlay call saw complete fence blocks only, never the whole region.
    expect(overlays.length).toBeGreaterThanOrEqual(2);
    for (const text of overlays) expect(text.split('gbrain:facts:begin').length).toBe(text.split('gbrain:facts:end').length);
    expect(Math.max(...overlays.map(text => Buffer.byteLength(text)))).toBeLessThan(bytes.length);
  }
}), 600_000);

test('under a source withdrawal, a fence added on disk is drift and a fence too long to overlay whole refuses', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await managedSource(engine);
    try {
      await withdraw(engine, f.sourceId, 'Some unrelated withdrawn claim');
      const small = join(f.root, 'notes/small.md');
      writeFileSync(small, '---\ntitle: Small note\ntype: note\n---\n\nA short body.\n');
      expect(await importManagedFile(engine, small, 'notes/small.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
      writeFileSync(small, `---\ntitle: Small note\ntype: note\n---\n\nA short body.\n\n${FENCE([ROW(1, 'Added on disk')])}\n`);
      const inline = await refusal(submit(engine, f, 'delete_page', 'notes/small'));
      expect(inline).toMatchObject({ code: 'source_changed', message: 'The canonical file contains an uncoordinated local edit.' });

      const file = await importHuge(engine, f, 'notes/huge');
      writeFileSync(file, huge.replace('midpointmarker', `midpointmarker\n\n${FENCE([ROW(1, 'Added on disk')])}\n`));
      expect(await refusal(submit(engine, f, 'delete_page', 'notes/huge'))).toEqual(inline);
      expect(await refusal(submit(engine, f, 'delete_page', 'notes/huge', { purge: true }))).toEqual(inline);

      // A fence longer than a segment run is overlaid whole up to FENCE_MAX_BYTES (the bound withdrawal discovery and
      // the purge rewrite read a fence within), so a 9 MiB fence added on disk is drift like any other.
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ROW(i + 1, `Routine note number ${i + 1} about the weekly planning meeting`));
      const long = FENCE(rows(90_000));
      expect(Buffer.byteLength(long)).toBeGreaterThan(8 * 1024 * 1024);
      writeFileSync(file, huge.replace('midpointmarker', `midpointmarker\n\n${long}\n`));
      expect(await refusal(submit(engine, f, 'delete_page', 'notes/huge'))).toEqual(inline);
      // Over FENCE_MAX_BYTES the file's digest refuses before it holds more of the fence than the bound and one read.
      const longer = FENCE(rows(Math.ceil(FENCE_MAX_BYTES / ROW(1, 'x').length)));
      expect(Buffer.byteLength(longer)).toBeGreaterThan(FENCE_MAX_BYTES);
      writeFileSync(file, huge.replace('midpointmarker', `midpointmarker\n\n${longer}\n`));
      bodyDigestWork.largestHeld = 0;
      const refused = await refusal(submit(engine, f, 'delete_page', 'notes/huge'));
      expect(refused.code).toBe('page_body_segmented');
      expect(refused.message).toContain(`over the ${FENCE_MAX_BYTES}-byte bound`);
      expect(bodyDigestWork.largestHeld).toBeGreaterThan(FENCE_MAX_BYTES - SEGMENT_MAX_BYTES);
      expect(bodyDigestWork.largestHeld).toBeLessThanOrEqual(FENCE_MAX_BYTES + 2 * SEGMENT_MAX_BYTES);
      expect(readFileSync(file, 'utf8').includes('Routine note number 90000')).toBe(true);
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }
}), 900_000);
