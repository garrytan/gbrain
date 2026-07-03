import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startReviewServer } from '../src/commands/review.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createReviewHarness(label: string): Promise<{
  engine: SQLiteEngine;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-review-ui-${label}-`));
  tempDirs.push(dir);
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
    },
  };
}

function candidateInput(id: string): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'The review UI should expose pending candidates with evidence.',
    source_refs: ['test/review-ui.test.ts'],
    generated_by: 'agent',
    extraction_kind: 'inferred',
    confidence_score: 0.7,
    importance_score: 0.6,
    recurrence_score: 0,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'systems/review-ui',
  };
}

describe('local review UI', () => {
  test('serves pending candidates and reviews them through page form actions', async () => {
    const harness = await createReviewHarness('verify');
    const server = startReviewServer({
      engine: harness.engine,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await harness.engine.createMemoryCandidateEntry(candidateInput('review-candidate-1'));
      await harness.engine.createMemoryCandidateEntry(candidateInput('review-candidate-2'));
      await harness.engine.createMemoryCandidateEntry(candidateInput('review-candidate-3'));

      const listResponse = await fetch(`${server.url}/api/candidates?status=candidate`);
      expect(listResponse.status).toBe(200);
      const listJson = await listResponse.json() as any;
      expect(listJson.candidates).toHaveLength(3);
      const listedCandidate = listJson.candidates.find((candidate: any) => candidate.id === 'review-candidate-1');
      expect(listedCandidate).toMatchObject({
        id: 'review-candidate-1',
        proposed_content: 'The review UI should expose pending candidates with evidence.',
      });

      const page = await fetch(`${server.url}/`).then(response => response.text());
      expect(page).toContain('review-candidate-1');
      expect(page).toContain('The review UI should expose pending candidates with evidence.');
      expect(page).toContain('method="post"');
      expect(page).toContain('action="/candidates/review-candidate-1/verify"');
      expect(page).toContain('action="/candidates/review-candidate-1/refute"');

      const verifyFormResponse = await fetch(`${server.url}/candidates/review-candidate-1/verify`, {
        method: 'POST',
        redirect: 'manual',
      });
      expect(verifyFormResponse.status).toBe(303);
      expect(verifyFormResponse.headers.get('location')).toBe('/?status=candidate');

      const refuteFormResponse = await fetch(`${server.url}/candidates/review-candidate-2/refute`, {
        method: 'POST',
        redirect: 'manual',
      });
      expect(refuteFormResponse.status).toBe(303);
      expect(refuteFormResponse.headers.get('location')).toBe('/?status=candidate');

      const verifiedCandidate = await harness.engine.getMemoryCandidateEntry('review-candidate-1');
      expect(verifiedCandidate?.verification_status).toBe('verified');
      expect(verifiedCandidate?.verification_evidence).toContain('mbrain review');

      const refutedCandidate = await harness.engine.getMemoryCandidateEntry('review-candidate-2');
      expect(refutedCandidate?.verification_status).toBe('refuted');
      expect(refutedCandidate?.verification_evidence).toContain('mbrain review');

      const verifyResponse = await fetch(`${server.url}/api/candidates/review-candidate-3/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verification_status: 'verified',
          verification_method: 'file_inspection',
          verification_evidence: 'Inspected the local test fixture and confirmed the claim.',
          verification_source_refs: ['test/review-ui.test.ts'],
        }),
      });
      expect(verifyResponse.status).toBe(200);
      const verifyJson = await verifyResponse.json() as any;
      expect(verifyJson.candidate.verification_status).toBe('verified');

      const candidate = await harness.engine.getMemoryCandidateEntry('review-candidate-3');
      expect(candidate?.verification_status).toBe('verified');
      expect(candidate?.verification_evidence).toContain('Inspected');
    } finally {
      server.stop();
      await harness.cleanup();
    }
  });
});
