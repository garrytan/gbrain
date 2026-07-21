/**
 * #1467 — take-proposal review queue (list / accept / reject).
 *
 * Real PGLite engine (in-memory) + a temp brain dir. Pins the queue→fence
 * promotion contract: list shows pending proposals (holder allow-list
 * respected), accept writes the canonical markdown fence + DB take +
 * verdict row with promoted_row_num, reject records the verdict, and a
 * second resolve on the same id fails loudly.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listTakeProposals, resolveTakeProposal } from '../src/core/takes-proposals.ts';

let engine: PGLiteEngine;
let brainDir: string;

async function insertProposal(opts: {
  slug: string;
  claim: string;
  holder?: string;
  status?: string;
  hash?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        status, claim_text, kind, holder, weight, domain, model_id)
     VALUES ('default', $1, $2, 'test-v1', 'run-test',
             $3, $4, 'take', $5, 0.6, NULL, 'anthropic:claude-sonnet-4-6')
     RETURNING id`,
    [opts.slug, opts.hash ?? `hash-${opts.slug}-${opts.claim.length}`, opts.status ?? 'pending', opts.claim, opts.holder ?? 'brain'],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-proposals-'));
  await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person' as const,
    compiled_truth: 'Alice is a strong founder.\n',
  });
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('listTakeProposals (#1467)', () => {
  test('lists pending by default, respects holder allow-list', async () => {
    const brainId = await insertProposal({ slug: 'people/alice-example', claim: 'Alice will raise a Series A', holder: 'brain', hash: 'h-list-1' });
    await insertProposal({ slug: 'people/alice-example', claim: 'Consensus view of Alice', holder: 'world', hash: 'h-list-2' });
    await insertProposal({ slug: 'people/alice-example', claim: 'Already rejected', status: 'rejected', hash: 'h-list-3' });

    const all = await listTakeProposals(engine, { sourceId: 'default' });
    expect(all.map((r) => r.id)).toContain(brainId);
    expect(all.every((r) => r.status === 'pending')).toBe(true);
    expect(all.some((r) => r.claim_text === 'Already rejected')).toBe(false);

    // MCP-style allow-list: only 'world' holders visible.
    const worldOnly = await listTakeProposals(engine, { sourceId: 'default', takesHoldersAllowList: ['world'] });
    expect(worldOnly.length).toBeGreaterThan(0);
    expect(worldOnly.every((r) => r.holder === 'world')).toBe(true);

    // Fail-closed: empty allow-list → nothing, not everything.
    expect(await listTakeProposals(engine, { sourceId: 'default', takesHoldersAllowList: [] })).toEqual([]);

    // Source isolation: a different source sees nothing.
    expect(await listTakeProposals(engine, { sourceId: 'other-source' })).toEqual([]);
  });
});

describe('resolveTakeProposal (#1467)', () => {
  test('accept promotes to markdown fence + DB take + verdict row', async () => {
    const id = await insertProposal({ slug: 'people/alice-example', claim: 'Alice ships weekly', hash: 'h-accept' });
    const result = await resolveTakeProposal(engine, { id, verdict: 'accept', brainDir, sourceId: 'default', actedBy: 'test' });

    expect(result.status).toBe('accepted');
    expect(result.promoted_row_num).toBeGreaterThanOrEqual(1);

    // Markdown fence written (markdown is canonical).
    const mdPath = join(brainDir, 'people/alice-example.md');
    expect(existsSync(mdPath)).toBe(true);
    expect(readFileSync(mdPath, 'utf-8')).toContain('Alice ships weekly');

    // DB mirror.
    const takes = await engine.listTakes({ page_slug: 'people/alice-example' });
    const promoted = takes.find((t) => t.claim === 'Alice ships weekly');
    expect(promoted).toBeTruthy();
    expect(promoted!.row_num).toBe(result.promoted_row_num!);

    // Verdict row.
    const rows = await engine.executeRaw<{ status: string; promoted_row_num: number; acted_by: string }>(
      `SELECT status, promoted_row_num, acted_by FROM take_proposals WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('accepted');
    expect(rows[0]!.promoted_row_num).toBe(result.promoted_row_num!);
    expect(rows[0]!.acted_by).toBe('test');

    // Double-resolve fails loudly.
    await expect(
      resolveTakeProposal(engine, { id, verdict: 'reject', sourceId: 'default' }),
    ).rejects.toThrow(/already accepted/);
  });

  test('reject records the verdict without touching the fence', async () => {
    const id = await insertProposal({ slug: 'people/alice-example', claim: 'Overreaching claim', hash: 'h-reject' });
    const result = await resolveTakeProposal(engine, { id, verdict: 'reject', sourceId: 'default' });
    expect(result.status).toBe('rejected');

    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id = $1`, [id],
    );
    expect(rows[0]!.status).toBe('rejected');
    expect(readFileSync(join(brainDir, 'people/alice-example.md'), 'utf-8')).not.toContain('Overreaching claim');
  });

  test('accept without a brain dir fails loudly (markdown is canonical)', async () => {
    const id = await insertProposal({ slug: 'people/alice-example', claim: 'No dir claim', hash: 'h-nodir' });
    await expect(
      resolveTakeProposal(engine, { id, verdict: 'accept', sourceId: 'default' }),
    ).rejects.toThrow(/NO_BRAIN_DIR/);
  });

  test('unknown or out-of-scope id fails loudly', async () => {
    await expect(
      resolveTakeProposal(engine, { id: 9_999_999, verdict: 'reject', sourceId: 'default' }),
    ).rejects.toThrow(/PROPOSAL_NOT_FOUND/);
    // Source isolation: an id that exists is invisible from another source.
    const id = await insertProposal({ slug: 'people/alice-example', claim: 'Scoped claim', hash: 'h-scope' });
    await expect(
      resolveTakeProposal(engine, { id, verdict: 'reject', sourceId: 'other-source' }),
    ).rejects.toThrow(/PROPOSAL_NOT_FOUND/);
  });
});
