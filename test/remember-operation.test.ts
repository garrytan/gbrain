import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

function rememberOp() {
  const op = operations.find((operation) => operation.name === 'remember');
  if (!op) throw new Error('remember operation is missing');
  return op;
}

async function withEngine(prefix: string, fn: (engine: SQLiteEngine) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-remember-${prefix}-`));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(engine: SQLiteEngine) {
  return { engine, config: {} as never, logger: console, dryRun: false };
}

test('remember stores a verified fact into an existing page in one call', async () => {
  await withEngine('stored', async (engine) => {
    await engine.putPage('concepts/acme', {
      type: 'concept',
      title: 'Acme',
      compiled_truth: 'Acme is tracked in MBrain. [Source: User, direct message, 2026-07-01 09:00 KST]',
      timeline: '- **2026-07-01** | Initial Acme note. [Source: User, direct message, 2026-07-01 09:00 KST]',
    });

    const receipt = await rememberOp().handler(ctxFor(engine), {
      content: 'Acme raised a series A round.',
      source_refs: ['User, direct message, 2026-07-06 13:00 KST'],
      evidence_kind: 'direct_user_statement',
      target_slug: 'concepts/acme',
      verification_status: 'verified',
      verification_method: 'user_confirmation',
      verification_evidence: 'User stated the series A directly in chat.',
    }) as {
      status: string;
      candidate_id: string | null;
      page_slug: string | null;
      canonical_handoff_id: string | null;
    };

    expect(receipt.status).toBe('stored');
    expect(receipt.page_slug).toBe('concepts/acme');
    expect(receipt.candidate_id).toBeTruthy();
    expect(receipt.canonical_handoff_id).toBeTruthy();

    const page = await engine.getPage('concepts/acme');
    expect(page?.compiled_truth).toContain('Acme raised a series A round.');
    expect(page?.compiled_truth).toContain('[Source: User, direct message, 2026-07-06 13:00 KST]');

    const candidate = await engine.getMemoryCandidateEntry(receipt.candidate_id as string);
    expect(candidate?.status).toBe('promoted');

    const handoffs = await engine.listCanonicalHandoffEntries({ candidate_id: receipt.candidate_id as string });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.completed_at).not.toBeNull();

    const session = await engine.getMemorySession(`remember:${receipt.candidate_id}`);
    expect(session?.status).toBe('closed');
  });
});

test('remember without verification stops honestly at needs_review', async () => {
  await withEngine('unverified', async (engine) => {
    const receipt = await rememberOp().handler(ctxFor(engine), {
      content: 'Acme may be hiring a CFO soon.',
      source_refs: ['Meeting notes, pipeline sync, 2026-07-06 14:00 KST'],
      evidence_kind: 'agent_inferred',
      target_slug: 'concepts/acme',
    }) as {
      status: string;
      candidate_id: string | null;
      stop_reason: string | null;
    };

    expect(receipt.status).toBe('needs_review');
    expect(receipt.candidate_id).toBeTruthy();
    expect(receipt.stop_reason).toBe('verification_required');

    const candidate = await engine.getMemoryCandidateEntry(receipt.candidate_id as string);
    expect(candidate?.status).not.toBe('promoted');
    expect(await engine.getPage('concepts/acme')).toBeNull();
  });
});

test('remember stops on likely duplicates against a different target instead of double-writing', async () => {
  await withEngine('duplicate', async (engine) => {
    await engine.createMemoryCandidateEntry({
      id: 'existing-open-duplicate',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Acme uses Postgres 16 with pgvector in production.',
      source_refs: ['User, direct message, 2026-07-06 15:00 KST'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.8,
      importance_score: 0.7,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'candidate',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/acme',
      reviewed_at: null,
      review_reason: null,
    });

    const second = await rememberOp().handler(ctxFor(engine), {
      content: 'Acme uses Postgres 16 with pgvector in production.',
      source_refs: ['User, direct message, 2026-07-06 15:05 KST'],
      evidence_kind: 'direct_user_statement',
      target_slug: 'concepts/acme-competitors',
      verification_status: 'verified',
      verification_method: 'user_confirmation',
      verification_evidence: 'User repeated the production stack.',
    }) as {
      status: string;
      candidate_id: string | null;
      stop_reason: string | null;
      duplicate_review?: { matches?: unknown[] };
    };

    expect(second.status).toBe('needs_review');
    expect(second.stop_reason).toBe('duplicate_content');
    expect(second.candidate_id).toBeNull();
    expect(second.duplicate_review?.matches?.length ?? 0).toBeGreaterThan(0);
    expect(await engine.getPage('concepts/acme-competitors')).toBeNull();
  });
});

test('remember without a canonical target promotes nothing silently and asks for a target', async () => {
  await withEngine('no-target', async (engine) => {
    const receipt = await rememberOp().handler(ctxFor(engine), {
      content: 'MBrain governance requires explicit canonical targets for durable facts.',
      source_refs: ['User, direct message, 2026-07-06 16:00 KST'],
      evidence_kind: 'direct_user_statement',
      verification_status: 'verified',
      verification_method: 'user_confirmation',
      verification_evidence: 'User stated the governance requirement directly.',
    }) as {
      status: string;
      candidate_id: string | null;
      page_slug: string | null;
      next_actions?: string[];
    };

    expect(receipt.status).toBe('needs_review');
    expect(receipt.candidate_id).toBeTruthy();
    expect(receipt.page_slug).toBeNull();
    expect((receipt.next_actions ?? []).join(' ')).toContain('target');
  });
});
