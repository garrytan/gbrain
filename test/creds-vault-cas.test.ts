/**
 * GST-3849 PR 1: the credential vault's custody rules.
 *  - version 1 files read and write unchanged; a per-account client moves the
 *    file to version 2, which a v1 binary refuses instead of clobbering;
 *  - the vault lock fails closed (no unlocked write), takes over only a dead
 *    holder's lock, and serializes writers across processes;
 *  - grant writes are compare-and-swap on the grant generation, which a
 *    disconnect never lets a reconnect reuse.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialError, type CredentialErrorCode } from '../src/core/creds/errors.ts';
import {
  FileVaultBackend,
  grantGeneration,
  parseVaultFile,
  withVaultLock,
  type CredentialEntry,
  type ProviderClientRecord,
} from '../src/core/creds/vault.ts';

const REPO = join(import.meta.dir, '..');
let dir = '';
let path = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-vault-cas-'));
  path = join(dir, 'credentials.json');
});

function entry(account: string, extra: Partial<CredentialEntry['meta']> = {}): CredentialEntry {
  return {
    id: `google:${account}`,
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: { access_token: 'ya29.old', refresh_token: '1//old', expiry: new Date(Date.now() + 3_600_000).toISOString() },
    meta: { account, scopes: ['openid', 'email'], connected_at: '2026-01-01T00:00:00.000Z', ...extra },
  };
}

function client(account?: string, id = '111-aaa.apps.googleusercontent.com'): ProviderClientRecord {
  return { provider: 'google', client_id: id, client_secret: 'GOCSPX-synthetic', created_at: '2026-01-01T00:00:00.000Z', ...(account ? { account, mode: 'personal' as const } : {}) };
}

/** A frozen copy of the v1 reader's version rule (gbrain before GST-3849). */
function v1Parse(raw: string): unknown {
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (parsed.version !== 1) throw new Error(`Unsupported credentials.json version: ${String(parsed.version)}`);
  return parsed;
}

async function expectCode(p: Promise<unknown>, code: CredentialErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CredentialError);
    expect((e as CredentialError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('vault file versions', () => {
  test('a v1 file reads unchanged and stays version 1 after byo writes', async () => {
    writeFileSync(path, JSON.stringify({ version: 1, clients: [client()], credentials: { 'google:a@example.com': entry('a@example.com') } }));
    const v = new FileVaultBackend(path);
    expect((await v.get('google:a@example.com'))?.secret.refresh_token).toBe('1//old');
    expect((await v.getClient('google'))?.client_id).toBe(client().client_id);
    await v.put(entry('b@example.com'));
    expect(JSON.parse(readFileSync(path, 'utf-8')).version).toBe(1);
    expect(() => v1Parse(readFileSync(path, 'utf-8'))).not.toThrow();
  });

  test('a per-account client moves the file to version 2, which a v1 reader refuses; the provider-wide client is untouched', async () => {
    const v = new FileVaultBackend(path);
    await v.putClient(client());
    await v.commitGrant({ entry: entry('a@example.com', { client_id: '222-bbb.apps.googleusercontent.com', client_mode: 'personal' }), client: client('a@example.com', '222-bbb.apps.googleusercontent.com'), expectedGeneration: null });
    const raw = readFileSync(path, 'utf-8');
    expect(JSON.parse(raw).version).toBe(2);
    expect(() => v1Parse(raw)).toThrow('Unsupported credentials.json version: 2');
    expect(parseVaultFile(raw).clients).toHaveLength(2);
    // getClient is the provider-wide (v1) record only; the account's record is read by id.
    expect((await v.getClient('google'))?.client_id).toBe(client().client_id);
    expect((await v.getClientById('google', '222-bbb.apps.googleusercontent.com'))?.account).toBe('a@example.com');
    // Replacing the provider-wide client never deletes an account's own client.
    await v.putClient(client(undefined, '333-ccc.apps.googleusercontent.com'));
    expect((await v.listClients('google')).map((c) => c.client_id).sort()).toEqual(['222-bbb.apps.googleusercontent.com', '333-ccc.apps.googleusercontent.com']);
    await v.deleteClient('google');
    expect((await v.listClients('google')).map((c) => c.account)).toEqual(['a@example.com']);
  });
});

describe('grant generations (compare-and-swap)', () => {
  test('commitGrant bumps the generation and refuses a stale expected generation', async () => {
    const v = new FileVaultBackend(path);
    const first = await v.commitGrant({ entry: entry('a@example.com'), expectedGeneration: null });
    expect(first.meta.grant_generation).toBe(1);
    await expectCode(v.commitGrant({ entry: entry('a@example.com'), expectedGeneration: null }), 'vault_generation_changed');
    const second = await v.commitGrant({ entry: entry('a@example.com'), expectedGeneration: 1 });
    expect(second.meta.grant_generation).toBe(2);
  });

  test('a disconnect never lets a reconnect reuse a generation, so a late refresh cannot write the new grant', async () => {
    const v = new FileVaultBackend(path);
    await v.commitGrant({ entry: entry('a@example.com'), expectedGeneration: null });
    const read = grantGeneration(await v.get('google:a@example.com'))!;
    expect(await v.delete('google:a@example.com')).toBe(true);
    // The late refresh (read at generation 1) finds the entry gone.
    await expectCode(v.casUpdateTokens('google:a@example.com', read, { secret: { access_token: 'ya29.late' }, meta: {} }), 'not_connected');
    // A reconnect gets generation 2, not 1 again, so the late write still loses.
    const again = await v.commitGrant({ entry: { ...entry('a@example.com'), secret: { refresh_token: '1//new', access_token: 'ya29.new' } }, expectedGeneration: null });
    expect(again.meta.grant_generation).toBe(2);
    await expectCode(v.casUpdateTokens('google:a@example.com', read, { secret: { access_token: 'ya29.late' }, meta: {} }), 'vault_generation_changed');
    expect((await v.get('google:a@example.com'))?.secret.access_token).toBe('ya29.new');
  });

  test('casUpdateTokens writes token fields only and keeps an entry without a generation at none', async () => {
    writeFileSync(path, JSON.stringify({ version: 1, clients: [], credentials: { 'google:a@example.com': entry('a@example.com') } }));
    const v = new FileVaultBackend(path);
    const updated = await v.casUpdateTokens('google:a@example.com', 0, { secret: { access_token: 'ya29.new' }, meta: { last_refresh_ok_at: '2026-02-01T00:00:00.000Z' } });
    expect(updated.secret.refresh_token).toBe('1//old');
    expect(updated.secret.access_token).toBe('ya29.new');
    expect(updated.meta.grant_generation).toBeUndefined();
  });
});

describe('vault lock fails closed', () => {
  const children: Array<{ kill: () => void }> = [];
  afterEach(() => { for (const c of children.splice(0)) c.kill(); });

  test('a lock held by a live process refuses with vault_lock_busy and writes nothing', () => {
    const holder = Bun.spawn(['sleep', '30']);
    children.push(holder);
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: holder.pid, nonce: 'held', at: Date.now() }));
    let ran = false;
    expect(() => withVaultLock(path, () => { ran = true; }, 200)).toThrow(CredentialError);
    expect(ran).toBe(false);
    expect(readFileSync(`${path}.lock`, 'utf-8')).toContain('held');
  });

  test('a steal guard left by a stealer that died is cleared, and the dead holder\'s lock is then taken over', () => {
    const gone = Bun.spawnSync(['true']);
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: gone.pid, nonce: 'dead', at: Date.now() }));
    writeFileSync(`${path}.lock.steal`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock.steal`, old, old);
    expect(withVaultLock(path, () => 'ran', 1000)).toBe('ran');
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(existsSync(`${path}.lock.steal`)).toBe(false);
  });

  test('a fresh steal guard means another process is stealing: the lock is left alone until the wait runs out', () => {
    const gone = Bun.spawnSync(['true']);
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: gone.pid, nonce: 'dead', at: Date.now() }));
    writeFileSync(`${path}.lock.steal`, '');
    expect(() => withVaultLock(path, () => 'ran', 200)).toThrow(CredentialError);
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf-8')).nonce).toBe('dead');
  });

  test('a lock whose holder process is gone is taken over', () => {
    const gone = Bun.spawnSync(['true']);
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: gone.pid, nonce: 'dead', at: Date.now() }));
    expect(withVaultLock(path, () => 'ran', 200)).toBe('ran');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test('another process holding the lock past the wait makes a disconnect refuse, then succeed after release', async () => {
    const v = new FileVaultBackend(path);
    await v.commitGrant({ entry: entry('a@example.com'), expectedGeneration: null });
    const script = join(dir, 'hold.ts');
    writeFileSync(script, `import { withVaultLock } from ${JSON.stringify(join(REPO, 'src/core/creds/vault.ts'))};
withVaultLock(${JSON.stringify(path)}, () => { console.log('held'); const until = Date.now() + 6500; while (Date.now() < until) {} });`);
    const child = Bun.spawn(['bun', script], { stdout: 'pipe' });
    children.push(child);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('held');
    await expectCode(v.delete('google:a@example.com'), 'vault_lock_busy');
    expect(await v.get('google:a@example.com')).not.toBeNull();
    await child.exited;
    expect(await v.delete('google:a@example.com')).toBe(true);
  }, 30_000);
});

describe('refresh lease', () => {
  test('two refreshes of one grant in this process run one at a time, and the lease is gone after release', async () => {
    const v = new FileVaultBackend(path);
    const order: string[] = [];
    const releaseA = await v.leaseRefresh('google:a@example.com', 1);
    order.push('a-held');
    const b = v.leaseRefresh('google:a@example.com', 1).then((rel) => { order.push('b-held'); return rel; });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['a-held']);
    releaseA();
    const releaseB = await b;
    expect(order).toEqual(['a-held', 'b-held']);
    releaseB();
    const other = await v.leaseRefresh('google:b@example.com', 1);
    other();
  });

  test('a lease whose holder process is gone is taken over', async () => {
    const v = new FileVaultBackend(path);
    const probe = await v.leaseRefresh('google:a@example.com', 1);
    const leaseFile = readdirSync(dir).find((f) => f.endsWith('.lease'))!;
    probe();
    const gone = Bun.spawnSync(['true']);
    writeFileSync(join(dir, leaseFile), JSON.stringify({ pid: gone.pid, generation: 1, nonce: 'dead', at: Date.now() }));
    const release = await v.leaseRefresh('google:a@example.com', 1);
    expect(JSON.parse(readFileSync(join(dir, leaseFile), 'utf-8')).pid).toBe(process.pid);
    release();
    expect(existsSync(join(dir, leaseFile))).toBe(false);
  });
});

