/**
 * GBRA-582 item 9 (leaver handover, PR 3): the owner's admin routes for a handover, POST /admin/api/access/handover
 * (preview, apply, undo) and GET /admin/api/access/handover/:id (status), over the same core as the CLI.
 *
 * 1. Protects: only an owner session previews, applies or reads a handover; an apply carries out only the preview made
 *    for the member it names, an undo only the one previewed for the handover it names, and a folder rule that moved to
 *    a new prefix after the preview is never rewritten. Each mismatch is refused and writes nothing; an applied
 *    handover or undo leaves one audit row.
 * 2. Fails when: a route answers without the owner session, an apply writes another member's or another handover's
 *    preview, a moved rule is rewritten, or an applied change leaves no audit row.
 * 3. Real seams: the routes mounted on an Express app over a real socket, on a repo-less brain (PGLite, and Postgres
 *    when DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember, disableMember, enableMember } from '../src/core/access/members.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addFolderRules, currentFolderRules, writeApprovedRules } from '../src/commands/access-rules.ts';
import { mountAdminAccess } from '../src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../src/commands/serve-http-admin-api.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'default';

for (const kind of testBackends()) {
  describe('owner HTTP routes for a member handover (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: Server;
    let base = '';
    const sessions = new Map<string, number>();
    async function call(method: 'GET' | 'POST', path: string, body?: unknown, owner = true) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(owner ? { Cookie: 'gbrain_admin=owner-session' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
    }
    const handover = (body: Record<string, unknown>, owner = true) => call('POST', '/admin/api/access/handover', body, owner);
    const readers = async (slug: string) => (await engine.executeRaw<{ r: unknown }>(
      "SELECT frontmatter->'readable_by' AS r FROM pages WHERE source_id = $1 AND slug = $2", [SRC, slug]))[0]?.r ?? null;
    const page = (slug: string, member: string) => importFromContent(engine, slug, '---\ntype: note\ntitle: ' + slug + '\nreadable_by: [' + member + ']\n---\nSynthetic.\n', { sourceId: SRC });
    const rows = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_handovers'))[0]!.n;
    const audits = async () => (await engine.executeRaw<{ params: Record<string, unknown> | string }>("SELECT params FROM mcp_request_log WHERE operation = 'access_admin' ORDER BY id"))
      .map(r => typeof r.params === 'string' ? JSON.parse(r.params) : r.params);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of ['owner-example', 'alice-example']) await addMember(engine, id);
      await engine.setConfig('access.owner_member', 'owner-example');
      sessions.set('owner-session', Date.now() + 3_600_000);
      const app = express();
      app.use(cookieParser());
      mountAdminAccess(app, createRequireAdmin(sessions), engine);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', () => r()));
      base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    }, 120_000);
    afterAll(async () => {
      server?.closeAllConnections(); await new Promise<void>(r => server ? server.close(() => r()) : r());
      await close?.();
    });

    test('both routes refuse a request without the owner session and change nothing', async () => {
      await addMember(engine, 'mallory-example');
      await page('notes/mallory-example', 'mallory-example');
      await disableMember(engine, 'mallory-example');
      const before = await rows();
      const preview = await handover({ member: 'mallory-example' }, false);
      expect([401, 403]).toContain(preview.status);
      expect([401, 403]).toContain((await handover({ member: 'mallory-example', expect: 'x' }, false)).status);
      expect([401, 403]).toContain((await call('GET', '/admin/api/access/handover/h-x', undefined, false)).status);
      expect(await rows()).toBe(before);
      expect(await readers('notes/mallory-example')).toEqual(['mallory-example']);
    });

    test('preview, apply and status: the apply writes what the preview showed and leaves one audit row', async () => {
      await addMember(engine, 'bob-example');
      await page('notes/bob-example', 'bob-example');
      await disableMember(engine, 'bob-example');
      const p = await handover({ member: 'bob-example' });
      expect(p.status).toBe(200);
      expect(p.json.applied).toBe(false);
      expect(await readers('notes/bob-example')).toEqual(['bob-example']);
      const applied = await handover({ member: 'bob-example', expect: p.json.plan_hash });
      expect(applied.status).toBe(200);
      expect([applied.json.applied, applied.json.state]).toEqual([true, 'applied']);
      expect(await readers('notes/bob-example')).toEqual(['owner-example']);
      expect((await audits()).filter(a => a.action === 'member_handover' && a.handover_id === applied.json.id)).toHaveLength(1);
      const again = await handover({ member: 'bob-example', expect: p.json.plan_hash });
      expect(again.json.id).toBe(applied.json.id);
      const status = await call('GET', '/admin/api/access/handover/' + applied.json.id);
      expect([status.status, status.json.state]).toEqual([200, 'applied']);
      expect((await call('GET', '/admin/api/access/handover/h-unknown')).status).toBe(400);
      expect((await handover({ member: 'bob-example', extra: 1 })).json.code).toBe('invalid_params');
    });

    test("another member's apply of an approved preview is refused and writes nothing", async () => {
      for (const id of ['gina-example', 'hank-example']) await addMember(engine, id);
      await page('notes/gina-example', 'gina-example');
      await disableMember(engine, 'gina-example');
      await disableMember(engine, 'hank-example');
      const p = await handover({ member: 'gina-example' });
      const before = await rows();
      const crossed = await handover({ member: 'hank-example', expect: p.json.plan_hash });
      expect([crossed.status, crossed.json.code]).toEqual([400, 'preview_changed']);
      expect(await readers('notes/gina-example')).toEqual(['gina-example']);
      expect(await rows()).toBe(before);
      const applied = await handover({ member: 'gina-example', expect: p.json.plan_hash });
      expect(applied.json.state).toBe('applied');
      const resumed = await handover({ member: 'hank-example', expect: p.json.plan_hash });
      expect([resumed.status, resumed.json.code]).toEqual([400, 'preview_changed']);
    });

    test('an undo approval applies only to the handover it was previewed for', async () => {
      await addMember(engine, 'jo-example');
      await page('notes/jo-first-example', 'jo-example');
      await disableMember(engine, 'jo-example');
      const first = await handover({ member: 'jo-example' });
      const h1 = (await handover({ member: 'jo-example', expect: first.json.plan_hash })).json;
      await enableMember(engine, 'jo-example');
      await page('notes/jo-second-example', 'jo-example');
      await disableMember(engine, 'jo-example');
      const second = await handover({ member: 'jo-example' });
      const h2 = (await handover({ member: 'jo-example', expect: second.json.plan_hash })).json;
      await enableMember(engine, 'jo-example');
      const undo1 = await handover({ undo: h1.id });
      expect([undo1.status, undo1.json.applied]).toEqual([200, false]);
      const crossed = await handover({ undo: h2.id, expect: undo1.json.plan_hash });
      expect([crossed.status, crossed.json.code]).toEqual([400, 'preview_changed']);
      expect(await readers('notes/jo-first-example')).toEqual(['owner-example']);
      expect((await call('GET', '/admin/api/access/handover/' + h2.id)).json.state).toBe('applied');
      const wrongMember = await handover({ undo: h1.id, member: 'alice-example', expect: undo1.json.plan_hash });
      expect([wrongMember.status, wrongMember.json.code]).toEqual([400, 'invalid_params']);
      const undone = await handover({ undo: h1.id, expect: undo1.json.plan_hash });
      expect([undone.status, undone.json.undo_of]).toEqual([200, h1.id]);
      expect(await readers('notes/jo-first-example')).toEqual(['jo-example']);
      expect((await audits()).filter(a => a.action === 'member_handover_undo' && a.undo_of === h1.id)).toHaveLength(1);
    });

    test('a folder rule moved to a new prefix after the preview is never rewritten', async () => {
      await addMember(engine, 'ivy-example');
      await addFolderRules(engine, SRC, [{ id: 'ivy-folder', prefix: 'people/ivy-example/', readable_by: ['member:ivy-example'] } as never], { apply: true, json: true });
      await importFromContent(engine, 'people/ivy-example/plan', '---\ntype: note\ntitle: plan\n---\nSynthetic.\n', { sourceId: SRC });
      await disableMember(engine, 'ivy-example');
      const p = await handover({ member: 'ivy-example' });
      expect(p.json.items.some((i: { kind: string }) => i.kind === 'rule')).toBe(true);
      await writeApprovedRules(engine, SRC, (await currentFolderRules(engine, SRC)).map(r => r.id === 'ivy-folder' ? { ...r, prefix: 'moved-ivy/' } : r), 'access: move ivy-folder');
      const before = await rows();
      const moved = await handover({ member: 'ivy-example', expect: p.json.plan_hash });
      expect([moved.status, moved.json.code]).toEqual([400, 'preview_changed']);
      expect(await rows()).toBe(before);
      expect((await currentFolderRules(engine, SRC)).find(r => r.id === 'ivy-folder')).toMatchObject({ prefix: 'moved-ivy/', readable_by: ['member:ivy-example'] });
    });
  });
}
