/** #8265: real import/storage/replay and installed-base audit, no provider calls. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { buildTranscriptSlug } from '../src/core/transcripts/types.ts';
import { auditTranscriptSecrets, saveTranscriptSecretAudit } from '../src/core/transcripts/secret-audit.ts';
import { transcriptSecretExposureCheck } from '../src/commands/doctor/checks/transcript-secrets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const value = ['Example', '9vQ2rX7mL4tZ8pC6'].join('');
const timestamp = '2026-11-01T12:00:00.000Z';
let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'assignment-encoding-'));
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('#8265 transcript assignment encoding', () => {
  test('import redacts escaped tool text and raw metadata before persistence; retry is unchanged', async () => {
    const path = join(dir, 'session.jsonl');
    const sessionId = 'encoded-assignment-8265';
    const text = `{\\"password\\":\\"${value}\\"}\npassword%3D${value}%26next%3D1\nbare ${value}`;
    writeFileSync(path, [
      { type: 'session', id: sessionId, version: 3, timestamp, cwd: `password%3D${value}&next=1` },
      { type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const opts = { paths: [path], sourceId: 'default', userPatternsPath: join(dir, 'absent-patterns.txt') };
    const result = await runTranscriptsIngest(engine, opts);
    expect(result.sessionsImported).toBe(1);
    expect(result.erroredFiles).toBe(0);
    const slug = buildTranscriptSlug('openclaw', timestamp, { sessionId });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).not.toContain(value);
    expect(page!.compiled_truth).toContain('<REDACTED:high_entropy_assignment>');
    expect(page!.compiled_truth).toContain('%26next%3D1');
    const raw = await engine.getRawData(slug, undefined, { sourceId: 'default' });
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toContain(value);
    expect(JSON.stringify(raw)).toContain('password%3D<REDACTED:high_entropy_assignment>&next=1');
    const again = await runTranscriptsIngest(engine, opts);
    expect(again.pages.imported).toBe(0);
    expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(page);
  });

  test('a pinned version-4 clean audit is stale; fresh audit detects old escaped assignments without exposing values', async () => {
    await engine.putPage('conversations/old-encoded-assignment', {
      type: 'conversation', title: 'Historical synthetic session',
      compiled_truth: `{\\"password\\":\\"${value}\\"}\npassword%3D${value}&next=1`,
      frontmatter: { transcript_import: { harness: 'openclaw', session_id: 'old' } },
    });
    await saveTranscriptSecretAudit(engine, {
      detector_version: 4, scanned_at: timestamp, source_id: null,
      pages_scanned: 2, pages_affected: 0, hits_total: 0, by_pattern: {}, pages: [],
    });
    const ctx = { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
    expect((await transcriptSecretExposureCheck(ctx))?.message).toContain('older detectors');
    const audit = await auditTranscriptSecrets(engine);
    expect(audit.pages_affected).toBe(1);
    expect(audit.by_pattern.high_entropy_assignment).toBe(2);
    expect(JSON.stringify(audit)).not.toContain(value);
    await saveTranscriptSecretAudit(engine, audit);
    expect((await transcriptSecretExposureCheck(ctx))?.message).toContain('found 2 credential hit(s)');
  });
});
