/**
 * GST-2517: a forget whose door commit landed in Git and whose database transaction then failed (an error thrown after
 * the commit, before the row committed: fault point `publication:before_commit`) on a source configured
 * `canonical: git`. Git is the parent, so the database follows it: the request is replayed, its replay finds the strike
 * already committed, and the withdrawal is recorded (the fact inactive, its withdrawal row written) without a second
 * commit. Protects:
 *   - a shared fact forgotten by the owner and a member's own-page fact forgotten by that member both commit;
 *   - with no retry by the caller, a later sync and a remember of the same claim is refused `fact_withdrawn`;
 *   - when the replay fails too, the reply names the landed commit instead of saying nothing was saved, and a forget
 *     submitted again with a new request_id records the withdrawal without a second commit;
 *   - a remember and a put_page in the same window are replayed the same way: one row, one commit;
 *   - a process killed in the window (Postgres: a SIGKILLed worker) is recovered by the owner and replayed the same way;
 *   - `gbrain repair failed-writes` lists a refused forget as a caller write to resubmit, not one the dream cycle produces.
 * PGLite here; with DATABASE_URL also Postgres (test/postgres-unit-arms.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName, type AuthInfo } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { performSync } from '../src/commands/sync.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { waitFor } from './helpers/wait-for.ts';

const PAGE = 'companies/acme-example';
const MEMBER_PAGE = 'memory/members/alice-example';
const OWNER = 'carol-example';
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nNotes about ${title}.\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const commitsTouching = (root: string, rel: string) => git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean);

async function bound(engine: BrainEngine, member: string): Promise<AuthInfo> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const client = await provider.registerClientManual(`gst2517-${member}-${randomUUID().slice(0, 6)}`, ['client_credentials'], 'read write', [], 'default');
  await bindCredential(engine, { kind: 'client', id: client.clientId }, { member });
  const { access_token } = await provider.exchangeClientCredentials(client.clientId, client.clientSecret ?? '');
  return await provider.verifyAccessToken(access_token) as unknown as AuthInfo;
}

async function remote(engine: BrainEngine, auth: AuthInfo, op: string, params: Record<string, unknown>) {
  const out = await dispatchToolCall(engine, op, { request_id: randomUUID(), ...params }, { remote: true, transport: 'http', sourceId: 'default', auth });
  const text = out.content.map(block => block.text).join('\n');
  let json: Record<string, any> = {};
  try { json = JSON.parse(out.content[0]!.text); } catch { /* a plain-text reply */ }
  return { isError: out.isError === true, json, text };
}

async function factState(engine: BrainEngine, claim: string) {
  const facts = await engine.executeRaw<{ active: boolean }>("SELECT expired_at IS NULL AS active FROM facts WHERE source_id='default' AND fact=$1 ORDER BY id", [claim]);
  const withdrawals = await engine.executeRaw<{ visibility: string; subject: string }>(
    "SELECT visibility, subject FROM fact_withdrawals WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1)", [claim]);
  return { facts: facts.map(fact => fact.active), withdrawals };
}

const forgets = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; outcome: Record<string, any> | null }>(
  "SELECT state, error_code, outcome FROM persistence_requests WHERE operation='forget' ORDER BY sequence");

/** Throws a plain owner exception at `publication:before_commit` of the next `times` forget publications. */
function failBeforeCommit(times: number): { fired: () => number } {
  let fired = 0;
  installFaultHook(async (point, detail) => {
    if (point !== 'publication:before_commit' || detail.operation !== 'forget' || fired >= times) return;
    fired++;
    throw new Error('fixture failure after the door commit');
  });
  return { fired: () => fired };
}

type Brain = ManagedBrain & { owner: AuthInfo; alice: AuthInfo };

for (const backend of testBackends()) describe(`[${backend}] GST-2517: a forget whose door commit landed before its row`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  const strict = (run: (brain: Brain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    __resetPrivateVisibilityCacheForTests();
    for (const id of ['alice-example', OWNER]) await addMember(brain.engine, id);
    await setOwner(brain.engine, OWNER);
    await call(brain.ctx, 'put_page', { slug: PAGE, content: page('Acme Example') });
    await settleManagedGitEffects(brain.engine);
    await run({ ...brain, owner: await bound(brain.engine, OWNER), alice: await bound(brain.engine, 'alice-example') });
  }, { databaseUrl, setup });

  /** A shared (world) fact the host remembered on PAGE: its id. */
  const sharedFact = async (b: Brain, claim: string) => {
    const out = await call(b.ctx, 'remember', { fact: claim, entity: PAGE, provenance: 'fixture', visibility: 'world' });
    await settleManagedGitEffects(b.engine);
    return String(out.id);
  };
  const rememberAgain = (b: Brain, claim: string) => call(b.ctx, 'remember', { fact: claim, entity: PAGE, provenance: 'fixture', visibility: 'world' })
    .then(out => ({ refused: null, id: String(out.id) }), (error: Error) => ({ refused: error.message.split(':')[0], id: null }));

  /** The forget committed in one strike commit, the withdrawal row recorded, and the same claim refused again. */
  async function expectWithdrawn(b: Brain, claim: string, rel: string, withdrawal: { visibility: string; subject: string }, strikeCommit: string) {
    expect(git(b.root, 'rev-parse', 'HEAD').trim()).toBe(strikeCommit);
    expect(git(b.root, 'show', `HEAD:${rel}`).split('\n').find(line => line.includes(claim))).toContain(`~~${claim}~~`);
    expect(git(b.root, 'status', '--porcelain')).toBe('');
    expect(await factState(b.engine, claim)).toEqual({ facts: [false], withdrawals: [withdrawal] });
    expect(await rememberAgain(b, claim)).toEqual({ refused: 'fact_withdrawn', id: null });
    expect((await factState(b.engine, claim)).facts).toEqual([false]);
  }

  test('a shared fact forgotten by the owner: the replay records the withdrawal; one strike commit', () => strict(async b => {
    const claim = 'Acme example shared claim one';
    const id = await sharedFact(b, claim);
    const before = commitsTouching(b.root, `${PAGE}.md`).length;
    const fault = failBeforeCommit(1);
    const out = await remote(b.engine, b.owner, 'forget', { id });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    expect(fault.fired()).toBe(1);
    expect({ isError: out.isError, text: out.text }).toEqual({ isError: false, text: expect.not.stringContaining('nothing was saved') });
    const strikes = commitsTouching(b.root, `${PAGE}.md`);
    expect(strikes).toHaveLength(before + 1);
    expect(await forgets(b.engine)).toEqual([{ state: 'committed', error_code: null,
      outcome: expect.objectContaining({ persistence: expect.objectContaining({ git_state: 'committed', git_commit: strikes[0] }) }) }]);
    await expectWithdrawn(b, claim, `${PAGE}.md`, { visibility: 'world', subject: PAGE }, strikes[0]!);
  }), 240_000);

  test("a member's own-page fact forgotten by that member: the replay records the withdrawal; one strike commit", () => strict(async b => {
    const claim = 'Acme example member claim two';
    expect((await remote(b.engine, b.alice, 'remember', { fact: claim, entity: PAGE, provenance: 'fixture' })).isError).toBe(false);
    await settleManagedGitEffects(b.engine);
    const [fact] = await b.engine.executeRaw<{ id: number; slug: string }>('SELECT id, source_markdown_slug AS slug FROM facts WHERE fact=$1', [claim]);
    expect(fact!.slug).toBe(MEMBER_PAGE);
    const before = commitsTouching(b.root, `${MEMBER_PAGE}.md`).length;
    const fault = failBeforeCommit(1);
    const out = await remote(b.engine, b.alice, 'forget', { id: String(fact!.id) });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    expect(fault.fired()).toBe(1);
    expect({ isError: out.isError, text: out.text }).toEqual({ isError: false, text: expect.not.stringContaining('nothing was saved') });
    const strikes = commitsTouching(b.root, `${MEMBER_PAGE}.md`);
    expect(strikes).toHaveLength(before + 1);
    expect((await forgets(b.engine)).map(row => [row.state, row.error_code])).toEqual([['committed', null]]);
    expect(await factState(b.engine, claim)).toEqual({ facts: [false], withdrawals: [{ visibility: 'private', subject: MEMBER_PAGE }] });
    expect(git(b.root, 'rev-parse', 'HEAD').trim()).toBe(strikes[0]);
    expect(git(b.root, 'status', '--porcelain')).toBe('');
  }), 240_000);

  test('no retry: after a sync, remembering the same claim is refused fact_withdrawn, beside no new active fact', () => strict(async b => {
    const claim = 'Acme example shared claim three';
    const id = await sharedFact(b, claim);
    failBeforeCommit(1);
    await remote(b.engine, b.owner, 'forget', { id });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    await performSync(b.engine, { sourceId: 'default', repoPath: b.root, noPull: true, noEmbed: true } as never);
    await settleManagedGitEffects(b.engine);
    expect(await rememberAgain(b, claim)).toEqual({ refused: 'fact_withdrawn', id: null });
    expect(await factState(b.engine, claim)).toEqual({ facts: [false], withdrawals: [{ visibility: 'world', subject: PAGE }] });
  }), 240_000);

  test('the replay fails too: the reply names the landed commit, never "nothing was saved"; a forget submitted again records the withdrawal without a second commit', () => strict(async b => {
    const claim = 'Acme example shared claim four';
    const id = await sharedFact(b, claim);
    const before = commitsTouching(b.root, `${PAGE}.md`).length;
    const fault = failBeforeCommit(2);
    const out = await remote(b.engine, b.owner, 'forget', { id });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    expect(fault.fired()).toBe(2);
    const strikes = commitsTouching(b.root, `${PAGE}.md`);
    expect(strikes).toHaveLength(before + 1);
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain('nothing was saved');
    expect(String(out.json.message)).toContain(strikes[0]!.slice(0, 12));
    expect(await forgets(b.engine)).toEqual([{ state: 'failed', error_code: 'storage_error',
      outcome: { persistence: { git_state: 'committed', git_commit: strikes[0], landed_before_row: true } } }]);
    expect(await factState(b.engine, claim)).toEqual({ facts: [true], withdrawals: [] });

    const retry = await remote(b.engine, b.owner, 'forget', { id });
    await settleManagedGitEffects(b.engine);
    expect(retry.isError).toBe(false);
    expect((await forgets(b.engine)).map(row => row.state)).toEqual(['failed', 'committed']);
    await expectWithdrawn(b, claim, `${PAGE}.md`, { visibility: 'world', subject: PAGE }, strikes[0]!);
  }), 240_000);
  test('other publications share the window: a remember and a put_page whose door commit landed are replayed into one row and one commit', () => strict(async b => {
    const claim = 'Acme example remembered claim five';
    const before = commitsTouching(b.root, `${PAGE}.md`).length;
    let fired = 0;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || !['remember', 'put_page'].includes(String(detail.operation)) || fired >= 1) return;
      fired++;
      throw new Error('fixture failure after the door commit');
    });
    const remembered = await remote(b.engine, b.owner, 'remember', { fact: claim, entity: PAGE, provenance: 'fixture', visibility: 'world' });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    expect(fired).toBe(1);
    expect({ isError: remembered.isError, text: remembered.text }).toEqual({ isError: false, text: expect.not.stringContaining('nothing was saved') });
    expect(await factState(b.engine, claim)).toEqual({ facts: [true], withdrawals: [] });
    expect(git(b.root, 'show', `HEAD:${PAGE}.md`).split('\n').filter(line => line.includes(claim))).toHaveLength(1);
    expect(commitsTouching(b.root, `${PAGE}.md`)).toHaveLength(before + 1);

    fired = 0;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || detail.operation !== 'put_page' || fired >= 1) return;
      fired++;
      throw new Error('fixture failure after the door commit');
    });
    const put = await remote(b.engine, b.owner, 'put_page', { slug: 'notes/acme-example-plan', content: page('Acme Example Plan') });
    installFaultHook(undefined);
    await settleManagedGitEffects(b.engine);
    expect(fired).toBe(1);
    expect({ isError: put.isError, state: put.json.state }).toEqual({ isError: false, state: 'committed' });
    expect(commitsTouching(b.root, 'notes/acme-example-plan.md')).toHaveLength(1);
    expect(put.json.persistence?.git_commit).toBe(commitsTouching(b.root, 'notes/acme-example-plan.md')[0]);
    expect((await b.engine.readPageSnapshot('notes/acme-example-plan', { sourceId: 'default' }))?.page.title).toBe('Acme Example Plan');
    expect(git(b.root, 'status', '--porcelain')).toBe('');
  }), 240_000);

  test('repair failed-writes lists a refused forget as a caller write to resubmit, never one the dream cycle produces again', () => strict(async b => {
    const claim = 'Acme example shared claim seven';
    const id = await sharedFact(b, claim);
    installFaultHook(async (point, detail) => {
      if (point === 'publication:prepared' && detail.operation === 'forget') throw new OperationError('writer_coordinator_required' as never, 'fixture guard refusal', 'fixture');
    });
    expect((await remote(b.engine, b.owner, 'forget', { id })).isError).toBe(true);
    installFaultHook(undefined);
    await b.engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_requests SET error_code='writer_coordinator_required' WHERE operation='forget' AND state='failed'");
    });
    const preview = await (await repairRunner(b.engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
      .run('failed-writes', await resolveRepairScope(b.engine, 'default'), { explicit: true, sourceFlag: 'default' });
    const resubmit = 'a caller made this forget and nothing produces it again; read the fact, then submit the forget again with a new request_id if it is still wanted';
    expect((preview.listing ?? []).map(entry => [entry.class, entry.detail])).toEqual([['producer_owned', `resubmit: ${resubmit}`]]);
    expect(preview.warnings).toEqual([`forget in default: made by a caller, not replayed here; ${resubmit}`]);
    expect(JSON.stringify(preview)).not.toContain('dream');
  }), 240_000);

  if (backend === 'postgres') test('a process killed in the window: the owner recovery replays the forget and records the withdrawal; one strike commit', async () => {
    let url = '';
    await managedBrain(async brain => {
      const b = brain as Brain;
      await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
      await call(b.ctx, 'put_page', { slug: PAGE, content: page('Acme Example') });
      await settleManagedGitEffects(b.engine);
      const claim = 'Acme example shared claim six';
      const id = await sharedFact(b, claim);
      const before = commitsTouching(b.root, `${PAGE}.md`).length;
      await disposePersistenceConsumer(b.engine);
      const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'fixtures', 'forget-before-commit-kill-worker.ts'), url, id],
        { env: process.env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect({ stdout: stdout.trim(), signal: child.signalCode }).toEqual({ stdout: JSON.stringify({ event: 'boundary' }), signal: 'SIGKILL' });
      expect(code).not.toBe(0);
      const strikes = commitsTouching(b.root, `${PAGE}.md`);
      expect(strikes).toHaveLength(before + 1);
      expect(await factState(b.engine, claim)).toEqual({ facts: [true], withdrawals: [] });
      startPersistenceConsumer(b.engine, b.ctx.config as never).wake(true);
      await waitFor(async () => (await forgets(b.engine))[0]?.state === 'committed', { timeoutMs: 120_000, label: 'the killed forget is recovered and replayed' });
      await settleManagedGitEffects(b.engine);
      expect(await forgets(b.engine)).toEqual([{ state: 'committed', error_code: null,
        outcome: expect.objectContaining({ persistence: expect.objectContaining({ git_state: 'committed', git_commit: strikes[0] }) }) }]);
      await expectWithdrawn(b, claim, `${PAGE}.md`, { visibility: 'world', subject: PAGE }, strikes[0]!);
    }, { setup, open: async () => { const opened = await isolatedPersistencePostgres(databaseUrl!); url = opened.databaseUrl; return opened; } });
  }, 240_000);
});
