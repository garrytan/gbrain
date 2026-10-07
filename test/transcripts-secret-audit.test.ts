/**
 * The installed-base transcript secret audit (#6147) and its doctor check.
 * Pages imported before the labeled-credential detector keep a typed
 * password; `gbrain transcripts audit-secrets` lists them by slug and count
 * (never a value) and `transcript_secret_exposure` reads its cached summary.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  TRANSCRIPT_SECRET_AUDIT_KEY,
  auditTranscriptSecrets,
  loadTranscriptSecretAudit,
  saveTranscriptSecretAudit,
} from '../src/core/transcripts/secret-audit.ts';
import { transcriptSecretExposureCheck } from '../src/commands/doctor/checks/transcript-secrets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const PW = ['hunter', '2'].join('');
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
});

async function conversation(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'conversation', title: 'session', compiled_truth: body,
    frontmatter: { transcript_import: { harness: 'codex', session_id: slug } },
  });
}

const ctx = () => ({ engine, progress: { heartbeat() {} } }) as unknown as DoctorContext;

describe('transcripts audit-secrets', () => {
  test('lists affected conversation pages with counts and lines, never values; other pages are not scanned', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `intro\nuser: password: ${PW}\nok\nlogin alice-example / ${PW}`);
    await conversation('conversations/sessions/2026-01-03-codex-bbbbbbbbbbbb', 'nothing secret here');
    await engine.putPage('notes/ops', { type: 'note', title: 'ops', compiled_truth: `password: ${PW}` });
    const result = await auditTranscriptSecrets(engine);
    expect(result.pages_scanned).toBe(2);
    expect(result.pages_affected).toBe(1);
    expect(result.hits_total).toBe(2);
    expect(result.by_pattern).toEqual({ labeled_credential: 2 });
    expect(result.pages).toEqual([
      { slug: 'conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', source_id: 'default', hits: { labeled_credential: 2 }, lines: [2, 4] },
    ]);
    expect(JSON.stringify(result)).not.toContain(PW);
  });

  test('the cached summary carries no slugs and no values', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    expect(await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine))).toBe(true);
    const raw = (await engine.getConfig(TRANSCRIPT_SECRET_AUDIT_KEY)) ?? '';
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('conversations/');
    expect((await loadTranscriptSecretAudit(engine))?.hits_total).toBe(1);
  });
});

describe('transcript_secret_exposure doctor check', () => {
  test('no imported conversation pages: no check emitted', async () => {
    expect(await transcriptSecretExposureCheck(ctx())).toBeNull();
  });

  test('never audited: warn with the read-only audit as fix', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    const check = await transcriptSecretExposureCheck(ctx());
    expect(check?.status).toBe('warn');
    expect((check?.fix as { argv: string[] }).argv).toEqual(['gbrain', 'transcripts', 'audit-secrets', '--json']);
    expect(check?.message).toContain('never been audited');
  });

  test('a cached audit with hits warns with its age; a clean audit is ok; the check never scans pages', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', `password: ${PW}`);
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { now: () => new Date(now - 3 * 3_600_000) }));
    const warn = await transcriptSecretExposureCheck(ctx(), now);
    expect(warn?.status).toBe('warn');
    expect(warn?.message).toContain('(3h ago) found 1 credential hit(s) on 1 conversation page(s)');
    expect(JSON.stringify(warn)).not.toContain(PW);

    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', 'password: <REDACTED:labeled_credential>');
    const stale = await transcriptSecretExposureCheck(ctx(), now);
    expect(stale?.status).toBe('warn');

    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { now: () => new Date(now) }));
    const ok = await transcriptSecretExposureCheck(ctx(), now);
    expect(ok?.status).toBe('ok');
  });

  test('a source-scoped audit does not clear the brain-wide warning', async () => {
    await conversation('conversations/sessions/2026-01-02-codex-aaaaaaaaaaaa', 'clean');
    await saveTranscriptSecretAudit(engine, await auditTranscriptSecrets(engine, { sourceId: 'default' }));
    const check = await transcriptSecretExposureCheck(ctx());
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('covered only source default');
  });
});
