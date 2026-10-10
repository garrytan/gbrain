import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { prepareLocalSubagent } from '../src/core/minions/submission-authority.ts';
import { localSubagentTools } from '../src/core/minions/local-subagent.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalGrant } from '../src/core/persistence/identity.ts';
import { authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { authorizeFactsBackstop, prepareFactsBackstop } from '../src/core/persistence/effect-facts.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { isFactsBackstopEligible } from '../src/core/facts/eligibility.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let home: string;
let engine: PGLiteEngine;
let queue: MinionQueue;
let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
const sourceId = 'local-child';
const oldHome = process.env.GBRAIN_HOME;
const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
const grant: LocalGrant = { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null };
const operations = ['get_page', 'put_page'];
const prefixes = ['wiki/originals/*'];
const context = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, remote: false,
  sourceId, logger: { info() {}, warn() {}, error() {} } });
const payload = () => ({ source_id: sourceId, prompt: 'synthetic bounded replay test', allowed_tools: [...operations], allowed_slug_prefixes: [...prefixes] });
const mint = async (data = payload()) => withVerifiedLocalRegistration(engine, registration, () =>
  prepareLocalSubagent(context(), randomUUID(), 'subagent', data, data.allowed_tools, data.allowed_slug_prefixes));

beforeEach(async () => {
  home = mkdtempSync(join(process.env.TMPDIR!, 'local-subagent-replay-'));
  process.env.GBRAIN_HOME = home;
  process.env.GIT_CEILING_DIRECTORIES = dirname(realpathSync(home));
  // GIT_CEILING_DIRECTORIES must prevent discovery of the protected agent-home .git marker.
  const git = Bun.spawnSync(['git', '-C', home, 'rev-parse', '--show-toplevel'], { env: process.env });
  expect(git.exitCode).not.toBe(0);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  registration = await registerLocalWriter(engine, 'cli', structuredClone(grant));
  await engine.setConfig('embedding_disabled', 'true');
  await engine.setConfig('facts.extraction_enabled', 'true');
});
afterEach(async () => {
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldHome;
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
});

async function accepted() {
  const data = payload();
  const trusted = await mint(data);
  const privateQueue = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = await queue.add('subagent', data, { queue: privateQueue }, trusted);
  const owner = randomUUID();
  const active = await queue.claim(owner, 60_000, privateQueue, ['subagent']);
  expect(active?.id).toBe(job.id);
  const capability = await localSubagentTools(engine, job.id, data);
  expect(capability).toBeTruthy();
  const ctx: OperationContext = { ...context(), remote: true, viaSubagent: true, jobId: job.id, subagentId: job.id,
    allowedSlugPrefixes: [...prefixes], localSubagent: capability };
  return { data, job, owner, ctx };
}
async function written() {
  const a = await accepted();
  const requestId = randomUUID();
  const slug = `wiki/originals/replay-${requestId.slice(0, 8)}`;
  const content = '---\ntype: note\ntitle: Replay proof\n---\n\n' + 'A synthetic decision records an independently useful fact about a bounded project. '.repeat(3);
  const response = await submitPageMutation(a.ctx, { operation: 'put_page', params: { slug, content, request_id: requestId } });
  expect(response.state).toBe('committed');
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  expect(row?.state).toBe('committed');
  return { ...a, requestId, slug, content, row };
}

describe('durable local-subagent publication, replay, and synthesis bounds', () => {
  test('committed local_subagent receipt survives private-job cleanup and the same request replays it', async () => {
    const a = await written();
    expect(a.row.authority).toMatchObject({ remote: true, localSubagent: { kind: 'local_subagent', acceptedJobId: a.job.id } });
    const cleaned = await queue.reconcilePrivateQueue(a.job.queue, 'synthetic private queue completed');
    expect(cleaned.map(job => job.id)).toContain(a.job.id);
    expect((await queue.getJob(a.job.id))?.status).toBe('cancelled');
    // Also cover later physical job GC, not only cancellation of the private queue.
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id=$1', [a.job.id]);
    expect(await queue.getJob(a.job.id)).toBeNull();
    await authorizeStoredRequest(engine, a.row);
    const before = await engine.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM persistence_requests WHERE id=$1::uuid', [a.row.id]);
    const replay = await withVerifiedLocalRegistration(engine, registration, () => submitPageMutation(context(),
      { operation: 'put_page', params: { slug: a.slug, content: a.content, request_id: a.requestId } }));
    expect(replay).toMatchObject({ state: 'committed', request_id: a.requestId });
    const after = await engine.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM persistence_requests WHERE id=$1::uuid', [a.row.id]);
    expect(after[0].count).toBe(before[0].count);
  });

  test('publication/replay authorization refuses a revoked or narrowed live CLI grant', async () => {
    for (const state of ['revoked', 'narrowed'] as const) {
      const a = await written();
      if (state === 'revoked') {
        await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
      } else {
        await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{slugPrefixes}','[\"wiki/other/*\"]'::jsonb) WHERE id=$1::uuid", [registration.id]);
      }
      await expect(authorizeStoredRequest(engine, a.row)).rejects.toThrow();
      await expect(submitPageMutation(a.ctx, { operation: 'put_page', params: { slug: a.slug, content: a.content, request_id: a.requestId } })).rejects.toThrow();
      await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL,grant_ceiling=$2::jsonb WHERE id=$1::uuid', [registration.id, JSON.stringify(grant)]);
    }
  });

  test('receipt replay refuses source-incarnation replacement and accepted operation/prefix/parent identity edits', async () => {
    const a = await written();
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await expect(authorizeStoredRequest(engine, a.row)).rejects.toThrow();

    const b = await written();
    const changed = structuredClone(b.row);
    changed.authority.localSubagent!.grant.allowedOperations = ['get_page'];
    await expect(authorizeStoredRequest(engine, changed)).rejects.toThrow();
    const changedPrefix = structuredClone(b.row);
    changedPrefix.authority.localSubagent!.grant.allowedSlugPrefixes = ['wiki/sibling/*'];
    await expect(authorizeStoredRequest(engine, changedPrefix)).rejects.toThrow();
    const changedParent = structuredClone(b.row);
    changedParent.authority.localSubagent!.principal.id = randomUUID();
    await expect(authorizeStoredRequest(engine, changedParent)).rejects.toThrow();
  });

  test('a broad parent does not give a confined child source-wide extraction authority', async () => {
    const a = await written();
    const page = parseMarkdown(a.content, a.slug);
    expect(isFactsBackstopEligible(a.slug, page)).toEqual({ ok: true });
    expect(await prepareFactsBackstop(engine, a.row, page)).toEqual({ skipped: 'slug_bound_client' });
    await expect(authorizeFactsBackstop(engine, a.row)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='facts-backstop'", [a.row.id])).toHaveLength(0);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='facts-absorb' AND data->>'persistence_request_id'=$1", [a.row.id])).toHaveLength(0);
  });

  test('dream-generated, private, opt-out and quarantined pages retain canonical exclusions', async () => {
    const a = await written();
    const before = (await engine.readPageSnapshot(a.slug, { sourceId }))!;
    for (const [frontmatter, reason] of [
      [{ dream_generated: true }, 'dream_generated'],
      [{ facts_backstop: false }, 'opted_out'],
      [{ quarantine: { reason: 'junk_pattern', detail: 'synthetic' } }, 'quarantined'],
    ] as const) {
      await engine.putPage(a.slug, { ...before.page, frontmatter: { ...before.page.frontmatter, ...frontmatter } }, { sourceId });
      const current = (await engine.readPageSnapshot(a.slug, { sourceId }))!;
      expect(isFactsBackstopEligible(a.slug, current.page)).toEqual({ ok: false, reason });
      expect(await prepareFactsBackstop(engine, a.row, parseMarkdown(a.content, a.slug))).toEqual({ skipped: 'slug_bound_client' });
    }
    await engine.putPage(a.slug, { ...before.page, frontmatter: { visibility: 'private' } }, { sourceId });
    await expect(authorizeStoredRequest(engine, a.row)).rejects.toMatchObject({ code: 'page_not_found' });
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='facts-backstop'", [a.row.id])).toHaveLength(0);
  });
});
