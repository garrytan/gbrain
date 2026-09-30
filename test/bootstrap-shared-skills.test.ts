import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyHarness, parseHarnessArgs, removeHarness, statusHarness, type HarnessDeps } from '../src/core/bootstrap/harness.ts';
import { readHarnessReceiptState, writeHarnessReceipt, type HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { installSharedSkillsConnection } from '../src/core/harness/shared-skills.ts';
import type { SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { operations } from '../src/core/operations.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const flags = (...args: string[]) => parseHarnessArgs(['--yes', '--no-hooks', '--harness', 'codex', ...args]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-bootstrap-skills-'));
  roots.push(root);
  const home = join(root, 'gbrain');
  const brain = randomUUID();
  const mints: Array<Parameters<NonNullable<HarnessDeps['mint']>>[0] & { id: string; token: string }> = [];
  const revoked: string[] = [];
  const output: string[] = [];
  const events: string[] = [];
  const memberships = new Map<string, { id: string; active: boolean }>();
  const supplied = 'synthetic-supplied-token';
  let failJoin = false, failLeave = false, failMintAt = 0, failSmoke = false;
  let claude: { url: string; token: string } | null = null;
  const receipt = (): HarnessReceipt => {
    const state = readHarnessReceiptState(home);
    if (state.state !== 'ok') throw new Error('missing fixture receipt');
    return state.receipt;
  };
  const deps: HarnessDeps = {
    gbrainHome: home, isTTY: false, gbrainBin: '/synthetic/gbrain',
    userSettingsPath: join(root, 'claude', 'settings.json'), codexConfig: join(root, 'codex', 'config.toml'),
    opencodeConfig: join(root, 'opencode', 'opencode.json'), loadFileConfig: () => null,
    nativeSkillsDir: host => join(root, host, 'skills'),
    detectClaude: () => true, detectCodex: () => true, detectOpencode: () => true,
    resolveHookSource: async explicit => ({ source_id: explicit ?? 'workspace', grant: explicit ? [explicit] : ['workspace', 'shared'] }),
    fetchFn: (async () => new Response(JSON.stringify({ status: 'ok', engine: 'postgres', version: '0.51.7.0' }))) as unknown as typeof fetch,
    probeIdentity: async (_url, token) => !failSmoke && (token === supplied || mints.some(m => m.token === token))
      ? { ok: true, identity: 'fixture brain' } : { ok: false, reason: 'auth', message: 'denied' },
    mint: async options => {
      expect(existsSync(join(home, 'bootstrap', 'harness.json'))).toBe(true);
      if (mints.length + 1 === failMintAt) throw new Error('synthetic mint failure');
      const result = { ...options, id: randomUUID(), token: `gbrain_${randomUUID().replaceAll('-', '').repeat(2)}` };
      mints.push(result);
      events.push(`mint:${result.id}`);
      return result;
    },
    revokeById: async id => { revoked.push(id); events.push(`revoke:${id}`); return true; },
    pgliteLiveServe: () => false,
    runner: async argv => {
      if (argv[0] === 'claude' && argv[2] === 'get') return claude
        ? { code: 0, stdout: `Type: http\nURL: ${claude.url}\nAuthorization: Bearer ${claude.token}`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
      if (argv[0] === 'claude' && argv[2] === 'add') claude = { url: argv.find(a => a.startsWith('http'))!, token: argv.find(a => a.startsWith('Authorization: Bearer '))!.slice(22) };
      if (argv[0] === 'claude' && argv[2] === 'remove') claude = null;
      return { code: 0, stdout: '', stderr: '' };
    },
    installSharedSkills: async (credentials, options) => {
      const principal = credentials.access_token!;
      const call: SharedSkillsToolCaller = async <T>(name: string): Promise<T> => {
        if (name === 'join_brain' && failJoin) throw new Error('synthetic grant refusal');
        if (name === 'leave_brain' && failLeave) throw new Error('synthetic leave outage');
        if (!memberships.has(principal)) memberships.set(principal, { id: randomUUID(), active: false });
        const member = memberships.get(principal)!;
        if (name === 'leave_brain') { member.active = false; events.push(`leave:${principal}`); return { status: 'left' } as T; }
        if (name === 'join_brain') { member.active = true; events.push(`join:${principal}`); }
        if (!member.active) throw new Error('membership_inactive');
        return { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: brain, installation_id: member.id,
          enrollment_epoch: 1, view_token: 'fixture-view', batch_token: 'fixture-batch', sequence: 1, skills: [], blocked_skills: [],
          delivery: { native: 'unverified', freshness: 'session_refresh' } } as T;
      };
      return installSharedSkillsConnection(credentials, { ...options, toolCaller: call });
    },
    log: text => output.push(text), logError: text => output.push(text),
  };
  return { root, home, deps, mints, revoked, output, events, memberships, supplied, receipt,
    failJoin: (value = true) => { failJoin = value; }, failLeave: (value = true) => { failLeave = value; },
    failMintAt: (value: number) => { failMintAt = value; }, failSmoke: () => { failSmoke = true; } };
}

test('follow policy parser validates explicit values without silently widening', () => {
  expect(parseHarnessArgs([]).skills).toBeUndefined();
  expect(flags('--skills', 'follow').skills).toBe('follow');
  expect(flags('--skills', 'memory-only').skills).toBe('memory-only');
  expect(flags('--skills').error).toContain('requires a value');
  expect(flags('--skills', 'editor').error).toContain('follow or memory-only');
});

test('fresh parent follows the catalog with an owned native router and a registry-bounded self-member grant', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'codex'), { recursive: true });
  writeFileSync(join(f.root, 'codex', 'AGENTS.md'), 'Preserve this agent identity.');
  expect(await applyHarness(flags('--source', 'workspace', '--no-capture'), f.deps)).toBe(0);
  const r = f.receipt(), mint = f.mints[0];
  expect(r.skills_policy).toBe('follow');
  expect(mint.scopes).toEqual(['read', 'write', 'skills_member_self']);
  expect(mint.sourceGrant).toEqual(['workspace']);
  for (const name of ['join_brain', 'sync_brain_skills', 'leave_brain', 'list_skills', 'get_skill', 'get_skill_asset']) expect(mint.allowedOperations).toContain(name);
  expect(mint.allowedOperations).not.toContain('put_skill');
  expect(mint.allowedOperations).not.toContain('delete_skill');
  expect(mint.allowedOperations).not.toContain('sync_brain');
  expect(mint.allowedOperations?.every(name => operations.some(op => op.name === name && !op.localOnly))).toBe(true);
  const entry = r.shared_skills![0];
  expect(entry.status).toBe('restart_required');
  const adapter = JSON.parse(readFileSync(join(entry.root, 'shared-skills', 'receipt.json'), 'utf8'));
  expect(adapter.native).toBe('unverified');
  expect(adapter.native_registration).toBe('installed');
  expect(readFileSync(adapter.native_router_path, 'utf8')).toContain('configured MCP connection "gbrain"');
  expect(readFileSync(adapter.native_router_path, 'utf8')).toContain('sync_brain_skills');
  expect(readFileSync(join(f.root, 'codex', 'AGENTS.md'), 'utf8')).toBe('Preserve this agent identity.');
  expect(statSync(join(entry.root, 'credentials.json')).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(r)).not.toContain(mint.token);
  expect(f.output.join('\n')).toContain('native activation remains unverified');
  expect(f.output.join('\n')).not.toContain(mint.token);
});

test('a legacy installation upgrades memory without silently enrolling; explicit follow upgrades later', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--skills', 'memory-only'), f.deps)).toBe(0);
  const legacy = f.receipt(); delete legacy.skills_policy; delete legacy.harness_tokens; delete legacy.shared_skills;
  writeHarnessReceipt(f.home, legacy);
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(f.receipt().skills_policy).toBe('memory-only');
  expect(f.memberships.size).toBe(0);
  expect(f.mints[1].scopes).toEqual(['read', 'write']);
  expect(f.mints[1].allowedOperations).not.toContain('join_brain');
  expect(await applyHarness(flags('--skills', 'follow'), f.deps)).toBe(0);
  expect(f.receipt().shared_skills?.at(-1)?.status).toBe('restart_required');
});

test('three managed harnesses get independent principals and native installation identities', async () => {
  const f = fixture();
  expect(await applyHarness(parseHarnessArgs(['--yes', '--no-hooks']), f.deps)).toBe(0);
  expect(new Set(f.mints.map(m => m.id)).size).toBe(3);
  expect(new Set([...f.memberships.values()].map(m => m.id)).size).toBe(3);
  expect(f.receipt().shared_skills?.map(e => e.host)).toEqual(['claude-code', 'codex', 'opencode']);
  expect(Object.keys(f.receipt().harness_tokens!)).toHaveLength(3);
  expect(await removeHarness(flags(), f.deps)).toBe(0);
  expect(new Set(f.revoked)).toEqual(new Set(f.mints.map(m => m.id)));
});

test('follow rerun rotates mint-first, removes the old router and leaves before revoking its token', async () => {
  const f = fixture();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  const old = f.receipt().shared_skills![0];
  const oldRouter = JSON.parse(readFileSync(join(old.root, 'shared-skills', 'receipt.json'), 'utf8')).native_router_path;
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(f.receipt().skills_policy).toBe('follow');
  expect(f.events.indexOf(`mint:${f.mints[1].id}`)).toBeLessThan(f.events.indexOf(`leave:${f.mints[0].token}`));
  expect(f.events.indexOf(`leave:${f.mints[0].token}`)).toBeLessThan(f.events.indexOf(`revoke:${f.mints[0].id}`));
  expect(existsSync(oldRouter)).toBe(false);
  expect(existsSync(join(old.root, 'credentials.json'))).toBe(false);
  expect(f.revoked).toEqual([f.mints[0].id]);
});

test('explicit opt-out leaves enrollment, preserves edited native files and never enables capture', async () => {
  const f = fixture();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  const old = f.receipt().shared_skills![0];
  const router = JSON.parse(readFileSync(join(old.root, 'shared-skills', 'receipt.json'), 'utf8')).native_router_path;
  writeFileSync(router, 'User edited router');
  expect(await applyHarness(flags('--skills', 'memory-only', '--no-capture'), f.deps)).toBe(0);
  expect(readFileSync(router, 'utf8')).toBe('User edited router');
  expect(f.receipt().shared_skills![0].status).toBe('left_with_retained_files');
  expect(f.output.join('\n')).toContain('edited files retained');
  expect(f.mints[1].scopes).toEqual(['read', 'write']);
  expect(f.receipt().targets.some(t => t.kind === 'hooks')).toBe(false);
});

test('follow failure stays pending without breaking memory or revoking the prior working enrollment', async () => {
  const f = fixture();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  f.failJoin();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(f.receipt().shared_skills?.at(-1)?.status).toBe('pending');
  expect(f.memberships.get(f.mints[0].token)?.active).toBe(true);
  expect(f.revoked).toEqual([]);
  expect(f.receipt().token.previous_ids).toContain(f.mints[0].id);
});

test('remove retains cleanup credentials and token IDs through a leave outage, then safely retries', async () => {
  const f = fixture();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  const entry = f.receipt().shared_skills![0];
  f.failLeave();
  expect(await removeHarness(flags(), f.deps)).toBe(1);
  expect(f.revoked).toEqual([]);
  expect(existsSync(join(entry.root, 'credentials.json'))).toBe(true);
  f.failLeave(false);
  expect(await removeHarness(flags(), f.deps)).toBe(0);
  expect(f.revoked).toEqual([f.mints[0].id]);
  expect(readHarnessReceiptState(f.home).state).toBe('absent');
});

test('a failed second mint leaves the first independent token recorded for removal', async () => {
  const f = fixture();
  f.failMintAt(2);
  await expect(applyHarness(parseHarnessArgs(['--yes', '--no-hooks']), f.deps)).rejects.toThrow('synthetic mint failure');
  expect(f.receipt().harness_tokens!['claude-code']?.id).toBe(f.mints[0].id);
  expect(await removeHarness(flags(), f.deps)).toBe(0);
  expect(f.revoked).toEqual([f.mints[0].id]);
});

test('failed smoke revokes every fresh independent token without enrolling skills', async () => {
  const f = fixture();
  f.failSmoke();
  expect(await applyHarness(parseHarnessArgs(['--yes', '--no-hooks']), f.deps)).toBe(1);
  expect(f.memberships.size).toBe(0);
  expect(new Set(f.revoked)).toEqual(new Set(f.mints.map(m => m.id)));
});

test('remote registrar uses its supplied grant without opening or minting against the local brain', async () => {
  const f = fixture();
  f.deps.resolveHookSource = async () => { throw new Error('must not open local brain'); };
  expect(await applyHarness(flags('--url', 'https://brain.example.com/mcp', '--token', f.supplied), f.deps)).toBe(0);
  expect(f.mints).toEqual([]);
  expect(f.receipt().shared_skills![0].status).toBe('restart_required');
  expect(await removeHarness(flags(), f.deps)).toBe(0);
  expect(f.revoked).toEqual([]);
});

test('remote registrar lacking follow authority remains memory-capable with honest pending status', async () => {
  const f = fixture(); f.failJoin();
  expect(await applyHarness(flags('--url', 'https://brain.example.com/mcp', '--token', f.supplied), f.deps)).toBe(0);
  expect(f.mints).toEqual([]);
  expect(f.receipt().shared_skills![0].status).toBe('pending');
  expect(f.receipt().targets.every(t => t.state === 'confirmed')).toBe(true);
});

test('a shared supplied credential never conflates independent managed member identities', async () => {
  const f = fixture();
  expect(await applyHarness(parseHarnessArgs(['--yes', '--no-hooks', '--token', f.supplied]), f.deps)).toBe(0);
  expect(f.memberships.size).toBe(0);
  expect(f.mints).toEqual([]);
  expect(f.receipt().shared_skills?.every(e => e.reason === 'independent_credentials_required')).toBe(true);
});

test('pending follow without any installed enrollment does not hold obsolete memory tokens live', async () => {
  const f = fixture(); f.failJoin();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(f.revoked).toEqual([f.mints[0].id]);
  expect(f.receipt().token.previous_ids).toBeUndefined();
  expect(f.receipt().shared_skills?.at(-1)?.status).toBe('pending');
});

test('a supplied single-harness follow rerun reuses its enrollment rather than leaving its replacement', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--token', f.supplied), f.deps)).toBe(0);
  const root = f.receipt().shared_skills![0].root;
  expect(await applyHarness(flags('--token', f.supplied), f.deps)).toBe(0);
  expect(f.receipt().shared_skills).toHaveLength(1);
  expect(f.receipt().shared_skills![0].root).toBe(root);
  expect(f.memberships.get(f.supplied)?.active).toBe(true);
  expect(f.events.filter(event => event.startsWith('leave:'))).toEqual([]);
});

test('status verifies each independent credential, not just the first healthy harness', async () => {
  const f = fixture();
  expect(await applyHarness(parseHarnessArgs(['--yes', '--no-hooks']), f.deps)).toBe(0);
  const denied = f.mints[2].token;
  const probe = f.deps.probeIdentity!;
  f.deps.probeIdentity = (url, token) => token === denied ? Promise.resolve({ ok: false, reason: 'auth', message: 'denied' }) : probe(url, token);
  expect(await statusHarness(flags('--json'), f.deps)).toBe(1);
  const result = JSON.parse(f.output.at(-1)!);
  expect(result.harness_tokens).toContainEqual({ host: 'opencode', verified: false });
  expect(result.token_verified).toBe(false);
  expect(result.shared_skills).toHaveLength(3);
  expect(f.output.join('\n')).not.toContain(denied);
  f.deps.probeIdentity = probe;
  const runner = f.deps.runner;
  f.deps.runner = argv => argv[0] === 'claude' && argv[2] === 'get'
    ? Promise.resolve({ code: 1, stdout: '', stderr: 'no registration' }) : runner(argv);
  expect(await statusHarness(flags('--json'), f.deps)).toBe(1);
  const missing = JSON.parse(f.output.at(-1)!);
  expect(missing.harness_tokens).toContainEqual({ host: 'claude-code', verified: false });
  expect(missing.harness_tokens).toContainEqual({ host: 'codex', verified: true });
  expect(missing.token_verified).toBe(false);
});

test('implicit source binding preserves the existing federated source ceiling for each principal', async () => {
  const f = fixture();
  expect(await applyHarness(parseHarnessArgs(['--yes', '--no-hooks']), f.deps)).toBe(0);
  expect(f.mints.every(m => JSON.stringify(m.sourceGrant) === JSON.stringify(['workspace', 'shared']))).toBe(true);
  expect(f.receipt().source_id).toBe('workspace');
});

test('an interrupted supplied-token removal remains visibly pending without owning a token to revoke', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--token', f.supplied), f.deps)).toBe(0);
  f.failLeave();
  expect(await removeHarness(flags(), f.deps)).toBe(1);
  expect(await statusHarness(flags('--json'), f.deps)).toBe(1);
  expect(f.revoked).toEqual([]);
});
