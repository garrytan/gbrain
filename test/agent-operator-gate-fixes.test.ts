/**
 * Unit pins for the Cat 41 release-gate fixes (see the serial journey in
 * agent-operator-gate-fixes.serial.test.ts): remediation-plan step fixes carry
 * their effects, the transcript pointer's trigger and wire shape, the serve status reasons
 * for a missing or unopenable brain, and the repair-failed marker file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobStepFix, repairStepFix } from '../src/commands/doctor/remediate.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';
import { localTranscriptsNotice, wantsTranscriptHint } from '../src/core/interop-notices.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { PER_CALL_NOTICE_CODES } from '../src/core/notice-ledger.ts';
import { statusReasonForError } from '../src/commands/serve-status.ts';
import { clearRepairFailedMarker, readRepairFailedMarker, repairFailedMarkerPath, writeRepairFailedMarker } from '../src/core/pglite-repair.ts';
import { isRepairFailedRefusal, repairFailedRefusal } from '../src/core/pglite-repair-consent.ts';
import { embedBackfillFix, EMBED_BACKFILL_JOB_NAMES } from '../src/core/embed-consent.ts';
import { embeddingProbeFix } from '../src/commands/doctor/checks/embedding-health.ts';

describe('remediation plan steps carry an Action with their effects', () => {
  test('a paid embed step asks first and runs verbatim once approved', async () => {
    const fix = await jobStepFix({ job: 'embed', params: { stale: true }, est_usd_cost: 0.00005 });
    expect(fix.consent).toEqual(['paid']);
    expect(fix.argv).toEqual(['gbrain', 'jobs', 'submit', 'embed', '--params', '{"stale":true}', '--follow', '--yes']);
    expect(fix.user_message).toBeTruthy();
    expect(renderAction(fix, cliRenderContext()).next).toBe('ask_user');
  });

  test('a provider-calling job is paid even when its estimate is 0', async () => {
    expect((await jobStepFix({ job: 'embed-catch-up', est_usd_cost: 0 })).consent).toEqual(['paid']);
  });

  test('a free job runs without consent', async () => {
    const fix = await jobStepFix({ job: 'extract', params: { stale: true }, est_usd_cost: 0 });
    expect(fix.consent).toEqual([]);
    expect(fix.argv).not.toContain('--yes');
    expect(renderAction(fix, cliRenderContext()).next).toBe('run');
  });

  test('a repair step is destructive (and paid when it embeds) with a read-only preview', () => {
    const fix = repairStepFix({ kind: 'timeline', command: 'gbrain repair timeline --apply', paid: true, est_usd_cost: 0.01, affected: 3, checks: ['timeline_history'] });
    expect(fix.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'timeline_history', '--json']);
    expect(fix.consent).toEqual(['destructive', 'paid']);
    expect(fix.argv).toEqual(['gbrain', 'repair', 'timeline', '--apply']);
    expect(fix.preview_argv).toEqual(['gbrain', 'repair', 'timeline']);
    expect(renderAction(fix, cliRenderContext()).next).toBe('ask_user');
  });
});

describe('doctor and embed fixes', () => {
  test('the embedding probe is paid + egress for a billed provider and free for a local one', () => {
    expect(embeddingProbeFix('openai:text-embedding-3-small').consent).toEqual(['paid', 'egress']);
    expect(embeddingProbeFix('openai:text-embedding-3-small').argv).toContain('--yes');
    expect(embeddingProbeFix('ollama:nomic-embed-text', true).consent).toEqual([]);
  });

  test('the embedding backlog fix asks first and previews with --dry-run', () => {
    const fix = embedBackfillFix({ backlog: 6, verifyCheck: 'embeddings' });
    expect(fix.consent).toEqual(['paid']);
    expect(fix.argv).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--yes']);
    expect(fix.preview_argv).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--dry-run']);
    expect([...EMBED_BACKFILL_JOB_NAMES].sort()).toEqual(['embed', 'embed-backfill', 'embed-catch-up']);
  });
});

describe('local transcripts pointer', () => {
  test('fires on activity-shaped or empty reads, never on a non-empty listing', () => {
    expect(wantsTranscriptHint('search', { query: 'what did I promise in my coding sessions this week' }, [{ slug: 'a' }])).toBe(true);
    expect(wantsTranscriptHint('query', { query: 'larkspur contract term' }, [])).toBe(true);
    expect(wantsTranscriptHint('query', { query: 'larkspur contract term' }, [{ slug: 'a' }])).toBe(false);
    expect(wantsTranscriptHint('list_pages', {}, [{ slug: 'a' }])).toBe(false);
    expect(wantsTranscriptHint('list_pages', {}, [])).toBe(true);
    expect(wantsTranscriptHint('get_page', { slug: 'sessions' }, null)).toBe(false);
  });

  test('a registered per-call info notice whose fix is the CLI read; none without transcripts', () => {
    expect(localTranscriptsNotice({ dirs: [], count: 0 })).toBeNull();
    const n = localTranscriptsNotice({ dirs: ['/host/transcripts'], count: 2 })!;
    expect(n).toMatchObject({ code: 'local_transcripts', kind: 'info' });
    expect(n.fix?.argv).toEqual(['gbrain', 'transcripts', 'recent', '--json']);
    expect(n.why).toContain('/host/transcripts');
    expect(n.why).toContain('Never answer "no transcripts"');
    expect(NOTICE_CODES.local_transcripts.kind).toBe('info');
    expect(PER_CALL_NOTICE_CODES.has('local_transcripts')).toBe(true);
  });
});

describe('serve status reasons and the repair-failed marker', () => {
  let dir = '';
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gate-marker-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test('an unopenable writer-lock file is a status-only reason, not a pre-handshake exit', () => {
    expect(statusReasonForError(new Error('Cannot open the stable writer lock file'))).toBe('brain_unopenable');
    expect(statusReasonForError(Object.assign(new Error('busy'), { code: 'pglite_busy' }))).toBe('lock_held');
    expect(statusReasonForError(new Error('something else'))).toBeNull();
  });

  test('the marker is a sibling file; unreadable counts as set; clear removes it', () => {
    const dataDir = join(dir, 'brain.pglite');
    mkdirSync(dataDir);
    expect(readRepairFailedMarker(dataDir)).toBeNull();
    writeRepairFailedMarker(dataDir, { ts: 1, repair: 'failed-restored', backup_path: `${dataDir}.wal-repair-backup-1` });
    expect(repairFailedMarkerPath(dataDir)).toBe(`${dataDir}.repair-failed.json`);
    expect(readRepairFailedMarker(dataDir)).toEqual({ ts: 1, repair: 'failed-restored', backup_path: `${dataDir}.wal-repair-backup-1` });
    writeFileSync(repairFailedMarkerPath(dataDir), '{not json');
    expect(readRepairFailedMarker(dataDir)).toEqual({ ts: 0, repair: 'unknown' });
    clearRepairFailedMarker(dataDir);
    expect(existsSync(repairFailedMarkerPath(dataDir))).toBe(false);
  });

  test('the refusal is the exit-3 consent payload: destructive, the consented repair, the read-only preview, hands off the files', () => {
    const dataDir = join(dir, 'other.pglite');
    mkdirSync(dataDir);
    const e = repairFailedRefusal(dataDir, { ts: 0, repair: 'failed-restored' });
    expect(isRepairFailedRefusal(e)).toBe(true);
    expect(e.consent).toMatchObject({ code: 'confirmation_required', effects: ['destructive'], actor: 'agent' });
    expect(e.consent.fix.argv).toEqual(['gbrain', 'pglite-repair', '--path', dataDir, '--yes', '--expect', e.consent.plan_hash!]);
    expect(e.consent.fix.next).toBe('ask_user');
    expect(e.consent.preview?.argv).toEqual(['gbrain', 'pglite-repair', '--path', dataDir, '--dry-run', '--json']);
    expect(e.consent.why).toContain('Do not copy, rebuild, move or modify the brain.pglite files yourself');
  });
});
