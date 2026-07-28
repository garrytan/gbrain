import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import {
  NON_EXTRACTABLE_AUDIT_SOURCE,
  TERMINAL_AUDIT_SOURCE,
} from '../src/commands/extract-conversation-facts.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

async function seedPage(slug: string, type: string): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: 'A page body long enough for the doctor backlog fixture.',
    timeline: '',
    frontmatter: {},
  });
}

async function seedOutcome(slug: string, source: string): Promise<void> {
  const pages = await engine.executeRaw<{
    content_hash: string;
    effective_date: Date | null;
  }>(
    `SELECT content_hash, effective_date
       FROM pages WHERE source_id = 'default' AND slug = $1`,
    [slug],
  );
  const effectiveDate = pages[0]!.effective_date
    ? new Date(pages[0]!.effective_date).toISOString().slice(0, 10)
    : 'none';
  const version = `page-${pages[0]!.content_hash}-${effectiveDate}`;
  await engine.executeRaw(
    `INSERT INTO facts (
       fact, kind, source, source_session, confidence, notability,
       row_num, source_markdown_slug, source_id
     ) VALUES ($1, 'fact', $2, $3, 1.0, 'low', 0, $4, 'default')`,
    [
      source === TERMINAL_AUDIT_SOURCE
        ? 'EXTRACTION_COMPLETE'
        : 'EXTRACTION_NOT_APPLICABLE',
      source,
      `${source}:${slug}:${version}`,
      slug,
    ],
  );
}

describe('conversation_facts_backlog durable outcomes', () => {
  test('reports complete, scanned-not-extractable, and backlog separately', async () => {
    await seedPage('meetings/complete', 'meeting');
    await seedPage('slack/not-applicable', 'slack');
    await seedPage('meetings/pending', 'meeting');
    await seedOutcome('meetings/complete', TERMINAL_AUDIT_SOURCE);
    await seedOutcome('slack/not-applicable', NON_EXTRACTABLE_AUDIT_SOURCE);

    const result = await computeConversationFactsBacklogCheck(engine);
    expect(result.details?.backlog).toBe(1);
    expect(result.details?.completed).toBe(1);
    expect(result.details?.scanned_not_extractable).toBe(1);
  });

  test('a content change invalidates the prior outcome', async () => {
    await seedPage('meetings/growing', 'meeting');
    await seedOutcome('meetings/growing', TERMINAL_AUDIT_SOURCE);
    await engine.putPage('meetings/growing', {
      type: 'meeting',
      title: 'meetings/growing',
      compiled_truth: 'The meeting body changed after its durable outcome.',
      timeline: '',
      frontmatter: {},
    });

    const result = await computeConversationFactsBacklogCheck(engine);
    expect(result.details?.backlog).toBe(1);
    expect(result.details?.completed).toBe(0);
  });

  test('a sidecar-only edit invalidates doctor completion', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-sidecar-'));
    try {
      const relativePath = 'meetings/sidecar.raw/transcript.txt';
      const transcriptPath = join(repoDir, relativePath);
      mkdirSync(join(repoDir, 'meetings/sidecar.raw'), { recursive: true });
      const body = 'Speaker A: Initial statement.\nSpeaker B: Initial reply.';
      writeFileSync(transcriptPath, body, 'utf8');
      await engine.setConfig('sync.repo_path', repoDir);
      const frontmatter = { raw_transcript: relativePath };
      await engine.putPage('meetings/sidecar', {
        type: 'meeting',
        title: 'Sidecar meeting',
        compiled_truth: 'Summary only.',
        timeline: '',
        frontmatter,
      });
      const page = await engine.getPage('meetings/sidecar', { sourceId: 'default' });
      const token = `sidecar-${createHash('sha256')
        .update(JSON.stringify({
          body,
          title: page!.title,
          type: page!.type,
          frontmatter: page!.frontmatter,
          effective_date: page!.effective_date ?? null,
        }))
        .digest('hex')}`;
      await engine.executeRaw(
        `INSERT INTO facts (
           fact, kind, source, source_session, confidence, notability,
           row_num, source_markdown_slug, source_id
         ) VALUES (
           'EXTRACTION_COMPLETE', 'fact', $1, $2, 1.0, 'low', 0, $3, 'default'
         )`,
        [
          TERMINAL_AUDIT_SOURCE,
          `${TERMINAL_AUDIT_SOURCE}:meetings/sidecar:${token}`,
          'meetings/sidecar',
        ],
      );
      const before = await computeConversationFactsBacklogCheck(engine);
      expect(before.details?.completed).toBe(1);
      expect(before.details?.backlog).toBe(0);

      writeFileSync(
        transcriptPath,
        'Speaker A: Edited sidecar statement.\nSpeaker B: Edited reply.',
        'utf8',
      );
      const after = await computeConversationFactsBacklogCheck(engine);
      expect(after.details?.completed).toBe(0);
      expect(after.details?.backlog).toBe(1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
