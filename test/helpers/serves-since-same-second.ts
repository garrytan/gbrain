/**
 * GST-3199: the requester-scope grace boundary inside one wall-clock second, shared by the PGLite file
 * (test/serves-since-same-second.test.ts) and the Postgres file (test/e2e/serves-since-same-second-postgres.test.ts).
 * An unbound token minted before the brain starts serving several people reads in its grace even when the second
 * member is added within the same second; one minted after it is refused; a whole-second access.serves_since stored
 * by an older gbrain keeps today's whole-second answer.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { addMember } from '../../src/core/access/members.ts';
import { credentialScopeFor, requesterScopeGate } from '../../src/core/access/requester-scope.ts';
import { readServesPolicy } from '../../src/core/search/private-visibility.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { v327 } from '../../src/core/schema-migrations/v327-serves-since-subsecond.ts';

export type Open = () => Promise<{ engine: BrainEngine; close: () => Promise<void> }>;

async function startOfSecond(): Promise<void> {
  while (Date.now() % 1000 > 30) await Bun.sleep(2);
}

async function mintUnbound(engine: BrainEngine, name: string): Promise<string> {
  return (await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] })).id;
}

async function gate(engine: BrainEngine, id: string, name: string): Promise<string> {
  const serves = await readServesPolicy(engine);
  const auth = await credentialScopeFor(engine, { clientName: name, scopes: ['read'], principal: { kind: 'legacy_token', id } } as never);
  try {
    return requesterScopeGate({ name: 'get_page', mutating: false } as never, { remotePolicy: { privacyRelaxed: false, restricted: false, serves } }, auth, 'http')?.state ?? 'none';
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

export function sameSecondTests(open: Open): void {
  test('a token minted before the second member, in the same second, reads in its grace', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await startOfSecond();
      const id = await mintUnbound(engine, 'tok-before');
      await addMember(engine, 'bob-example');
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await engine.getConfig('access.serves_since')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
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
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await gate(engine, id, 'tok-after')).toBe('requester_scope_required:created_after');
    } finally { await close(); }
  }, 60_000);

  test('a whole-second serves_since an older gbrain stored keeps the whole-second answer, and v327 leaves it as it is', async () => {
    const { engine, close } = await open();
    try {
      await addMember(engine, 'alice-example');
      await startOfSecond();
      const id = await mintUnbound(engine, 'tok-legacy');
      await addMember(engine, 'bob-example');
      const whole = new Date(await sinceSecond(engine) * 1000).toISOString().replace('.000Z', 'Z');
      await engine.setConfig('access.serves_since', whole);
      await engine.executeRaw(v327.sql);
      await addMember(engine, 'carol-example');
      expect(await engine.getConfig('access.serves_since')).toBe(whole);
      expect(await createdSecond(engine, id)).toBe(await sinceSecond(engine));
      expect(await gate(engine, id, 'tok-legacy')).toBe('requester_scope_required:created_after');
    } finally { await close(); }
  }, 60_000);
}
