/**
 * Remote job owner fence (GST-4010, supersedes #10469): every remote credential, admin scope included, reads and
 * steers only the background jobs it submitted.
 *
 * 1. Protects: a remote job records the verified principal and the person or audience its call declared on
 *    submission_authority; get_job, wait_job, list_jobs (both pages), get_job_progress, cancel_job, pause_job,
 *    resume_job, retry_job, replay_job and send_job_message answer a remote caller only for jobs with that principal and
 *    that person or audience. A foreign job and a missing id read as the same not_found. Job insight never names or
 *    counts another caller's parent, child, slot holder or spend. The local CLI, an unauthenticated local stdio server
 *    and an admin credential bound to the brain owner (access.owner_member) keep the whole-queue view.
 * 2. Fails when: a remote admin credential that is not the owner's reads, lists or steers a job another credential, another
 *    audience or the local operator queued; a foreign id answers differently from a missing one; or a carve-out loses
 *    its view.
 * 3. Real seams: PGLite, submit_job's prepareRemoteJob on a real Git source, the jobs operations, MCP dispatch for
 *    the owner binding (config access.owner_member plus a member-bound credential).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { parseSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-job-owner-fence-'));
const repo = join(sandbox, 'repo');
const home = join(sandbox, 'home');
let engine: PGLiteEngine;
let queue: MinionQueue;
const isolated = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined }, fn);
const op = (name: string) => operationsByName[name]!;

type Auth = NonNullable<OperationContext['auth']>;
const credential = (id: string, over: Partial<Auth> = {}): Auth =>
  ({ token: 'test-only', clientId: id, principal: { kind: 'oauth_client', id }, scopes: ['admin'], sourceId: 'default', ...over }) as Auth;
function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], dryRun: false, remote: true, transport: 'http', sourceId: 'default',
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'], ...over,
  } as OperationContext;
}
const remote = (id: string, over: Partial<Auth> = {}) => ctx({ auth: credential(id, over) });
const local = () => ctx({ remote: false, transport: undefined });
const stdio = () => ctx({ transport: 'stdio' });

const submit = async (c: OperationContext) => (await op('submit_job').handler(c, { name: 'lint' })) as { id: number };
const ids = (rows: unknown) => (rows as Array<{ id: number }>).map(j => j.id).sort((a, b) => a - b);
async function errorOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try { await fn(); } catch (e) { return JSON.parse(JSON.stringify({ message: (e as Error).message, ...(e as object), code: (e as { canonicalCode?: string }).canonicalCode })); }
  throw new Error('expected a refusal');
}
const body = (r: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(r.content[0]!.text);

beforeAll(async () => isolated(async () => {
  mkdirSync(repo); mkdirSync(home);
  execFileSync('git', ['init', '-q', repo]);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}), 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(sandbox, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => isolated(async () => {
  for (const t of ['mcp_spend_reservations', 'minion_inbox', 'minion_jobs', 'oauth_clients']) await engine.executeRaw(`DELETE FROM ${t}`);
  await engine.executeRaw("DELETE FROM config WHERE key = 'access.owner_member'");
  await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [repo]);
  for (const id of ['client-a', 'client-b', 'client-owner']) {
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ($1, 'test-only', 'example-client', 'admin', 'default')", [id]);
  }
}));

describe('a remote admin credential sees and steers only its own jobs', () => {
  test('submit_job records the verified principal, and the audience its call declared, on the job authority', () => isolated(async () => {
    const plain = parseSubmissionAuthority((await queue.getJob((await submit(remote('client-a'))).id))?.submission_authority);
    expect(plain).toMatchObject({ kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } });
    expect((plain as { grant: Record<string, unknown> }).grant.actingFor).toBeUndefined();
    const forAlice = await withCallerAccess({ audience: ['member:alice-example'] }, () => submit(remote('client-a')));
    const grant = (parseSubmissionAuthority((await queue.getJob(forAlice.id))?.submission_authority) as { grant: Record<string, unknown> }).grant;
    expect(grant.actingFor).toEqual(['member:alice-example']);
  }));

  test('another credential gets, for every read and steer op, exactly the refusal a missing id gets, and nothing changes', () => isolated(async () => {
    const mine = remote('client-a');
    const other = remote('client-b');
    const { id } = await submit(mine);
    await engine.executeRaw("UPDATE minion_jobs SET progress = '{\"step\":\"secret-progress\"}'::jsonb WHERE id = $1", [id]);
    expect(((await op('get_job').handler(mine, { id })) as { id: number }).id).toBe(id);
    const missing = 987_654;
    const calls: Array<[string, (job: number) => Record<string, unknown>]> = [
      ['get_job', job => ({ id: job })], ['wait_job', job => ({ id: job, timeout_s: 0 })], ['get_job_progress', job => ({ id: job })],
      ['cancel_job', job => ({ id: job })], ['pause_job', job => ({ id: job })], ['resume_job', job => ({ id: job })],
      ['retry_job', job => ({ id: job })], ['replay_job', job => ({ id: job })], ['send_job_message', job => ({ id: job, payload: { steer: 'x' } })],
    ];
    for (const [name, args] of calls) {
      const foreign = await errorOf(() => op(name).handler(other, args(id)));
      const absent = await errorOf(() => op(name).handler(other, args(missing)));
      expect([name, foreign.code]).toEqual([name, name === 'cancel_job' ? 'invalid_params' : 'not_found']);
      expect([name, JSON.stringify(foreign).replaceAll(String(id), 'N')]).toEqual([name, JSON.stringify(absent).replaceAll(String(missing), 'N')]);
      expect(JSON.stringify(foreign)).not.toContain('secret-progress');
    }
    expect(await op('list_jobs').handler(other, {})).toEqual([]);
    expect(((await op('list_jobs').handler(other, { finished_since: '2020-01-01T00:00:00Z' })) as { jobs: unknown[] }).jobs).toEqual([]);
    expect(ids(await op('list_jobs').handler(mine, {}))).toEqual([id]);
    const row = await queue.getJob(id);
    expect(row?.status).toBe('waiting');
    expect(await engine.executeRaw('SELECT id FROM minion_inbox WHERE job_id = $1', [id])).toEqual([]);
  }));

  test('both list pages and the owner\'s own steering follow the submitting credential', () => isolated(async () => {
    const mine = remote('client-a');
    const { id } = await submit(mine);
    const theirs = await submit(remote('client-b'));
    await engine.executeRaw("UPDATE minion_jobs SET status = 'failed', finished_at = now() WHERE id = ANY($1::int[])", [[id, theirs.id]]);
    const since = (await op('list_jobs').handler(mine, { finished_since: '2020-01-01T00:00:00Z' })) as { jobs: Array<{ id: number }> };
    expect(since.jobs.map(j => j.id)).toEqual([id]);
    expect(ids(await op('list_jobs').handler(mine, { status: 'failed' }))).toEqual([id]);
    expect(((await op('retry_job').handler(mine, { id })) as { status: string }).status).toBe('waiting');
    expect(((await op('cancel_job').handler(mine, { id })) as { status: string }).status).toBe('cancelled');
    const terminal = await errorOf(() => op('cancel_job').handler(mine, { id }));
    expect(terminal.code).toBe('invalid_params');
  }));

  test('two people behind one credential (different audiences) never read or cancel each other\'s jobs', () => isolated(async () => {
    const asAlice = <T>(fn: () => Promise<T>) => withCallerAccess({ audience: ['member:alice-example'] }, fn);
    const asBob = <T>(fn: () => Promise<T>) => withCallerAccess({ audience: ['member:bob-example'] }, fn);
    const shared = remote('client-a');
    const alices = await asAlice(() => submit(shared));
    const bobs = await asBob(() => submit(shared));
    expect(ids(await asAlice(() => op('list_jobs').handler(shared, {})))).toEqual([alices.id]);
    expect(ids(await asBob(() => op('list_jobs').handler(shared, {})))).toEqual([bobs.id]);
    expect(ids(await op('list_jobs').handler(shared, {}))).toEqual([]);
    expect((await errorOf(() => asBob(() => op('get_job').handler(shared, { id: alices.id })))).code).toBe('not_found');
    expect((await errorOf(() => asBob(() => op('cancel_job').handler(shared, { id: alices.id })))).message).toMatch(/Cannot cancel/);
    expect((await queue.getJob(alices.id))?.status).toBe('waiting');
  }));
});

describe('who keeps the whole-queue view', () => {
  test('local operator jobs are hidden from remote credentials; the local CLI and an unauthenticated stdio server see every job', () => isolated(async () => {
    const operator = await queue.add('maintenance', { prompt: 'operator-only canary' });
    const { id } = await submit(remote('client-a'));
    expect(ids(await op('list_jobs').handler(remote('client-a'), {}))).toEqual([id]);
    expect((await errorOf(() => op('get_job').handler(remote('client-a'), { id: operator.id }))).code).toBe('not_found');
    expect(ids(await op('list_jobs').handler(local(), {}))).toEqual([operator.id, id].sort((a, b) => a - b));
    expect(ids(await op('list_jobs').handler(stdio(), {}))).toEqual([operator.id, id].sort((a, b) => a - b));
    expect(((await op('get_job').handler(stdio(), { id: operator.id })) as { id: number }).id).toBe(operator.id);
  }));

  test('an admin credential bound to the brain owner sees every job; on a brain with no owner set it sees only its own', () => isolated(async () => {
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example') ON CONFLICT (id) DO NOTHING");
    const operator = await queue.add('maintenance', { prompt: 'operator-only canary' });
    const theirs = await submit(remote('client-b'));
    const owner = { remote: true, transport: 'http' as const, sourceId: 'default',
      auth: credential('client-owner', { member: { id: 'owner-example', groups: [] } }) };
    const unset = body(await dispatchToolCall(engine, 'list_jobs', {}, owner));
    expect(unset).toEqual([]);
    await engine.setConfig('access.owner_member', 'owner-example');
    const all = body(await dispatchToolCall(engine, 'list_jobs', {}, owner)) as Array<{ id: number }>;
    expect(ids(all)).toEqual([operator.id, theirs.id].sort((a, b) => a - b));
    expect(body(await dispatchToolCall(engine, 'get_job', { id: operator.id }, owner)).id).toBe(operator.id);
    const notOwner = { ...owner, auth: credential('client-a', { member: null }) };
    expect(body(await dispatchToolCall(engine, 'list_jobs', {}, notOwner))).toEqual([]);
  }));

  test('a legacy agent row is matched by its __owner_client_id stamp; a row whose recorded principal is another client never is', () => isolated(async () => {
    const agent = remote('agent-a', { scopes: ['agent'] });
    const legacy = await queue.add('subagent', { prompt: 'legacy', __owner_client_id: 'agent-a' }, {}, { allowProtectedSubmit: true });
    expect(((await op('get_job').handler(agent, { id: legacy.id })) as { id: number }).id).toBe(legacy.id);
    await engine.executeRaw(`UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1`, [legacy.id, JSON.stringify({
      version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'agent-b' },
      grant: { scopes: ['agent'], sourceId: 'default', sourceCreatedAt: new Date().toISOString(), allowedTools: ['get_page'], allowedSlugPrefixes: [] },
      payloadHash: 'a'.repeat(64) })]);
    expect((await errorOf(() => op('get_job').handler(agent, { id: legacy.id }))).code).toBe('not_found');
  }));
});

describe('job insight for a fenced admin credential', () => {
  test('a foreign parent, child and slot holder are reported by kind only, and foreign spend is never counted', () => isolated(async () => {
    const mine = remote('client-a');
    const submittedLike = async (id: number, from: number) => engine.executeRaw(`UPDATE minion_jobs SET submission_authority = (SELECT submission_authority FROM minion_jobs WHERE id = $2) WHERE id = $1`, [id, from]);
    const own = await submit(mine);
    const foreignRoot = await submit(remote('client-b'));
    const parent = await queue.add('noop', { n: 1 }, {}, { allowProtectedSubmit: true });
    const mineChild = await queue.add('noop', { n: 2 }, { parent_job_id: parent.id }, { allowProtectedSubmit: true });
    const theirChild = await queue.add('noop', { n: 3 }, { parent_job_id: parent.id }, { allowProtectedSubmit: true });
    await submittedLike(parent.id, own.id);
    await submittedLike(mineChild.id, own.id);
    await submittedLike(theirChild.id, foreignRoot.id);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1", [parent.id]);
    for (const [job, cents] of [[parent.id, 100], [mineChild.id, 10], [theirChild.id, 5000]] as const) {
      await engine.executeRaw(`INSERT INTO mcp_spend_reservations (reservation_id, client_id, job_id, estimated_cents, actual_cents, model, provider, status, expires_at)
        VALUES (gen_random_uuid(), 'c', $1, 1, $2, 'm', 'p', 'settled', now() + interval '1 hour')`, [job, cents]);
    }
    const seen = (await op('get_job').handler(mine, { id: parent.id })) as Record<string, any>;
    expect(seen.blocked_by[0]).toMatchObject({ kind: 'waiting_children', pending: 2, child_ids: [mineChild.id] });
    expect(seen.spend.cost_usd).toBeCloseTo(1.1, 5);
    const child = (await op('get_job').handler(mine, { id: mineChild.id })) as Record<string, any>;
    expect(child.submitted_by).toMatchObject({ kind: 'mcp_client', id: 'client-a' });
    const all = (await op('get_job').handler(local(), { id: parent.id })) as Record<string, any>;
    expect(all.blocked_by[0].child_ids).toEqual([mineChild.id, theirChild.id]);
    expect(all.spend.cost_usd).toBeCloseTo(51.1, 5);
    const foreignParent = await queue.add('noop', { n: 4 }, {}, { allowProtectedSubmit: true });
    const underForeign = await queue.add('noop', { n: 5, __owner_client_id: 'client-a' }, { parent_job_id: foreignParent.id }, { allowProtectedSubmit: true });
    await submittedLike(foreignParent.id, foreignRoot.id);
    expect(((await op('get_job').handler(mine, { id: underForeign.id })) as Record<string, unknown>).submitted_by).toEqual({ kind: 'parent_job' });
    expect(((await op('get_job').handler(local(), { id: underForeign.id })) as Record<string, unknown>).submitted_by).toEqual({ kind: 'parent_job', id: foreignParent.id });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'active', claim_generation = claim_generation + 1, lock_token = 'w:' || id::text, lock_until = now() + interval '1 minute', started_at = now() WHERE id = $1", [foreignRoot.id]);
    const queued = (await op('get_job').handler(mine, { id: own.id })) as Record<string, any>;
    const slot = queued.blocked_by.find((b: { kind: string }) => b.kind === 'queue');
    expect(slot).toMatchObject({ active: 1, active_jobs: [] });
  }));
});
