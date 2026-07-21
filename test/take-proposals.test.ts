/**
 * Review-first take proposal lifecycle (#2269, takeover of PR #2418):
 * list / accept / reject over the shared operation registry, plus the
 * source-isolation + holder-allow-list repairs.
 *
 * Real PGLite engine (in-memory, no DATABASE_URL) so the SQL shapes
 * (FOR UPDATE OF, pg_advisory_xact_lock, ANY($::text[])) run for real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import {
  acceptTakeProposal,
  listTakeProposals,
  rejectTakeProposal,
} from '../src/core/take-proposals.ts';

let engine: PGLiteEngine;
let brainDir: string;

async function addSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, NULL, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function insertProposal(p: {
  source_id: string;
  page_slug: string;
  claim: string;
  holder?: string;
  kind?: string;
  weight?: number;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, model_id)
     VALUES ($1, $2, md5($6 || random()::text), 'v1', 'run-test', $6, $3, $4, $5, 'test-model')
     RETURNING id`,
    [p.source_id, p.page_slug, p.kind ?? 'take', p.holder ?? 'garry', p.weight ?? 0.7, p.claim],
  );
  return Number(rows[0].id);
}

function writePage(slug: string, body = '# Page\n'): string {
  const path = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

beforeAll(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-take-proposals-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('sync.repo_path', brainDir);
  await addSource('tenant-a');
  await addSource('tenant-b');
  await engine.putPage('topics/a', { title: 'A', type: 'concept', compiled_truth: 'Body' }, { sourceId: 'tenant-a' });
  await engine.putPage('topics/b', { title: 'B', type: 'concept', compiled_truth: 'Body' }, { sourceId: 'tenant-b' });
  // Real content date on topics/a so accept threads since_date.
  await engine.executeRaw(
    `UPDATE pages SET effective_date = '2024-03-02', effective_date_source = 'frontmatter' WHERE slug = 'topics/a'`,
  );
}, 30000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('listTakeProposals — scope isolation', () => {
  let idA: number;
  let idB: number;
  let idWorld: number;

  beforeAll(async () => {
    idA = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'A will happen', holder: 'garry' });
    idB = await insertProposal({ source_id: 'tenant-b', page_slug: 'topics/b', claim: 'B will happen', holder: 'garry' });
    idWorld = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'Public claim', holder: 'world' });
  });

  test('unscoped (trusted local) sees all pending proposals', async () => {
    const rows = await listTakeProposals(engine);
    const ids = rows.map(r => r.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect(ids).toContain(idWorld);
  });

  test('scalar sourceId filters to that source', async () => {
    const rows = await listTakeProposals(engine, { sourceId: 'tenant-b' });
    expect(rows.map(r => r.id)).toEqual([idB]);
  });

  test('federated sourceIds array filters to the grant', async () => {
    const rows = await listTakeProposals(engine, { sourceIds: ['tenant-a'] });
    const ids = rows.map(r => r.id).sort();
    expect(ids).toEqual([idA, idWorld].sort());
  });

  test('holdersAllowList hides other holders; empty list matches nothing', async () => {
    const world = await listTakeProposals(engine, { holdersAllowList: ['world'] });
    expect(world.map(r => r.id)).toEqual([idWorld]);
    expect(await listTakeProposals(engine, { holdersAllowList: [] })).toEqual([]);
  });

  test('invalid status is rejected', async () => {
    await expect(listTakeProposals(engine, { status: 'garbage' as never })).rejects.toThrow('invalid proposal status');
  });

  test('takes_propose_list op threads source scope + holder allow-list (remote)', async () => {
    const result = await dispatchToolCall(engine, 'takes_propose_list', {}, {
      remote: true,
      sourceId: 'tenant-a',
      takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(result.content[0].text) as Array<{ id: number; holder: string; source_id: string }>;
    expect(rows.map(r => r.id)).toEqual([idWorld]);
  });

  test('list surfaces page effective-date metadata', async () => {
    const rows = await listTakeProposals(engine, { sourceIds: ['tenant-a'] });
    const a = rows.find(r => r.id === idA)!;
    expect(a.effective_date).toContain('2024-03-02');
    expect(a.effective_date_source).toBe('frontmatter');
  });
});

describe('acceptTakeProposal', () => {
  test('promotes: writes markdown fence, mirrors DB, stamps proposal; idempotent re-accept', async () => {
    const pagePath = writePage('topics/a', '# A\n\nBody\n');
    const id = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'Promote me', holder: 'garry' });

    const result = await acceptTakeProposal(engine, id, { actedBy: 'test', brainDir });
    expect(result).toMatchObject({ ok: true, proposal_id: id, page_slug: 'topics/a', status: 'accepted', idempotent: false, since_date: '2024-03-02' });

    const body = readFileSync(pagePath, 'utf-8');
    expect(body).toContain('Promote me');
    expect(body).toContain(`proposal:${id}`);

    const takes = await engine.listTakes({ page_slug: 'topics/a', sourceId: 'tenant-a' });
    const promoted = takes.find(t => t.claim === 'Promote me')!;
    expect(promoted).toBeDefined();
    expect(promoted.row_num).toBe(result.row_num);
    expect(promoted.since_date).toContain('2024-03-02');

    const [stamped] = await engine.executeRaw<{ status: string; acted_by: string; promoted_row_num: number }>(
      `SELECT status, acted_by, promoted_row_num FROM take_proposals WHERE id = $1`, [id],
    );
    expect(stamped).toMatchObject({ status: 'accepted', acted_by: 'test' });
    expect(Number(stamped.promoted_row_num)).toBe(result.row_num);

    const again = await acceptTakeProposal(engine, id, { actedBy: 'test', brainDir });
    expect(again).toMatchObject({ ok: true, idempotent: true, row_num: result.row_num });
  });

  test('refuses out-of-scope source and out-of-allow-list holder', async () => {
    writePage('topics/a', '# A\n');
    const id = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'Scoped claim', holder: 'garry' });
    await expect(acceptTakeProposal(engine, id, { brainDir, sourceIds: ['tenant-b'] })).rejects.toThrow('outside your source scope');
    await expect(acceptTakeProposal(engine, id, { brainDir, sourceId: 'tenant-b' })).rejects.toThrow('outside your source scope');
    await expect(acceptTakeProposal(engine, id, { brainDir, holdersAllowList: ['world'] })).rejects.toThrow('outside your holder allow-list');
    const [row] = await engine.executeRaw<{ status: string }>(`SELECT status FROM take_proposals WHERE id = $1`, [id]);
    expect(row.status).toBe('pending');
  });

  test('refuses a duplicate of an existing active take', async () => {
    writePage('topics/a', '# A\n');
    const id = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: '  PROMOTE ME  ', holder: 'garry' });
    await expect(acceptTakeProposal(engine, id, { brainDir })).rejects.toThrow('duplicates existing take row');
  });

  test('rolls back markdown and proposal stamp when the DB mirror fails', async () => {
    const original = '# Rollback\n';
    const pagePath = writePage('topics/a-rollback', original);
    await engine.putPage('topics/a-rollback', { title: 'R', type: 'concept', compiled_truth: 'Body' }, { sourceId: 'tenant-a' });
    const id = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a-rollback', claim: 'Should not persist', holder: 'garry' });

    // Wrap the real engine: same transaction machinery, injected batch failure.
    const failing = Object.create(engine) as BrainEngine;
    failing.transaction = <T>(fn: (tx: BrainEngine) => Promise<T>) =>
      engine.transaction((tx) => {
        const failingTx = Object.create(tx) as BrainEngine;
        failingTx.addTakesBatch = async () => { throw new Error('injected addTakesBatch failure'); };
        return fn(failingTx);
      });

    await expect(acceptTakeProposal(failing, id, { brainDir })).rejects.toThrow('injected addTakesBatch failure');
    expect(readFileSync(pagePath, 'utf-8')).toBe(original);
    const [row] = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
      `SELECT status, promoted_row_num FROM take_proposals WHERE id = $1`, [id],
    );
    expect(row.status).toBe('pending');
    expect(row.promoted_row_num).toBeNull();
  });

  test('accept without a real content date leaves since_date unset', async () => {
    writePage('topics/b', '# B\n');
    const id = await insertProposal({ source_id: 'tenant-b', page_slug: 'topics/b', claim: 'No date here', holder: 'garry' });
    const result = await acceptTakeProposal(engine, id, { brainDir });
    expect(result.since_date).toBeUndefined();
  });
});

describe('rejectTakeProposal', () => {
  test('stamps pending → rejected; idempotent; refuses accepted; enforces scope', async () => {
    const id = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'Reject me', holder: 'garry' });

    await expect(rejectTakeProposal(engine, id, { sourceId: 'tenant-b' })).rejects.toThrow('outside your source scope');
    await expect(rejectTakeProposal(engine, id, { holdersAllowList: ['world'] })).rejects.toThrow('outside your holder allow-list');

    const first = await rejectTakeProposal(engine, id, { actedBy: 'reviewer', reason: 'not supported' });
    expect(first).toEqual({ ok: true, proposal_id: id, status: 'rejected', idempotent: false, reason: 'not supported' });
    const [row] = await engine.executeRaw<{ status: string; acted_by: string }>(
      `SELECT status, acted_by FROM take_proposals WHERE id = $1`, [id],
    );
    expect(row).toMatchObject({ status: 'rejected', acted_by: 'reviewer' });

    const second = await rejectTakeProposal(engine, id, { actedBy: 'reviewer' });
    expect(second.idempotent).toBe(true);

    writePage('topics/a', '# A\n');
    const acceptedId = await insertProposal({ source_id: 'tenant-a', page_slug: 'topics/a', claim: 'Accepted already', holder: 'garry' });
    await acceptTakeProposal(engine, acceptedId, { brainDir });
    await expect(rejectTakeProposal(engine, acceptedId)).rejects.toThrow('already accepted');
  });
});

describe('take proposal MCP operation schema', () => {
  test('exposes list/accept/reject through the shared operation registry with correct scopes', () => {
    const byName = Object.fromEntries(operations.map((op) => [op.name, op]));
    expect(byName.takes_propose_list?.scope).toBe('read');
    expect(byName.takes_propose_accept?.scope).toBe('write');
    expect(byName.takes_propose_reject?.scope).toBe('write');
    expect(byName.takes_propose_accept.params.proposal_id.required).toBe(true);
    expect(byName.takes_propose_reject.params.proposal_id.required).toBe(true);

    const defs = Object.fromEntries(buildToolDefs(operations).map((def) => [def.name, def]));
    expect(defs.takes_propose_accept.inputSchema.required).toEqual(['proposal_id']);
    expect(defs.takes_propose_reject.inputSchema.required).toEqual(['proposal_id']);
    expect(Object.keys(defs.takes_propose_list.inputSchema.properties)).toEqual(['limit', 'offset', 'status']);
  });
});
