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
 *   - acceptProposal: fence write via addTakeToPage + status='accepted' +
 *     promoted_row_num/acted_at/acted_by stamps
 *   - rejectProposal: status='rejected' + stamps, no markdown write
 *   - double-accept refuses with not_pending
 *   - source scope: an out-of-scope id reads as not_found
 *   - CLI dispatcher: `takes propose` no longer falls through to the slug path
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
import { runTakes } from '../src/commands/takes.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;

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
    writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\nabout ${slug}\n`, 'utf-8');
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
      { engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester' },
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
      acceptProposal({ engine, brainDir: repo, sourceId: 'default', actedBy: 'racer-a' }, id),
      acceptProposal({ engine, brainDir: repo, sourceId: 'default', actedBy: 'racer-b' }, id),
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
    await acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, id);
    try {
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TakeProposalError).code).toBe('not_pending');
    }
  });

  test('wave-g: stranded claim (accepted, no promoted take) surfaces the repair SQL on retry', async () => {
    // The crash-between-CAS-and-fence-write shape (#4480 residual): the row
    // is status='accepted' with promoted_row_num NULL — invisible in the
    // pending list, so the retry path must name it and print the repair.
    const id = await insertProposal({ slug: 'people/strand-example', claim: 'stranded claim', status: 'accepted' });
    try {
      await acceptProposal({ engine, brainDir: repo }, id);
      throw new Error('expected acceptProposal to throw for the stranded row');
    } catch (e) {
      expect(e).toBeInstanceOf(TakeProposalError);
      expect((e as TakeProposalError).code).toBe('not_pending');
      expect((e as Error).message).toContain('stranded');
      expect((e as Error).message).toContain(`SET status='pending'`);
      expect((e as Error).message).toContain(String(id));
    }
  });

  test('source scope: accepting an out-of-scope proposal reads as not_found', async () => {
    const id = await insertProposal({
      slug: 'companies/acme-example', claim: 'scope: other-source only', sourceId: 'other',
    });
    try {
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, id);
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
      await acceptProposal({ engine, brainDir: repo, sourceId: 'default' }, 99999999);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TakeProposalError).code).toBe('not_found');
    }
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
