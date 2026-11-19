/**
 * GST-3199: the requester-scope grace boundary inside one wall-clock second, shared by the PGLite file
 * (test/serves-since-same-second.test.ts) and the Postgres file (test/e2e/serves-since-same-second-postgres.test.ts).
 * An unbound token minted before the brain starts serving several people reads in its grace even when the second
 * member is added within the same second; one minted after it is refused; a whole-second access.serves_since stored
 * by an older gbrain keeps today's whole-second answer.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { credentialScopeFor, requesterScopeGate } from '../../src/core/access/requester-scope.ts';
import { readServesPolicy } from '../../src/core/search/private-visibility.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { v329 } from '../../src/core/schema-migrations/v329-serves-since-subsecond.ts';

export type Open = () => Promise<{ engine: BrainEngine; close: () => Promise<void> }>;

async function startOfSecond(): Promise<void> {
  while (Date.now() % 1000 > 30) await Bun.sleep(2);
}

async function mintUnbound(engine: BrainEngine, name: string): Promise<string> {
  return (await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] })).id;
}

async function gate(engine: BrainEngine, id: string, name: string, member?: string): Promise<string> {
  const serves = await readServesPolicy(engine);
  const auth = await credentialScopeFor(engine, { clientName: name, scopes: ['read'], principal: { kind: 'legacy_token', id } } as never);
  try {
    return requesterScopeGate({ name: 'get_page', mutating: false } as never, { remotePolicy: { privacyRelaxed: false, restricted: false, serves }, ...(member ? { identity: ['member:' + member] } : {}) }, auth, 'http')?.state ?? 'none';
  } catch (e) {
    const err = e as { code?: string };
    return (err.code ?? 'error') + (JSON.stringify(e).includes('created_after') ? ':created_after' : '');
  }
}

const second = async (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  Number((await engine.executeRaw<{ s: unknown }>(sql, params))[0]?.s);

async function createdSecond(engine: BrainEngine, id: string): Promise<number> {
  return second(engine, 'SELECT floor(extract(epoch FROM created_at)) AS s FROM access_tokens WHERE id::text = $1', [id]);
}

async function sinceSecond(engine: BrainEngine): Promise<number> {
  return Math.floor(Date.parse((await engine.getConfig('access.serves_since'))!) / 1000);
}

async function pinSecond(engine: BrainEngine, before: string[], after: string[]): Promise<void> {
  const s = await sinceSecond(engine);
  await engine.setConfig('access.serves_since', new Date(s * 1000 + 500).toISOString().replace('.500Z', '.500000Z'));
  for (const [ids, ms] of [[before, 250], [after, 750]] as const) {
    for (const id of ids) await engine.executeRaw('UPDATE access_tokens SET created_at = $2::timestamptz WHERE id::text = $1', [id, new Date(s * 1000 + ms).toISOString()]);
  }
}

export function sameSecondTests(open: Open): void {
  test('against the whole-second answer for the same instant, the only caller whose answer changes is an unbound token minted before the switch in that second, and it moves from refused to its grace', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      const owner = await mintUnbound(engine, 'tok-owner');
      await bindCredential(engine, { kind: 'token', id: owner }, { member: 'alice-example' });
      const optedOut = await mintUnbound(engine, 'tok-reads-unscoped');
      await engine.executeRaw('UPDATE access_tokens SET reads_unscoped = now() WHERE id::text = $1', [optedOut]);
      const member = await mintUnbound(engine, 'tok-member');
      await startOfSecond();
      const before = await mintUnbound(engine, 'tok-before');
      await addMember(engine, 'bob-example');
      const after = await mintUnbound(engine, 'tok-after');
      await bindCredential(engine, { kind: 'token', id: member }, { member: 'bob-example' });
      await pinSecond(engine, [before], [after]);
      expect(await createdSecond(engine, before)).toBe(await sinceSecond(engine));
      expect(await createdSecond(engine, after)).toBe(await sinceSecond(engine));
      const callers: Array<[string, string, string?]> = [[owner, 'tok-owner', 'alice-example'], [member, 'tok-member', 'bob-example'], [optedOut, 'tok-reads-unscoped'], [before, 'tok-before'], [after, 'tok-after']];
      const answers = async () => Object.fromEntries(await Promise.all(callers.map(async ([id, name, m]) => [name, await gate(engine, id, name, m)] as const)));
      const subSecond = await answers();
      await engine.setConfig('access.serves_since', new Date(await sinceSecond(engine) * 1000).toISOString().replace('.000Z', 'Z'));
      const wholeSecond = await answers();
      expect(wholeSecond).toEqual({ 'tok-owner': 'none', 'tok-member': 'none', 'tok-reads-unscoped': 'none', 'tok-before': 'requester_scope_required:created_after', 'tok-after': 'requester_scope_required:created_after' });
      expect(subSecond).toEqual({ ...wholeSecond, 'tok-before': 'grace' });
    } finally { await close(); }
  }, 60_000);

  test('an unbound OAuth client registered after the second member, in the same second, is refused', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      const issued = await sinceSecond(engine);
      await engine.setConfig('access.serves_since', new Date(issued * 1000 + 500).toISOString().replace('.500Z', '.500000Z'));
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
        client_id_issued_at) VALUES ('client-after', 'x', 'client-after', '{}', '{client_credentials}', 'read', 'client_secret_post', $1)`, [issued]);
      expect(Date.parse((await engine.getConfig('access.serves_since'))!) / 1000).toBeGreaterThan(issued);
      const serves = await readServesPolicy(engine);
      const auth = await credentialScopeFor(engine, { clientName: 'client-after', scopes: ['read'], principal: { kind: 'oauth_client', id: 'client-after' } } as never);
      let answer = 'none';
      try {
        answer = requesterScopeGate({ name: 'get_page', mutating: false } as never, { remotePolicy: { privacyRelaxed: false, restricted: false, serves } }, auth, 'http')?.state ?? 'none';
      } catch (e) {
        answer = ((e as { code?: string }).code ?? 'error') + (JSON.stringify(e).includes('created_after') ? ':created_after' : '');
      }
      expect(answer).toBe('requester_scope_required:created_after');
    } finally {
      await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = 'client-after'`);
      await close();
    }
  }, 60_000);

  test('a token minted before the second member, in the same second, reads in its grace', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await startOfSecond();
      const id = await mintUnbound(engine, 'tok-before');
      await addMember(engine, 'bob-example');
      expect(await engine.getConfig('access.serves_since')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      await pinSecond(engine, [id], []);
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await gate(engine, id, 'tok-before')).toBe('grace');
    } finally { await close(); }
  }, 60_000);

  test('a token minted after the second member, in the same second, is refused', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await startOfSecond();
      await addMember(engine, 'bob-example');
      const id = await mintUnbound(engine, 'tok-after');
      await pinSecond(engine, [], [id]);
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await gate(engine, id, 'tok-after')).toBe('requester_scope_required:created_after');
    } finally { await close(); }
  }, 60_000);

  test('a whole-second serves_since an older gbrain stored keeps the whole-second answer, and v329 leaves it as it is', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await startOfSecond();
      const id = await mintUnbound(engine, 'tok-legacy');
      await addMember(engine, 'bob-example');
      await pinSecond(engine, [id], []);
      const whole = new Date(await sinceSecond(engine) * 1000).toISOString().replace('.000Z', 'Z');
      await engine.setConfig('access.serves_since', whole);
      await engine.executeRaw(v329.sql);
      await addMember(engine, 'carol-example');
      expect(await engine.getConfig('access.serves_since')).toBe(whole);
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await gate(engine, id, 'tok-legacy')).toBe('requester_scope_required:created_after');
    } finally { await close(); }
  }, 60_000);
}
