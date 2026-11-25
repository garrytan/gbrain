/**
 * Roadmap PR 2 (d7): onboarding_status and onboarding_off over MCP, and `gbrain onboarding status|off`, on a repo-less
 * brain (in-memory PGLite; Postgres too when DATABASE_URL is set), dispatched with remote=true.
 *
 * 1. Protects: the owner turns the suggestion off from any native client (unbound stdio, stdio bound to the owner, a
 *    credential bound to the owner) and the answer is read back from the store; anyone else is refused with
 *    onboarding_owner_only and nothing changes; the local hook outcome is shown only on this machine.
 * 2. Fails when: a member-bound or unbound HTTP credential can stop the owner's suggestion, a refusal still writes,
 *    or an HTTP caller sees the machine-local hook outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { STDIO_MEMBER_KEY } from '../src/core/access/caller.ts';
import { OWNER_MEMBER_KEY } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { INSTALL_RECEIPT_KEY } from '../src/core/onboard/setup-history.ts';
import { FIRST_SESSION_KEY, firstSessionStatus } from '../src/core/onboard/first-session.ts';
import { recordFirstSessionOutcome } from '../src/core/context/session-start-sections.ts';
import { runOnboarding } from '../src/commands/onboarding.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gb-onboarding-ops-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const kind of testBackends()) {
  describe(`onboarding ops (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(op: string, via: { stdioMember?: string; token?: string }) {
      const opts = via.token
        ? { remote: true, transport: 'http' as const, auth: await provider().verifyAccessToken(tokens[via.token]!) as unknown as AuthInfo, sourceId: 'default', takesHoldersAllowList: ['world'] }
        : { remote: true, transport: 'stdio' as const, sourceId: 'default', ...(via.stdioMember ? { stdioMember: via.stdioMember } : {}) };
      const out = await dispatchToolCall(engine, op, {}, opts);
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* an error envelope */ }
      return { isError: out.isError === true, text, json };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      await engine.setConfig(OWNER_MEMBER_KEY, 'alice-example');
      for (const name of ['alice', 'bob', 'unbound']) {
        tokens[name] = (await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] })).token;
      }
      const ids = await engine.executeRaw<{ id: string; name: string }>("SELECT id::text AS id, name FROM access_tokens WHERE name IN ('alice', 'bob')");
      for (const row of ids) await bindCredential(engine, { kind: 'token', id: row.id }, { member: row.name === 'alice' ? 'alice-example' : 'bob-example' });
    }, 120_000);
    afterAll(async () => { await close(); });

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM config WHERE key IN ($1, $2)', [INSTALL_RECEIPT_KEY, FIRST_SESSION_KEY]);
      await engine.setConfig(INSTALL_RECEIPT_KEY, JSON.stringify({ version: 1, install_id: randomUUID(), created_at: new Date().toISOString(), created_by: 'setup', harness: 'claude-code', eligible: true, stages: {} }));
    });

    test('status reads over stdio and HTTP; only the stdio answer names this machine\'s newest startup outcome', async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        recordFirstSessionOutcome({ harness: 'codex', sessionId: 's1', outcome: 'not_due', reason: 'not_startup' });
        const stdio = await call('onboarding_status', {});
        expect(stdio.json).toMatchObject({ state: 'off', reason: 'not_personal', max_sessions: 3, off: { mcp: 'onboarding_off' } });
        expect(stdio.json.last_session).toMatchObject({ harness: 'codex', outcome: 'not_due' });
        const http = await call('onboarding_status', { token: 'bob' });
        expect(http.json).toMatchObject({ state: 'off', reason: 'not_personal' });
        expect('last_session' in http.json).toBe(false);
      });
    });

    test('an unbound stdio server is the owner: off is verified from the store', async () => {
      const r = await call('onboarding_off', {});
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ stopped: true, verified: true, already: false, status: { state: 'off', reason: 'stopped' } });
      expect((await firstSessionStatus(engine)).stopped?.by).toBe('mcp');
    });

    test('a stdio server whose binding cannot be read is refused and nothing changes', async () => {
      const e = engine;
      const unreadable = new Proxy(e, {
  get(t, k) {
    if (k === 'getConfig') return async (key: string) => { if (key === STDIO_MEMBER_KEY) throw new Error('config read failed'); return t.getConfig(key); };
    const v = (t as unknown as Record<PropertyKey, unknown>)[k];
    return typeof v === 'function' ? v.bind(t) : v;
  },
}) as BrainEngine;
      const out = await dispatchToolCall(unreadable, 'onboarding_off', {}, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(out.isError).toBe(true);
      expect(out.content.map(c => c.text).join('\n')).toContain('onboarding_owner_only');
      expect(await engine.getConfig(FIRST_SESSION_KEY)).toBeNull();
    });

    test('a stdio server bound to the owner member may turn it off', async () => {
      expect((await call('onboarding_off', { stdioMember: 'alice-example' })).json).toMatchObject({ verified: true });
    });

    test('a credential bound to the owner member may turn it off', async () => {
      expect((await call('onboarding_off', { token: 'alice' })).json).toMatchObject({ verified: true });
    });

    test('a member-bound stdio server, a member credential and an unbound credential are refused and nothing changes', async () => {
      for (const via of [{ stdioMember: 'bob-example' }, { token: 'bob' }, { token: 'unbound' }]) {
        const r = await call('onboarding_off', via);
        expect(r.isError).toBe(true);
        expect(r.text).toContain('onboarding_owner_only');
        expect(await firstSessionStatus(engine)).toMatchObject({ state: 'off', reason: 'not_personal' });
        expect(await engine.getConfig(FIRST_SESSION_KEY)).toBeNull();
      }
    });

    test('gbrain onboarding status --json and off --by setup on the trusted local CLI', async () => {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
      try {
        await withEnv({ GBRAIN_HOME: home }, async () => {
          await runOnboarding(engine, ['status', '--json']);
          expect(JSON.parse(lines.join('\n'))).toMatchObject({ state: 'off', reason: 'not_personal', off: { argv: ['gbrain', 'onboarding', 'off'] } });
          lines.length = 0;
          await runOnboarding(engine, ['off', '--by', 'setup', '--json']);
          expect(JSON.parse(lines.join('\n'))).toMatchObject({ verified: true });
          expect((await firstSessionStatus(engine)).stopped?.by).toBe('setup');
          lines.length = 0;
          await runOnboarding(engine, ['status']);
          expect(lines.join('\n')).toContain('The first-session suggestion is off: it was turned off');
        });
      } finally { console.log = log; }
    });
  });
}

describe('gbrain onboarding --help', () => {
  test('prints its help without opening a brain', () => {
    const r = Bun.spawnSync(['bun', 'src/cli.ts', 'onboarding', '--help'], { env: { ...process.env, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain('gbrain onboarding status [--json]');
    expect(out).toContain('gbrain onboarding off [--json]');
    expect(out).toContain('--no-suggestion');
  }, 60_000);
});
