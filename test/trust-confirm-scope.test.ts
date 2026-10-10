/**
 * The owner-confirmation capability for memory trust (#5575: CEO-6, CEO-9,
 * CEO-14, CEO-18, DX-3, ENG-15).
 *
 * Protects: `memory_confirm` implies only itself, admin never implies it, it
 * is never DCR-registrable or advertised in discovery (both modes), never in a
 * grant profile, never on a grandfathered null-scope token, and every admin
 * HTTP mint surface refuses it while the local CLI mints it; the typed-token
 * TTY confirmation (the user types the ref, not y/N) through the isInteractive
 * seam's test override; `--yes` never confirms and tier-raising fixes are
 * `tell_user_to_run`; the per-token `min_trust` floor reaches
 * `AuthInfo.minTrust` on both legacy tokens and OAuth clients and is changed
 * only through the local `auth set-min-trust` path. Fails if admin starts
 * implying the scope, a mint path accepts it remotely, a y/N answer or
 * piped input confirms, or the floor drops out of token verification.
 * PGLite only (the verify path's SQL is shared with Postgres and covered by
 * the OAuth suites).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  ALLOWED_SCOPES, dcrScopeViolation, hasScope, localCliOnlyScopeViolation, normalizeScopesInput, scopesSupportedForDiscovery,
} from '../src/core/scope.ts';
import { GRANT_PROFILES, grantFromTokenRow } from '../src/core/grants/model.ts';
import { resolveGrantProfile } from '../src/core/grants/profiles.ts';
import { AGENT_WRITE_OPERATIONS } from '../src/core/trust/channel.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';
import { parseApiKeyMintRequest } from '../src/commands/serve-http-api-keys.ts';
import { parseAuthCreateArgs } from '../src/commands/auth.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { OperationError, type AuthInfo, type OperationContext } from '../src/core/ops/contract.ts';
import {
  __setConfirmationIoForTests, promptTypedConfirmation, requireOwnerConfirmation, tierRaiseFix, type ConfirmationTarget,
} from '../src/core/trust/confirm.ts';
import { setMinTrust, setTokenMinTrust } from '../src/core/trust/min-trust.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  __setConfirmationIoForTests(null);
  await engine.disconnect();
});

describe('memory_confirm scope (CEO-6)', () => {
  test('implies only itself; admin and write never imply it', () => {
    expect(ALLOWED_SCOPES.has('memory_confirm')).toBe(true);
    expect(hasScope(['admin'], 'memory_confirm')).toBe(false);
    expect(hasScope(['admin', 'agent', 'write'], 'memory_confirm')).toBe(false);
    expect(hasScope(['memory_confirm'], 'memory_confirm')).toBe(true);
    expect(hasScope(['memory_confirm'], 'read')).toBe(false);
  });

  test('never advertised in discovery, in either DCR mode', () => {
    expect(scopesSupportedForDiscovery({ enableDcr: true })).not.toContain('memory_confirm');
    expect(scopesSupportedForDiscovery({ enableDcr: false })).not.toContain('memory_confirm');
  });

  test('dynamic registration refuses it with the local command', () => {
    for (const grants of [['authorization_code'], ['client_credentials']]) {
      const violation = dcrScopeViolation(['read', 'memory_confirm'], grants);
      expect(violation).toContain('memory_confirm');
      expect(violation).toContain('gbrain auth create');
    }
  });

  test('the admin HTTP normalizer refuses it; plain scopes still pass', () => {
    expect(() => normalizeScopesInput('read memory_confirm')).toThrow(/local CLI/);
    expect(() => normalizeScopesInput(['memory_confirm'])).toThrow(/local CLI/);
    expect(normalizeScopesInput('write read')).toBe('read write');
    expect(localCliOnlyScopeViolation(['read', 'write', 'admin'])).toBeNull();
  });

  test('admin API key minting refuses it with a user-run fix', async () => {
    try { await parseApiKeyMintRequest(engine, { name: 'k', scopes: ['read', 'memory_confirm'] }); throw new Error('accepted'); }
    catch (e) {
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as OperationError).fix?.argv).toContain('read,write,memory_confirm');
      expect((e as OperationError).fix?.actor).toBe('user');
    }
  });

  test('no grant profile carries it', () => {
    for (const profile of GRANT_PROFILES) {
      const patch = resolveGrantProfile({ profile, sourceId: 'default', boundTools: ['search'], boundSlugPrefixes: ['wiki/agents/'] });
      expect({ profile, confirm: hasScope(patch.scopes ?? [], 'memory_confirm') }).toEqual({ profile, confirm: false });
    }
  });

  test('bulk-write grants (full surface, put_pages) cannot confirm or raise a tier', () => {
    const writer = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    expect(writer.surface).toBe('full');
    expect(writer.allowedOperations).toContain('put_pages');
    // put_pages publishes at the agent channel tier; only memory_confirm (never implied) confirms.
    expect(AGENT_WRITE_OPERATIONS).toContain('put_pages');
    for (const profile of ['memory-writer', 'coding-agent'] as const) {
      const patch = resolveGrantProfile({ profile, sourceId: 'default', boundSlugPrefixes: ['wiki/agents/'] });
      expect({ profile, confirm: hasScope(patch.scopes ?? [], 'memory_confirm') }).toEqual({ profile, confirm: false });
    }
  });

  test('a grandfathered null-scope token never holds it', () => {
    const grant = grantFromTokenRow({ id: randomUUID(), scopes: null, permissions: null, source_grant: null });
    expect(grant.scopes).toEqual(['read', 'write', 'admin']);
    expect(hasScope(grant.scopes, 'memory_confirm')).toBe(false);
  });

  test('the local CLI mints it explicitly, and verification carries it', async () => {
    const minted = await mintLegacyToken(engine, { name: `confirm-${randomUUID().slice(0, 6)}`, scopes: ['read', 'write', 'memory_confirm'], takesHolders: ['world'] });
    const auth = await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
    expect(hasScope(auth.scopes, 'memory_confirm')).toBe(true);
  });
});

const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

describe('per-token min_trust floor (CEO-18)', () => {
  test('auth create parses --min-trust and refuses a non-tier', () => {
    expect(parseAuthCreateArgs(['bot', '--scopes', 'read', '--min-trust', 'agent_written'])).toEqual({ name: 'bot', scopes: ['read'], minTrust: 'agent_written' });
    expect(parseAuthCreateArgs(['bot', '--min-trust', 'high']).error).toContain('agent_written');
    expect(parseAuthCreateArgs(['bot']).minTrust).toBeUndefined();
  });

  test('a legacy token floor reaches AuthInfo.minTrust; none leaves it undefined', async () => {
    const minted = await mintLegacyToken(engine, { name: `floor-${randomUUID().slice(0, 6)}`, scopes: ['read'], takesHolders: ['world'] });
    expect((await provider().verifyAccessToken(minted.token) as unknown as AuthInfo).minTrust).toBeUndefined();
    await setTokenMinTrust(engine, minted.id, 'tool_observed');
    expect((await provider().verifyAccessToken(minted.token) as unknown as AuthInfo).minTrust).toBe('tool_observed');
    const change = await setMinTrust(engine, minted.name, null);
    expect(change).toMatchObject({ kind: 'legacy_token', id: minted.id, before: 'tool_observed', after: null });
    expect((await provider().verifyAccessToken(minted.token) as unknown as AuthInfo).minTrust).toBeUndefined();
  });

  test('an OAuth client floor reaches AuthInfo.minTrust', async () => {
    const clientId = `client-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','floor-client','read','default')`, [clientId]);
    const token = generateToken('gbrain_at_');
    await engine.executeRaw(`INSERT INTO oauth_tokens(token_hash,token_type,client_id,scopes,expires_at) VALUES($1,'access',$2,'{read}'::text[],$3)`,
      [hashToken(token), clientId, Math.floor(Date.now() / 1000) + 3600]);
    expect((await provider().verifyAccessToken(token) as unknown as AuthInfo).minTrust).toBeUndefined();
    expect(await setMinTrust(engine, clientId, 'agent_written')).toMatchObject({ kind: 'oauth_client', before: null, after: 'agent_written' });
    expect((await provider().verifyAccessToken(token) as unknown as AuthInfo).minTrust).toBe('agent_written');
  });

  test('the column refuses a value that names no tier', async () => {
    const minted = await mintLegacyToken(engine, { name: `bad-${randomUUID().slice(0, 6)}`, scopes: ['read'], takesHolders: ['world'] });
    await expect(engine.executeRaw(`UPDATE access_tokens SET min_trust='high' WHERE id=$1::uuid`, [minted.id])).rejects.toThrow(/min_trust_check/);
  });

  test('an unknown target is not_found', async () => {
    await expect(setMinTrust(engine, 'no-such-client', 'unknown')).rejects.toMatchObject({ code: 'not_found' });
  });
});

const target: ConfirmationTarget = { ref: 'f42', summary: 'Raise fact f42 to confirmed by you', command: ['gbrain', 'trust', 'confirm', 'f42'] };
const local = { remote: false } as OperationContext;
function tty(answer: string | null) {
  const input = new PassThrough();
  const output = new PassThrough();
  let prompt = '';
  output.on('data', chunk => { prompt += String(chunk); });
  __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { GBRAIN_INTERACTIVE: '1' } }, input, output, timeoutMs: 2000 });
  if (answer === null) input.end(); else input.write(`${answer}\n`);
  return { prompt: () => prompt };
}

describe('typed-token owner confirmation (CEO-9, CEO-14, ENG-15, DX-3)', () => {
  test('on a TTY the user types the target token and it confirms', async () => {
    const io = tty('f42');
    expect(await requireOwnerConfirmation(local, target)).toEqual({ via: 'tty' });
    expect(io.prompt()).toContain('Type f42 to confirm');
  });

  test('y, yes or a wrong token decline with confirmation_required', async () => {
    for (const answer of ['y', 'yes', 'f43']) {
      tty(answer);
      await expect(requireOwnerConfirmation(local, target)).rejects.toMatchObject({ code: 'confirmation_required' });
    }
  });

  test('a custom token (hash8) is what must be typed', async () => {
    tty('a1b2c3d4');
    expect(await promptTypedConfirmation({ ...target, token: 'a1b2c3d4' })).toBe('confirmed');
    tty('f42');
    expect(await promptTypedConfirmation({ ...target, token: 'a1b2c3d4' })).toBe('declined');
  });

  test('without a TTY nothing is asked and the refusal is a user-run fix with no --yes', async () => {
    __setConfirmationIoForTests({ probe: { stdinIsTTY: false, stdoutIsTTY: false, env: {} } });
    expect(await promptTypedConfirmation(target)).toBe('non_interactive');
    try { await requireOwnerConfirmation(local, target); throw new Error('accepted'); }
    catch (e) {
      const err = e as OperationError;
      expect(err.code).toBe('confirmation_required');
      const rendered = renderAction(err.fix!, { transport: 'cli', isCallable: () => false, preapproved: () => true });
      expect(rendered.next).toBe('tell_user_to_run');
      expect(rendered.argv).toEqual(['gbrain', 'trust', 'confirm', 'f42']);
      expect(rendered.argv).not.toContain('--yes');
    }
  });

  test('an agent-marker environment on two TTYs still cannot confirm', async () => {
    __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } } });
    await expect(requireOwnerConfirmation(local, target)).rejects.toMatchObject({ code: 'confirmation_required' });
  });

  test('a remote connection needs memory_confirm: admin gets insufficient_scope with a user-run fix', async () => {
    const remote = (scopes: string[]) => ({ remote: true, auth: { token: 't', clientId: 'c', scopes } }) as unknown as OperationContext;
    try { await requireOwnerConfirmation(remote(['read', 'write', 'admin']), target); throw new Error('accepted'); }
    catch (e) {
      expect((e as OperationError).code).toBe('insufficient_scope');
      expect(renderAction((e as OperationError).fix!, { transport: 'http', isCallable: () => true, preapproved: () => true }).next).toBe('tell_user_to_run');
    }
    expect(await requireOwnerConfirmation(remote(['read', 'memory_confirm']), target)).toEqual({ via: 'memory_confirm_scope' });
  });

  test('a tier-raising fix refuses to carry --yes', () => {
    expect(() => tierRaiseFix(['gbrain', 'trust', 'confirm', 'f1', '--yes'], 'why')).toThrow(/--yes/);
    expect(() => tierRaiseFix(['gbrain', 'trust', 'confirm', 'f1', '-y'], 'why')).toThrow(/--yes/);
    expect(tierRaiseFix(['gbrain', 'trust', 'confirm', 'f1'], 'why')).toMatchObject({ actor: 'user', consent: [] });
  });
});
