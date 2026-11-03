/**
 * Wave B PR 3: an upload over the single-string ceiling (PAGE_MAX_BYTES, 24 MiB) commits through the segmented
 * streamed preparation (persistence/upload-streamed.ts).
 *
 * 1. Protects: a 25 MiB create upload lands segmented and reads back byte-identical with the content_hash of exactly
 *    those bytes; a replace above 24 MiB keeps its expected_revision precondition (a moved page refuses with
 *    revision_changed and releases the reservation) and the shrink guard (a 50 MiB page replaced by 24.5 MiB refuses
 *    page_shrink_refused until allow_shrink); no step builds the body as one string (stagedUploadWork: no whole-text
 *    read, one streamed preparation, no part held over 4 MiB); a remote writer under the default write gate is refused
 *    file_too_large at begin, as put_page over the ceiling is, and nothing is staged.
 * 2. Fails when: begin refuses total_bytes over 24 MiB, commit reads the staged parts back as one string, the revision
 *    or shrink guard is skipped for a large replace, or the write gate is bypassed for an agent-written page.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set (no embedding, no model calls).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { stagedUploadWork } from '../../src/core/persistence/page-upload.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { ContentHashStream } from '../../src/core/page-body/content-hash-stream.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../../src/core/facts-fence.ts';
import { segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
/** A synthetic conversation of at least `bytes` ASCII bytes, ending without whitespace (a page body is stored trimmed). */
function conversation(bytes: number, tag: string): string {
  const turns: string[] = [`# Conversation ${tag}\n\n`];
  for (let i = 0, n = 0; n < bytes; i++) {
    const turn = `**User (${tag} ${i}):** What did we decide about the launch plan for week ${i}?\n\n**Assistant:** ${'We agreed to ship the review checklist first and revisit pricing next week. '.repeat(6)}\n\n`;
    turns.push(turn);
    n += turn.length;
  }
  return `${turns.join('')}End of conversation ${tag}.`;
}

for (const kind of testBackends()) {
  describe(`uploads over the single-string ceiling (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    const ctx = (): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
      transport: 'http', inboundFrameBytes: 4 * MiB, auth: { token: 'fixture', clientId: 'upload-big', principal: { kind: 'oauth_client', id: 'upload-big' },
        scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] } } as unknown as OperationContext);
    const call = async (name: string, params: Record<string, unknown>) => await op(name).handler(ctx(), params) as Record<string, any>;
    const refusal = async (name: string, params: Record<string, unknown>) => {
      try { await op(name).handler(ctx(), params); } catch (error) { if (error instanceof OperationError) return error; throw error; }
      throw new Error(`${name} did not refuse`);
    };
    const staged = async (text: string, slug: string, over: Record<string, unknown> = {}) => {
      const session = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(), ...over });
      for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
        const piece = text.slice(at, at + PART_CHARS);
        await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: hex(piece) });
      }
      return session.upload_id as string;
    };
    /** commit_page_upload, repeated (as its pending reply says) until the write ends: a large preparation outlasts one wait. */
    const commit = async (params: Record<string, unknown>) => {
      for (let attempt = 0; ; attempt++) {
        try { return await call('commit_page_upload', { ...params, wait_ms: 30_000 }); }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
      }
    };
    const commitRefusal = async (params: Record<string, unknown>) => {
      try { await commit(params); } catch (error) { if (error instanceof OperationError) return error; throw error; }
      throw new Error('commit_page_upload did not refuse');
    };
    const stored = async (slug: string) => (await engine.executeRaw<{ id: number; body_storage: string; content_hash: string; title: string; type: string; frontmatter: Record<string, unknown> }>(
      'SELECT id, body_storage, content_hash, title, type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]!;
    const expectStoredBody = async (slug: string, text: string) => {
      const page = await stored(slug);
      expect(page.body_storage).toBe('segmented');
      const body = await materializeSegmentedBody(engine, Number(page.id), 'default');
      expect({ bytes: Buffer.byteLength(body.compiled_truth), sha: hex(body.compiled_truth), timeline: body.timeline }).toEqual({ bytes: Buffer.byteLength(text), sha: hex(text), timeline: '' });
      const tags = (await engine.executeRaw<{ tag: string }>('SELECT t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.id = $1 ORDER BY t.tag', [page.id])).map(row => row.tag);
      const frontmatter = typeof page.frontmatter === 'string' ? JSON.parse(page.frontmatter) : page.frontmatter;
      expect(ContentHashStream.begin(page).pushTruth(text).finish({ frontmatter, tags })).toBe(page.content_hash);
    };
    const counters = async () => Object.fromEntries((await engine.executeRaw<{ key: string; intent_bytes: unknown; outstanding_count: unknown }>(
      `SELECT key, intent_bytes, outstanding_count FROM persistence_counters WHERE key LIKE '%:staged' OR key LIKE '%:uploads' ORDER BY key`))
      .map(row => [row.key, [Number(row.intent_bytes), Number(row.outstanding_count)]]));
    const setConfig = async (key: string, value: string) =>
      engine.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    const privateFactRows = async (slug: string) => {
      const [row] = await engine.executeRaw<{ id: number; storage: string; truth: string | null; timeline: string | null }>(
        'SELECT id, body_storage AS storage, compiled_truth AS truth, timeline FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
      const fences = row!.storage === 'segmented'
        ? await segmentedFactsFenceView(engine, { id: Number(row!.id), slug, source_id: 'default' }).then(view => [view.body, view.timeline])
        : [parseFactsFence(row!.truth ?? ''), parseFactsFence(row!.timeline ?? '')];
      return fences.flatMap(fence => fence.facts).filter(fact => fact.visibility !== 'world').map(fact => fact.claim);
    };
    const revisionOf = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
        VALUES('upload-big','fixture-hash','upload-client','read write','default') ON CONFLICT (client_id) DO NOTHING`);
    }, 120_000);
    afterAll(async () => { await close(); });

    test('under the default write gate a remote writer is refused file_too_large at begin and nothing is staged', async () => {
      const total = PAGE_MAX_BYTES + MiB;
      const refused = await refusal('begin_page_upload', { slug: 'notes/gated-huge', mode: 'create', total_bytes: total, sha256: 'a'.repeat(64), request_id: randomUUID() });
      expect({ code: refused.code, wire: JSON.stringify(refused.toJSON()).includes('file_too_large') }).toEqual({ code: 'request_too_large', wire: true });
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_body_stagings WHERE kind = 'upload'"))[0]!.n).toBe(0);
    }, 60_000);

    test('a 25 MiB create lands segmented, byte-identical with its content_hash, and no step holds it as one string', async () => {
      await setConfig('write_gate.agent_mode', 'off');
      const slug = 'notes/huge-conversation';
      const text = conversation(25 * MiB, 'create');
      const before = { ...stagedUploadWork };
      const prior = await counters();
      const id = await staged(text, slug);
      stagedUploadWork.largestPart = 0;
      const receipt = await commit({ upload_id: id });
      expect({ state: receipt.state, status: receipt.status }).toEqual({ state: 'committed', status: 'created_or_updated' });
      expect({ wholeTexts: stagedUploadWork.wholeTexts - before.wholeTexts, streamed: stagedUploadWork.streamed - before.streamed }).toEqual({ wholeTexts: 0, streamed: 1 });
      expect(stagedUploadWork.largestPart).toBeLessThanOrEqual(4 * MiB);
      expect(stagedUploadWork.largestPart).toBeGreaterThan(0);
      await expectStoredBody(slug, text);
      expect((await commit({ upload_id: id })).request_id).toBe(receipt.request_id);
      const after = await counters();
      for (const [key, value] of Object.entries(after)) expect([key, value]).toEqual([key, prior[key] ?? [0, 0]]);
    }, 600_000);

    for (const [label, head, close] of [['Visibility: Private', 'Visibility: Private\n', '---'], ['a duplicate visibility key', 'visibility: private\nvisibility: world\n', '---'],
      ['an unparseable block', 'visibility: private\nfoo: [unclosed\n', '---'], ['a block closed with dots', 'visibility: private\n', '...']] as const) {
      test(`a 25 MiB upload that asks for visibility: private as ${label} is refused and nothing is stored (#7841)`, async () => {
        await setConfig('write_gate.agent_mode', 'off');
        const slug = `notes/huge-private-request-${label.replace(/\W+/g, '-').toLowerCase()}`;
        const text = `---\ntitle: Huge private request\ntype: note\n${head}${close}\n${conversation(25 * MiB, 'private')}`;
        const id = await staged(text, slug);
        const refused = await commitRefusal({ upload_id: id });
        expect(refused.code).toBe(label === 'Visibility: Private' ? 'visibility_not_applied' : 'invalid_params');
        expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
      }, 600_000);
    }

    test('a replace above 24 MiB commits at its expected_revision and refuses with revision_changed after the page moved', async () => {
      const slug = 'notes/huge-conversation';
      const v2 = conversation(25.5 * MiB, 'replace');
      const id = await staged(v2, slug, { mode: 'replace', expected_revision: await revisionOf(slug) });
      await commit({ upload_id: id });
      await expectStoredBody(slug, v2);

      const prior = await counters();
      const stale = conversation(25 * MiB, 'stale');
      const staleId = await staged(stale, slug, { mode: 'replace', expected_revision: await revisionOf(slug) });
      await call('add_tag', { slug, tag: 'moved' });
      expect((await commitRefusal({ upload_id: staleId })).code).toBe('revision_changed');
      const after = await counters();
      for (const [key, value] of Object.entries(after)) expect([key, value]).toEqual([key, prior[key] ?? [0, 0]]);
      const body = await materializeSegmentedBody(engine, Number((await stored(slug)).id), 'default');
      expect(hex(body.compiled_truth)).toBe(hex(v2));
    }, 600_000);

    test('the shrink guard applies to a replace above 24 MiB: a 50 MiB page replaced by 24.5 MiB refuses until allow_shrink', async () => {
      const slug = 'notes/huger-conversation';
      const original = conversation(50 * MiB, 'original');
      await commit({ upload_id: await staged(original, slug) });
      const smaller = conversation(24.5 * MiB, 'smaller');
      const id = await staged(smaller, slug, { mode: 'replace', expected_revision: await revisionOf(slug) });
      expect((await commitRefusal({ upload_id: id })).code).toBe('page_shrink_refused');
      const body = await materializeSegmentedBody(engine, Number((await stored(slug)).id), 'default');
      expect(hex(body.compiled_truth)).toBe(hex(original));
      await commit({ upload_id: id, allow_shrink: true });
      await expectStoredBody(slug, smaller);
    }, 900_000);

    test('a remote replace over 24 MiB of a page with a hidden takes fence, private facts rows or timeline rows refuses upload_protected_content and releases its bytes', async () => {
      const cases: Array<['takes' | 'facts' | 'timeline', string, () => Promise<unknown>]> = [
        ['takes', 'notes/huge-with-takes', () => call('takes_add', { slug: 'notes/huge-with-takes', claim: 'Launch slips to Q3.', kind: 'take', holder: 'world', request_id: randomUUID() })],
        ['facts', 'notes/huge-with-facts', () => call('remember', { fact: 'Private launch budget is forty thousand.', provenance: 'upload-test', entity: 'notes/huge-with-facts', visibility: 'private', request_id: randomUUID() })],
        ['facts', 'notes/segmented-with-facts', async () => {
          await importFromContent(engine, 'notes/segmented-with-facts', `---\ntitle: Segmented facts\ntype: note\n---\n\n${conversation(2 * MiB, 'segmented-facts')}\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Private launch budget is forty thousand. | fact | 1.0 | private | high | 2026-01-01 |  | s |  |\n${FACTS_FENCE_END}\n`, { sourceId: 'default', noEmbed: true });
          expect((await stored('notes/segmented-with-facts')).body_storage).toBe('segmented');
        }],
        ['timeline', 'notes/huge-with-timeline', () => call('add_timeline_entry', { slug: 'notes/huge-with-timeline', date: '2026-01-02', summary: 'Kickoff held', request_id: randomUUID() })],
      ];
      await setConfig('write_gate.agent_mode', 'off');
      for (const [reason, slug, protect] of cases) {
        if (slug !== 'notes/segmented-with-facts') await call('put_page', { slug, content: `---\ntitle: Protected ${reason}\ntype: note\n---\n\n# Protected ${reason}\n\nShort page.\n`, request_id: randomUUID(), wait_ms: 30_000 });
        await protect();
        if (reason === 'facts') expect(await privateFactRows(slug)).toEqual(['Private launch budget is forty thousand.']);
        const prior = await counters();
        const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        const id = await staged(conversation(25 * MiB, `protected-${reason}`), slug, { mode: 'replace', expected_revision: before!.revision });
        const refused = await commitRefusal({ upload_id: id });
        expect({ reason, code: refused.code, names: refused.message.includes(({ takes: 'takes fence', facts: 'facts rows', timeline: 'timeline rows' })[reason]) }).toEqual({ reason, code: 'upload_protected_content', names: true });
        expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before!.revision);
        if (reason === 'facts') expect(await privateFactRows(slug)).toEqual(['Private launch budget is forty thousand.']);
        const after = await counters();
        for (const [key, value] of Object.entries(after)) expect([reason, key, value]).toEqual([reason, key, prior[key] ?? [0, 0]]);
      }
    }, 900_000);
  });
}
