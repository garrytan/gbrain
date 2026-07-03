import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryCandidateCreateStatus, MemoryCandidateEntryInput } from '../src/core/types.ts';
import {
  advanceMemoryCandidateStatus,
  MemoryInboxServiceError,
  preflightPromoteMemoryCandidate,
  verifyMemoryCandidateEntry,
} from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-memory-inbox-verification-${label}-`));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedCandidate(
  engine: SQLiteEngine,
  id: string,
  status: MemoryCandidateCreateStatus = 'captured',
  overrides: Partial<MemoryCandidateEntryInput> = {},
) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'The ingest worker retries failed chunks twice before flagging.',
    source_refs: ['Agent session transcript, 2026-06-12 10:00 AM KST'],
    generated_by: 'agent',
    extraction_kind: 'inferred',
    confidence_score: 0.6,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status,
    target_object_type: 'curated_note',
    target_object_id: 'systems/ingest-worker',
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  });
}

test('verify service records a verified checked fact on an active candidate', async () => {
  await withEngine('verified', async (engine) => {
    await seedCandidate(engine, 'candidate-verify-1', 'captured');

    const verified = await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-verify-1',
      verification_status: 'verified',
      verification_method: 'file_inspection',
      verification_evidence: 'Read src/worker/ingest.ts:120-141; retry loop caps at 2 attempts.',
      verification_source_refs: ['src/worker/ingest.ts:120-141, inspected 2026-06-12'],
    });

    expect(verified.verification_status).toBe('verified');
    expect(verified.verification_method).toBe('file_inspection');
    expect(verified.verification_evidence).toContain('retry loop');
    expect(verified.verification_source_refs).toEqual(['src/worker/ingest.ts:120-141, inspected 2026-06-12']);
    expect(verified.verified_at).not.toBeNull();
    expect(verified.status).toBe('captured');
  });
});

test('verify service records a refuted claim without changing lifecycle status', async () => {
  await withEngine('refuted', async (engine) => {
    await seedCandidate(engine, 'candidate-refute-1', 'candidate');

    const refuted = await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-refute-1',
      verification_status: 'refuted',
      verification_method: 'command_execution',
      verification_evidence: 'Ran the worker locally; failed chunks are retried three times, not twice.',
    });

    expect(refuted.verification_status).toBe('refuted');
    expect(refuted.status).toBe('candidate');
  });
});

test('verify service rejects blank evidence', async () => {
  await withEngine('blank-evidence', async (engine) => {
    await seedCandidate(engine, 'candidate-verify-blank', 'captured');

    await expect(verifyMemoryCandidateEntry(engine, {
      id: 'candidate-verify-blank',
      verification_status: 'verified',
      verification_method: 'db_query',
      verification_evidence: '   ',
    })).rejects.toThrow(MemoryInboxServiceError);
  });
});

test('verify service rejects terminal candidates', async () => {
  await withEngine('terminal', async (engine) => {
    await seedCandidate(engine, 'candidate-verify-terminal', 'staged_for_review');
    await engine.updateMemoryCandidateEntryStatus('candidate-verify-terminal', {
      status: 'rejected',
      review_reason: 'Rejected before verification attempt.',
    });

    await expect(verifyMemoryCandidateEntry(engine, {
      id: 'candidate-verify-terminal',
      verification_status: 'verified',
      verification_method: 'user_confirmation',
      verification_evidence: 'User confirmed in chat.',
    })).rejects.toThrow(/rejected/);
  });
});

test('verify service surfaces missing candidates', async () => {
  await withEngine('missing', async (engine) => {
    await expect(verifyMemoryCandidateEntry(engine, {
      id: 'candidate-does-not-exist',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'n/a',
    })).rejects.toThrow(/not found/);
  });
});

test('promotion preflight denies refuted candidates', async () => {
  await withEngine('preflight-refuted', async (engine) => {
    await seedCandidate(engine, 'candidate-preflight-refuted', 'staged_for_review');
    await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-preflight-refuted',
      verification_status: 'refuted',
      verification_method: 'db_query',
      verification_evidence: 'Canonical table contradicts the proposed fact.',
    });

    const preflight = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-preflight-refuted' });
    expect(preflight.decision).toBe('deny');
    expect(preflight.reasons).toContain('candidate_refuted');
  });
});

test('promotion preflight clears procedure revalidation once verified', async () => {
  await withEngine('preflight-procedure', async (engine) => {
    await seedCandidate(engine, 'candidate-procedure-verified', 'staged_for_review', {
      candidate_type: 'procedure',
      target_object_type: 'procedure',
      target_object_id: 'procedures/ingest-retry-runbook',
    });

    const before = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-procedure-verified' });
    expect(before.decision).toBe('defer');
    expect(before.reasons).toContain('candidate_requires_revalidation');

    await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-procedure-verified',
      verification_status: 'verified',
      verification_method: 'command_execution',
      verification_evidence: 'Executed the runbook steps end-to-end on a scratch database.',
    });

    const after = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-procedure-verified' });
    expect(after.decision).toBe('allow');
    expect(after.reasons).toEqual(['candidate_ready_for_promotion']);
  });
});

test('verified procedure candidates can promote end-to-end', async () => {
  await withEngine('promote-verified-procedure', async (engine) => {
    await seedCandidate(engine, 'candidate-procedure-promote', 'captured', {
      candidate_type: 'procedure',
      target_object_type: 'procedure',
      target_object_id: 'procedures/ingest-retry-runbook',
    });
    await advanceMemoryCandidateStatus(engine, { id: 'candidate-procedure-promote', next_status: 'candidate' });
    await advanceMemoryCandidateStatus(engine, { id: 'candidate-procedure-promote', next_status: 'staged_for_review' });
    await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-procedure-promote',
      verification_status: 'verified',
      verification_method: 'command_execution',
      verification_evidence: 'Executed the runbook steps end-to-end on a scratch database.',
    });

    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'candidate-procedure-promote',
      review_reason: 'Verified procedure ready for canonical memory.',
    });
    expect(promoted.status).toBe('promoted');
    expect(promoted.verification_status).toBe('verified');
  });
});

test('verify service allows refuting a promoted candidate after canonical handoff', async () => {
  await withEngine('promoted-refuted', async (engine) => {
    await seedCandidate(engine, 'candidate-promoted-refute', 'captured');
    await advanceMemoryCandidateStatus(engine, { id: 'candidate-promoted-refute', next_status: 'candidate' });
    await advanceMemoryCandidateStatus(engine, { id: 'candidate-promoted-refute', next_status: 'staged_for_review' });
    await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-promoted-refute',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Source initially appeared to support the claim.',
    });
    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'candidate-promoted-refute',
      review_reason: 'Initial evidence supported promotion.',
    });
    expect(promoted.status).toBe('promoted');

    const refuted = await verifyMemoryCandidateEntry(engine, {
      id: 'candidate-promoted-refute',
      verification_status: 'refuted',
      verification_method: 'source_recheck',
      verification_evidence: 'A later source recheck found the promoted claim was false; review the canonical page and handoff.',
      verification_source_refs: ['source-recheck:2026-07-03'],
    });

    expect(refuted.status).toBe('promoted');
    expect(refuted.verification_status).toBe('refuted');
    expect(refuted.verification_evidence).toContain('canonical page and handoff');
    expect(refuted.verification_source_refs).toEqual(['source-recheck:2026-07-03']);
  });
});
