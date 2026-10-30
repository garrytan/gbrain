/**
 * #7873: a remote upload over the single-string ceiling (the segmented streamed preparation, upload-streamed.ts)
 * cannot supply provenance stamps, as a remote put_page cannot.
 *
 * 1. Protects: commit_page_upload of a 25 MiB page whose frontmatter carries source_kind / ingested_via /
 *    ingested_at stores none of the caller's values; a replace of an unclassified page keeps the stamps of the page it
 *    replaces and is tiered by them.
 * 2. Fails when: a caller-written stamp reaches the stored frontmatter through the streamed path, or a replace drops
 *    the stored stamps or is tiered above them.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set (no embedding, no model calls).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { stagedUploadWork } from '../../src/core/persistence/page-upload.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

for (const kind of testBackends()) {
  describe(`#7873 streamed upload provenance stamps (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ctx = (): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
      transport: 'http', inboundFrameBytes: 4 * MiB, auth: { token: 'fixture', clientId: 'upload-stamps', principal: { kind: 'oauth_client', id: 'upload-stamps' },
        scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext);
    const call = async (name: string, params: Record<string, unknown>) => await op(name).handler(ctx(), params) as Record<string, any>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
        VALUES('upload-stamps','fixture-hash','upload-client','read write','default') ON CONFLICT (client_id) DO NOTHING`);
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('write_gate.agent_mode', 'off') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    }, 120_000);
    afterAll(async () => { await close(); });

    test('a 25 MiB remote upload stores none of the caller\'s stamps', async () => {
      const slug = 'notes/huge-stamped';
      const line = 'We agreed to ship the review checklist first and revisit pricing next week.\n\n';
      const text = `---\ntitle: Huge stamped\nsource_kind: forged-kind\ningested_via: forged-channel\ningested_at: '2020-01-01T00:00:00.000Z'\n---\n\n${line.repeat(Math.ceil(25 * MiB / line.length))}End.`;
      const session = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
      for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
        const piece = text.slice(at, at + PART_CHARS);
        await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: hex(piece) });
      }
      const streamed = stagedUploadWork.streamed;
      for (let attempt = 0; ; attempt++) {
        try { expect((await call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 })).state).toBe('committed'); break; }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
      }
      expect(stagedUploadWork.streamed).toBe(streamed + 1);
      const [row] = await engine.executeRaw<{ body_storage: string; frontmatter: Record<string, unknown> | string }>(
        'SELECT body_storage, frontmatter FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
      expect(row!.body_storage).toBe('segmented');
      const frontmatter = typeof row!.frontmatter === 'string' ? JSON.parse(row!.frontmatter) : row!.frontmatter;
      expect({ source_kind: frontmatter.source_kind, ingested_via: frontmatter.ingested_via, ingested_at: frontmatter.ingested_at })
        .toEqual({ source_kind: undefined, ingested_via: undefined, ingested_at: undefined });
    }, 600_000);

    test('a 25 MiB remote replace keeps the stored stamps of the page it replaces', async () => {
      const slug = 'notes/huge-restamped';
      const stored = { source_kind: 'webhook', ingested_via: 'webhook', ingested_at: '2026-01-02T03:04:05.000Z' };
      await engine.putPage(slug, { type: 'note', title: 'Huge restamped', compiled_truth: 'Captured body', timeline: '', frontmatter: stored,
        source_kind: 'webhook', ingested_via: 'webhook' } as never);
      await engine.executeRaw("UPDATE pages SET trust_tier = 'unknown' WHERE source_id = 'default' AND slug = $1", [slug]);
      // An external-tier write is scanned whole, which a 25 MiB body is too large for; the tier is what this test reads.
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('write_gate.external_mode', 'off') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
      const line = 'We agreed to ship the review checklist first and revisit pricing next week.\n\n';
      const text = `---\ntitle: Huge restamped\nsource_kind: forged-kind\ningested_via: forged-channel\ningested_at: '2020-01-01T00:00:00.000Z'\n---\n\n${line.repeat(Math.ceil(25 * MiB / line.length))}End.`;
      const session = await call('begin_page_upload', { slug, mode: 'replace', expected_revision: revision, total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
      for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
        const piece = text.slice(at, at + PART_CHARS);
        await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: hex(piece) });
      }
      const streamed = stagedUploadWork.streamed;
      for (let attempt = 0; ; attempt++) {
        try { expect((await call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 })).state).toBe('committed'); break; }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
      }
      expect(stagedUploadWork.streamed).toBe(streamed + 1);
      const [row] = await engine.executeRaw<{ body_storage: string; frontmatter: Record<string, unknown> | string; trust_tier: string }>(
        'SELECT body_storage, frontmatter, trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
      expect(row!.body_storage).toBe('segmented');
      const frontmatter = typeof row!.frontmatter === 'string' ? JSON.parse(row!.frontmatter) : row!.frontmatter;
      expect({ source_kind: frontmatter.source_kind, ingested_via: frontmatter.ingested_via, ingested_at: frontmatter.ingested_at }).toEqual(stored);
      expect(row!.trust_tier).toBe('external_untrusted');
    }, 600_000);
  });
}
