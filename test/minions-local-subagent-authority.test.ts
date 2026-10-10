import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { authorizeJobExecution, parseSubmissionAuthority, prepareLocalSubagent, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { localSubagentTools } from '../src/core/minions/local-subagent.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalGrant } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let home: string; let engine: PGLiteEngine; let queue: MinionQueue;
let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
const sourceId = 'local-child';
const oldHome = process.env.GBRAIN_HOME;
const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
const broad: LocalGrant = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };
const ops = ['get_page', 'put_page'];
const prefixes = ['wiki/originals/*'];
const context = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, remote: false, sourceId,
  logger: { info() {}, warn() {}, error() {} } });
const data = () => ({ source_id: sourceId, prompt: 'bounded scripted task', allowed_tools: [...ops], allowed_slug_prefixes: [...prefixes] });
const mint = (payload = data(), ctx = context()) => withVerifiedLocalRegistration(engine, registration, () =>
  prepareLocalSubagent(ctx, randomUUID(), 'subagent', payload, payload.allowed_tools, payload.allowed_slug_prefixes));

beforeEach(async () => {
  home = mkdtempSync(join(process.env.TMPDIR!, 'local-delegation-'));
  process.env.GBRAIN_HOME = home; process.env.GIT_CEILING_DIRECTORIES = dirname(home);
  const git = Bun.spawnSync(['git', '-C', home, 'rev-parse', '--show-toplevel'], { env: process.env });
  expect(git.exitCode).not.toBe(0); // Never discover the live agent home's ownership marker.
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); queue = new MinionQueue(engine);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  registration = await registerLocalWriter(engine, 'cli', structuredClone(broad));
  await engine.setConfig('embedding_disabled', 'true'); await engine.setConfig('facts.extraction_enabled', 'false');
});
afterEach(async () => {
  await engine?.disconnect(); rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldHome;
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
});
async function accepted() {
  const payload = data(); const trusted = await mint(payload);
  const job = await queue.add('subagent', payload, {}, trusted);
  const token = randomUUID(); const active = await queue.claim(token, 60000, 'default', ['subagent']);
  expect(active?.id).toBe(job.id);
  const capability = await localSubagentTools(engine, job.id, payload);
  expect(capability).toBeTruthy();
  const ctx: OperationContext = { ...context(), remote: true, viaSubagent: true, jobId: job.id, subagentId: job.id,
    allowedSlugPrefixes: [...prefixes], localSubagent: capability };
  return { payload, job, token, ctx, capability };
}
async function written() {
  const a = await accepted();
  const requestId = randomUUID(); const slug = `wiki/originals/proof-${requestId.slice(0,8)}`;
  const content = '---\ntype: note\ntitle: Accepted proof\n---\n\n' + 'A concrete scripted decision was made in August 2026. '.repeat(4);
  const result = await submitPageMutation(a.ctx, { operation: 'put_page', params: { slug, content, request_id: requestId } });
  expect(result.state).toBe('committed');
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return { ...a, row, slug, content, requestId };
}

describe('durable local-subagent authority', () => {

  test('authenticated owner admits immutable durable work without a fake parent job', async () => {
    const payload = data();
    const ctx = { ...context(), auth: { token: '', clientId: registration.id, scopes: ['read', 'write'], sourceId } };
    const trusted = await mint(payload, ctx);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.submissionAuthority.grant.allowedSlugPrefixes)).toBe(true);
    expect(() => trusted.submissionAuthority.grant.allowedSlugPrefixes.push('wiki/sibling/*')).toThrow();
    const job = await queue.add('subagent', payload, {}, trusted);
    expect((await authorizeJobExecution(engine, (await queue.getJob(job.id))!)).kind).toBe('local_subagent');
    expect(job.parent_job_id).toBeNull();
    expect(trusted.submissionAuthority.grant.allowedSlugPrefixes).toEqual(prefixes);
    for (const fake of [{ ...trusted }, JSON.parse(JSON.stringify(trusted)), { submissionAuthority: job.submission_authority! }]) {
      await expect(queue.add('subagent', payload, {}, fake)).rejects.toThrow('Unsupported submission authority');
    }
    const other = new PGLiteEngine();
    try {
      await other.connect({}); await other.initSchema();
      await expect(new MinionQueue(other).add('subagent', payload, {}, trusted)).rejects.toThrow('another engine');
      await expect(mint(payload, { ...ctx, engine: other })).rejects.toThrow('verified local CLI');
      await expect(authorizeJobExecution(other, job)).rejects.toThrow();
    } finally { await other.disconnect(); }
  });

  test('unverified, mismatched authenticated, stdio and remote lanes cannot mint; fresh narrowing beats retained ALS', async () => {
    const payload = data();
    await expect(prepareLocalSubagent(context(), randomUUID(), 'subagent', payload, ops, prefixes)).rejects.toThrow('verified local CLI');
    await expect(mint(payload, { ...context(), remote: true })).rejects.toThrow('verified local CLI');
    await expect(mint(payload, { ...context(), auth: { token: '', clientId: randomUUID(), scopes: ['read','write'], sourceId } })).rejects.toThrow('matching authenticated');
    const stdio = await registerLocalWriter(engine, 'stdio');
    await expect(withVerifiedLocalRegistration(engine, stdio, () => prepareLocalSubagent(context(), randomUUID(), 'subagent', payload, ops, prefixes))).rejects.toThrow('verified local CLI');
    await withVerifiedLocalRegistration(engine, registration, async () => {
      await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{operations}','[\"get_page\"]') WHERE id=$1::uuid", [registration.id]);
      await expect(prepareLocalSubagent(context(), randomUUID(), 'subagent', payload, ops, prefixes)).rejects.toThrow('narrowed');
    });
  });

  test('execution rejects payload, tools, prefixes, sibling job/source/principal and archived/recreated source', async () => {
    const payload = data(); const trusted = await mint(payload); const job = await queue.add('subagent', payload, {}, trusted);
    for (const change of [{ prompt: 'tampered' }, { source_id: 'default' }, { allowed_tools: [...ops, 'delete_page'] }, { allowed_slug_prefixes: ['wiki/sibling/*'] }]) {
      await expect(authorizeJobExecution(engine, { ...job, data: { ...payload, ...change } })).rejects.toThrow('payload changed');
    }
    await expect(authorizeJobExecution(engine, { ...job, id: job.id + 1 })).rejects.toThrow('job binding');
    const authority = parseSubmissionAuthority(job.submission_authority)!;
    if (authority.kind !== 'local_subagent') throw new Error('wrong authority');
    await expect(authorizeJobExecution(engine, { ...job, submission_authority: { ...authority, principal: { kind: 'local_cli', id: randomUUID() } } })).rejects.toThrow('integrity');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('incarnation');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await expect(authorizeJobExecution(engine, job)).rejects.toThrow('incarnation');
  });

  test('accepted tools stay remote, source-bound and private-excluding; ordinary descendants inherit no CLI power', async () => {
    const a = await accepted();
    const tools = buildBrainTools({ engine, config: context().config, subagentId: a.job.id, sourceId,
      allowedSlugPrefixes: prefixes, localSubagent: a.capability, deferEmbeds: true });
    const get = tools.find(t => t.name === 'brain_get_page')!;
    const toolCtx = { engine, jobId: a.job.id, remote: true as const };
    await engine.putPage('wiki/originals/public', { type: 'note', title: 'Public', compiled_truth: 'PUBLIC-PROOF', timeline: '', frontmatter: { visibility: 'world' } }, { sourceId });
    expect(JSON.stringify(await get.execute({ slug: 'wiki/originals/public' }, toolCtx))).toContain('PUBLIC-PROOF');
    await engine.putPage('wiki/originals/private', { type: 'note', title: 'Private', compiled_truth: 'PRIVATE-PROOF', timeline: '', frontmatter: { visibility: 'private' } }, { sourceId });
    const result = await get.execute({ slug: 'wiki/originals/private' }, toolCtx).catch(e => ({ error: String(e) }));
    expect(JSON.stringify(result)).not.toContain('PRIVATE-PROOF');
    await expect(get.execute({ slug: 'wiki/originals/private', source_id: 'default' }, toolCtx)).rejects.toThrow('source override');
    await expect(get.execute({ slug: 'x' }, { ...toolCtx, jobId: a.job.id + 1 })).rejects.toThrow('binding');
    await expect(tools.find(t => t.name === 'brain_list_pages')!.execute({}, toolCtx)).rejects.toThrow('bounds');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const authority = await submissionAuthority(a.ctx, 'put_page', sourceId, source.incarnation, 'wiki/originals/allowed');
    expect(authority).toMatchObject({ remote: true, excludePrivate: true, takesHolders: ['world'], principal: { kind: 'local_cli', id: registration.id } });
    await expect(submissionAuthority(a.ctx, 'put_page', sourceId, source.incarnation, 'wiki/sibling/excess')).rejects.toThrow('namespace');
    await withVerifiedLocalRegistration(engine, registration, async () => {
      await expect(submissionAuthority({ ...context(), remote: true, viaSubagent: true, subagentId: a.job.id, allowedSlugPrefixes: prefixes }, 'put_page', sourceId, source.incarnation, 'wiki/originals/ordinary')).rejects.toThrow('trust lane');
    });
    await expect(withSubmissionAuthority(a.job.submission_authority!, () => queue.add('unit-child', {}))).rejects.toThrow('descendant');
    await expect(withSubmissionAuthority(a.job.submission_authority!, () => queue.add('facts-absorb', { slug: 'x', sourceId }, {}, {}))).rejects.toThrow('descendant');
  });

});
