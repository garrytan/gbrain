/**
 * #9669 (second door): a remote agent job's brain tools ran on the full operation registry, so a starter client with
 * agent scope could submit a job whose get_page call passed include_deleted and read a soft-deleted page.
 *
 * 1. Protects: every remote_agent job records the tool surface its submitting connection was served (grant.surface),
 *    and each tool call the job makes is confined to it exactly as MCP dispatch confines the connection: a hidden
 *    parameter gets param_not_on_surface (with the same reviewed exceptions), a hidden tool gets unknown_tool, and the
 *    job's tool call fails with that refusal before validation and the handler. A full-surface submitter, a local
 *    (application) job and a job accepted before the surface was recorded keep the full surface.
 * 2. Fails when: a job tool call reaches a handler with a parameter or tool its submitter's surface leaves out, or a
 *    path that creates a remote_agent job leaves grant.surface unset.
 * 3. Real seams: submit_agent through dispatchToolCall (stdio and HTTP), the queue, authorizeJobExecution, and the
 *    job's registry as the subagent handler builds it (buildBrainTools, selectAllowedTools, guardDelegatedTools), on
 *    in-memory PGLite and on Postgres when DATABASE_URL is set. No model runs: the test makes the tool call the model
 *    would make.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { allowedOpNames, type McpSurface } from '../src/mcp/surface.ts';
import { PARAM_NOT_ON_SURFACE_CODE } from '../src/mcp/hidden-tool-hint.ts';
import { APPLICATION_AUTHORITY, authorizeJobExecution, withSubmissionAuthority, type SubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { buildBrainTools, selectAllowedTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { guardDelegatedTools } from '../src/core/minions/delegated-tools.ts';
import { snapshotFromJob } from '../src/core/minions/delegated-policy.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CLIENT = 'agent-client-example';
const GONE = { slug: 'notes/gone-example', canary: 'canaryjobtombstone' };
const LIVE = { slug: 'notes/live-example', canary: 'canaryjoblive' };
const TOOLS = ['get_page', 'search'];
const config = { engine: 'pglite' } as never;

function auth(surface: McpSurface): AuthInfo {
  return { token: 't', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'agent'], sourceId: 'default',
    effectiveSurface: surface } as AuthInfo;
}

const text = (res: Awaited<ReturnType<typeof dispatchToolCall>>) => res.content.map(c => c.text).join('\n');

for (const kind of testBackends()) {
  describe(`agent jobs keep their submitter's tool surface (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let queue: MinionQueue;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      queue = new MinionQueue(engine);
      for (const p of [GONE, LIVE]) {
        await engine.putPage(p.slug, { type: 'note' as never, title: p.slug, compiled_truth: `Notes ${p.canary}.`, timeline: '', frontmatter: {} });
      }
      expect(await engine.softDeletePage(GONE.slug)).not.toBeNull();
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ($1, 'x', $1, 'read', 'default')`, [CLIENT]);
      await engine.executeRaw(`UPDATE oauth_clients SET scope = 'read agent', bound_tools = $2::text[], delegated_namespace = 'job', delegated_slug_prefixes = NULL,
        bound_source_id = 'default', federated_read = ARRAY['default'], bound_max_concurrent = 10 WHERE client_id = $1`, [CLIENT, TOOLS]);
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    async function submit(surface: McpSurface) {
      const res = await dispatchToolCall(engine, 'submit_agent', { prompt: 'Read the example notes.', allowed_tools: TOOLS },
        { remote: true, transport: 'http', surface, allowedOps: allowedOpNames(operations, surface), auth: auth(surface), sourceId: 'default' });
      expect({ surface, error: res.isError === true ? text(res) : null }).toEqual({ surface, error: null });
      const job = (await queue.getJob((JSON.parse(res.content[0]!.text) as { id: number }).id))!;
      expect(job.submission_authority?.kind).toBe('remote_agent');
      return job;
    }

    /** The job's tool calls as the subagent handler runs them, under the authority its execution was authorized with. */
    async function jobTools(job: NonNullable<Awaited<ReturnType<MinionQueue['getJob']>>>, authority?: SubmissionAuthority) {
      const granted = authority ?? await authorizeJobExecution(engine, job);
      const data = job.data as Record<string, unknown>;
      const tools = guardDelegatedTools(engine, config, snapshotFromJob(data), job.id,
        selectAllowedTools(buildBrainTools({ subagentId: job.id, engine, config, sourceId: 'default' }), data.allowed_tools), false);
      return async (name: string, input: Record<string, unknown>) => {
        const tool = tools.find(t => t.name === `brain_${name}`)!;
        try { return { ok: JSON.stringify(await withSubmissionAuthority(granted, () => tool.execute(input, { engine, jobId: job.id, remote: true } as never))) }; }
        catch (e) { return { code: (e as { code?: string }).code, message: String((e as Error).message) }; }
      };
    }

    test('a starter client\'s job cannot read a soft-deleted page through get_page include_deleted, and the job says why', async () => {
      const job = await submit('starter');
      expect((job.submission_authority as { grant: { surface?: string } }).grant.surface).toBe('starter');
      const call = await jobTools(job);
      const refused = await call('get_page', { slug: GONE.slug, include_deleted: true });
      expect(JSON.stringify(refused)).not.toContain(GONE.canary);
      expect(refused).toMatchObject({ code: PARAM_NOT_ON_SURFACE_CODE });
      expect(refused.message).toContain('include_deleted');
      expect((await call('get_page', { slug: LIVE.slug })).ok).toContain(LIVE.canary);
    });

    // Every brain tool is on starter today, so a narrower recorded surface stands in for a tool a surface hides.
    test('a job cannot call a tool its recorded surface hides', async () => {
      expect(allowedOpNames(operations, 'verbs').has('get_page')).toBe(false);
      const job = await submit('starter');
      await engine.executeRaw(`UPDATE minion_jobs SET submission_authority = jsonb_set(submission_authority, '{grant,surface}', '"verbs"') WHERE id = $1`, [job.id]);
      const call = await jobTools((await queue.getJob(job.id))!);
      const refused = await call('get_page', { slug: LIVE.slug });
      expect(refused).toMatchObject({ code: 'unknown_tool' });
      expect(JSON.stringify(refused)).not.toContain(LIVE.canary);
    });

    test('a parameter on the reviewed starter list stays usable inside a starter job', async () => {
      const call = await jobTools(await submit('starter'));
      expect((await call('get_page', { slug: LIVE.slug, lines: { from: 1, count: 5 } })).code).not.toBe(PARAM_NOT_ON_SURFACE_CODE);
    });

    test('a full-surface client\'s job, a local job and a job accepted before the surface was recorded read the tombstone as before', async () => {
      const full = await submit('full');
      expect((full.submission_authority as { grant: { surface?: string } }).grant.surface).toBe('full');
      expect((await (await jobTools(full))('get_page', { slug: GONE.slug, include_deleted: true })).ok).toContain(GONE.canary);
      expect((await (await jobTools(full))('search', { query: LIVE.canary, include_content: true })).code).toBeUndefined();
      expect((await (await jobTools(full, APPLICATION_AUTHORITY))('get_page', { slug: GONE.slug, include_deleted: true })).ok).toContain(GONE.canary);
      const old = await submit('starter');
      await engine.executeRaw("UPDATE minion_jobs SET submission_authority = submission_authority #- '{grant,surface}' WHERE id = $1", [old.id]);
      const before = (await queue.getJob(old.id))!;
      expect((before.submission_authority as { grant: Record<string, unknown> }).grant).not.toHaveProperty('surface');
      expect((await (await jobTools(before))('get_page', { slug: GONE.slug, include_deleted: true })).ok).toContain(GONE.canary);
    });

    test('a starter stdio client cannot create a remote agent job at all', async () => {
      const before = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
      const res = await dispatchToolCall(engine, 'submit_agent', { prompt: 'Read the example notes.', allowed_tools: TOOLS },
        { remote: true, transport: 'stdio', surface: 'starter', allowedOps: allowedOpNames(operations, 'starter'), sourceId: 'default' });
      expect(res.isError).toBe(true);
      expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs')).toEqual(before);
    });
  });
}

// The one remote_agent constructor is prepareRemoteAgent and its one caller is submit_agent; the suites above prove at
// runtime that submit_agent records the dispatch surface over HTTP (starter and full) and that stdio cannot submit.
// This census fails when a second producer appears, so it cannot leave grant.surface unset unseen.
test('every path that creates a remote_agent job records the submitter\'s surface', () => {
  const grep = Bun.spawnSync(['git', 'grep', '-l', '-E', "prepareRemoteAgent\\(|kind: 'remote_agent'", '--', 'src'], { cwd: join(import.meta.dir, '..') });
  expect(grep.stdout.toString().trim().split('\n').sort()).toEqual(['src/core/minions/submission-authority.ts', 'src/core/ops/jobs.ts']);
  const calls = Bun.spawnSync(['git', 'grep', '-c', '-E', 'prepareRemoteAgent\\(', '--', 'src/core/ops/jobs.ts'], { cwd: join(import.meta.dir, '..') });
  expect(calls.stdout.toString().trim()).toBe('src/core/ops/jobs.ts:1');
});
