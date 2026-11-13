/**
 * GST-2114: a mixed-case X-Gbrain-Slug captures the page the door writes.
 *
 * On a managed brain the ingest_capture job read the snapshot with the raw mixed-case slug, missed the stored
 * lowercase page, sent no expected_revision, and the door (which lowercases) refused revision_required, so a capture
 * the route had answered 202 dead-lettered.
 * Protects: on a managed brain, a capture sent to Notes/Mixed-Example replaces the existing notes/mixed-example.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const note = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\n${line}\n`;
const jobCtx = (id: number, data: Record<string, unknown>): MinionJobContext => ({ id, name: 'ingest_capture', data,
  attempts_made: 0, idempotency_key: null, signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
  updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] });
const captureData = (content: string, slug: string, sourceId: string) => ({ slug, sourceId, event: { source_id: 'webhook-client-example', source_kind: 'webhook',
  source_uri: 'mcp-webhook:client-example:1', received_at: new Date().toISOString(), content_type: 'text/markdown', content,
  content_hash: computeContentHash(content), untrusted_payload: true } });
const text = async (engine: BrainEngine, slug: string, sourceId: string) => (await engine.readPageSnapshot(slug, { sourceId }))?.page.compiled_truth ?? null;

describe('ingest_capture with a mixed-case slug on a managed brain (GST-2114)', () => {
  test('a capture sent to a mixed-case slug replaces the existing lowercase page', () => managedBrain(async ({ engine, ctx }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/mixed-example', content: note('Mixed example', 'Original body.') } });
    const result = await makeIngestCaptureHandler(engine)(jobCtx(4, captureData(note('Mixed example', 'Captured body.'), 'Notes/Mixed-Example', 'default')));
    expect(result.status).toBe('imported');
    expect(result.slug).toBe('notes/mixed-example');
    expect(await text(engine, 'notes/mixed-example', 'default')).toContain('Captured body.');
  }), 120_000);
});
