/**
 * System One S9 proposal review on an unmanaged PGLite brain with a real
 * source file: `gbrain decide proposals list|accept|reject|undo`.
 *
 * Protects: accept supersedes old with new as one unit (expired_at,
 * valid_until, superseded_by, the struck `## Facts` row in the file and the
 * DB body, the proposal status with before/after state); a failed fence
 * write leaves the proposal pending and the facts untouched, and a retry
 * succeeds; concurrent accepts apply once; an intervening withdrawal makes
 * the proposal stale; undo restores all fields and the fence row, refusing
 * when either fact or the row changed; bulk --all-from; a DB-only fact;
 * the extract_facts reconcile agrees with the accepted state; list shows both
 * facts' text locally (--json golden).
 * Serial: mutates GBRAIN_HOME and the process-global gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { insertProposal } from '../../src/core/ai/decide/proposals-store.ts';
import { applyProposalAction, rejectProposal } from '../../src/core/facts/proposal-supersede.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { runProposalsCommand } from '../../src/commands/decide/proposals.ts';
import { expectGolden, defineNormalizer } from '../helpers/golden.ts';

let engine: PGLiteEngine;
let brainDir: string;
const SLUG = 'people/alice-example';
const DIM = 1536;
let file: string;

function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = 1;
  v[1 + ([...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 500)] = 0.4;
  return v;
}

async function remember(fact: string, opts: { entity?: string; validUntil?: Date } = {}): Promise<number> {
  const r = await writeSingleFact(engine, 'default', { fact, provenance: 'test', entity: opts.entity ?? SLUG, kind: 'fact', validUntil: opts.validUntil ?? null });
  expect(r.status).toBe('inserted');
  return r.id;
}

async function fact(id: number) {
  const [r] = await engine.executeRaw<Record<string, unknown>>('SELECT id, expired_at, valid_until, superseded_by FROM facts WHERE id = $1', [id]);
  return { expired: r!.expired_at !== null, valid_until: r!.valid_until === null ? null : new Date(r!.valid_until as string).toISOString(), superseded_by: r!.superseded_by === null ? null : Number(r!.superseded_by) };
}
async function status(id: number) {
  const [r] = await engine.executeRaw<{ status: string; before_state: string | null; after_state: string | null }>('SELECT status, before_state, after_state FROM decide_proposals WHERE id = $1', [id]);
  return r!;
}
async function propose(newId: number, oldId: number, sweep = 'sweep-1', index = 0): Promise<number> {
  return (await insertProposal(engine, { source_id: 'default', sweep_id: sweep, pair_index: index, new_fact_id: newId, old_fact_id: oldId,
    direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'jev-1.13.0' }))!;
}
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  try { return { code: await runProposalsCommand(engine, args), out: out.join('\n') }; } finally { console.log = log; }
}
const fenceLine = (claim: string) => readFileSync(file, 'utf-8').split('\n').find((l) => l.includes(claim)) ?? '';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'conflict-proposals-'));
  file = join(brainDir, `${SLUG}.md`);
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(embed) })) as never);
  const content = `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n`;
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(file, content);
  await importFromContent(engine, SLUG, content, { noEmbed: true, sourceId: 'default' });
});

afterEach(() => { rmSync(brainDir, { recursive: true, force: true }); });

describe('accept', () => {
  test('supersedes old with new as one unit and records before/after state', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    const before = readFileSync(file, 'utf-8');
    expect(await applyProposalAction(engine, id, 'accept')).toEqual({ id, action: 'accept', status: 'accepted' });
    expect(await fact(old)).toMatchObject({ expired: true, superseded_by: fresh });
    expect(await fact(fresh)).toEqual({ expired: false, valid_until: null, superseded_by: null });
    expect(fenceLine('Alice leads research')).toMatch(/~~Alice leads research~~.*superseded by #2/);
    expect(readFileSync(file, 'utf-8')).not.toBe(before);
    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('~~Alice leads research~~');
    const s = await status(id);
    expect(s.status).toBe('accepted');
    const states = { before: JSON.parse(s.before_state!), after: JSON.parse(s.after_state!) };
    expect(states.before.old).toMatchObject({ expired_at: null, valid_until: null, superseded_by: null });
    expect(states.after.old).toMatchObject({ superseded_by: fresh });
    expect(states.after.old.expired_at).not.toBeNull();
    expect(states.before.fence).toMatchObject({ slug: SLUG, row_num: 1, file: true, row: { active: true } });
    expect(states.after.fence.row).toMatchObject({ active: false, supersededBy: 2 });
    expect(await engine.executeRaw('SELECT * FROM fact_withdrawals')).toEqual([]);
    // The fence reconcile agrees with the accepted state.
    await runExtractFacts(engine, { slugs: [SLUG] });
    expect(await fact(old)).toMatchObject({ expired: true, superseded_by: fresh });
    expect((await fact(fresh)).expired).toBe(false);
    // An accepted proposal is refused with its status.
    expect(await applyProposalAction(engine, id, 'accept')).toEqual({ id, action: 'accept', status: 'refused', reason: 'accepted' });
  });

  test('a fence-write failure fails the operation, leaves the proposal pending, and a retry succeeds', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    const before = readFileSync(file, 'utf-8');
    mkdirSync(`${file}.tmp`);
    await expect(applyProposalAction(engine, id, 'accept')).rejects.toThrow();
    expect((await status(id)).status).toBe('pending');
    expect(await fact(old)).toEqual({ expired: false, valid_until: null, superseded_by: null });
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).not.toContain('~~');
    rmSync(`${file}.tmp`, { recursive: true });
    expect((await applyProposalAction(engine, id, 'accept')).status).toBe('accepted');
    expect(await fact(old)).toMatchObject({ expired: true, superseded_by: fresh });
  });

  test('concurrent accepts apply once', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    const results = await Promise.all([applyProposalAction(engine, id, 'accept'), applyProposalAction(engine, id, 'accept')]);
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'refused']);
    expect(readFileSync(file, 'utf-8').match(/~~Alice leads research~~/g)).toHaveLength(1);
  });

  test('an intervening withdrawal makes the proposal stale and changes nothing', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    await forgetFactInFence(engine, fresh, { reason: 'wrong' });
    const fileBefore = readFileSync(file, 'utf-8');
    expect(await applyProposalAction(engine, id, 'accept')).toEqual({ id, action: 'accept', status: 'stale', reason: 'new_fact_inactive' });
    expect((await status(id)).status).toBe('stale');
    expect(await fact(old)).toEqual({ expired: false, valid_until: null, superseded_by: null });
    expect(readFileSync(file, 'utf-8')).toBe(fileBefore);
  });

  test('a DB-only fact (no fence row) is superseded in the database alone', async () => {
    const old = await remember('Bob plays chess', { entity: 'people/bob-example' });
    const fresh = await remember('Bob plays go', { entity: 'people/bob-example' });
    const id = await propose(fresh, old);
    expect((await applyProposalAction(engine, id, 'accept')).status).toBe('accepted');
    expect(JSON.parse((await status(id)).after_state!).fence).toBeNull();
    expect(await fact(old)).toMatchObject({ expired: true, superseded_by: fresh });
    expect((await applyProposalAction(engine, id, 'undo')).status).toBe('undone');
    expect(await fact(old)).toEqual({ expired: false, valid_until: null, superseded_by: null });
  });
});

describe('undo', () => {
  test('restores expired_at, valid_until, superseded_by and the struck fence line', async () => {
    const until = new Date(Date.UTC(2030, 0, 1));
    const old = await remember('Alice leads research', { validUntil: until });
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    const line = fenceLine('Alice leads research');
    const beforeFact = await fact(old);
    expect(beforeFact.valid_until).toBe(until.toISOString());
    await applyProposalAction(engine, id, 'accept');
    expect((await fact(old)).valid_until).not.toBe(until.toISOString());
    expect(await applyProposalAction(engine, id, 'undo')).toEqual({ id, action: 'undo', status: 'undone' });
    expect(await fact(old)).toEqual(beforeFact);
    expect(fenceLine('Alice leads research')).toBe(line);
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).not.toContain('~~');
    expect((await status(id)).status).toBe('undone');
    expect((await applyProposalAction(engine, id, 'undo')).status).toBe('refused');
    await runExtractFacts(engine, { slugs: [SLUG] });
    expect(await fact(old)).toMatchObject({ expired: false, superseded_by: null });
  });

  test('refuses when either fact or the fence row changed since accept', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    await applyProposalAction(engine, id, 'accept');
    await engine.executeRaw(`UPDATE facts SET valid_until = '2031-01-01' WHERE id = $1`, [fresh]);
    expect(await applyProposalAction(engine, id, 'undo')).toEqual({ id, action: 'undo', status: 'refused', reason: 'new_fact_changed' });
    await engine.executeRaw('UPDATE facts SET valid_until = NULL WHERE id = $1', [fresh]);
    writeFileSync(file, readFileSync(file, 'utf-8').replace('superseded by #2', 'superseded by #2 | edited by hand'));
    expect(await applyProposalAction(engine, id, 'undo')).toEqual({ id, action: 'undo', status: 'refused', reason: 'fence_changed' });
    expect((await status(id)).status).toBe('accepted');
    expect((await fact(old)).expired).toBe(true);
  });
});

describe('reject and bulk', () => {
  test('reject marks it rejected; accept afterwards is refused', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    const id = await propose(fresh, old);
    expect(await rejectProposal(engine, id)).toEqual({ id, action: 'reject', status: 'rejected' });
    expect(await applyProposalAction(engine, id, 'accept')).toMatchObject({ status: 'refused', reason: 'rejected' });
    expect((await fact(old)).expired).toBe(false);
  });

  test('accept --all-from and reject --all-from apply to every pending proposal of a sweep', async () => {
    const a = await remember('Alice leads research');
    const b = await remember('Alice leads the lab');
    const fresh = await remember('Alice leads design');
    const c = await remember('Alice likes tea');
    const p1 = await propose(fresh, a, 'sweep-a', 0);
    const p2 = await propose(fresh, b, 'sweep-a', 1);
    const p3 = await propose(fresh, c, 'sweep-b', 0);
    const accepted = await cli(['accept', '--all-from', 'sweep-a', '--json']);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.out).results.map((r: { id: number; status: string }) => [r.id, r.status])).toEqual([[p1, 'accepted'], [p2, 'accepted']]);
    expect((await fact(a)).expired && (await fact(b)).expired).toBe(true);
    const rejected = await cli(['reject', '--all-from', 'sweep-b']);
    expect(rejected.out).toContain(`proposal ${p3}: rejected`);
    expect((await fact(c)).expired).toBe(false);
  });
});

describe('list', () => {
  test('shows both facts\' text locally; --json golden', async () => {
    const old = await remember('Alice leads research');
    const fresh = await remember('Alice leads design');
    await propose(fresh, old);
    const text = await cli(['list']);
    expect(text.out).toContain('new #2: Alice leads design');
    expect(text.out).toContain('old #1: Alice leads research');
    expect(text.out).toContain('gbrain decide proposals undo <id>');
    const json = await cli(['list', '--status', 'all', '--json']);
    expectGolden('decide/proposals-list-json', JSON.parse(json.out), defineNormalizer('decide-proposals-v1', (v: any) => ({
      ...v, proposals: v.proposals.map((p: any) => ({ ...p, created_at: '<ts>' })),
    })));
    expect((await cli(['list', '--status', 'bogus'])).code).toBe(1);
  });
});
