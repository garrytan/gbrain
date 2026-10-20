/**
 * Wave B PR 3 review (lane 3b): upload sessions never strand quota, disclose nothing across connections, and refuse
 * malformed input.
 *
 * 1. Protects: begin_page_upload runs put_page's visibility authorization before reading the page, so a remote caller
 *    gets the same answer for a private page as for a missing one in replace and append (and create answers as
 *    put_page does for an invisible page); every refusal at commit (stale revision, sha mismatch) and every failed
 *    commit releases the session's staged bytes without a manual abort; the creating principal can always abort,
 *    even after the page, slug or source moved on, while another principal gets upload_not_found; abort after a
 *    commit that failed answers aborted, not "already committed"; parts are deleted in the statement that releases
 *    their quota; the brain-wide quota refusal names its limit but never the brain's usage; a slug fence the caller
 *    gained after begin closes the session to part, status and abort; sha mismatch, an overflowing total_bytes, a lone
 *    surrogate and an archived source refuse.
 * 2. Fails when: any of those regress (each was missing at c704bdfc3 unless noted in its test).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set (no embedding, no model calls).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import * as uploadOps from '../../src/core/ops/page-upload.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

for (const kind of testBackends()) {
  describe(`upload sessions: review fixes (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let n = 0;

    const ctx = (client = 'review-a', over: Record<string, unknown> = {}): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default',
      transport: 'http', inboundFrameBytes: MiB, auth: { token: 'fixture', clientId: client, principal: { kind: 'oauth_client', id: client },
        scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'], ...over } } as unknown as OperationContext);
    const call = async (name: string, params: Record<string, unknown>, c = ctx()) => await op(name).handler(c, params) as Record<string, any>;
    const refusal = async (name: string, params: Record<string, unknown>, c = ctx()) => {
      try { await op(name).handler(c, params); } catch (error) { if (error instanceof OperationError) return error; throw error; }
      throw new Error(`${name} did not refuse`);
    };
    const wire = (error: OperationError) => JSON.stringify(error.toJSON());
    const slugOf = () => `notes/review-${++n}`;
    const pageText = (tag: string, bytes = 4000) => `---\ntitle: Review ${tag}\ntype: note\n---\n\n# Review ${tag}\n\n${`Planning notes for ${tag}. `.repeat(Math.ceil(bytes / 30))}`;
    const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    const begin = async (slug: string, text: string, over: Record<string, unknown> = {}, c = ctx()) =>
      await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(), ...over }, c);
    const send = async (uploadId: string, parts: string[], c = ctx()) => {
      for (const [part, text] of parts.entries()) await call('upload_page_part', { upload_id: uploadId, part, text, part_sha256: hex(text) }, c);
    };
    const counters = async () => Object.fromEntries((await engine.executeRaw<{ key: string; intent_bytes: unknown; outstanding_count: unknown }>(
      `SELECT key, intent_bytes, outstanding_count FROM persistence_counters WHERE key LIKE '%:staged' OR key LIKE '%:uploads' ORDER BY key`))
      .map(row => [row.key, [Number(row.intent_bytes), Number(row.outstanding_count)]]));
    const expectReleased = async (prior: Record<string, number[]>) => {
      for (const [key, value] of Object.entries(await counters())) expect([key, value]).toEqual([key, prior[key] ?? [0, 0]]);
    };
    const parts = async (id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_staging_parts WHERE staging_id = $1::uuid', [id]))[0]!.n;
    const createPage = async (slug: string, text = pageText(slug)) => {
      await call('put_page', { slug, content: text, request_id: randomUUID(), wait_ms: 30_000 });
      return (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('review-archived','review-archived','{}') ON CONFLICT DO NOTHING");
      for (const client of ['review-a', 'review-b', 'review-c']) {
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
          VALUES($1,'fixture-hash','review-client','read write','default') ON CONFLICT (client_id) DO NOTHING`, [client]);
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    afterEach(async () => {
      await engine.executeRaw('DELETE FROM page_body_stagings');
      await engine.executeRaw("DELETE FROM persistence_counters WHERE key LIKE '%:staged' OR key LIKE '%:uploads'");
    });

    test('a private page answers begin exactly as a missing one in replace and append, and create answers as put_page does', async () => {
      const hidden = slugOf();
      await importFromContent(engine, hidden, `---\ntitle: Hidden\ntype: note\nvisibility: private\n---\n\nPrivate body.\n`, { sourceId: 'default', noEmbed: true });
      const missing = slugOf();
      const text = pageText('probe');
      const params = (slug: string, mode: string) => ({ slug, mode, total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(),
        ...(mode === 'replace' ? { expected_revision: '00000000-0000-4000-8000-000000000000' } : {}) });
      for (const mode of ['replace', 'append']) {
        const a = await refusal('begin_page_upload', params(hidden, mode));
        const b = await refusal('begin_page_upload', params(missing, mode));
        expect({ mode, wire: wire(a) }).toEqual({ mode, wire: wire(b) });
      }
      const created = await refusal('begin_page_upload', params(hidden, 'create'));
      const put = await refusal('put_page', { slug: hidden, content: text, request_id: randomUUID() });
      expect(wire(created)).toBe(wire(put));
      expect(wire(created)).toBe(wire(await refusal('begin_page_upload', params(missing, 'replace'))));
    }, 120_000);

    test('a replace whose page moved refuses revision_changed at commit and releases its bytes and parts without an abort', async () => {
      const slug = slugOf();
      const base = await createPage(slug);
      const prior = await counters();
      const text = pageText('stale');
      const session = await begin(slug, text, { mode: 'replace', expected_revision: base });
      await send(session.upload_id, halves(text));
      await call('put_page', { slug, content: pageText('moved'), expected_revision: base, request_id: randomUUID(), wait_ms: 30_000 });
      expect((await refusal('commit_page_upload', { upload_id: session.upload_id })).code).toBe('revision_changed');
      await expectReleased(prior);
      expect(await parts(session.upload_id)).toBe(0);
    }, 120_000);

    test('a sha mismatch at commit refuses, discards the session and releases its bytes', async () => {
      const prior = await counters();
      const text = pageText('sha');
      const session = await begin(slugOf(), text, { sha256: hex(`${text}x`) });
      await send(session.upload_id, halves(text));
      const refused = await refusal('commit_page_upload', { upload_id: session.upload_id });
      expect(refused.code).toBe('invalid_params');
      expect(refused.message).toContain('sha256');
      await expectReleased(prior);
      expect(await parts(session.upload_id)).toBe(0);
    }, 120_000);

    test('abort deletes the parts in the statement that releases the quota, and a commit does too', async () => {
      const prior = await counters();
      const text = pageText('parts');
      const aborted = await begin(slugOf(), text);
      await send(aborted.upload_id, halves(text));
      expect(await parts(aborted.upload_id)).toBe(2);
      await call('abort_page_upload', { upload_id: aborted.upload_id });
      expect(await parts(aborted.upload_id)).toBe(0);
      const committed = await begin(slugOf(), text);
      await send(committed.upload_id, halves(text));
      await call('commit_page_upload', { upload_id: committed.upload_id, wait_ms: 30_000 });
      expect(await parts(committed.upload_id)).toBe(0);
      await expectReleased(prior);
    }, 120_000);

    test('the creating principal aborts after its source incarnation changed; another principal gets upload_not_found', async () => {
      const slug = slugOf();
      const base = await createPage(slug);
      const prior = await counters();
      const session = await begin(slug, pageText('gone'), { mode: 'replace', expected_revision: base });
      // The binding breaks as when the source is re-created under the session (its rows keep the old incarnation).
      await engine.executeRaw('UPDATE page_body_stagings SET source_incarnation = $2::uuid WHERE id = $1::uuid', [session.upload_id, randomUUID()]);
      const other = await refusal('abort_page_upload', { upload_id: session.upload_id }, ctx('review-b'));
      expect(wire(other)).toBe(wire(await refusal('abort_page_upload', { upload_id: randomUUID() }, ctx('review-b'))));
      expect((await refusal('get_page_upload', { upload_id: session.upload_id })).code).toBe('upload_not_found');
      expect((await call('abort_page_upload', { upload_id: session.upload_id })).state).toBe('aborted');
      await expectReleased(prior);
    }, 120_000);

    test('abort after a commit that ended without writing answers aborted, not already committed', async () => {
      const slug = slugOf();
      const base = await createPage(slug);
      const text = `\nAppended text. ${'More notes. '.repeat(50)}\n`;
      const session = await begin(slug, text, { mode: 'append', expected_revision: base });
      await send(session.upload_id, halves(text));
      await call('put_page', { slug, content: pageText('moved'), expected_revision: base, request_id: randomUUID(), wait_ms: 30_000 });
      expect((await refusal('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 })).code).toBe('revision_changed');
      // The commit's reply was lost before the session was settled: it is still sealed and names the failed request.
      await engine.executeRaw("UPDATE page_body_stagings SET state = 'sealed' WHERE id = $1::uuid", [session.upload_id]);
      const [row] = await engine.executeRaw<{ commit_request_id: string | null }>('SELECT commit_request_id::text AS commit_request_id FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
      expect(row!.commit_request_id).not.toBeNull();
      expect((await call('abort_page_upload', { upload_id: session.upload_id })).state).toBe('aborted');
    }, 120_000);

    test('the brain-wide quota refusal names its limit but not the staged bytes of other connections', async () => {
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('persistence.limits.brain_staged_bytes', '9000') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      try {
        const held = pageText('held', 5000);
        await begin(slugOf(), held, {}, ctx('review-b'));
        const refused = await refusal('begin_page_upload', { slug: slugOf(), mode: 'create', total_bytes: 5000, sha256: 'a'.repeat(64), request_id: randomUUID() });
        const json = wire(refused);
        expect(refused.code).toBe('write_quota_exhausted');
        expect(json).toContain('persistence.limits.brain_staged_bytes');
        expect(json).not.toContain(String(Buffer.byteLength(held)));
        expect(json).not.toMatch(/used of/);
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'persistence.limits.brain_staged_bytes'");
      }
    }, 120_000);

    test('a begin request_id that already named a put_page attaches no session to that write, and abort still frees the session', async () => {
      const requestId = randomUUID();
      const other = slugOf();
      await call('put_page', { slug: other, content: pageText('other'), request_id: requestId, wait_ms: 30_000 });
      const prior = await counters();
      const slug = slugOf();
      const text = pageText('reused');
      const session = await begin(slug, text, { request_id: requestId });
      await send(session.upload_id, halves(text));
      expect((await refusal('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 })).code).toBe('idempotency_conflict');
      const [row] = await engine.executeRaw<{ commit_request_id: string | null }>('SELECT commit_request_id::text AS commit_request_id FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
      expect(row!.commit_request_id).toBeNull();
      expect((await call('abort_page_upload', { upload_id: session.upload_id })).state).toBe('aborted');
      await expectReleased(prior);
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    }, 120_000);

    test("another principal's lapsed session does not count against the brain-wide cap at begin", async () => {
      const heldText = pageText('lapsed', 5000);
      const text = pageText('fits', 5000);
      const cap = Buffer.byteLength(heldText) + Buffer.byteLength(text) - 1;
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('persistence.limits.brain_staged_bytes', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(cap)]);
      try {
        const held = await begin(slugOf(), heldText, {}, ctx('review-b'));
        await engine.executeRaw("UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 second' WHERE id = $1::uuid", [held.upload_id]);
        const session = await begin(slugOf(), text);
        expect(session.state).toBe('open');
        expect((await refusal('get_page_upload', { upload_id: held.upload_id }, ctx('review-b'))).code).toBe('upload_expired');
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'persistence.limits.brain_staged_bytes'");
      }
    }, 120_000);

    test('a session of tiny parts stops at its part limit unless the part completes the content', async () => {
      const text = 'x'.repeat(200);
      const session = await begin(slugOf(), text);
      for (let part = 0; part < 65; part++) await call('upload_page_part', { upload_id: session.upload_id, part, text: 'x', part_sha256: hex('x') });
      const refused = await refusal('upload_page_part', { upload_id: session.upload_id, part: 65, text: 'x', part_sha256: hex('x') });
      expect(refused.code).toBe('upload_too_many_parts');
      expect(refused.message).toContain('at most 65 parts');
      expect(wire(refused)).toContain('get_page_upload');
      const rest = text.slice(65);
      expect((await call('upload_page_part', { upload_id: session.upload_id, part: 65, text: rest, part_sha256: hex(rest) })).received_bytes).toBe(200);
    }, 120_000);

    test('a slug fence the caller gained after begin closes the session to part, status and abort', async () => {
      const slug = slugOf();
      const text = pageText('fenced');
      const session = await begin(slug, text);
      const fenced = ctx('review-a', { boundSlugPrefixes: ['elsewhere/'] });
      const probes: Array<[string, (id: string) => Record<string, unknown>]> = [
        ['upload_page_part', id => ({ upload_id: id, part: 0, text: 'abc', part_sha256: hex('abc') })],
        ['get_page_upload', id => ({ upload_id: id })],
        ['abort_page_upload', id => ({ upload_id: id })],
      ];
      for (const [name, params] of probes) {
        const bound = await refusal(name, params(session.upload_id), fenced);
        expect({ name, code: bound.code }).toEqual({ name, code: 'upload_not_found' });
        expect(wire(bound)).toBe(wire(await refusal(name, params(randomUUID()), fenced)));
      }
      expect(await call('get_page_upload', { upload_id: session.upload_id })).toMatchObject({ state: 'open' });
    }, 120_000);

    test('a commit retried while the first commit is past its hash and the idle deadline passes publishes once and never answers upload_expired', async () => {
      const slug = slugOf();
      const base = await createPage(slug);
      const text = `\nRaced append block. ${'Race notes. '.repeat(80)}\n`;
      const session = await begin(slug, text, { mode: 'append', expected_revision: base });
      await send(session.upload_id, halves(text));
      const probe = (uploadOps as { uploadCommitProbe?: { afterHash?: (id: string) => Promise<void> } }).uploadCommitProbe;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let reached!: () => void;
      const paused = new Promise<void>(resolve => { reached = resolve; });
      let first: Promise<Record<string, any>>;
      if (probe) {
        probe.afterHash = async id => { if (id === session.upload_id) { reached(); await gate; } };
        first = call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 });
        await paused;
      } else {
        // A build without the seam: the state commit A leaves at that point (sealed, hashed, not yet journaled).
        await engine.executeRaw("UPDATE page_body_stagings SET state = 'sealed' WHERE id = $1::uuid", [session.upload_id]);
        first = gate.then(() => call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 }));
      }
      try {
        await engine.executeRaw("UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 second' WHERE id = $1::uuid", [session.upload_id]);
        await engine.sweepSegments({ expireStagings: true });
        const second = await call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 });
        expect(second.state).toBe('committed');
        release();
        const result = await first;
        expect(result.request_id).toBe(second.request_id);
      } finally {
        release();
        if (probe) delete probe.afterHash;
      }
      const truth = (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
      expect(truth.split('Raced append block.').length - 1).toBe(1);
      const [requests] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug = $1 AND operation = 'append_page'", [slug]);
      expect(requests!.n).toBe(1);
    }, 120_000);

    test('an overflowing part, total_bytes over the ceiling and a lone surrogate refuse', async () => {
      const text = pageText('overflow');
      const session = await begin(slugOf(), text);
      const over = `${text}extra`;
      expect((await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text: over, part_sha256: hex(over) })).code).toBe('invalid_params');
      expect((await refusal('begin_page_upload', { slug: slugOf(), mode: 'create', total_bytes: 2 ** 40, sha256: 'a'.repeat(64), request_id: randomUUID() })).code).toBe('request_too_large');
      const lone = 'abc\uD800def';
      const surrogate = await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text: lone, part_sha256: 'a'.repeat(64) });
      expect(surrogate.code).toBe('invalid_params');
      expect(surrogate.message).toContain('surrogate');
      expect(await call('get_page_upload', { upload_id: session.upload_id })).toMatchObject({ next_part: 0, received_bytes: 0 });
    }, 120_000);

    test('an archived source refuses begin; its open session takes no parts but its owner can still abort', async () => {
      const text = pageText('archived');
      const c = ctx('review-c', { sourceId: 'review-archived', allowedSources: ['review-archived'] });
      (c as { sourceId: string }).sourceId = 'review-archived';
      await engine.executeRaw("UPDATE oauth_clients SET source_id = 'review-archived' WHERE client_id = 'review-c'");
      const prior = await counters();
      const session = await begin('notes/archived-upload', text, {}, c);
      await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'review-archived'");
      try {
        expect((await refusal('begin_page_upload', { slug: 'notes/archived-other', mode: 'create', total_bytes: 10, sha256: hex('0123456789'), request_id: randomUUID() }, c)).code).toBe('source_changed');
        const [first] = halves(text);
        expect((await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text: first, part_sha256: hex(first!) }, c)).code).toBe('upload_not_found');
        expect((await call('abort_page_upload', { upload_id: session.upload_id }, c)).state).toBe('aborted');
        await expectReleased(prior);
      } finally {
        await engine.executeRaw("UPDATE sources SET archived = false WHERE id = 'review-archived'");
      }
    }, 120_000);
  });
}
