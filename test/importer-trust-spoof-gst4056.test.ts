/**
 * GST-4056: a remote writer can never make its text read as the transcript importer's, whatever maintenance runs after it.
 *
 * 1. Protects: a page the importer wrote is trusted (its speaker_owner marker is honored and accept-fences counts it as an
 *    imported transcript) only while its live text is the importer's. A remote edit_page, put_page, append_page, streamed
 *    upload (above the single-string ceiling) or edit of a segmented page drops that trust, and it stays dropped after a
 *    later maintenance write that carries no request (a tag change) and after a local tag change whose journal row was
 *    compacted away. A genuine imported page keeps its trust through contextual re-embedding and tag changes, which move
 *    updated_at but not its text. Remote put_page, append_page, streamed uploads and segmented edits keep the page's
 *    first-ingest record (source_kind, source_uri, ingested_via, ingested_at), as edit_page does since #10330.
 * 2. Fails when: the fallback to pages.ingested_via or to the revision's principal reads a remote writer's text as the
 *    importer's, a timestamp comparison drops a genuine page after contextual re-embedding, or a remote write replaces the
 *    first-ingest record with its own channel.
 *    A coordinated tag change (inline or segmented) keeps it; a raw rewrite that keeps the hash drops it; the importer
 *    re-importing unchanged text takes it back. Migration v342's backfill stamps a legacy importer or connector page the
 *    earlier rule trusted (a page only its first-ingest stamp vouched for is honored by speaker markers only), and never a
 *    page a remote writer is on record for, in the journal or in the page's archived versions.
 * 3. Repo-less brains (no repository): in-memory PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { FENCE_ACCEPTANCE_KEY, applyFenceAcceptance, isAccepted, listOutsideFencePages, loadFenceAcceptance, planFenceAcceptance } from '../src/core/transcripts/fence-acceptance.ts';
import { withWriteAttribution } from '../src/core/persistence/attribution.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { CONTENT_AUTHOR_BACKFILL_SQL, EXACT_AUTHOR_MARK } from '../src/core/persistence/content-author-schema.ts';
import { rechunkWork, runSegmentedRechunk } from '../src/core/page-body/rechunk.ts';
import { copyMigrationSources, copyPageToTarget } from '../src/commands/migrate-engine.ts';
import { needlePageBody, sealAtOldChunker } from './helpers/rechunk-segmented-cases.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

setDefaultTimeout(240_000);

const VIA = 'cli:transcripts-ingest';
const MARKER = { label: 'User', basis: 'session_user', turns: 1 };
const FENCE = [
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | A row from an imported conversation | fact | 0.8 | world | medium | 2026-01-01 | | conversation | |',
  '<!--- gbrain:facts:end -->',
].join('\n');
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const transcript = (id: string, body: string, fence = true) => ['---', 'type: conversation', `title: Session ${id}`, 'date: 2026-01-02',
  `speaker_owner: ${JSON.stringify(MARKER)}`, 'transcript_import:', '  harness: codex', `  session_id: ${id}`, '---', '',
  '**User** (2026-01-02T00:00:00Z): hello', '', body, '', ...(fence ? [FENCE, ''] : [])].join('\n');
/** Over PAGE_INLINE_MAX_BYTES (1 MiB): stored segmented. */
const LARGE = 'We agreed to ship the review checklist first and revisit pricing next week. '.repeat(16_000);
/** Over PAGE_MAX_BYTES (24 MiB), the single-string ceiling: only a streamed upload writes it. */
const HUGE = 'We agreed to ship the review checklist first and revisit pricing next week.\n'.repeat(Math.ceil(25 * 1024 ** 2 / 76));

for (const backend of testBackends()) describe(`[${backend}] importer trust follows the live text, not the first-ingest stamp (GST-4056)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let home: string;
  let target: PGLiteEngine;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-gst4056-'));
    target = new PGLiteEngine();
    await target.connect({ engine: 'pglite' } as never);
    await target.initSchema();
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
    await engine.executeRaw("INSERT INTO config (key, value) VALUES ('write_gate.agent_mode', 'off') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  }, 240_000);
  afterAll(async () => { await target?.disconnect(); await disposePersistenceConsumer(engine); await close?.(); resetGateway(); rmSync(home, { recursive: true, force: true }); }, 120_000);
  beforeEach(async () => { resetGateway(); });

  /** A remote agent (MCP dispatch, remote: true, a registered write-scope writer). */
  async function remote(op: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    return withEnv({ GBRAIN_HOME: home }, async () => {
      const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null } as never);
      const ctx = { remote: true, config: { engine: engine.kind }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
        auth: { token: 'fixture', clientId: 'remote-agent-example', scopes: ['read', 'write'], sourceId: 'default' }, inboundFrameBytes: 4 * 1024 ** 2 } as never;
      const out = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, op, params, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
      const text = out.content.map(c => c.text).join('\n');
      if (out.isError) throw new Error(`${op} refused: ${text}`);
      try { return JSON.parse(out.content[0]!.text) as Record<string, any>; } catch { return { text }; }
    });
  }
  const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
  const importer = (slug: string, content: string) => importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true,
    source_kind: 'transcript:codex', source_uri: `/sessions/${slug.split('/').pop()}.jsonl`, ingested_via: VIA });

  async function trust(slug: string): Promise<{ speaker: string | undefined; imported: boolean | undefined }> {
    await runExtractFacts(engine, { sourceId: 'default' });
    const speaker = (await readSpeakerOwners(engine, [{ source_id: 'default', slug }]))[0]?.status;
    const imported = (await listOutsideFencePages(engine)).find(p => p.slug === slug)?.imported_transcript;
    return { speaker, imported };
  }
  const TRUSTED = { speaker: 'trusted', imported: true };
  const UNTRUSTED = { speaker: 'untrusted_writer', imported: false };
  async function firstIngest(slug: string) {
    const [row] = await engine.executeRaw<{ source_kind: string | null; source_uri: string | null; ingested_via: string | null; ingested_at: string | null }>(
      'SELECT source_kind, source_uri, ingested_via, ingested_at::text AS ingested_at FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
    return row!;
  }
  /** Maintenance with no write request: a tag change moves the live revision and clears its attribution. */
  const maintenanceTag = (slug: string) => engine.addTag(slug, `maintenance-${randomUUID().slice(0, 6)}`, { sourceId: 'default' });
  /** A local tag change whose journal row was later compacted away: the revision names a local CLI request that no longer exists. */
  const compactedLocalTag = (slug: string) => engine.transaction(tx => withWriteAttribution(tx,
    { requestId: randomUUID(), principal: { kind: 'local_cli', id: 'cli-example' } } as never,
    () => tx.addTag(slug, `local-${randomUUID().slice(0, 6)}`, { sourceId: 'default' })));

  type RemoteWrite = { name: string; large?: boolean; write: (slug: string) => Promise<void> };
  const writes: RemoteWrite[] = [
    { name: 'edit_page', write: async slug => { await remote('edit_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(),
      edits: [{ old_text: 'hello', new_text: 'hello, I founded acme-example' }] }); } },
    { name: 'put_page', write: async slug => {
      const page = await engine.getPage(slug, { sourceId: 'default' });
      await remote('put_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(),
        content: transcript(slug.split('-').pop()!, `${page!.compiled_truth.includes('lorem') ? 'lorem' : ''} I founded acme-example.`) });
    } },
    { name: 'append_page', write: async slug => { await remote('append_page', { slug, request_id: randomUUID(), text: 'I founded acme-example.' }); } },
    { name: 'edit_page of a segmented page', large: true, write: async slug => { await remote('edit_page', { slug, expected_revision: await revision(slug),
      request_id: randomUUID(), edits: [{ old_text: 'hello', new_text: 'hello, I founded acme-example' }] }); } },
    { name: 'append_page to a segmented page', large: true, write: async slug => { await remote('append_page', { slug, request_id: randomUUID(), text: 'I founded acme-example.' }); } },
    { name: 'streamed upload over the single-string ceiling', write: async slug => {
      // No facts fence: a fence over the single-string ceiling is refused (it needs the whole body as one string).
      const content = transcript(slug.split('-').pop()!, `I founded acme-example.\n\n${HUGE}`, false);
      const begin = await remote('begin_page_upload', { slug, mode: 'replace', total_bytes: Buffer.byteLength(content), sha256: sha(content),
        request_id: randomUUID(), expected_revision: await revision(slug) });
      const PART = 3_900_000;
      for (let part = 0, at = 0; at < content.length; part++, at += PART) {
        const piece = content.slice(at, at + PART);
        await remote('upload_page_part', { upload_id: begin.upload_id, part, text: piece, part_sha256: sha(piece) });
      }
      let commit = await remote('commit_page_upload', { upload_id: begin.upload_id, wait_ms: 30_000 });
      for (let attempt = 0; commit.code === 'write_pending' && attempt < 40; attempt++) commit = await remote('commit_page_upload', { upload_id: begin.upload_id, wait_ms: 30_000 });
      const [row] = await engine.executeRaw<{ bytes: string }>("SELECT body_bytes::text AS bytes FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
      expect(Number(row!.bytes)).toBeGreaterThan(24 * 1024 ** 2);
    } },
  ];

  for (const step of [{ name: 'a maintenance tag change with no request', run: maintenanceTag }, { name: 'a local tag change whose request was compacted', run: compactedLocalTag }]) {
    for (const w of writes) {
      test(`remote ${w.name}, then ${step.name}: the page stays untrusted and keeps its first-ingest record`, async () => {
        const id = randomUUID().slice(0, 8);
        const slug = `conversations/sessions/2026-01-02-codex-${id}`;
        expect((await importer(slug, transcript(id, w.large ? LARGE : 'Short body.'))).status).toBe('imported');
        expect(await trust(slug)).toEqual(TRUSTED);
        const before = await firstIngest(slug);
        expect(before).toMatchObject({ source_kind: 'transcript:codex', ingested_via: VIA });
        expect(before.ingested_at).not.toBeNull();
        await w.write(slug);
        expect(await trust(slug)).toEqual(UNTRUSTED);
        await step.run(slug);
        expect(await trust(slug)).toEqual(UNTRUSTED);
        expect(await firstIngest(slug)).toEqual(before);
        // The importer writing the page again takes it back.
        expect((await importer(slug, transcript(id, 'Short body, imported again.'))).status).toBe('imported');
        expect(await trust(slug)).toEqual(TRUSTED);
      });
    }
  }

  test('a genuine imported page stays trusted through contextual re-embedding and tag changes, and through a remote write of identical text', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importer(slug, content);
    const [{ updated_at: before }] = await engine.executeRaw<{ updated_at: string }>("SELECT updated_at::text AS updated_at FROM pages WHERE slug = $1", [slug]);
    await engine.updatePageContextualRetrievalState(slug, 'default', 'title', 'corpus-example');
    await maintenanceTag(slug);
    await compactedLocalTag(slug);
    expect(await remote('put_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(), content })).toMatchObject({ status: 'skipped' });
    const [{ updated_at: after }] = await engine.executeRaw<{ updated_at: string }>("SELECT updated_at::text AS updated_at FROM pages WHERE slug = $1", [slug]);
    expect(after).not.toBe(before);
    expect(await trust(slug)).toEqual(TRUSTED);
  });

  test('a page that never had importer text is not trusted, whatever its first-ingest stamp says', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await remote('put_page', { slug, request_id: randomUUID(), content: transcript(id, 'Remote body.') });
    await engine.executeRaw("UPDATE pages SET ingested_via = $2, source_kind = 'transcript:codex' WHERE slug = $1", [slug, VIA]);
    await maintenanceTag(slug);
    expect(await trust(slug)).toEqual(UNTRUSTED);
  });

  /** A page as a brain before migration v341 holds it: no content author (written past the trigger, as no writer can). */
  /** A page as an upgrade finds it before v342: no author. An exact write, so no DDL lock races a background chunk writer. */
  const legacy = (slug: string, sourceId = 'default') => engine.executeRaw(
    'UPDATE pages SET content_author = NULL, content_author_hash = $3 WHERE source_id = $1 AND slug = $2', [sourceId, slug, EXACT_AUTHOR_MARK]);
  async function author(slug: string, sourceId = 'default') {
    const [row] = await engine.executeRaw<{ content_author: string | null; stamped: boolean }>(
      'SELECT content_author, content_author_hash IS NOT DISTINCT FROM content_hash AS stamped FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
    return row!;
  }

  test('the v342 backfill stamps a genuine legacy imported page, which then survives re-embedding, tag changes and a second backfill', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await engine.updatePageContextualRetrievalState(slug, 'default', 'title', 'corpus-example');
    await maintenanceTag(slug);
    await compactedLocalTag(slug);
    await legacy(slug);
    expect(await trust(slug)).toEqual(UNTRUSTED);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    expect(await trust(slug)).toEqual(TRUSTED);
    await engine.updatePageContextualRetrievalState(slug, 'default', 'title', 'corpus-example-2');
    await maintenanceTag(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    expect(await trust(slug)).toEqual(TRUSTED);
  });

  test('the v342 backfill stamps a legacy imported page whose only remote request was a committed no-op', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importer(slug, content);
    expect(await remote('put_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(), content })).toMatchObject({ status: 'skipped' });
    const [request] = await engine.executeRaw<{ state: string; noop: string | null }>(
      "SELECT state, outcome->>'noop' AS noop FROM persistence_requests WHERE slug = $1 AND principal_kind = 'local_stdio'", [slug]);
    expect(request).toEqual({ state: 'committed', noop: 'true' });
    await legacy(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
  });

  test('a retried engine migration copies the source page\'s author exactly, clearing one the source no longer has', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await copyMigrationSources(engine, target);
    const page = async () => (await engine.getPage(slug, { sourceId: 'default' }))!;
    await copyPageToTarget(engine, target, await page());
    const copied = async () => (await target.executeRaw<{ content_author: string | null; stamped: boolean }>(
      'SELECT content_author, content_author_hash IS NOT DISTINCT FROM content_hash AS stamped FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0];
    expect(await copied()).toEqual({ content_author: VIA, stamped: true });
    await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' I founded acme-example.' WHERE source_id = 'default' AND slug = $1", [slug]);
    await engine.executeRaw("UPDATE pages SET compiled_truth = replace(compiled_truth, ' I founded acme-example.', '') WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(await author(slug)).toEqual({ content_author: null, stamped: false });
    await copyPageToTarget(engine, target, await page());
    expect(await copied()).toEqual({ content_author: null, stamped: false });
  });

  test('the v342 backfill never stamps a legacy page a remote writer edited before maintenance moved its revision', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await remote('edit_page', { slug, expected_revision: await revision(slug), request_id: randomUUID(),
      edits: [{ old_text: 'hello', new_text: 'hello, I founded acme-example' }] });
    await maintenanceTag(slug);
    await legacy(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: null, stamped: false });
    expect(await trust(slug)).toEqual(UNTRUSTED);
  });

  test('the v342 backfill never stamps a legacy page whose remote write requests were compacted', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    for (const say of ['I founded acme-example.', 'I also founded fund-a.']) await remote('append_page', { slug, request_id: randomUUID(), text: say });
    await maintenanceTag(slug);
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.slug = $1 AND v.write_principal_kind IN ('oauth_client', 'legacy_token', 'local_stdio')`, [slug]);
    expect(n).toBeGreaterThan(0);
    await compactWriteReceipts(engine, 0);
    const kinds = await engine.executeRaw<{ operation: string; compacted: boolean }>(
      "SELECT operation, compacted FROM persistence_requests WHERE slug = $1 AND principal_kind = 'local_stdio' ORDER BY sequence", [slug]);
    expect(kinds.map(k => k.operation)).toEqual(['append_page', 'append_page']);
    expect(kinds[0]!.compacted).toBe(true);
    await legacy(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: null, stamped: false });
    expect(await trust(slug)).toEqual(UNTRUSTED);
  });

  test('the v342 backfill stamps a legacy connector page in a connector source only', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('texts', 'texts', '{\"kind\":\"imessage\"}'::jsonb) ON CONFLICT (id) DO NOTHING");
    const slug = `imessage/2026-01-02-${randomUUID().slice(0, 8)}`;
    const content = ['---', 'type: conversation', 'title: Chat', `speaker_owner: ${JSON.stringify({ label: 'Me', basis: 'is_from_me', turns: 1 })}`, '---', '',
      '**Me** (2026-01-02T00:00:00Z): hello', ''].join('\n');
    for (const sourceId of ['texts', 'default']) {
      await importFromContent(engine, slug, content, { sourceId, noEmbed: true });
      await legacy(slug, sourceId);
    }
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug, 'texts')).toEqual({ content_author: 'connector:imessage', stamped: true });
    expect(await author(slug, 'default')).toEqual({ content_author: null, stamped: false });
    const status = await readSpeakerOwners(engine, [{ source_id: 'texts', slug }, { source_id: 'default', slug }]);
    expect(status.map(s => s.status)).toEqual(['trusted', 'untrusted_writer']);
  });

  test('a local write that declares no author into a connector source is not a connector write', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('texts', 'texts', '{\"kind\":\"imessage\"}'::jsonb) ON CONFLICT (id) DO NOTHING");
    const slug = `imessage/2026-01-02-${randomUUID().slice(0, 8)}`;
    const content = ['---', 'type: conversation', 'title: Chat', `speaker_owner: ${JSON.stringify({ label: 'Me', basis: 'is_from_me', turns: 1 })}`, '---', '',
      '**Me** (2026-01-02T00:00:00Z): hello', ''].join('\n');
    await importFromContent(engine, slug, content, { sourceId: 'texts', noEmbed: true });
    expect((await readSpeakerOwners(engine, [{ source_id: 'texts', slug }]))[0]!.status).toBe('untrusted_writer');
    await importFromContent(engine, slug, content.replace('hello', 'hello again'), { sourceId: 'texts', noEmbed: true, content_author: 'connector:imessage' });
    expect((await readSpeakerOwners(engine, [{ source_id: 'texts', slug }]))[0]!.status).toBe('trusted');
  });

  test('a coordinated tag change keeps the importer\'s trust on an inline and a segmented page', async () => {
    for (const large of [false, true]) {
      const id = randomUUID().slice(0, 8);
      const slug = `conversations/sessions/2026-01-02-codex-${id}`;
      await importer(slug, transcript(id, large ? LARGE : 'Short body.'));
      await remote('add_tag', { slug, tag: `coordinated-${id}`, request_id: randomUUID() });
      expect(await trust(slug)).toEqual(TRUSTED);
      await remote('remove_tag', { slug, tag: `coordinated-${id}`, request_id: randomUUID() });
      expect(await trust(slug)).toEqual(TRUSTED);
    }
  });

  test('a rewrite that keeps the stored hash drops the importer\'s trust, and an unchanged re-import never takes it back', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importer(slug, content);
    await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' I founded acme-example.' WHERE source_id = 'default' AND slug = $1", [slug]);
    expect((await author(slug)).content_author).toBeNull();
    const other = `conversations/sessions/2026-01-02-codex-${randomUUID().slice(0, 8)}`;
    await importFromContent(engine, other, content, { sourceId: 'default', noEmbed: true });
    expect(await trust(other)).toEqual(UNTRUSTED);
    expect((await importer(other, content)).status).toBe('skipped');
    expect(await trust(other)).toEqual(UNTRUSTED);
  });

  test('a re-import that changes only tags never makes untrusted text the importer\'s', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importFromContent(engine, slug, content, { sourceId: 'default', noEmbed: true });
    expect(await trust(slug)).toEqual(UNTRUSTED);
    expect((await importer(slug, content.replace('type: conversation\n', 'type: conversation\ntags: [retagged-example]\n'))).status).toBe('imported');
    expect((await author(slug)).content_author).not.toBe(VIA);
    expect(await trust(slug)).toEqual(UNTRUSTED);
  });

  test('an engine copy over identical text replaces the target\'s author with the source\'s', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await copyMigrationSources(engine, target);
    const page = async () => (await engine.getPage(slug, { sourceId: 'default' }))!;
    await copyPageToTarget(engine, target, await page());
    await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' I founded acme-example.' WHERE source_id = 'default' AND slug = $1", [slug]);
    await engine.executeRaw("UPDATE pages SET compiled_truth = replace(compiled_truth, ' I founded acme-example.', ''), content_author = 'mcp:put_page', content_author_hash = NULL WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(await author(slug)).toEqual({ content_author: 'mcp:put_page', stamped: true });
    await copyPageToTarget(engine, target, await page());
    const [copied] = await target.executeRaw<{ content_author: string | null; stamped: boolean }>(
      'SELECT content_author, content_author_hash IS NOT DISTINCT FROM content_hash AS stamped FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
    expect(copied).toEqual({ content_author: 'mcp:put_page', stamped: true });
  });

  test('an acceptance recorded for a page\'s exact content survives the upgrade that attributes the page as legacy', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await runExtractFacts(engine, { sourceId: 'default' });
    await applyFenceAcceptance(engine, await planFenceAcceptance(engine));
    await engine.executeRaw(`UPDATE pages SET updated_at = ingested_at + interval '1 hour', revision_write_request_id = NULL, revision_principal_kind = NULL
      WHERE source_id = 'default' AND slug = $1`, [slug]);
    await legacy(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: `legacy:${VIA}`, stamped: true });
    const accepted = async () => isAccepted((await listOutsideFencePages(engine)).find(p => p.slug === slug)!, await loadFenceAcceptance(engine));
    expect(await accepted()).toBe(true);
    expect((await planFenceAcceptance(engine)).pages.map(p => p.slug)).not.toContain(slug);
    const stored = JSON.parse((await engine.getConfig(FENCE_ACCEPTANCE_KEY))!) as Array<Record<string, unknown>>;
    await engine.setConfig(FENCE_ACCEPTANCE_KEY, JSON.stringify(stored.map(({ content_hash: _hash, ...entry }) => entry)));
    expect(await accepted()).toBe(false);
    await engine.setConfig(FENCE_ACCEPTANCE_KEY, JSON.stringify(stored));
    await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' I founded acme-example.' WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(await accepted()).toBe(false);
    await engine.unsetConfig(FENCE_ACCEPTANCE_KEY);
  });

  test('a timeline change that leaves the stored hash stale is never certified by an unchanged re-import', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importer(slug, content);
    await engine.executeRaw("UPDATE pages SET timeline = coalesce(timeline, '') || E'\\n- 2026-01-03: I founded acme-example.' WHERE source_id = 'default' AND slug = $1", [slug]);
    await engine.executeRaw("UPDATE pages SET text_projection_revision = knowledge_revision WHERE source_id = 'default' AND slug = $1", [slug]);
    expect((await author(slug)).content_author).toBeNull();
    await importer(slug, content);
    const [row] = await engine.executeRaw<{ timeline: string | null }>("SELECT timeline FROM pages WHERE source_id = 'default' AND slug = $1", [slug]);
    const trusted = (await author(slug)).stamped && (await author(slug)).content_author === VIA;
    expect(trusted && (row!.timeline ?? '').includes('acme-example')).toBe(false);
    expect(await trust(slug)).toEqual(UNTRUSTED);
  });

  test('a segmented re-import that rebuilds a stale projection from identical bytes keeps the importer\'s trust', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, LARGE);
    await importer(slug, content);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    await engine.executeRaw("UPDATE pages SET text_projection_revision = gen_random_uuid() WHERE source_id = 'default' AND slug = $1", [slug]);
    await importer(slug, content);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    expect(await trust(slug)).toEqual(TRUSTED);
  });

  test('a segmented re-chunk keeps the importer\'s trust (the bytes do not change)', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, needlePageBody(), false));
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    await sealAtOldChunker(engine, slug);
    const flips = rechunkWork.flips;
    await runSegmentedRechunk(engine, { apply: true, slug });
    expect(rechunkWork.flips).toBeGreaterThan(flips);
    expect(await author(slug)).toEqual({ content_author: VIA, stamped: true });
    expect((await readSpeakerOwners(engine, [{ source_id: 'default', slug }]))[0]?.status).toBe('trusted');
  });

  test.skipIf(backend !== 'postgres')('the v342 backfill never stamps a page a write changed while the backfill waited for its row', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    await importer(slug, transcript(id, 'Short body.'));
    await legacy(slug);
    // The editor polls for the waiting backfill on its own connection, so the race needs two pooled connections only.
    let locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const editor = engine.transaction(async tx => {
      await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' I founded acme-example.', content_hash = 'edited-' || content_hash WHERE source_id = 'default' AND slug = $1", [slug]);
      locked();
      for (let i = 0; i < 200; i++) {
        const [{ n }] = await tx.executeRaw<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%content_author%'");
        if (n > 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    await holding;
    const backfill = engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    await editor;
    await backfill;
    expect(await author(slug)).toEqual({ content_author: null, stamped: false });
  });

  test('the v342 backfill honors a page only its first-ingest stamp vouches for in speaker markers, not in fence acceptance', async () => {
    const id = randomUUID().slice(0, 8);
    const slug = `conversations/sessions/2026-01-02-codex-${id}`;
    const content = transcript(id, 'Short body.');
    await importer(slug, content);
    await engine.executeRaw(`UPDATE pages SET updated_at = ingested_at + interval '1 hour', revision_write_request_id = NULL, revision_principal_kind = NULL
      WHERE source_id = 'default' AND slug = $1`, [slug]);
    await legacy(slug);
    await engine.executeRaw(CONTENT_AUTHOR_BACKFILL_SQL);
    expect(await author(slug)).toEqual({ content_author: `legacy:${VIA}`, stamped: true });
    expect(await trust(slug)).toEqual({ speaker: 'trusted', imported: false });
    expect((await importer(slug, content)).status).toBe('skipped');
    expect(await trust(slug)).toEqual({ speaker: 'trusted', imported: false });
  });
});
