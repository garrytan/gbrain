/**
 * Postgres parity for the installed-base transcript secret audit (#6147):
 * the `frontmatter ? 'transcript_import'` page set, keyset batching past one
 * batch, and the doctor check reading the cached summary.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { auditTranscriptSecrets, saveTranscriptSecretAudit } from '../../src/core/transcripts/secret-audit.ts';
import { transcriptSecretExposureCheck } from '../../src/commands/doctor/checks/transcript-secrets.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const PW = ['hunter', '2'].join('');
const RUN = hasDatabase();
let engine: PostgresEngine;

describe.skipIf(!RUN)('transcripts audit-secrets (Postgres)', () => {
  beforeAll(async () => { engine = await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('streams every imported conversation page across batches and reports counts, never values', async () => {
    for (let i = 0; i < 30; i++) {
      await engine.putPage(`conversations/sessions/2026-01-02-codex-${String(i).padStart(12, '0')}`, {
        type: 'conversation', title: 'session', compiled_truth: i % 10 === 0 ? `ok\npassword: ${PW}` : 'clean',
        frontmatter: { transcript_import: { harness: 'codex', session_id: `s${i}` } },
      });
    }
    await engine.putPage('notes/ops', { type: 'note', title: 'ops', compiled_truth: `password: ${PW}` });
    const result = await auditTranscriptSecrets(engine);
    expect(result.pages_scanned).toBe(30);
    expect(result.pages_affected).toBe(3);
    expect(result.pages.every((p) => p.lines[0] === 2)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PW);
    const ctx = { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
    expect((await transcriptSecretExposureCheck(ctx))?.message).toContain('never been audited');
    await saveTranscriptSecretAudit(engine, result);
    expect((await transcriptSecretExposureCheck(ctx))?.message).toContain('found 3 credential hit(s) on 3 conversation page(s)');
  });
});
