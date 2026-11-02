/**
 * GST-240 / GST-359 C2: the keyless two-member check over a real `gbrain serve --http`.
 *
 * A keyless brain (PGLite, no embedding provider, no repo; and Postgres when DATABASE_URL is set) with two members,
 * alice-example and bob-example, each holding a member key (`gbrain auth create --member`), plus a QM
 * client-credentials client holding the attest right for every attestable operation (`gbrain auth rescope
 * --attest-actor qm --attest-ops ...`), both members linked through the real CLI (`gbrain access member link`).
 *
 * 1. Protects: 0 cross-member rows across every operation the attest grant may call, for Bob as an attested actor,
 *    Bob's member key, the bare attest client and an unbound key; a fact Alice saves through her member key is
 *    recalled by her attested actor (another harness) and by no one else.
 * 2. Fails when: any tools/call response (text, structuredContent, _meta) carries Alice's canary for anyone but
 *    Alice, or her member-key fact is not on her member page.
 * 3. Existing coverage: test/access-member-sweep.test.ts sweeps dispatch on both engines; this is the transport.
 * 4. No production seam.
 *
 * Run: bun test test/e2e/serve-http-member-sweep.test.ts (PGLite arm always; Postgres arm with
 *      DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from '../../src/core/operations.ts';
import { attestableOp } from '../../src/core/access/actor.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { sweepArgs, type SweepFixture } from '../helpers/member-sweep.ts';

const ALICE_ID = 'U0ALICE';
const BOB_ID = 'oidc:3f2a:bob-example';
const CANARY = { actor: 'canaryhttpaliceactor', key: 'canaryhttpalicekey', bob: 'canaryhttpbob' } as const;
const ATTESTABLE = operations.filter(op => attestableOp(op.name, op));
const KEYLESS_ENV = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GBRAIN_SKIP_STARTUP_HOOKS: '1' };

const backends: Array<'pglite' | 'postgres'> = ['pglite', ...(hasDatabase() ? ['postgres' as const] : [])];

for (const [index, backend] of backends.entries()) {
  describe('/mcp keyless two-member sweep over serve --http (' + backend + ')', () => {
    const port = 19171 + index;
    const base = 'http://localhost:' + port;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-c2-e2e-'));
    const env: NodeJS.ProcessEnv = { ...process.env, ...KEYLESS_ENV, GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') };
    if (backend === 'pglite') delete env.DATABASE_URL;
    let server: ChildProcess | null = null;
    const bearer: Record<'qm' | 'alice' | 'bob' | 'plain', string> = { qm: '', alice: '', bob: '', plain: '' };
    const cli = (...args: string[]) => execFileSync('bun', ['run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const token = (out: string) => out.match(/gbrain_[a-f0-9]{32,}/)![0];
    const fixture: SweepFixture = { sourceId: 'default', memberSlug: 'memory/members/alice-example', entitySlug: 'companies/acme-example', entityName: 'Acme Example',
      words: 'oolong harbor ledger', factId: '1', requestId: 'c2-e2e-request', sessionId: 'c2-e2e-session' };

    beforeAll(async () => {
      if (backend === 'postgres') await setupDB();
      else cli('init', '--pglite', '--no-embedding');
      for (const id of ['alice-example', 'bob-example']) cli('access', 'member', 'add', id);
      bearer.alice = token(cli('auth', 'create', 'c2-alice-key', '--member', 'alice-example', '--scopes', 'read,write'));
      bearer.bob = token(cli('auth', 'create', 'c2-bob-key', '--member', 'bob-example', '--scopes', 'read,write'));
      bearer.plain = token(cli('auth', 'create', 'c2-plain-key', '--scopes', 'read,write'));
      const registered = cli('auth', 'register-client', 'c2-qm', '--grant-types', 'client_credentials', '--scopes', 'read write');
      const clientId = registered.match(/Client ID:\s+(\S+)/)![1]!;
      const clientSecret = registered.match(/Client Secret:\s+(\S+)/)![1]!;
      expect(cli('auth', 'rescope', '--client', clientId, '--attest-actor', 'qm', '--attest-ops', ATTESTABLE.map(op => op.name).join(','))).toContain('attests actor: qm');
      expect(cli('access', 'member', 'link', 'alice-example', '--qm', ALICE_ID)).toContain('Linked qm:' + ALICE_ID);
      expect(cli('access', 'member', 'link', 'bob-example', '--qm', BOB_ID)).toContain('-> bob-example');
      server = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(port), '--public-url', base], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      server.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { up = (await fetch(base + '/health')).ok; } catch { /* not up yet */ }
        if (!up) await new Promise(r => setTimeout(r, 500));
      }
      if (!up) throw new Error('Server failed to start within 30s.\nstderr: ' + stderr.slice(-800));
      const res = await fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
      expect(res.status).toBe(200);
      bearer.qm = (await res.json() as { access_token: string }).access_token;
      await call({ token: 'qm' }, 'put_page', { slug: fixture.entitySlug, content: '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.' });
    }, 180_000);

    afterAll(async () => {
      if (server) {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1000));
        if (!server.killed) server.kill('SIGKILL');
      }
      if (backend === 'postgres') await teardownDB();
      rmSync(home, { recursive: true, force: true });
    }, 30_000);

    type Who = { token: keyof typeof bearer; actor?: string };
    async function call(as: Who, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; all: string; result: Record<string, any> }> {
      const res = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bearer[as.token], 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(as.actor ? { 'x-qm-actor': as.actor } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { session_id: fixture.sessionId } } }),
      });
      const text = (await res.text()).trim();
      let parsed: { result?: Record<string, any>; error?: unknown } = {};
      try { parsed = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim()); } catch { /* raw */ }
      return { ok: res.status === 200 && !!parsed.result && parsed.result.isError !== true, all: text, result: parsed.result ?? {} };
    }

    test('facts saved by each member land on that member\'s page, across harnesses', async () => {
      expect((await call({ token: 'qm', actor: ALICE_ID }, 'remember', { fact: 'Alice drafts the oolong harbor ledger ' + CANARY.actor, provenance: 'qm', entity: fixture.entitySlug })).ok).toBe(true);
      expect((await call({ token: 'alice' }, 'remember', { fact: 'Alice signs the oolong harbor ledger ' + CANARY.key, provenance: 'cli harness' })).ok).toBe(true);
      expect((await call({ token: 'bob' }, 'remember', { fact: 'Bob audits the oolong harbor ledger ' + CANARY.bob, provenance: 'cli harness' })).ok).toBe(true);
      const recalled = await call({ token: 'qm', actor: ALICE_ID }, 'recall', { query: fixture.words });
      expect(recalled.all).toContain(CANARY.actor);
      expect(recalled.all).toContain(CANARY.key);
      expect(recalled.all).not.toContain(CANARY.bob);
      const page = await call({ token: 'alice' }, 'get_page', { slug: fixture.memberSlug });
      expect(page.all).toContain(CANARY.actor);
      expect(page.all).toContain(CANARY.key);
      const bobs = await call({ token: 'qm', actor: BOB_ID }, 'recall', { query: fixture.words });
      expect(bobs.all).toContain(CANARY.bob);
      expect(bobs.all).not.toContain(CANARY.actor);
    }, 120_000);

    test('0 cross-member rows across every operation the attest grant may call', async () => {
      const callers: Array<Who & { label: string }> = [
        { label: 'bob actor', token: 'qm', actor: BOB_ID }, { label: 'bob key', token: 'bob' }, { label: 'bare qm client', token: 'qm' }, { label: 'unbound key', token: 'plain' },
      ];
      const leaks: string[] = [];
      let answered = 0;
      for (const op of ATTESTABLE) {
        for (const args of sweepArgs(op, fixture)) {
          for (const as of callers) {
            const out = await call(as, op.name, args);
            if (out.ok) answered += 1;
            if (out.all.includes(CANARY.actor) || out.all.includes(CANARY.key)) leaks.push(op.name + ' as ' + as.label + ' ' + JSON.stringify(args));
          }
        }
      }
      expect(leaks).toEqual([]);
      expect(answered).toBeGreaterThan(100);
      const alice = await call({ token: 'qm', actor: ALICE_ID }, 'recall', { query: fixture.words });
      expect(alice.all).toContain(CANARY.actor);
    }, 1_200_000);
  });
}
