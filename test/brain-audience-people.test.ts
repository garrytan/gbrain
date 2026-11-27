/**
 * GST-3180: whether a brain with no brain.audience declaration reads as shared counts people, not credentials. Each
 * credential bound to a member counts as that member; a credential bound to nobody still counts by itself, so only
 * credentials known to be one person merge. One owner with three clients is one person and stays personal; two members
 * are two people and read as shared. Repo-less, keyless, synthetic values only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyBrainAudience, BRAIN_AUDIENCE_KEY } from '../src/core/facts/writeback-audience.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await addMember(engine, 'alice-example');
  await addMember(engine, 'bob-example');
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.unsetConfig(BRAIN_AUDIENCE_KEY);
  await engine.executeRaw('DELETE FROM mcp_request_log');
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
});

async function client(name: string, member: string | null, kind: 'token' | 'client' = 'token'): Promise<void> {
  if (kind === 'token') {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
    if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  } else {
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope) VALUES ($1, $1, '{}', '{client_credentials}', 'read')`, [name]);
    if (member) await bindCredential(engine, { kind: 'client', id: name }, { member });
  }
  for (let i = 0; i < 5; i++) {
    await engine.executeRaw(`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status) VALUES ($1, 'search', 5, 'success')`, [name]);
  }
}

describe('brain audience counts people, not credentials', () => {
  test('three clients bound to the one owner read as one person: personal', async () => {
    await client('alice-laptop', 'alice-example');
    await client('alice-phone', 'alice-example');
    await client('alice-agent', 'alice-example', 'client');
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('personal');
    expect(r.reasons.join(' ')).toContain('1 person');
  });

  test('two members read as shared, however their clients split', async () => {
    await client('alice-laptop', 'alice-example');
    await client('alice-phone', 'alice-example');
    await client('bob-laptop', 'bob-example');
    expect((await classifyBrainAudience(engine)).audience).toBe('shared');
    await engine.executeRaw(`DELETE FROM mcp_request_log WHERE token_name = 'alice-phone'`);
    expect((await classifyBrainAudience(engine)).audience).toBe('shared');
  });

  test('credentials bound to nobody still count one each', async () => {
    await client('laptop', null);
    await client('phone', null);
    expect((await classifyBrainAudience(engine)).audience).toBe('personal');
    await client('agent', null, 'client');
    expect((await classifyBrainAudience(engine)).audience).toBe('shared');
  });

  test('one owner plus two unbound credentials still reads as shared', async () => {
    await client('alice-laptop', 'alice-example');
    await client('alice-phone', 'alice-example');
    await client('laptop', null);
    await client('phone', null);
    expect((await classifyBrainAudience(engine)).audience).toBe('shared');
  });

  test('a client name bound to two different members counts as unbound, not as either member', async () => {
    await client('dup', 'alice-example');
    await client('dup', 'bob-example', 'client');
    await client('alice-phone', 'alice-example');
    await client('x', null);
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('shared');
    expect(r.reasons.join(' ')).toContain('1 member(s), 2 unbound client(s)');
  });

  test('a revoked twin of a member-bound token name does not make it unbound', async () => {
    await client('alice-laptop', 'alice-example');
    await engine.executeRaw(`UPDATE access_tokens SET revoked_at = now() WHERE name = 'alice-laptop'`);
    await client('alice-laptop', 'alice-example');
    await engine.executeRaw(`UPDATE access_tokens SET member_id = NULL WHERE name = 'alice-laptop' AND revoked_at IS NOT NULL`);
    await client('alice-phone', 'alice-example');
    await client('alice-agent', 'alice-example', 'client');
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('personal');
    expect(r.reasons.join(' ')).toContain('1 person (1 member(s), 0 unbound client(s))');
  });

  test('when the member bindings cannot be read, every client counts by itself', async () => {
    await client('alice-laptop', 'alice-example');
    await client('alice-phone', 'alice-example');
    await client('alice-agent', 'alice-example', 'client');
    const failing = new Proxy(engine, {
      get(target, prop) {
        // The binding read is a typed member (listCredentialMemberBindings): a non-refusal failure of it.
        if (prop === 'listCredentialMemberBindings') return () => Promise.reject(new Error('bindings unreadable'));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const r = await classifyBrainAudience(failing);
    expect(r.audience).toBe('shared');
    expect(r.reasons.join(' ')).toContain('0 member(s), 3 unbound client(s), member bindings unreadable');
  });
  test('an engine that refuses the member binding read refuses the caller, instead of counting every client by itself', async () => {
    await client('alice-laptop', 'alice-example');
    await client('alice-phone', 'alice-example');
    const refusing = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'listCredentialMemberBindings') {
          return () => Promise.reject(Object.assign(new Error('listCredentialMemberBindings is not served'), { code: 'engine_capability_missing' }));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(classifyBrainAudience(refusing)).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });
});
