/**
 * GST-2768 PR 3: when a brain archived while personal becomes shared, the archive keeps the earlier pages to the owner
 * with owner-only rules. When it cannot (the shared brain names no owner, or the source's access rules live in git),
 * `gbrain transcripts archive status` and the transcript_archive_freshness doctor check each say so in one line, with
 * what the owner does next. Repo-less PGLite; synthetic values only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveStatus, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { checkTranscriptArchiveFreshness } from '../src/commands/doctor/checks/transcript-archive.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const NOW = new Date('2026-11-05T00:00:00Z');
const reader = () => staticReader('codex', [conversation('codex', 'rescope-session', [['user', '2026-11-04T10:00:00.000Z', 'personal era note']])]);

async function personalThenShared(): Promise<void> {
  await engine.setConfig('brain.audience', 'personal');
  await runTranscriptArchive(engine, { mode: 'run', readers: [reader()], now: NOW });
  await engine.setConfig('brain.audience', 'shared');
  for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
}

const doctor = () => checkTranscriptArchiveFreshness(engine, { readers: [staticReader('codex', [])], nowMs: NOW.getTime() });

describe('a skipped re-scope is reported', () => {
  test('a shared brain with no owner: status and doctor name it and say to set the owner', async () => {
    await personalThenShared();
    await runTranscriptArchive(engine, { mode: 'run', readers: [reader()], now: NOW });
    const status = await archiveStatus(engine, { readers: [] });
    expect(status.rescope).toMatchObject({ code: 'archive_rescope_owner_unset' });
    expect(status.rescope!.message).toContain('gbrain access owner set');
    const check = await doctor();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain access owner set');
  }, 120_000);

  test('a source whose access rules live in git: status and doctor name it and give the access.yml rule to add', async () => {
    await personalThenShared();
    await setOwner(engine, 'alice-example');
    await engine.executeRaw("UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb('git'::text)) WHERE id = 'conversations'");
    await runTranscriptArchive(engine, { mode: 'run', readers: [reader()], now: NOW });
    const status = await archiveStatus(engine, { readers: [] });
    expect(status.rescope).toMatchObject({ code: 'archive_rescope_git_rules' });
    expect(status.rescope!.message).toContain('access.yml');
    const check = await doctor();
    expect(check.message).toContain('access.yml');
  }, 120_000);

  test('a re-scope that ran leaves no line', async () => {
    await personalThenShared();
    await setOwner(engine, 'alice-example');
    await runTranscriptArchive(engine, { mode: 'run', readers: [reader()], now: NOW });
    expect((await archiveStatus(engine, { readers: [] })).rescope).toBeUndefined();
  }, 120_000);
});
