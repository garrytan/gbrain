/**
 * #2411 — take_proposals drain surface.
 *
 * The propose_takes cycle phase writes proposals to `take_proposals`, and the
 * D17 posture says explicit operator accept is the ONLY queue→canonical path.
 * Before this fix nothing implemented that path: `gbrain takes propose` fell
 * through the dispatcher to the page-slug branch and printed
 * "No takes on propose." (exit 0), so proposals accumulated forever and
 * nothing ever wrote status='accepted'.
 *
 * Covers, against a real PGLite engine + temp markdown repo:
 *   - listPendingProposals: pending-only (tombstones/acted rows excluded),
 *     source-scoped
 *   - acceptProposal: promotes via a coordinated takes_add mutation +
 *     status='accepted' + promoted_row_num/acted_at/acted_by stamps
 *   - rejectProposal: status='rejected' + stamps, no markdown write
 *   - double-accept refuses with not_pending
 *   - source scope: an out-of-scope id reads as not_found
 *   - CLI dispatcher: `takes propose` no longer falls through to the slug path
 *   - managed root: accept succeeds where the legacy uncoordinated write
 *     (addTakeToPage) is refused — the report-lane accept-before-correct
 *     failure this module exists to fix
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  listPendingProposals,
  acceptProposal,
  rejectProposal,
  coerceProposalKind,
  TakeProposalError,
} from '../src/core/take-proposals.ts';
import { addTakeToPage } from '../src/core/takes-write.ts';
import { runTakes } from '../src/commands/takes.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
let repo: string;
// acceptProposal now promotes via a coordinated takes_add mutation
// (submitPageMutation), which requires a GBrainConfig — a minimal
// { engine: 'pglite' } is the same fallback takes-mutation.ts's CLI dispatch
// uses when loadConfig() finds no config file.
const testConfig = { engine: 'pglite' as const };

async function insertProposal(opts: {
  slug: string;
  claim: string;
  sourceId?: string;
  kind?: string;
  holder?: string;
  weight?: number;
  status?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, model_id, status)
     VALUES ($1, $2, md5($6), 'test-v1', 'run-test', $6, $3, $4, $5, NULL, 'test-model', $7)
     RETURNING id`,
    [
      opts.sourceId ?? 'default',
      opts.slug,
      opts.kind ?? 'bet',
      opts.holder ?? 'world',
      opts.weight ?? 0.7,
      opts.claim,
      opts.status ?? 'pending',
    ],
  );
  return rows[0].id;
}

async function proposalRow(id: number) {
  const rows = await engine.executeRaw<{
    status: string; promoted_row_num: number | null; acted_by: string | null; acted_at: string | null;
  }>(`SELECT status, promoted_row_num, acted_by, acted_at FROM take_proposals WHERE id = $1`, [id]);
  return rows[0];
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-take-proposals-'));
  await engine.setConfig('sync.repo_path', repo);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`,
    [],
  );
  for (const slug of ['companies/acme-example', 'companies/widget-co']) {
    await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `about ${slug}` });
    mkdirSync(join(repo, 'companies'), { recursive: true });
    // Coordinated writes (acceptProposal now goes through one) compare the
    // on-disk file against a canonical re-render of the DB snapshot before
    // touching it, so the fixture file must match what putPage recorded —
    // an arbitrary hand-written body reads as an "uncoordinated local edit".
    const snapshot = (await engine.readPageSnapshot(slug))!;
    writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags), 'utf-8');
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('listPendingProposals', () => {
  test('lists pending rows only, excluding acted rows and other sources', async () => {
    const pendingId = await insertProposal({ slug: 'companies/acme-example', claim: 'list: pending claim' });
    const rejectedId = await insertProposal({
      slug: 'companies/acme-example', claim: 'list: already rejected', status: 'rejected',
    });
    const otherSourceId = await insertProposal({
      slug: 'companies/acme-example', claim: 'list: other-source claim', sourceId: 'other',
    });

    const rows = await listPendingProposals(engine, { sourceId: 'default', limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(rejectedId);
    expect(ids).not.toContain(otherSourceId);
    for (const r of rows) expect(r.status).toBe('pending');
  });
});

describe('acceptProposal', () => {
  test('promotes into the fence via addTakeToPage and stamps accepted + promoted_row_num', async () => {
    const id = await insertProposal({
      slug: 'companies/acme-example', claim: 'Acme ships the widget by Q3', kind: 'bet', weight: 0.8,
    });
    const { rowNum, proposal } = await acceptProposal(
      { engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester', config: testConfig },
      id,
    );
    expect(proposal.page_slug).toBe('companies/acme-example');
    expect(rowNum).toBeGreaterThan(0);

    // Markdown-canonical: the fence on disk holds the promoted claim.
    const fence = parseTakesFence(readFileSync(join(repo, 'companies/acme-example.md'), 'utf-8'));
    const promoted = fence.takes.find((t) => t.claim === 'Acme ships the widget by Q3');
    expect(promoted).toBeDefined();
    expect(promoted!.rowNum).toBe(rowNum);

    // DB mirror carries the row too.
    const takes = await engine.listTakes({ page_slug: 'companies/acme-example', active: true });
    expect(takes.some((t) => t.claim === 'Acme ships the widget by Q3' && t.row_num === rowNum)).toBe(true);

    // Queue row is stamped.
    const row = await proposalRow(id);
    expect(row.status).toBe('accepted');
    expect(row.promoted_row_num).toBe(rowNum);
    expect(row.acted_by).toBe('people/tester');
    expect(row.acted_at).not.toBeNull();
  });

  test('#4480 TOCTOU: concurrent accepts — exactly one wins, one fence write, loser gets not_pending', async () => {
    const id = await insertProposal({
      slug: 'companies/acme-example', claim: 'Acme signs exactly one concurrent deal', kind: 'take',
    });
    // Pre-fix (fence write first, status flip after, rowcount ignored) BOTH
    // callers passed the pending check, BOTH appended the take to the .md,
    // and BOTH reported success. Post-fix the claim CAS runs first, so only
    // the winner touches the fence.
    const results = await Promise.allSettled([
      acceptProposal({ engine, brainDir: repo, sourceId: 'default', actedBy: 'racer-a', config: testConfig }, id),
      acceptProposal({ engine, brainDir: repo, sourceId: 'default', actedBy: 'racer-b', config: testConfig }, id),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    const lossReason = (losses[0] as PromiseRejectedResult).reason;
    expect(lossReason).toBeInstanceOf(TakeProposalError);
    expect((lossReason as TakeProposalError).code).toBe('not_pending');

    // Exactly ONE copy of the claim in the markdown fence.
    const fence = parseTakesFence(readFileSync(join(repo, 'companies/acme-example.md'), 'utf-8'));
    const copies = fence.takes.filter((t) => t.claim === 'Acme signs exactly one concurrent deal');
    expect(copies.length).toBe(1);

    // Row is stamped once, with the winner's identity + promoted_row_num.
    const row = await proposalRow(id);
    expect(row.status).toBe('accepted');
    expect(row.promoted_row_num).not.toBeNull();
  });

  test('double-accept refuses with not_pending', async () => {
    const id = await insertProposal({ slug: 'companies/widget-co', claim: 'Widget-co raises fund-a next year' });
    await acceptProposal({ engine, brainDir: repo, sourceId: 'default', config: testConfig }, id);
    try {
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default', config: testConfig }, id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TakeProposalError).code).toBe('not_pending');
    }
  });

  test('wave-g: a stranded claim (accepted, no promoted take) is resumed by the retry, and a failed resume leaves it actionable', async () => {
    // The crash-between-CAS-and-fence-write shape (#4480 residual): the row
    // is status='accepted' with promoted_row_num NULL — invisible in the
    // pending list. Re-running accept resumes the claim's own write request
    // (never a second take); here that write fails (no such page), so the
    // claim is released and the row is pending again instead of stranded.
    const id = await insertProposal({ slug: 'people/strand-example', claim: 'stranded claim', status: 'accepted' });
    await expect(acceptProposal({ engine, brainDir: repo, config: testConfig }, id)).rejects.toBeDefined();
    expect((await proposalRow(id)).status).toBe('pending');
  });

  test('a claim taken moments ago by another accept is not resumed while that accept may still be submitting', async () => {
    const id = await insertProposal({ slug: 'people/strand-example', claim: 'fresh claim', status: 'accepted' });
    await engine.executeRaw('UPDATE take_proposals SET acted_at = now() WHERE id = $1', [id]);
    await expect(acceptProposal({ engine, brainDir: repo, config: testConfig }, id)).rejects.toThrow('may still be submitting');
    expect((await proposalRow(id)).status).toBe('accepted');
  });

  test('reject refuses a claimed accept and names the resume command', async () => {
    const id = await insertProposal({ slug: 'people/strand-example', claim: 'claimed accept', status: 'accepted' });
    await expect(rejectProposal({ engine }, id)).rejects.toMatchObject({ code: 'not_pending' });
    await expect(rejectProposal({ engine }, id)).rejects.toThrow(`gbrain takes propose --accept ${id}`);
  });

  test('source scope: accepting an out-of-scope proposal reads as not_found', async () => {
    const id = await insertProposal({
      slug: 'companies/acme-example', claim: 'scope: other-source only', sourceId: 'other',
    });
    try {
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default', config: testConfig }, id);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TakeProposalError);
      expect((err as TakeProposalError).code).toBe('not_found');
    }
    // Row untouched.
    expect((await proposalRow(id)).status).toBe('pending');
  });

  test('unknown id → not_found', async () => {
    try {
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default', config: testConfig }, 99999999);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TakeProposalError).code).toBe('not_found');
    }
  });

  test('managed root: accept succeeds where the legacy uncoordinated write is refused', async () => {
    // Reproduces the reported production failure: PaaS Brain's report-lane
    // hit "This file belongs to a managed canonical worktree." — the exact
    // message assertManagedFilesystemWrite throws — every time it tried to
    // accept a pending take proposal against a managed brain (Postgres/
    // Supabase with a coordinator-owned worktree). A `.gbrain-managed`
    // marker file reproduces that guard directly (hasManagedRootMarker),
    // without needing the full persistence_brain/Supabase lifecycle.
    const managedRepo = mkdtempSync(join(tmpdir(), 'gbrain-managed-root-'));
    mkdirSync(join(managedRepo, 'companies'), { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('managed-example', 'Managed', $1)
         ON CONFLICT (id) DO UPDATE SET local_path = $1`,
      [managedRepo],
    );
    const slug = 'companies/managed-example';
    await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `about ${slug}` }, { sourceId: 'managed-example' });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'managed-example' }))!;
    writeFileSync(join(managedRepo, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags), 'utf-8');
    // The marker that makes assertManagedFilesystemWrite refuse any writer
    // outside the persistence coordinator's own withFilesystemPublication.
    writeFileSync(join(managedRepo, '.gbrain-managed'), JSON.stringify({ version: 1, managed: true, brain_id: 'test-managed-root' }));

    const id = await insertProposal({ slug, claim: 'Managed root accept works', sourceId: 'managed-example' });

    // The OLD write path (addTakeToPage, called directly and uncoordinated)
    // is refused outright — this is the production symptom.
    await expect(addTakeToPage(
      { engine, slug, brainDir: managedRepo, sourceId: 'managed-example' },
      { claim: 'legacy direct write', kind: 'take', holder: 'world' },
    )).rejects.toMatchObject({ code: 'writer_coordinator_required' });

    // acceptProposal now promotes through the coordinated pipeline, whose
    // own publish step runs inside withFilesystemPublication — it must
    // succeed even though the target is a managed root.
    const { rowNum } = await acceptProposal(
      { engine, brainDir: managedRepo, sourceId: 'managed-example', config: testConfig }, id,
    );
    expect(rowNum).toBeGreaterThan(0);
    const fence = parseTakesFence(readFileSync(join(managedRepo, `${slug}.md`), 'utf-8'));
    expect(fence.takes.some((t) => t.claim === 'Managed root accept works')).toBe(true);
  });
});

describe('rejectProposal', () => {
  test('stamps rejected + acted_by without touching the fence', async () => {
    const before = readFileSync(join(repo, 'companies/widget-co.md'), 'utf-8');
    const id = await insertProposal({ slug: 'companies/widget-co', claim: 'reject: never promoted' });
    const proposal = await rejectProposal({ engine, sourceId: 'default', actedBy: 'people/tester' }, id);
    expect(proposal.claim_text).toBe('reject: never promoted');
    const row = await proposalRow(id);
    expect(row.status).toBe('rejected');
    expect(row.acted_by).toBe('people/tester');
    // No markdown write happened (reject is DB-only).
    const after = readFileSync(join(repo, 'companies/widget-co.md'), 'utf-8');
    expect(after.includes('reject: never promoted')).toBe(false);
    expect(after.length >= before.length).toBe(true);
  });

  test('rejecting an acted row refuses with not_pending', async () => {
    const id = await insertProposal({
      slug: 'companies/widget-co', claim: 'reject: already accepted', status: 'accepted',
    });
    try {
      await rejectProposal({ engine, sourceId: 'default' }, id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TakeProposalError).code).toBe('not_pending');
    }
  });

  test('#4480 TOCTOU: concurrent rejects — exactly one wins the CAS', async () => {
    const id = await insertProposal({ slug: 'companies/widget-co', claim: 'reject: raced claim' });
    const results = await Promise.allSettled([
      rejectProposal({ engine, sourceId: 'default', actedBy: 'racer-a' }, id),
      rejectProposal({ engine, sourceId: 'default', actedBy: 'racer-b' }, id),
    ]);
    // Pre-fix both resolved (the loser's no-op UPDATE went unchecked).
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const loss = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loss.reason as TakeProposalError).code).toBe('not_pending');
    const row = await proposalRow(id);
    expect(row.status).toBe('rejected');
  });
});

describe('coerceProposalKind', () => {
  test('canonical kinds pass through; prediction→bet; unknown→take', () => {
    expect(coerceProposalKind('bet')).toBe('bet');
    expect(coerceProposalKind('fact')).toBe('fact');
    expect(coerceProposalKind('hunch')).toBe('hunch');
    expect(coerceProposalKind('take')).toBe('take');
    expect(coerceProposalKind('prediction')).toBe('bet');
    expect(coerceProposalKind('garbage')).toBe('take');
  });
});

describe('CLI dispatcher (#2411 no-fallthrough)', () => {
  test('`takes propose` lists the queue instead of slug-ifying "propose"', async () => {
    const id = await insertProposal({ slug: 'companies/acme-example', claim: 'cli: pending list claim' });
    const out = await captureStdout(() => runTakes(engine, ['propose']));
    expect(out).not.toContain('No takes on propose.');
    expect(out).toContain('cli: pending list claim');
    expect(out).toContain(`#${id}`);
  });

  test('`takes propose --json` returns rows', async () => {
    const out = await captureStdout(() => runTakes(engine, ['propose', '--json', '--limit', '100']));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((r: { claim_text: string }) => r.claim_text === 'cli: pending list claim')).toBe(true);
  });

  test('`takes propose --json` normalizes Postgres BigInt proposal rows (#4634)', async () => {
    const id = await insertProposal({
      slug: 'companies/acme-example',
      claim: 'cli: bigint proposal row',
    });
    const originalExecuteRaw = engine.executeRaw;
    // `this` forwarded via `apply`, not hardcoded to `engine` — see the
    // matching comment on the mock below (munged loadProposal row test) for
    // why hardcoding it deadlocks any mutation that runs inside a real
    // engine.transaction().
    engine.executeRaw = (async function (this: unknown, query: string, params?: unknown[]) {
      const rows = await originalExecuteRaw.apply(this, [query, params]);
      if (!query.includes('FROM take_proposals') || !query.includes("status = 'pending'")) {
        return rows;
      }
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          ...record,
          id: BigInt(Number(record.id)),
          weight: String(record.weight),
          promoted_row_num: record.promoted_row_num == null
            ? null
            : BigInt(Number(record.promoted_row_num)),
        };
      });
    }) as typeof engine.executeRaw;

    try {
      const out = await captureStdout(() =>
        runTakes(engine, ['propose', '--json', '--limit', '100'])
      );
      const parsed = JSON.parse(out) as Array<{ id: number; claim_text: string }>;
      const row = parsed.find((candidate) => candidate.claim_text === 'cli: bigint proposal row');
      expect(row?.id).toBe(id);
      expect(typeof row?.id).toBe('number');
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }
  });

  test('accept path normalizes a munged old-shape loadProposal row (BigInt/string id, string weight)', async () => {
    // loadProposal's SELECT (`FROM take_proposals WHERE id = $1`) is a
    // DIFFERENT query from listPendingProposals' — a Postgres driver
    // returning BigInt ids / NUMERIC-as-string weights on THAT read must be
    // normalized before the row reaches the fence write and the caller.
    const id = await insertProposal({
      slug: 'companies/acme-example',
      claim: 'accept: munged driver row',
      weight: 0.65,
    });
    const originalExecuteRaw = engine.executeRaw;
    engine.executeRaw = (async function (this: unknown, query: string, params?: unknown[]) {
      // `this` must be forwarded, not hardcoded to `engine`: acceptProposal now
      // promotes via a coordinated mutation that runs inside engine.transaction(),
      // whose callback receives a transaction-scoped engine clone (`tx`) with its
      // own `.db` handle. `tx.executeRaw` resolves to THIS mock via the prototype
      // chain, called as `tx.executeRaw(...)` (`this` = `tx`) — forcing `this` back
      // to the outer `engine` here would run the query against the non-transactional
      // connection while the real transaction still holds it, deadlocking forever.
      const rows = await originalExecuteRaw.apply(this, [query, params]);
      // Match ONLY the loadProposal SELECT — the id-keyed single-row read.
      if (!query.includes('FROM take_proposals') || !query.includes('WHERE id = $1')) {
        return rows;
      }
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          ...record,
          id: BigInt(Number(record.id)),
          weight: String(record.weight),
          promoted_row_num: record.promoted_row_num == null
            ? null
            : BigInt(Number(record.promoted_row_num)),
        };
      });
    }) as typeof engine.executeRaw;

    try {
      const { proposal, rowNum } = await acceptProposal(
        { engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester', config: testConfig },
        id,
      );
      // The public numeric row contract: normalized id AND weight.
      expect(proposal.id).toBe(id);
      expect(typeof proposal.id).toBe('number');
      expect(typeof proposal.weight).toBe('number');
      expect(proposal.weight).toBeCloseTo(0.65, 6);
      expect(rowNum).toBeGreaterThan(0);
      // The promoted take carries the numeric weight through to the DB mirror.
      const takes = await engine.listTakes({ page_slug: 'companies/acme-example', active: true });
      const promoted = takes.find((t) => t.claim === 'accept: munged driver row');
      expect(promoted).toBeDefined();
      expect(Number(promoted!.weight)).toBeCloseTo(0.65, 6);
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }
  });

  test('`takes propose --accept <id>` promotes and reports the fence row', async () => {
    const id = await insertProposal({ slug: 'companies/acme-example', claim: 'cli: accept me' });
    const out = await captureStdout(() => runTakes(engine, ['propose', '--accept', String(id)]));
    expect(out).toContain(`Accepted proposal #${id}`);
    expect((await proposalRow(id)).status).toBe('accepted');
  });

  test('`takes propose --reject <id>` rejects', async () => {
    const id = await insertProposal({ slug: 'companies/acme-example', claim: 'cli: reject me' });
    const out = await captureStdout(() => runTakes(engine, ['propose', '--reject', String(id)]));
    expect(out).toContain(`Rejected proposal #${id}`);
    expect((await proposalRow(id)).status).toBe('rejected');
  });
});
