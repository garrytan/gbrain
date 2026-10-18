/**
 * #6743: bootstrap's shared-skills cleanup converges after a cleanup
 * credential was revoked before its enrollment left.
 *
 * Real adapter files: each enrollment installs its owned router and native
 * router through installSharedSkillsConnection; the host is a synthetic tool
 * caller that refuses a revoked bearer the way the HTTP serve does (an auth
 * failure, not an OperationError). No paid model calls, no database.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyHarness, parseHarnessArgs, statusHarness, type HarnessDeps } from '../src/core/bootstrap/harness.ts';
import { readHarnessReceiptState, type HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { installSharedSkillsConnection } from '../src/core/harness/shared-skills.ts';
import type { SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import * as exitCodes from '../src/core/exit-codes.ts';
import { bootstrapDoctorChecks } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const HARNESS_CLEANUP_PENDING_EXIT_CODE = (exitCodes as Record<string, number>).HARNESS_CLEANUP_PENDING_EXIT_CODE;
const flags = (...args: string[]) => parseHarnessArgs(['--yes', '--no-hooks', '--harness', 'codex', ...args]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-cleanup-6743-'));
  roots.push(root);
  const home = join(root, '.gbrain');
  const brain = randomUUID();
  const tokens = new Map<string, { token: string; revoked: boolean }>();
  const mints: Array<{ id: string; token: string }> = [];
  const events: string[] = [];
  const output: string[] = [];
  const memberships = new Map<string, { id: string; active: boolean }>();
  let leaveOutage = false;
  const live = (token: string | undefined) => [...tokens.values()].some(t => t.token === token && !t.revoked);
  const states = (ids: string[]) => Object.fromEntries(ids.map(id => [id, !tokens.has(id) ? 'missing' : tokens.get(id)!.revoked ? 'revoked' : 'active'] as const));
  let codex: string | null = null;
  const deps: HarnessDeps = {
    gbrainHome: home, isTTY: false, gbrainBin: '/synthetic/gbrain',
    userSettingsPath: join(root, 'claude', 'settings.json'), codexConfig: join(root, 'codex', 'config.toml'),
    opencodeConfig: join(root, 'opencode', 'opencode.json'), loadFileConfig: () => null,
    nativeSkillsDir: host => join(root, host, 'skills'),
    detectClaude: () => true, detectCodex: () => true, detectOpencode: () => true,
    resolveHookSource: async explicit => ({ source_id: explicit ?? 'workspace', grant: explicit ? [explicit] : ['workspace'] }),
    fetchFn: (async () => new Response(JSON.stringify({ status: 'ok', engine: 'postgres', version: '0.51.7.0' }))) as unknown as typeof fetch,
    probeIdentity: async (_url, token) => live(token) ? { ok: true, identity: 'fixture brain' } : { ok: false, reason: 'auth', message: 'denied' },
    mint: async options => {
      const result = { ...options, id: randomUUID(), token: `gbrain_${randomUUID().replaceAll('-', '').repeat(2)}` };
      tokens.set(result.id, { token: result.token, revoked: false });
      mints.push(result);
      events.push(`mint:${result.id}`);
      return result;
    },
    revokeById: async id => {
      events.push(`revoke:${id}`);
      const row = tokens.get(id);
      if (!row || row.revoked) return false;
      row.revoked = true;
      return true;
    },
    tokenStates: async ids => states(ids),
    pgliteLiveServe: () => false,
    runner: async () => ({ code: 0, stdout: codex ?? '', stderr: '' }),
    installSharedSkills: async (credentials, options) => {
      const principal = credentials.access_token;
      const call: SharedSkillsToolCaller = async <T>(name: string): Promise<T> => {
        if (!live(principal)) throw new Error('401 unauthorized: invalid or revoked token');
        if (name === 'leave_brain' && leaveOutage) throw new Error('synthetic leave outage');
        if (!memberships.has(principal!)) memberships.set(principal!, { id: randomUUID(), active: false });
        const member = memberships.get(principal!)!;
        if (name === 'leave_brain') { member.active = false; events.push(`leave:${principal}`); return { status: 'left' } as T; }
        if (name === 'join_brain') member.active = true;
        if (!member.active) throw new Error('membership_inactive');
        return { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: brain, installation_id: member.id,
          enrollment_epoch: 1, view_token: 'fixture-view', batch_token: 'fixture-batch', sequence: 1, skills: [], blocked_skills: [],
          delivery: { native: 'unverified', freshness: 'session_refresh' } } as T;
      };
      return installSharedSkillsConnection(credentials, { ...options, toolCaller: options.toolCaller ?? call });
    },
    log: text => output.push(text), logError: text => output.push(text),
  };
  const receipt = (): HarnessReceipt => {
    const state = readHarnessReceiptState(home);
    if (state.state !== 'ok') throw new Error('missing fixture receipt');
    return state.receipt;
  };
  return {
    root, home, deps, mints, events, output, tokens, receipt, states,
    leaveOutage: (value = true) => { leaveOutage = value; },
    revokeByHand: (id: string) => { tokens.get(id)!.revoked = true; },
    lastJson: () => JSON.parse(output.at(-1)!),
  };
}

const adapterReceipt = (entryRoot: string) => JSON.parse(readFileSync(join(entryRoot, 'shared-skills', 'receipt.json'), 'utf8'));

/** Two old enrollments stuck on a leave outage, the first with a user edit to its owned router. */
async function twoPendingEnrollments(f: ReturnType<typeof fixture>) {
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  const a = f.receipt().shared_skills![0];
  const ownedRouter = join(a.root, 'shared-skills', 'router', 'SKILL.md');
  expect(existsSync(ownedRouter)).toBe(true);
  writeFileSync(ownedRouter, '# User edited router');
  const nativeRouter = adapterReceipt(a.root).native_router_path as string;
  expect(existsSync(nativeRouter)).toBe(true);
  f.leaveOutage();
  expect(await applyHarness(flags(), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  expect(await applyHarness(flags('--json'), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  return { a, ownedRouter, nativeRouter };
}

test('exit code 14 is bootstrap_cleanup_pending', () => {
  expect(HARNESS_CLEANUP_PENDING_EXIT_CODE).toBe(14);
});

test('a two-entry receipt (one credential revoked, one valid) converges on a rerun and keeps the user edit', async () => {
  const f = fixture();
  const { a, ownedRouter, nativeRouter } = await twoPendingEnrollments(f);
  const pending = f.lastJson();
  expect(pending.status).toBe('cleanup_pending');
  expect(pending.code).toBe('bootstrap_cleanup_pending');
  expect(pending.cleanup.map((i: { token_id: string; state: string; token: string; converges: boolean }) => [i.token_id, i.state, i.token, i.converges]))
    .toEqual([[f.mints[0].id, 'leave_pending', 'active', true], [f.mints[1].id, 'leave_pending', 'active', true]]);
  expect(pending.fix.next).toBe('run');
  expect(f.receipt().token.previous_ids).toEqual([f.mints[0].id, f.mints[1].id]);

  // The old doctor advice: revoke first. Its enrollment can no longer leave remotely.
  f.revokeByHand(f.mints[0].id);
  f.leaveOutage(false);

  // Fixture run of the rendered fix: the argv, then its verify.
  expect(pending.fix.argv.slice(0, 3)).toEqual(['gbrain', 'bootstrap', 'harness']);
  expect(pending.fix.argv).not.toContain('--json');
  expect(await applyHarness(parseHarnessArgs([...pending.fix.argv.slice(3), '--json']), f.deps)).toBe(0);
  const done = f.lastJson();
  expect(done.status).toBe('ok');
  expect(done.cleanup).toBeUndefined();
  const r = f.receipt();
  expect(r.token.previous_ids).toBeUndefined();
  const revokedEntry = r.shared_skills!.find(e => e.token_id === f.mints[0].id)!;
  expect(revokedEntry.status).toBe('left_with_retained_files');
  expect(revokedEntry.reason).toBe('credential_revoked');
  expect(r.shared_skills!.filter(e => !e.status.startsWith('left')).map(e => e.token_id)).toEqual([f.mints[3].id]);
  // Local cleanup still ran for the revoked enrollment: receipt deactivated, native router removed, credential dropped, edit kept.
  expect(adapterReceipt(a.root).status).toBe('left_with_retained_files');
  expect(existsSync(nativeRouter)).toBe(false);
  expect(readFileSync(ownedRouter, 'utf8')).toBe('# User edited router');
  expect(existsSync(join(a.root, 'credentials.json'))).toBe(false);
  // The valid ones left before their tokens were revoked; the revoked one was only cleared.
  for (const m of [f.mints[1], f.mints[2]]) expect(f.events.indexOf(`leave:${m.token}`)).toBeLessThan(f.events.indexOf(`revoke:${m.id}`));
  expect(f.events).not.toContain(`leave:${f.mints[0].token}`);
  expect(f.states([f.mints[0].id, f.mints[1].id, f.mints[2].id, f.mints[3].id]))
    .toEqual({ [f.mints[0].id]: 'revoked', [f.mints[1].id]: 'revoked', [f.mints[2].id]: 'revoked', [f.mints[3].id]: 'active' });

  expect(await statusHarness(parseHarnessArgs(pending.fix.verify.argv.slice(3)), f.deps)).toBe(0);
  const status = f.lastJson();
  expect(status.pending_previous_tokens).toEqual([]);
  expect(status.cleanup).toBeUndefined();
});

test('status and doctor tell a revoked credential awaiting cleanup apart from an active one', async () => {
  const f = fixture();
  await twoPendingEnrollments(f);
  f.revokeByHand(f.mints[0].id);
  expect(await statusHarness(flags('--status', '--json'), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  const status = f.lastJson();
  expect(status.status).toBe('cleanup_pending');
  expect(status.code).toBe('bootstrap_cleanup_pending');
  expect(status.cleanup.map((i: { token_id: string; token: string }) => [i.token_id, i.token]))
    .toEqual([[f.mints[0].id, 'revoked'], [f.mints[1].id, 'active']]);

  const engine = {
    executeRaw: async (sql: string, params: unknown[] = []) => sql.includes('access_tokens')
      ? (params[0] as string[]).filter(id => f.tokens.has(id)).map(id => ({ id, revoked: f.tokens.get(id)!.revoked }))
      : [],
    getConfig: async () => null,
  } as unknown as BrainEngine;
  const checks = await withEnv({ GBRAIN_HOME: f.root }, () => bootstrapDoctorChecks(engine));
  const health = checks.find(c => c.name === 'bootstrap_harness_health')!;
  expect(health.status).toBe('fail');
  expect(health.message).toContain(`${f.mints[0].id}: revoked; enrollment cleanup pending`);
  expect(health.message).toContain(`${f.mints[1].id}: active; enrollment leave pending`);
  expect(health.message).toContain('Leave before revoke');
  expect(health.message).not.toContain('never revoked');
});

test('a cleanup no rerun can finish names the owner revoke step and carries no new ids', async () => {
  const f = fixture();
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  const a = f.receipt().shared_skills![0];
  f.leaveOutage();
  expect(await applyHarness(flags(), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  f.leaveOutage(false);
  rmSync(join(a.root, 'credentials.json'));
  expect(await applyHarness(flags('--json'), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  const stuck = f.lastJson();
  expect(stuck.cleanup).toEqual([expect.objectContaining({ token_id: f.mints[0].id, state: 'credential_unreadable', token: 'active', converges: false })]);
  expect(stuck.fix.next).toBe('tell_user_to_run');
  expect(stuck.fix.argv).toEqual(['gbrain', 'auth', 'revoke', '--id', f.mints[0].id]);
  expect(stuck.fix.user_message).toContain('credentials.json');
  // The enrollment rotated out by that run left and its token was revoked: the list does not grow.
  expect(f.receipt().token.previous_ids).toEqual([f.mints[0].id]);
  expect(await applyHarness(flags(), f.deps)).toBe(HARNESS_CLEANUP_PENDING_EXIT_CODE);
  expect(f.receipt().token.previous_ids).toEqual([f.mints[0].id]);

  // The owner runs the step (gbrain auth revoke by id), then the re-run converges.
  expect(await f.deps.revokeById!(stuck.fix.argv[4])).toBe(true);
  expect(await applyHarness(flags(), f.deps)).toBe(0);
  expect(f.receipt().token.previous_ids).toBeUndefined();
  expect(f.receipt().shared_skills!.some(e => e.token_id === f.mints[0].id)).toBe(false);
  expect(f.output.join('\n')).toContain(`token ${f.mints[0].id} is already revoked, so its enrollment cannot leave remotely and is inert`);
  expect(await statusHarness(parseHarnessArgs(stuck.fix.verify.argv.slice(3)), f.deps)).toBe(0);
});
