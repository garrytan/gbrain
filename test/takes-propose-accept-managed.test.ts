/**
 * #5764: `gbrain takes propose --accept` on a managed brain. The accept used
 * to promote through the uncoordinated addTakeToPage, which a managed
 * worktree refuses with writer_coordinator_required, so no pending proposal
 * could ever be accepted there. It now promotes through a coordinated
 * takes_add mutation: the fence row lands in the managed file and the DB,
 * and the proposal is stamped accepted.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { acceptProposal, rejectProposal } from '../src/core/take-proposals.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runTakes } from '../src/commands/takes.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

async function insertProposal(engine: BrainEngine, slug: string, claim: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
       claim_text, kind, holder, weight, domain, model_id, status)
     VALUES ('default', $1, md5($2), 'test-v1', 'run-test', $2, 'bet', 'world', 0.7, NULL, 'test-model', 'pending')
     RETURNING id`, [slug, claim]);
  return Number(rows[0]!.id);
}

async function proposalStatus(engine: BrainEngine, id: number) {
  const [row] = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
    'SELECT status, promoted_row_num FROM take_proposals WHERE id = $1', [id]);
  return { status: row!.status, promoted_row_num: row!.promoted_row_num == null ? null : Number(row!.promoted_row_num) };
}

for (const backend of testBackends()) test(`${backend}: takes propose --accept promotes through the writer coordinator on a managed brain`, async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'companies/acme-example';
    await put(ctx, slug, 'About acme-example.', 'company');

    const direct = await insertProposal(engine, slug, 'Acme ships the widget by Q3');
    const { rowNum } = await acceptProposal({ engine, brainDir: root, sourceId: 'default', config: ctx.config }, direct);
    expect(rowNum).toBeGreaterThan(0);
    expect(await proposalStatus(engine, direct)).toEqual({ status: 'accepted', promoted_row_num: rowNum });

    const viaCli = await insertProposal(engine, slug, 'Acme doubles revenue next year');
    const lines: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    try { await runTakes(engine, ['propose', '--accept', String(viaCli), '--dir', root]); } finally { console.log = log; }
    expect(lines.join('\n')).toContain(`Accepted proposal #${viaCli}`);
    expect((await proposalStatus(engine, viaCli)).status).toBe('accepted');

    const fence = parseTakesFence(readFileSync(join(root, `${slug}.md`), 'utf-8'));
    expect(fence.takes.map(t => t.claim)).toEqual(expect.arrayContaining(['Acme ships the widget by Q3', 'Acme doubles revenue next year']));
    const takes = await engine.executeRaw<{ claim: string }>(
      'SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.row_num', [slug]);
    expect(takes.map(t => t.claim)).toEqual(['Acme ships the widget by Q3', 'Acme doubles revenue next year']);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 180_000);

// Codex review: a claim left 'accepted' without a recorded take (an accept
// whose publication was still pending, or a crash between commit and the
// row_num stamp) resumes with the SAME write request, so re-running accept
// records the one take instead of appending a second one.
for (const backend of testBackends()) test(`${backend}: a stranded accepted claim resumes its own write request and never duplicates the take`, async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'companies/acme-example';
    await put(ctx, slug, 'About acme-example.', 'company');
    const id = await insertProposal(engine, slug, 'Acme opens a second office');
    const first = await acceptProposal({ engine, brainDir: root, sourceId: 'default', config: ctx.config }, id);
    await engine.executeRaw('UPDATE take_proposals SET promoted_row_num = NULL WHERE id = $1', [id]);
    const resumed = await acceptProposal({ engine, brainDir: root, sourceId: 'default', config: ctx.config }, id);
    expect(resumed.rowNum).toBe(first.rowNum);
    expect(await proposalStatus(engine, id)).toEqual({ status: 'accepted', promoted_row_num: first.rowNum });
    const takes = await engine.executeRaw<{ claim: string }>(
      'SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1', [slug]);
    expect(takes.map(t => t.claim)).toEqual(['Acme opens a second office']);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 180_000);

// Codex review: an explicit --dir is validated against the source's canonical
// root, as `gbrain takes add --dir` does, instead of being ignored.
for (const backend of testBackends()) test(`${backend}: accept with a --dir that is not the canonical root refuses and leaves the proposal pending`, async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'companies/acme-example';
    await put(ctx, slug, 'About acme-example.', 'company');
    const id = await insertProposal(engine, slug, 'Acme hires a CFO');
    const elsewhere = join(root, '..');
    await expect(acceptProposal({ engine, brainDir: elsewhere, localDir: elsewhere, sourceId: 'default', config: ctx.config }, id))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(await proposalStatus(engine, id)).toEqual({ status: 'pending', promoted_row_num: null });
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 180_000);

// Codex review (cycle 2): the journal keys requests per writer principal, so a
// resume from another local writer must settle from the claim's existing
// request instead of admitting a second takes_add; while that request is
// still in flight the claim is kept and neither accept nor reject races it.
for (const backend of testBackends()) test(`${backend}: a claim whose request belongs to another writer settles from that request, and an in-flight one is never raced`, async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'companies/acme-example';
    await put(ctx, slug, 'About acme-example.', 'company');
    const target = { engine, brainDir: root, sourceId: 'default', config: ctx.config };
    const id = await insertProposal(engine, slug, 'Acme signs a reseller');
    const first = await acceptProposal(target, id);
    const [request] = await engine.executeRaw<{ id: string }>(
      "SELECT id FROM persistence_requests WHERE operation = 'takes_add' ORDER BY sequence DESC LIMIT 1");
    // Fixture-only rewrites of the journal row, under the protocol the request guard requires.
    const rewrite = (set: string) => engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol', '2', true)");
      await tx.executeRaw(`UPDATE persistence_requests SET ${set} WHERE id = $1`, [request!.id]);
    });
    await rewrite("principal_id = 'another-writer-example'");
    await engine.executeRaw('UPDATE take_proposals SET promoted_row_num = NULL WHERE id = $1', [id]);

    await disposePersistenceConsumer(engine);
    await rewrite("state = 'running'");
    await expect(acceptProposal(target, id)).rejects.toThrow('still being written');
    await expect(rejectProposal({ engine }, id)).rejects.toMatchObject({ code: 'not_pending' });
    expect(await proposalStatus(engine, id)).toEqual({ status: 'accepted', promoted_row_num: null });

    await rewrite("state = 'committed'");
    expect((await acceptProposal(target, id)).rowNum).toBe(first.rowNum);
    expect(await proposalStatus(engine, id)).toEqual({ status: 'accepted', promoted_row_num: first.rowNum });
    const takes = await engine.executeRaw<{ claim: string }>(
      'SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1', [slug]);
    expect(takes.map(t => t.claim)).toEqual(['Acme signs a reseller']);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
}, 180_000);
