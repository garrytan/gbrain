/**
 * Large-pages hardening (g): the file side of a segmented page's drift check stops reading a facts fence at its bound.
 *
 * 1. Protects: overlaidFileBodyDigests (page-body/body-digests.ts), the overlaid file digest the drift check of a
 *    segmented page over the single-string ceiling computes when the source has a withdrawal ledger that applies,
 *    refuses a facts fence longer than FENCE_MAX_BYTES (counted from its begin marker) with `page_body_segmented`
 *    after reading at most the bound plus a small fixed lookahead of that fence, never a further segment. A fence of
 *    exactly the bound, begin marker through end marker, is still overlaid (the lookahead sees its end marker).
 * 2. Fails when: the overlay reads the region in fixed 1 MiB steps and checks the open block only after each step, so
 *    a fence whose bound falls on a step boundary is read up to a whole segment (1 MiB) past the bound before it refuses.
 * 3. The first two tests call the digest directly through a ByteSource that records the furthest byte read (no
 *    database is involved, so they run once). The third runs the real drift check (delete_page of a segmented page whose
 *    file gained a fence over the bound) on PGLite, and on Postgres when DATABASE_URL is set, measuring the file bytes
 *    the overlay pass read (`bodyDigestWork.fileBytes` less the scan pass, which reads the file once whole).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { FENCE_MAX_BYTES, SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { bodyDigestWork, fileBodyDigests, overlaidFileBodyDigests, type ByteSource } from '../../src/core/page-body/body-digests.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

/** The most a refusing read may pass the bound by inside the fence: a held-back UTF-8 sequence and the proving byte, with room to spare. */
const LOOKAHEAD = 16;
const M = SEGMENT_MAX_BYTES;
const BEGIN = '<!--- gbrain:facts:begin -->';
const END = '<!--- gbrain:facts:end -->';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const row = (n: number) => `| ${n} | Routine note € number ${n} about the weekly planning meeting | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n`;
/** An unclosed fence block of at least `bytes` bytes. */
function openFence(bytes: number): string {
  const rows: string[] = [BEGIN, '\n', HEADER];
  for (let n = 1, size = Buffer.byteLength(BEGIN + '\n' + HEADER); size < bytes; n++) { const r = row(n); rows.push(r); size += Buffer.byteLength(r); }
  return rows.join('');
}
/** A complete fence block of exactly `bytes` bytes, begin marker through end marker. */
function exactFence(bytes: number): string {
  const head = openFence(bytes - Buffer.byteLength(END) - 2 * M);
  const left = bytes - Buffer.byteLength(head) - Buffer.byteLength(END) - 1;
  return head + ' '.repeat(left) + '\n' + END;
}

/** A Buffer read through `subarray` only, recording the furthest byte any read reached. */
function recorded(buffer: Buffer): ByteSource & { furthest: number } {
  const source = { length: buffer.length, furthest: 0, subarray(start?: number, end?: number) {
    const to = Math.min(end ?? buffer.length, buffer.length);
    if (to > source.furthest) source.furthest = to;
    return buffer.subarray(start, to);
  } };
  return source;
}

const HEAD = '---\ntitle: Fence bound\ntype: note\n---\n\n';
/** The file's truth region start in its virtual stream (no prefix, no BOM), as the scan splits it. */
function truthStart(content: string): number {
  const file = fileBodyDigests(Buffer.from(content, 'utf8'), { prefix: new Uint8Array(0), skip: 0 }, 'probe.md', {});
  if (file.kind !== 'ok') throw new Error(file.reason);
  const first = file.regions.truth[0];
  if (!first || !('start' in first)) throw new Error('the truth region is not a byte range');
  return first.start;
}
/** Padding after `offset` bytes of the truth region that puts the next byte on a 1 MiB step (where a fixed-step reader passes the bound by a segment). */
const padTo = (offset: number) => { const left = (M - (offset % M)) % M; return left === 0 ? '' : left === 1 ? '\n' : 'p'.repeat(left - 1) + '\n'; };

describe('the overlaid file digest reads a fence up to its bound and a fixed lookahead', () => {
  test('a fence over the bound refuses after reading at most the bound and the lookahead of it', async () => {
    const lead = HEAD + '# Fence bound\n';
    const start = truthStart(lead);
    const before = lead + padTo(Buffer.byteLength(lead) - start);
    expect((Buffer.byteLength(before) - start) % M).toBe(0);
    const buffer = Buffer.from(before + openFence(FENCE_MAX_BYTES + 3 * M) + '\n', 'utf8');
    const fenceAt = Buffer.byteLength(before);
    const reading = { prefix: new Uint8Array(0), skip: 0 };
    const file = fileBodyDigests(buffer, reading, 'bound.md', {});
    if (file.kind !== 'ok') throw new Error(file.reason);
    expect(file.factsFence).toBe(true);
    const source = recorded(buffer);
    let refusedAt = 0;
    await expect(overlaidFileBodyDigests(source, reading, file.regions, async text => text, bytes => { refusedAt = bytes; return new Error('fence refused'); }))
      .rejects.toThrow('fence refused');
    const read = source.furthest - fenceAt;
    console.log(`[lp-g] fence read ${read} bytes before refusing (bound ${FENCE_MAX_BYTES}, ${read - FENCE_MAX_BYTES} past it); refused at ${refusedAt}`);
    expect(refusedAt).toBeGreaterThan(FENCE_MAX_BYTES);
    expect(read).toBeGreaterThan(FENCE_MAX_BYTES);
    expect(read).toBeLessThanOrEqual(FENCE_MAX_BYTES + LOOKAHEAD);
  }, 300_000);

  test('a fence of exactly the bound is overlaid whole, its end marker seen within the lookahead', async () => {
    const lead = HEAD + '# Fence bound\n';
    const start = truthStart(lead);
    const before = lead + padTo(Buffer.byteLength(lead) - start);
    const fence = exactFence(FENCE_MAX_BYTES);
    expect(Buffer.byteLength(fence)).toBe(FENCE_MAX_BYTES);
    const buffer = Buffer.from(before + fence + '\n\nAfter the fence.\n', 'utf8');
    const reading = { prefix: new Uint8Array(0), skip: 0 };
    const file = fileBodyDigests(buffer, reading, 'exact.md', {});
    if (file.kind !== 'ok') throw new Error(file.reason);
    const overlays: string[] = [];
    const digests = await overlaidFileBodyDigests(recorded(buffer), reading, file.regions, async text => { overlays.push(text); return text; },
      bytes => new Error(`refused at ${bytes}`));
    expect(digests).toEqual(file.digests);
    expect(overlays.some(text => text.includes(BEGIN) && text.includes(END))).toBe(true);
  }, 300_000);
});

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

for (const { backend, databaseUrl } of pathologicalArms()) describe(`the drift check refuses an over-bound fence within the lookahead (${backend})`, () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-lp-g-'));
  homes.push(home);
  const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => withEnv(env(), async () => {
    if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }), 120_000);
  afterAll(async () => withEnv(env(), async () => { await disposePersistenceConsumer(engine); await close?.(); }), 120_000);

  test('delete_page of a segmented page whose file gained a fence over the bound: page_body_segmented, the overlay stops at the bound', async () => {
    await withEnv(env(), async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const root = join(home, 'src');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root });
      const sourceId = `lp-g-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as OperationContext;

      const slug = 'notes/fence-bound';
      const file = join(root, `${slug}.md`);
      const huge = conversationPage(PAGE_MAX_BYTES + 512 * 1024, { seed: 97, needles: [{ at: 0.5, word: 'midpointmarker' }] });
      writeFileSync(file, huge);
      expect(await importManagedFile(engine, file, `${slug}.md`, { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
      const [page] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      expect(page!.body_storage).toBe('segmented');
      // Any '*' withdrawal applies to every page of the source, so the drift check overlays the file's fences.
      await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
        VALUES ($1, 'world', '*', gbrain_fact_fingerprint('Some unrelated withdrawn claim')) ON CONFLICT DO NOTHING`, [sourceId]);

      // The fence begins on a 1 MiB step of the truth region, so its bound falls on a step boundary.
      const cut = huge.indexOf('midpointmarker') + 'midpointmarker'.length;
      const start = truthStart(huge);
      const head = huge.slice(0, cut) + '\n\n';
      const before = head + padTo(Buffer.byteLength(head) - start);
      expect((Buffer.byteLength(before) - start) % M).toBe(0);
      writeFileSync(file, before + openFence(FENCE_MAX_BYTES + 2 * M) + END + '\n' + huge.slice(cut));
      const fileBytes = statSync(file).size;
      // `bodyDigestWork.fileBytes` counts the scan (the file once whole), the region digests (each region once) and the overlay pass:
      // the truth region before the fence read and hashed as emitted (twice its bytes), then the fence as far as it was read.
      // test-reads-source-ok[raw-bytes]: reads this test's own fixture page file to measure its regions, not src/ text.
      const scanned = fileBodyDigests(Buffer.from(readFileSync(file)), { prefix: new Uint8Array(0), skip: 0 }, 'probe.md', {});
      if (scanned.kind !== 'ok') throw new Error(scanned.reason);
      const regionBytes = [...scanned.regions.truth, ...scanned.regions.timeline].reduce((n, piece) => n + ('text' in piece ? Buffer.byteLength(piece.text) : piece.end - piece.start), 0);

      const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
      bodyDigestWork.fileBytes = 0;
      let refusal: { code?: string; message: string } | undefined;
      try {
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
      } catch (error) { refusal = { code: (error as { code?: string }).code, message: (error as Error).message }; }
      expect(refusal?.code).toBe('page_body_segmented');
      expect(refusal?.message).toContain(`over the ${FENCE_MAX_BYTES}-byte bound`);
      const fenceRead = bodyDigestWork.fileBytes - fileBytes - regionBytes - 2 * (Buffer.byteLength(before) - start);
      console.log(`[lp-g] ${backend}: the overlay pass read ${fenceRead} bytes of the fence (bound ${FENCE_MAX_BYTES}, ${fenceRead - FENCE_MAX_BYTES} past it)`);
      expect(fenceRead).toBeGreaterThan(FENCE_MAX_BYTES);
      expect(fenceRead).toBeLessThanOrEqual(FENCE_MAX_BYTES + LOOKAHEAD);
    });
  }, 900_000);
});
