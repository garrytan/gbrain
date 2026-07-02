import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { upsertTakeRow } from '../src/core/takes-fence.ts';
import {
  acceptTakeProposal,
  listTakeProposals,
  rejectTakeProposal,
  type TakeProposalRow,
} from '../src/core/take-proposals.ts';
import type { BrainEngine } from '../src/core/engine.ts';

type ProposalStatus = TakeProposalRow['status'];

interface ProposalRecord {
  id: number;
  source_id: string;
  page_slug: string;
  status: ProposalStatus;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain?: string | null;
  dedup_against_fence_rows?: unknown;
  model_id: string;
  proposed_at: Date;
  acted_at?: Date | null;
  acted_by?: string | null;
  promoted_row_num?: number | null;
  predicted_brier?: number | null;
  predicted_brier_bucket_n?: number | null;
}

interface PageRecord {
  id: number;
  source_id: string;
  slug: string;
  effective_date?: Date | null;
  effective_date_source?: string | null;
}

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeBrainDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-take-proposals-'));
  tmpRoots.push(root);
  return root;
}

function writePage(brainDir: string, slug: string, body = '# Page\n'): string {
  const path = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

class FakeProposalEngine {
  readonly kind = 'postgres' as const;
  readonly proposals = new Map<number, ProposalRecord>();
  readonly pages = new Map<string, PageRecord>();
  readonly config = new Map<string, string>();
  readonly addedBatches: unknown[][] = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  failAddTakes = false;
  activeTakes: Array<{ page_id: number; row_num: number; claim: string; active: boolean }> = [];

  constructor(brainDir: string) {
    this.config.set('sync.repo_path', brainDir);
  }

  addPage(page: PageRecord): void {
    this.pages.set(`${page.source_id}:${page.slug}`, page);
  }

  addProposal(record: Partial<ProposalRecord> & Pick<ProposalRecord, 'id' | 'page_slug' | 'claim_text'>): void {
    this.proposals.set(record.id, {
      source_id: 'default',
      status: 'pending',
      kind: 'take',
      holder: 'people/garry-tan',
      weight: 0.7,
      model_id: 'test-model',
      proposed_at: new Date('2026-06-25T00:00:00Z'),
      acted_at: null,
      acted_by: null,
      promoted_row_num: null,
      predicted_brier: null,
      predicted_brier_bucket_n: null,
      ...record,
    });
  }

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return fn(this as unknown as BrainEngine);
  }

  async addTakesBatch(rows: unknown[]): Promise<number> {
    if (this.failAddTakes) throw new Error('addTakesBatch failed');
    this.addedBatches.push(rows);
    for (const row of rows as Array<{ page_id: number; row_num: number; claim: string; active: boolean }>) {
      this.activeTakes.push(row);
    }
    return rows.length;
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params });
    const compact = sql.replace(/\s+/g, ' ').trim();

    if (compact.includes('FROM take_proposals tp LEFT JOIN pages p')) {
      const [status, sourceId, limitRaw, offsetRaw] = params;
      const limit = Number(limitRaw ?? 50);
      const offset = Number(offsetRaw ?? 0);
      const rows = [...this.proposals.values()]
        .filter((p) => status === null || p.status === status)
        .filter((p) => sourceId === null || p.source_id === sourceId)
        .sort((a, b) => b.proposed_at.getTime() - a.proposed_at.getTime())
        .slice(offset, offset + limit)
        .map((p) => ({
          ...p,
          ...this.pageFields(p.source_id, p.page_slug),
        }));
      return rows as T[];
    }

    if (compact.startsWith('SELECT page_slug, source_id, status, promoted_row_num FROM take_proposals WHERE id')) {
      const p = this.proposals.get(Number(params[0]));
      return (p ? [{
        page_slug: p.page_slug,
        source_id: p.source_id,
        status: p.status,
        promoted_row_num: p.promoted_row_num ?? null,
      }] : []) as T[];
    }

    if (compact.includes('FROM take_proposals tp JOIN pages p')) {
      const p = this.proposals.get(Number(params[0]));
      if (!p) return [] as T[];
      const page = this.pages.get(`${p.source_id}:${p.page_slug}`);
      if (!page) return [] as T[];
      return [{
        ...p,
        page_id: page.id,
        effective_date: page.effective_date ?? null,
        effective_date_source: page.effective_date_source ?? null,
      }] as T[];
    }

    if (compact.startsWith('SELECT pg_advisory_xact_lock')) {
      return [] as T[];
    }

    if (compact.includes('FROM takes WHERE page_id')) {
      const [pageId, claim] = params;
      const normalizedClaim = String(claim).trim().toLowerCase();
      const duplicate = this.activeTakes.find((t) =>
        t.page_id === Number(pageId) &&
        t.active === true &&
        t.claim.trim().toLowerCase() === normalizedClaim
      );
      return (duplicate ? [{ row_num: duplicate.row_num }] : []) as T[];
    }

    if (compact.startsWith("UPDATE take_proposals SET status = 'accepted'")) {
      const [id, actedBy, rowNum] = params;
      const p = this.proposals.get(Number(id));
      if (!p || p.status !== 'pending') return [] as T[];
      p.status = 'accepted';
      p.acted_at = new Date('2026-06-25T01:00:00Z');
      p.acted_by = String(actedBy);
      p.promoted_row_num = Number(rowNum);
      return [{ promoted_row_num: p.promoted_row_num }] as T[];
    }

    if (compact.startsWith('SELECT id, source_id, status, promoted_row_num FROM take_proposals WHERE id')) {
      const p = this.proposals.get(Number(params[0]));
      return (p ? [{
        id: p.id,
        source_id: p.source_id,
        status: p.status,
        promoted_row_num: p.promoted_row_num ?? null,
      }] : []) as T[];
    }

    if (compact.startsWith("UPDATE take_proposals SET status = 'rejected'")) {
      const [id, actedBy] = params;
      const p = this.proposals.get(Number(id));
      if (p) {
        p.status = 'rejected';
        p.acted_at = new Date('2026-06-25T01:00:00Z');
        p.acted_by = String(actedBy);
      }
      return [] as T[];
    }

    throw new Error(`unhandled SQL in fake engine: ${compact}`);
  }

  private pageFields(sourceId: string, slug: string) {
    const page = this.pages.get(`${sourceId}:${slug}`);
    return {
      effective_date: page?.effective_date ?? null,
      effective_date_source: page?.effective_date_source ?? null,
    };
  }
}

describe('take proposal review helpers', () => {
  test('lists pending proposals with page effective-date metadata', async () => {
    const brainDir = makeBrainDir();
    const engine = new FakeProposalEngine(brainDir);
    engine.addPage({ id: 10, source_id: 'default', slug: 'topics/a', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'frontmatter' });
    engine.addProposal({ id: 1, page_slug: 'topics/a', claim_text: 'A will happen' });

    const rows = await listTakeProposals(engine as unknown as BrainEngine, { status: 'pending', sourceId: 'default' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      status: 'pending',
      page_slug: 'topics/a',
      effective_date_source: 'frontmatter',
    });
    expect(rows[0].effective_date).toContain('2024-03-02');
  });

  test('accept writes markdown, mirrors DB, stamps proposal, and uses real effective date', async () => {
    const brainDir = makeBrainDir();
    const pagePath = writePage(brainDir, 'topics/a', '# A\n\nBody\n');
    const engine = new FakeProposalEngine(brainDir);
    engine.addPage({ id: 10, source_id: 'default', slug: 'topics/a', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'frontmatter' });
    engine.addProposal({ id: 1, page_slug: 'topics/a', claim_text: 'A will happen' });

    const result = await acceptTakeProposal(engine as unknown as BrainEngine, 1, { actedBy: 'test' });

    expect(result).toMatchObject({ ok: true, proposal_id: 1, page_slug: 'topics/a', status: 'accepted', idempotent: false, since_date: '2024-03-02' });
    expect(result.row_num).toBe(1);
    expect(engine.addedBatches).toHaveLength(1);
    expect((engine.addedBatches[0][0] as Record<string, unknown>)).toMatchObject({
      page_id: 10,
      row_num: 1,
      claim: 'A will happen',
      since_date: '2024-03-02',
      source: 'proposal:1',
      active: true,
    });
    expect(engine.proposals.get(1)).toMatchObject({ status: 'accepted', acted_by: 'test', promoted_row_num: 1 });
    const body = readFileSync(pagePath, 'utf-8');
    expect(body).toContain('A will happen');
    expect(body).toContain('2024-03-02');
    expect(body).toContain('proposal:1');
  });

  test('accept omits since_date when only fallback effective date is available', async () => {
    const brainDir = makeBrainDir();
    writePage(brainDir, 'topics/fallback', '# Fallback\n');
    const engine = new FakeProposalEngine(brainDir);
    engine.addPage({ id: 11, source_id: 'default', slug: 'topics/fallback', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'fallback' });
    engine.addProposal({ id: 2, page_slug: 'topics/fallback', claim_text: 'Fallback date should not be trusted' });

    const result = await acceptTakeProposal(engine as unknown as BrainEngine, 2, { actedBy: 'test' });

    expect(result.since_date).toBeUndefined();
    expect((engine.addedBatches[0][0] as Record<string, unknown>).since_date).toBeUndefined();
  });

  test('accept rolls back markdown if DB mirror fails', async () => {
    const brainDir = makeBrainDir();
    const original = '# Rollback\n';
    const pagePath = writePage(brainDir, 'topics/rollback', original);
    const engine = new FakeProposalEngine(brainDir);
    engine.failAddTakes = true;
    engine.addPage({ id: 12, source_id: 'default', slug: 'topics/rollback', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'frontmatter' });
    engine.addProposal({ id: 3, page_slug: 'topics/rollback', claim_text: 'Should not persist' });

    await expect(acceptTakeProposal(engine as unknown as BrainEngine, 3, { actedBy: 'test' })).rejects.toThrow('addTakesBatch failed');
    expect(readFileSync(pagePath, 'utf-8')).toBe(original);
    expect(engine.proposals.get(3)).toMatchObject({ status: 'pending', promoted_row_num: null });
  });

  test('accept rejects unsafe proposal slugs before filesystem access', async () => {
    const brainDir = makeBrainDir();
    const engine = new FakeProposalEngine(brainDir);
    engine.addProposal({ id: 7, page_slug: '../outside', claim_text: 'Should not escape brain dir' });

    await expect(acceptTakeProposal(engine as unknown as BrainEngine, 7, { actedBy: 'test' })).rejects.toThrow('Invalid slug');
    expect(engine.addedBatches).toHaveLength(0);
  });

  test('accept reuses an existing proposal markdown row on retry', async () => {
    const brainDir = makeBrainDir();
    const seededBody = upsertTakeRow('# Retry\n', {
      claim: 'Already written',
      kind: 'take',
      holder: 'people/garry-tan',
      weight: 0.7,
      source: 'proposal:8',
      active: true,
    }).body;
    const pagePath = writePage(brainDir, 'topics/retry', seededBody);
    const engine = new FakeProposalEngine(brainDir);
    engine.addPage({ id: 18, source_id: 'default', slug: 'topics/retry', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'frontmatter' });
    engine.addProposal({ id: 8, page_slug: 'topics/retry', claim_text: 'Already written' });

    const result = await acceptTakeProposal(engine as unknown as BrainEngine, 8, { actedBy: 'test' });

    expect(result).toMatchObject({ ok: true, proposal_id: 8, row_num: 1, status: 'accepted', idempotent: false });
    expect(engine.addedBatches).toHaveLength(1);
    expect((engine.addedBatches[0][0] as Record<string, unknown>).row_num).toBe(1);
    expect(readFileSync(pagePath, 'utf-8').match(/Already written/g)).toHaveLength(1);
  });

  test('accept is idempotent after a proposal has already been promoted', async () => {
    const brainDir = makeBrainDir();
    writePage(brainDir, 'topics/done', '# Done\n');
    const engine = new FakeProposalEngine(brainDir);
    engine.addPage({ id: 13, source_id: 'default', slug: 'topics/done', effective_date: new Date('2024-03-02T00:00:00Z'), effective_date_source: 'frontmatter' });
    engine.addProposal({ id: 4, page_slug: 'topics/done', claim_text: 'Already accepted', status: 'accepted', promoted_row_num: 9 });

    const result = await acceptTakeProposal(engine as unknown as BrainEngine, 4, { actedBy: 'test' });
    expect(result).toMatchObject({ ok: true, proposal_id: 4, row_num: 9, status: 'accepted', idempotent: true, since_date: '2024-03-02' });
    expect(engine.addedBatches).toHaveLength(0);
  });

  test('reject stamps pending proposals and is idempotent for rejected proposals', async () => {
    const brainDir = makeBrainDir();
    const engine = new FakeProposalEngine(brainDir);
    engine.addProposal({ id: 5, page_slug: 'topics/reject', claim_text: 'Reject me' });

    const first = await rejectTakeProposal(engine as unknown as BrainEngine, 5, { actedBy: 'reviewer', reason: 'not supported' });
    expect(first).toEqual({ ok: true, proposal_id: 5, status: 'rejected', idempotent: false, reason: 'not supported' });
    expect(engine.proposals.get(5)).toMatchObject({ status: 'rejected', acted_by: 'reviewer' });

    const second = await rejectTakeProposal(engine as unknown as BrainEngine, 5, { actedBy: 'reviewer', reason: 'not supported' });
    expect(second).toEqual({ ok: true, proposal_id: 5, status: 'rejected', idempotent: true, reason: 'not supported' });
  });

  test('reject refuses accepted proposals', async () => {
    const brainDir = makeBrainDir();
    const engine = new FakeProposalEngine(brainDir);
    engine.addProposal({ id: 6, page_slug: 'topics/accepted', claim_text: 'Accepted', status: 'accepted', promoted_row_num: 1 });

    await expect(rejectTakeProposal(engine as unknown as BrainEngine, 6, { actedBy: 'reviewer' })).rejects.toThrow('already accepted');
  });
});

describe('take proposal MCP operation schema', () => {
  test('exposes list/accept/reject through the shared operation registry with correct scopes', () => {
    const byName = Object.fromEntries(operations.map((op) => [op.name, op]));
    expect(byName.takes_propose_list?.scope).toBe('read');
    expect(byName.takes_propose_accept?.scope).toBe('write');
    expect(byName.takes_propose_reject?.scope).toBe('write');
    expect(byName.takes_propose_accept?.localOnly).toBe(true);
    expect(byName.takes_propose_accept.params.proposal_id.required).toBe(true);
    expect(byName.takes_propose_reject.params.proposal_id.required).toBe(true);

    const defs = Object.fromEntries(buildToolDefs(operations).map((def) => [def.name, def]));
    expect(defs.takes_propose_accept.inputSchema.required).toEqual(['proposal_id']);
    expect(defs.takes_propose_reject.inputSchema.required).toEqual(['proposal_id']);
    expect(Object.keys(defs.takes_propose_list.inputSchema.properties)).toEqual(['limit', 'offset', 'status']);
  });
});
