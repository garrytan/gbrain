/**
 * Wave C 1H-a (ceo-r3-outside-2, unsplit half): a strict git-first upload of a fenced page (1-24 MiB, unsplit) goes
 * through the fence rewrite (Tier 1 normalization, withdrawn-row preservation, purged-row removal, streamed-fences.ts)
 * before the door, so Git commits the rewritten bytes and the index step can stage the committed blob verbatim. The
 * page carries a facts fence with a forgotten (withdrawn) row and a purged row; the upload replaces it with the original,
 * unstruck rows. The committed file keeps the row struck, leaves the purged row out, and the pending head's size and
 * sha256 are the committed blob's. The over-24 MiB (split) half of ceo-r3-outside-2 is 1H-b's.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { gitChildEnv } from '../../src/core/git-env.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string | Buffer) => createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

const FORGOTTEN = 'Prefers the aisle seat on long flights';
const PURGED = 'Keeps a spare key under the planter';
const KEPT = 'Walks to the office on Fridays';
const fence = FACTS_FENCE_BEGIN + '\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
  + '| 1 | ' + FORGOTTEN + ' | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n'
  + '| 2 | ' + PURGED + ' | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n'
  + '| 3 | ' + KEPT + ' | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n' + FACTS_FENCE_END;
const page = (bytes: number) => {
  const head = '---\ntitle: Fenced upload\ntype: note\n---\n\n# Fenced upload\n\n## Facts\n\n' + fence + '\n\n';
  const line = 'Line about the fenced upload and the launch plan for this week.\n';
  return head + line.repeat(Math.max(0, Math.ceil((bytes - head.length) / line.length)));
};
const rowOf = (body: string, claim: string) => body.split('\n').find(line => line.includes(claim)) ?? null;

/** Runs one write op, replaying it with its request_id while it is still pending. */
async function call(ctx: OperationContext, name: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  for (let attempt = 0; ; attempt++) {
    try { return await op(name).handler(ctx, params) as Record<string, any>; }
    catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
  }
}

for (const backend of testBackends()) describe('[' + backend + '] a fenced strict upload is rewritten before the door (ceo-r3-outside-2)', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('Git commits the rewritten body: the forgotten row stays struck, the purged row stays out', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/fenced-upload';
    expect((await call(ctx, 'put_page', { slug, content: page(8 * 1024), request_id: randomUUID(), wait_ms: 30_000 })).state).toBe('committed');
    await runExtractFacts(engine, { sourceId: 'default', slugs: [slug] });
    const facts = await engine.executeRaw<{ id: number; fact: string }>("SELECT id, fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1", [slug]);
    const idOf = (claim: string) => Number(facts.find(row => row.fact === claim)!.id);
    expect((await call(ctx, 'forget_fact', { id: idOf(FORGOTTEN), request_id: randomUUID() })).status).not.toBe('error');
    await settleManagedGitEffects(engine);
    const dry = await call(ctx, 'purge_fact', { id: idOf(PURGED), dry_run: true });
    expect((await call(ctx, 'purge_fact', { id: idOf(PURGED), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() })).state).toBe('committed');
    await settleManagedGitEffects(engine);
    const committedBefore = git(root, 'show', 'HEAD:' + slug + '.md');
    expect(rowOf(committedBefore, FORGOTTEN)).toContain('~~' + FORGOTTEN + '~~');
    expect(committedBefore).not.toContain(PURGED);

    const text = page(2 * MiB);
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const begun = await call(ctx, 'begin_page_upload', { slug, mode: 'replace', expected_revision: revision, total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    for (let part = 0, at = 0; at < text.length; part++, at += 3_000_000) {
      const piece = text.slice(at, at + 3_000_000);
      await call(ctx, 'upload_page_part', { upload_id: begun.upload_id, part, text: piece, part_sha256: hex(piece) });
    }
    await op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 30_000 }).catch((error: { code?: string }) => { if (error.code !== 'write_pending') throw error; });
    let request: { id: string; state: string } | undefined;
    for (const deadline = performance.now() + 60_000; performance.now() < deadline; await Bun.sleep(100)) {
      [request] = await engine.executeRaw<{ id: string; state: string }>("SELECT id::text AS id, state FROM persistence_requests WHERE slug = $1 AND operation = 'put_page' ORDER BY created_at DESC LIMIT 1", [slug]);
      if (request && !['queued', 'running'].includes(request.state)) break;
    }
    expect(request?.state).toBe('indexing');

    const committed = git(root, 'show', 'HEAD:' + slug + '.md');
    expect(rowOf(committed, FORGOTTEN)).toMatch(new RegExp('^\\| 1 \\| ~~' + FORGOTTEN + '~~ \\|.*\\| forgotten: '));
    expect(committed).not.toContain(PURGED);
    expect(rowOf(committed, KEPT)).toContain('| ' + KEPT + ' |');
    expect(committed.length).toBeGreaterThan(MiB);
    const blob = execFileSync('git', ['-C', root, 'cat-file', 'blob', 'HEAD:' + slug + '.md'], { env: gitChildEnv(), maxBuffer: 64 * MiB });
    const [head] = await engine.executeRaw<{ request_id: string; body_bytes: unknown; sha: string }>(
      "SELECT request_id::text AS request_id, body_bytes, encode(body_sha256, 'hex') AS sha FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]);
    expect(head?.request_id).toBe(request!.id);
    expect(Number(head!.body_bytes)).toBe(blob.length);
    expect(head!.sha).toBe(hex(blob));
  }, { databaseUrl, setup }), 300_000);
});
