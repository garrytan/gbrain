/**
 * Wave B PR 3 lane 3b: upload sessions (spec 6.2) bind to their creator and page, hold staged quota, expire, and
 * commit once.
 *
 * 1. Protects: begin_page_upload / upload_page_part / get_page_upload / commit_page_upload / abort_page_upload. A
 *    session answers only its creating principal, in its write source, at the source incarnation and page it began
 *    against; every other caller gets an upload_not_found byte-identical to a missing id. A replace whose page moved
 *    commits nothing (revision_changed). Parts arrive in order, replay idempotently by hash, never split a code point
 *    and never exceed the connection's part_max_frame_bytes. Staged bytes and open sessions hold the per-principal and
 *    per-brain counters until commit, abort or expiry returns them to their prior value; a cap refuses begin with
 *    write_quota_exhausted. A second commit after a lost reply returns the first receipt.
 * 2. Fails when: a session id is usable by another principal or source, a mismatch answers differently from a missing
 *    id, a stale replace commits, a lapsed session accepts parts, a reservation leaks, or commit writes twice.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set (no embedding, no model calls).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { partMaxFrameBytes, UPLOAD_FRAME_RESERVE_BYTES } from '../../src/core/persistence/page-upload.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MiB = 1024 ** 2;
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('part_max_frame_bytes per transport', () => {
  const ctx = (over: Partial<OperationContext>) => ({ remote: true, ...over }) as OperationContext;
  test('legacy HTTP (1 MiB body cap), OAuth /mcp (4 MiB), stdio (64 MiB capped at 4 MiB) and local CLI', () => {
    expect(partMaxFrameBytes(ctx({ transport: 'http', inboundFrameBytes: MiB }))).toBe(MiB - UPLOAD_FRAME_RESERVE_BYTES);
    expect(partMaxFrameBytes(ctx({ transport: 'http', inboundFrameBytes: 4 * MiB }))).toBe(4 * MiB - 4096);
    expect(partMaxFrameBytes(ctx({ transport: 'stdio', inboundFrameBytes: 64 * MiB }))).toBe(4 * MiB - 4096);
    expect(partMaxFrameBytes(ctx({ transport: 'http' }))).toBe(MiB - 4096);
    expect(partMaxFrameBytes(ctx({ remote: false }))).toBe(4 * MiB - 4096);
  });
});

for (const kind of testBackends()) {
  describe(`upload sessions: binding, quotas, expiry, idempotent commit (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let n = 0;

    const ctx = (client = 'upload-a', sourceId = 'default', over: Partial<OperationContext> = {}): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId,
      transport: 'http', inboundFrameBytes: MiB, auth: { token: 'fixture', clientId: client, principal: { kind: 'oauth_client', id: client },
        scopes: ['read', 'write'], sourceId, allowedSources: [sourceId] }, ...over } as unknown as OperationContext);
    const call = async (name: string, params: Record<string, unknown>, c = ctx()) => await op(name).handler(c, params) as Record<string, any>;
    const refusal = async (name: string, params: Record<string, unknown>, c = ctx()) => {
      try { await op(name).handler(c, params); } catch (error) {
        if (error instanceof OperationError) return error;
        throw error;
      }
      throw new Error(`${name} did not refuse`);
    };
    const wire = (error: OperationError) => JSON.stringify(error.toJSON());
    const slugOf = () => `notes/upload-${++n}`;
    const pageText = (tag: string, bytes = 6000) => `---\ntitle: Upload ${tag}\ntype: note\n---\n\n# Upload ${tag}\n\n${`Line of planning notes for ${tag}. `.repeat(Math.ceil(bytes / 34))}\n`;
    const cut = (text: string, parts: number) => {
      const size = Math.ceil(text.length / parts);
      return Array.from({ length: parts }, (_, i) => text.slice(i * size, (i + 1) * size)).filter(Boolean);
    };
    const begin = async (slug: string, text: string, over: Record<string, unknown> = {}, c = ctx()) =>
      await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(), ...over }, c);
    const send = async (uploadId: string, parts: string[], c = ctx()) => {
      for (const [part, text] of parts.entries()) await call('upload_page_part', { upload_id: uploadId, part, text, part_sha256: hex(text) }, c);
    };
    const counters = async () => Object.fromEntries((await engine.executeRaw<{ key: string; intent_bytes: unknown; outstanding_count: unknown }>(
      `SELECT key, intent_bytes, outstanding_count FROM persistence_counters WHERE key LIKE '%:staged' OR key LIKE '%:uploads' ORDER BY key`))
      .map(row => [row.key, [Number(row.intent_bytes), Number(row.outstanding_count)]]));
    const setLimit = async (key: string, value: string | null) => {
      if (value === null) await engine.executeRaw('DELETE FROM config WHERE key = $1', [key]);
      else await engine.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    };
    const createPage = async (slug: string, text: string) => {
      const session = await begin(slug, text);
      await send(session.upload_id, cut(text, 2));
      return await call('commit_page_upload', { upload_id: session.upload_id });
    };
    const revisionOf = async (slug: string, sourceId = 'default') => (await engine.readPageSnapshot(slug, { sourceId }))!.revision;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('upload-other','upload-other','{}') ON CONFLICT DO NOTHING");
      for (const client of ['upload-a', 'upload-b', 'upload-q', 'upload-r']) {
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
          VALUES($1,'fixture-hash','upload-client','read write','default') ON CONFLICT (client_id) DO NOTHING`, [client]);
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    afterEach(async () => {
      await engine.executeRaw('DELETE FROM page_body_stagings');
      await engine.executeRaw("DELETE FROM persistence_counters WHERE key LIKE '%:staged' OR key LIKE '%:uploads'");
    });

    test('create in three parts writes the page and returns the staged counters to their prior value', async () => {
      const before = await counters();
      const slug = slugOf();
      const text = pageText('create', 9000);
      const session = await begin(slug, text);
      expect(session).toMatchObject({ state: 'open', next_part: 0, received_bytes: 0, total_bytes: Buffer.byteLength(text), part_max_frame_bytes: MiB - 4096 });
      expect((await counters())['principal:oauth_client:upload-a:staged']?.[0]).toBe((before['principal:oauth_client:upload-a:staged']?.[0] ?? 0) + Buffer.byteLength(text));
      await send(session.upload_id, cut(text, 3));
      expect(await call('get_page_upload', { upload_id: session.upload_id })).toMatchObject({ next_part: 3, received_bytes: Buffer.byteLength(text) });
      const receipt = await call('commit_page_upload', { upload_id: session.upload_id });
      expect({ state: receipt.state, slug: receipt.slug }).toEqual({ state: 'committed', slug });
      const [staging] = await engine.executeRaw<{ state: string; commit_request_id: string | null }>(
        'SELECT state, commit_request_id::text AS commit_request_id FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
      expect(staging?.state).toBe('committed');
      expect(staging?.commit_request_id).not.toBeNull();
      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page?.compiled_truth).toContain('Line of planning notes for create.');
      const after = await counters();
      for (const [key, value] of Object.entries(after)) expect([key, value]).toEqual([key, before[key] ?? [0, 0]]);
    }, 120_000);

    test('another principal, another source and a changed source incarnation get upload_not_found byte-identical to a missing id', async () => {
      const slug = slugOf();
      const text = pageText('bound');
      const session = await begin(slug, text);
      const id = session.upload_id as string;
      const missing = randomUUID();
      const strangers: Array<[string, OperationContext]> = [['other principal', ctx('upload-b')], ['other source', ctx('upload-a', 'upload-other')]];
      const probes: Array<[string, (uploadId: string) => Record<string, unknown>]> = [
        ['upload_page_part', uploadId => ({ upload_id: uploadId, part: 0, text: 'abc', part_sha256: hex('abc') })],
        ['get_page_upload', uploadId => ({ upload_id: uploadId })],
        ['commit_page_upload', uploadId => ({ upload_id: uploadId })],
        ['abort_page_upload', uploadId => ({ upload_id: uploadId })],
      ];
      for (const [label, stranger] of strangers) {
        for (const [name, params] of probes) {
          const bound = await refusal(name, params(id), stranger);
          const unknown = await refusal(name, params(missing), stranger);
          expect({ label, name, code: bound.code }).toEqual({ label, name, code: 'upload_not_found' });
          expect(wire(bound)).toBe(wire(unknown));
        }
      }
      expect(await call('get_page_upload', { upload_id: id })).toMatchObject({ state: 'open', next_part: 0 });
      const [began] = await engine.executeRaw<{ incarnation: string }>('SELECT source_incarnation::text AS incarnation FROM page_body_stagings WHERE id = $1::uuid', [id]);
      await engine.executeRaw('UPDATE page_body_stagings SET source_incarnation = $2::uuid WHERE id = $1::uuid', [id, randomUUID()]);
      for (const [name, params] of probes.filter(([name]) => name !== 'abort_page_upload')) expect(wire(await refusal(name, params(id)))).toBe(wire(await refusal(name, params(missing))));
      await engine.executeRaw('UPDATE page_body_stagings SET source_incarnation = $2::uuid WHERE id = $1::uuid', [id, began!.incarnation]);
      expect((await call('abort_page_upload', { upload_id: id })).state).toBe('aborted');
    }, 120_000);

    test('a page created at the slug after a create upload began makes the session upload_not_found', async () => {
      const slug = slugOf();
      const text = pageText('raced-create');
      const session = await begin(slug, text);
      await createPage(slug, pageText('winner'));
      const after = await refusal('get_page_upload', { upload_id: session.upload_id });
      expect(wire(after)).toBe(wire(await refusal('get_page_upload', { upload_id: randomUUID() })));
    }, 120_000);

    test('replace commits at its expected_revision and refuses with revision_changed after the page moved', async () => {
      const slug = slugOf();
      await createPage(slug, pageText('v1'));
      const v1 = await revisionOf(slug);
      const v2Text = pageText('v2');
      const ok = await begin(slug, v2Text, { mode: 'replace', expected_revision: v1 });
      await send(ok.upload_id, cut(v2Text, 2));
      await call('commit_page_upload', { upload_id: ok.upload_id });
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('notes for v2.');
      expect((await refusal('begin_page_upload', { slug, mode: 'replace', total_bytes: 10, sha256: hex('0123456789'), request_id: randomUUID() })).code).toBe('invalid_params');

      const v2 = await revisionOf(slug);
      const staleText = pageText('stale');
      const stale = await begin(slug, staleText, { mode: 'replace', expected_revision: v2 });
      await send(stale.upload_id, cut(staleText, 2));
      const v3 = pageText('v3');
      await call('put_page', { slug, content: v3, expected_revision: v2, request_id: randomUUID() });
      const moved = await refusal('commit_page_upload', { upload_id: stale.upload_id });
      expect(moved.code).toBe('revision_changed');
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('notes for v3.');
    }, 120_000);

    test('an expired session answers upload_expired with a begin-again fix and releases its reservation', async () => {
      const before = await counters();
      const slug = slugOf();
      const text = pageText('expired');
      const session = await begin(slug, text);
      await send(session.upload_id, cut(text, 3).slice(0, 1));
      await engine.executeRaw("UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 second' WHERE id = $1::uuid", [session.upload_id]);
      const parts = cut(text, 3);
      const expired = await refusal('upload_page_part', { upload_id: session.upload_id, part: 1, text: parts[1], part_sha256: hex(parts[1]!) });
      expect(expired.code).toBe('upload_expired');
      expect(JSON.stringify(expired.toJSON())).toContain('begin_page_upload');
      expect((await refusal('get_page_upload', { upload_id: session.upload_id })).code).toBe('upload_expired');
      expect((await refusal('commit_page_upload', { upload_id: session.upload_id })).code).toBe('upload_expired');
      expect(await counters()).toEqual({ ...Object.fromEntries(Object.keys(await counters()).map(key => [key, [0, 0]])), ...before });
    }, 120_000);

    test('the segment sweep expires a lapsed session and releases its reservation', async () => {
      const before = await counters();
      const text = pageText('swept');
      const session = await begin(slugOf(), text);
      await engine.executeRaw("UPDATE page_body_stagings SET hard_expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' WHERE id = $1::uuid", [session.upload_id]);
      await engine.sweepSegments({ expireStagings: true });
      expect(await counters()).toEqual({ ...Object.fromEntries(Object.keys(await counters()).map(key => [key, [0, 0]])), ...before });
      expect((await refusal('get_page_upload', { upload_id: session.upload_id })).code).toMatch(/^upload_(expired|not_found)$/);
    }, 120_000);

    test('a replayed part with the same hash is accepted once; a different hash is idempotency_conflict', async () => {
      const text = pageText('replay');
      const session = await begin(slugOf(), text);
      const [first, second] = cut(text, 2) as [string, string];
      const once = await call('upload_page_part', { upload_id: session.upload_id, part: 0, text: first, part_sha256: hex(first) });
      const again = await call('upload_page_part', { upload_id: session.upload_id, part: 0, text: first, part_sha256: hex(first) });
      expect(again).toEqual(once);
      const other = first.slice(0, -1) + 'Q';
      expect((await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text: other, part_sha256: hex(other) })).code).toBe('idempotency_conflict');
      await call('upload_page_part', { upload_id: session.upload_id, part: 1, text: second, part_sha256: hex(second) });
      await call('abort_page_upload', { upload_id: session.upload_id });
    }, 120_000);

    test('parts go in order and a part cut inside a surrogate pair is part_splits_code_point', async () => {
      const text = `${pageText('order')}Emoji \u{1F600} end.\n`;
      const session = await begin(slugOf(), text);
      const parts = cut(text, 2);
      expect((await refusal('upload_page_part', { upload_id: session.upload_id, part: 1, text: parts[1], part_sha256: hex(parts[1]!) })).code).toBe('invalid_params');
      const at = text.indexOf('\u{1F600}') + 1;
      const split = text.slice(0, at);
      const refused = await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text: split, part_sha256: hex(split) });
      expect(refused.code).toBe('part_splits_code_point');
      expect(await call('get_page_upload', { upload_id: session.upload_id })).toMatchObject({ next_part: 0, received_bytes: 0 });
      await call('abort_page_upload', { upload_id: session.upload_id });
    }, 120_000);

    test('a part over part_max_frame_bytes is part_too_large naming the cap', async () => {
      const text = 'x'.repeat(5000);
      const session = await begin(slugOf(), `---\ntitle: big\n---\n\n${text}`, {}, ctx('upload-a', 'default', { inboundFrameBytes: 8192 } as Partial<OperationContext>));
      expect(session.part_max_frame_bytes).toBe(4096);
      const refused = await refusal('upload_page_part', { upload_id: session.upload_id, part: 0, text, part_sha256: hex(text) },
        ctx('upload-a', 'default', { inboundFrameBytes: 8192 } as Partial<OperationContext>));
      expect(refused.code).toBe('part_too_large');
      expect(refused.message).toContain('4096');
      await call('abort_page_upload', { upload_id: session.upload_id });
    }, 120_000);

    test('a second commit after a lost reply returns the first receipt and writes once', async () => {
      const slug = slugOf();
      const text = pageText('lost-ack');
      const session = await begin(slug, text);
      await send(session.upload_id, cut(text, 2));
      const first = await call('commit_page_upload', { upload_id: session.upload_id });
      const second = await call('commit_page_upload', { upload_id: session.upload_id });
      expect(second.request_id).toBe(first.request_id);
      expect(second.revision ?? second.receipt?.revision).toBe(first.revision ?? first.receipt?.revision);
      const [versions] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug = $1 AND operation = 'put_page'", [slug]);
      expect(versions!.n).toBe(1);
      expect((await refusal('abort_page_upload', { upload_id: session.upload_id })).code).toBe('invalid_params');
    }, 120_000);

    test('put_page refuses a body_ref: only commit_page_upload names a staged body', async () => {
      const slug = slugOf();
      const text = pageText('forged');
      const session = await begin(slug, text);
      await send(session.upload_id, cut(text, 2));
      const ref = { kind: 'staging', staging_id: session.upload_id, sha256: hex(text), bytes: Buffer.byteLength(text) };
      for (const params of [{ slug, body_ref: ref, request_id: randomUUID() }, { slug, content: 'stub', body_ref: ref, request_id: randomUUID() }]) {
        expect((await refusal('put_page', params)).code).toBe('invalid_params');
      }
      expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toBeNull();
    }, 120_000);

    test('begin with the same request_id resumes; different arguments are idempotency_conflict', async () => {
      const slug = slugOf();
      const text = pageText('resume');
      const requestId = randomUUID();
      const first = await begin(slug, text, { request_id: requestId });
      const again = await begin(slug, text, { request_id: requestId });
      expect(again.upload_id).toBe(first.upload_id);
      expect((await refusal('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text) + 1, sha256: hex(text), request_id: requestId })).code).toBe('idempotency_conflict');
      await call('abort_page_upload', { upload_id: first.upload_id });
    }, 120_000);

    test('abort releases the reservation: the counters return to their prior value', async () => {
      const before = await counters();
      const session = await begin(slugOf(), pageText('abort'));
      expect(await counters()).not.toEqual(before);
      expect((await call('abort_page_upload', { upload_id: session.upload_id })).state).toBe('aborted');
      expect((await call('abort_page_upload', { upload_id: session.upload_id })).state).toBe('aborted');
      expect(await counters()).toEqual({ ...Object.fromEntries(Object.keys(await counters()).map(key => [key, [0, 0]])), ...before });
    }, 120_000);

    test('append uploads commit in order through append_page, a second commit replays the receipt, and the reservation is released', async () => {
      const slug = slugOf();
      await createPage(slug, pageText('append-base', 2000));
      const before = await counters();
      const appended: string[] = [];
      for (const tag of ['first', 'second']) {
        const text = `\nAppended ${tag} block. ${`Notes for the ${tag} append. `.repeat(200)}\n`;
        const session = await begin(slug, text, { mode: 'append' });
        await send(session.upload_id, cut(text, 3));
        const receipt = await call('commit_page_upload', { upload_id: session.upload_id });
        expect(receipt.state).toBe('committed');
        const again = await call('commit_page_upload', { upload_id: session.upload_id });
        expect(again.request_id).toBe(receipt.request_id);
        appended.push(text);
      }
      const truth = (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
      const first = truth.indexOf('Appended first block.'), second = truth.indexOf('Appended second block.');
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(first);
      expect(truth.split('Notes for the first append.').length - 1).toBe(200);
      const [requests] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug = $1 AND operation = 'append_page'", [slug]);
      expect(requests!.n).toBe(2);
      const after = await counters();
      for (const [key, value] of Object.entries(after)) expect([key, value]).toEqual([key, before[key] ?? [0, 0]]);
    }, 120_000);

    test('an append upload against a stale expected_revision refuses with revision_changed, appends nothing and releases its reservation', async () => {
      const slug = slugOf();
      await createPage(slug, pageText('append-stale', 2000));
      const base = await revisionOf(slug);
      const before = await counters();
      const text = `\nStale append. ${'Never lands. '.repeat(100)}\n`;
      const session = await begin(slug, text, { mode: 'append', expected_revision: base });
      await send(session.upload_id, cut(text, 2));
      await call('put_page', { slug, content: pageText('append-moved', 2000), expected_revision: base, request_id: randomUUID() });
      const refused = await refusal('commit_page_upload', { upload_id: session.upload_id });
      expect(refused.code).toBe('revision_changed');
      expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).not.toContain('Stale append.');
      const after = await counters();
      for (const [key, value] of Object.entries(after)) expect([key, value]).toEqual([key, before[key] ?? [0, 0]]);
    }, 120_000);

    const quotas: Array<[string, string, string, number]> = [
      ['open sessions per principal', 'persistence.limits.principal_uploads', 'open_uploads', 1],
      ['staged bytes per principal', 'persistence.limits.principal_staged_bytes', 'staged_bytes', 10_000],
      ['staged bytes per brain', 'persistence.limits.brain_staged_bytes', 'staged_bytes', 10_000],
    ];
    for (const [label, key, reason, value] of quotas) {
      test(`${label} at its cap refuses begin with write_quota_exhausted`, async () => {
        await setLimit(key, String(value));
        try {
          const held = await begin(slugOf(), pageText('quota-a', 7000), {}, ctx('upload-q'));
          const refused = await refusal('begin_page_upload', { slug: slugOf(), mode: 'create', total_bytes: 7000, sha256: hex('x'), request_id: randomUUID() },
            key.includes('brain') ? ctx('upload-r') : ctx('upload-q'));
          expect({ code: refused.code, reason: (refused.toJSON() as Record<string, unknown>).reason }).toEqual({ code: 'write_quota_exhausted', reason });
          expect(JSON.stringify(refused.toJSON())).toContain(key);
          await call('abort_page_upload', { upload_id: held.upload_id }, ctx('upload-q'));
          const after = await begin(slugOf(), pageText('quota-b', 7000), {}, ctx('upload-q'));
          await call('abort_page_upload', { upload_id: after.upload_id }, ctx('upload-q'));
        } finally {
          await setLimit(key, null);
        }
      }, 120_000);
    }
  });
}
