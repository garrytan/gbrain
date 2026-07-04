import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
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
  test('runs on the shared MCP HTTP server with the review_local surface profile', async () => {
    const source = readFileSync(
      new URL('../src/commands/review.ts', import.meta.url),
      'utf-8',
    );

    expect(source).toContain('startMcpHttpServer');
    expect(source).toContain("surfaceProfile: 'review_local'");
    expect(source).not.toContain('Bun.serve({');

    const harness = await createReviewHarness('shared-http');
    const server = startReviewServer({
      engine: harness.engine,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const healthResponse = await fetch(`${server.url}/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toMatchObject({
        status: 'ok',
        transport: 'http',
      });
    } finally {
      server.stop();
      await harness.cleanup();
    }
  });

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

      const listResponse = await fetch(`${server.url}/api/candidates?status=candidate`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(listResponse.status).toBe(200);
      const listJson = await listResponse.json() as any;
      expect(listJson.candidates).toHaveLength(3);
      const listedCandidate = listJson.candidates.find((candidate: any) => candidate.id === 'review-candidate-1');
      expect(listedCandidate).toMatchObject({
        id: 'review-candidate-1',
        proposed_content: 'The review UI should expose pending candidates with evidence.',
      });

      const page = await fetch(`${server.url}/?review_token=${server.token}`).then(response => response.text());
      expect(page).toContain('review-candidate-1');
      expect(page).toContain('The review UI should expose pending candidates with evidence.');
      expect(page).toContain('test/review-ui.test.ts');
      expect(page).toContain('generated_by: agent');
      expect(page).toContain('confidence: 0.7');
      expect(page).toContain('method="post"');
      expect(page).toContain('action="/candidates/review-candidate-1/verify"');
      expect(page).toContain('action="/candidates/review-candidate-1/refute"');
      expect(page).toContain('name="review_token"');

      const verifyFormResponse = await fetch(`${server.url}/candidates/review-candidate-1/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ review_token: server.token }),
        redirect: 'manual',
      });
      expect(verifyFormResponse.status).toBe(303);
      expect(verifyFormResponse.headers.get('location')).toBe('/?status=candidate');

      const refuteFormResponse = await fetch(`${server.url}/candidates/review-candidate-2/refute`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ review_token: server.token }),
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
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
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

  test('gates candidate reads and mutations with the review token and origin checks', async () => {
    const harness = await createReviewHarness('auth');
    const server = startReviewServer({
      engine: harness.engine,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await harness.engine.createMemoryCandidateEntry(candidateInput('review-auth-candidate'));

      const unauthenticatedList = await fetch(`${server.url}/api/candidates?status=candidate`);
      expect(unauthenticatedList.status).toBe(403);

      const wrongHostList = await fetch(`${server.url}/api/candidates?status=candidate`, {
        headers: {
          authorization: `Bearer ${server.token}`,
          host: 'evil.example.com',
        },
      });
      expect(wrongHostList.status).toBe(403);

      const crossSitePost = await fetch(`${server.url}/candidates/review-auth-candidate/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example.com',
        },
        body: new URLSearchParams({ review_token: server.token }),
        redirect: 'manual',
      });
      expect(crossSitePost.status).toBe(403);

      const missingTokenPost = await fetch(`${server.url}/candidates/review-auth-candidate/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
      });
      expect(missingTokenPost.status).toBe(403);

      const authorizedList = await fetch(`${server.url}/api/candidates?status=candidate`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(authorizedList.status).toBe(200);
    } finally {
      server.stop();
      await harness.cleanup();
    }
  });

  test('refuses non-loopback bind unless explicitly allowed', async () => {
    const harness = await createReviewHarness('non-loopback');
    try {
      expect(() => startReviewServer({
        engine: harness.engine,
        host: '0.0.0.0',
        port: 0,
      })).toThrow(/non-loopback/i);

      const server = startReviewServer({
        engine: harness.engine,
        host: '0.0.0.0',
        port: 0,
        allowNonLoopback: true,
      });
      try {
        const port = new URL(server.url).port;
        const lanHost = await fetch(`http://127.0.0.1:${port}/api/candidates?status=candidate`, {
          headers: {
            authorization: `Bearer ${server.token}`,
            host: '192.168.0.10',
          },
        });
        expect(lanHost.status).toBe(200);

        const dnsHost = await fetch(`http://127.0.0.1:${port}/api/candidates?status=candidate`, {
          headers: {
            authorization: `Bearer ${server.token}`,
            host: 'evil.example.com',
          },
        });
        expect(dnsHost.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      await harness.cleanup();
    }
  });

  test('applies the shared HTTP body limit to review API routes', async () => {
    const harness = await createReviewHarness('body-limit');
    const server = startReviewServer({
      engine: harness.engine,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await harness.engine.createMemoryCandidateEntry(candidateInput('oversized-review-candidate'));

      const response = await fetch(`${server.url}/api/candidates/oversized-review-candidate/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          verification_status: 'verified',
          verification_method: 'user_confirmation',
          verification_evidence: 'x'.repeat(1_048_577),
          verification_source_refs: ['oversized-test'],
        }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: 'request_too_large',
      });
    } finally {
      server.stop();
      await harness.cleanup();
    }
  });
});
