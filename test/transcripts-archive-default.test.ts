/**
 * GST-2768 PR 3 (decision A): the conversation archive is on by default for a personal brain. An unset
 * transcripts.archive.enabled resolves on when the brain audience classifies personal, off for a shared or unknown
 * brain, a thin client and a remote caller; an explicit on or off wins; a config read failure resolves off. A keyless
 * archive run makes no network call. PGLite, synthetic sessions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_ENABLED_KEY, ARCHIVE_TIMEZONE_KEY, archiveEnabled, runTranscriptArchive } from '../src/core/transcripts/archive.ts';
import { resolveArchiveEnabled } from '../src/core/transcripts/archive-default.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

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

describe('archive default resolution', () => {
  test('a personal brain with the switch unset resolves on', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const r = await resolveArchiveEnabled(engine, { config: null });
    expect(r).toMatchObject({ enabled: true, source: 'default', audience: 'personal', offered: false });
    expect(await archiveEnabled(engine)).toBe(true);
  });

  test('an undeclared brain the heuristic reads as personal resolves on', async () => {
    expect((await resolveArchiveEnabled(engine, { config: null })).enabled).toBe(true);
  });

  test('a shared brain with the switch unset resolves off and is only offered', async () => {
    await engine.setConfig('brain.audience', 'shared');
    const r = await resolveArchiveEnabled(engine, { config: null });
    expect(r).toMatchObject({ enabled: false, source: 'default', audience: 'shared', offered: true });
    expect(await archiveEnabled(engine)).toBe(false);
    expect(await engine.getConfig(ARCHIVE_ENABLED_KEY)).toBeNull();
  });

  test('an unknown audience resolves off', async () => {
    const unknown = { getConfig: async (key: string) => { if (key === 'brain.audience') throw new Error('config read failed'); return null; } } as unknown as BrainEngine;
    const r = await resolveArchiveEnabled(unknown, { config: null });
    expect(r.enabled).toBe(false);
    expect(r.audience).toBe('unknown');
  });

  test('an explicit off wins on a personal brain', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await engine.setConfig(ARCHIVE_ENABLED_KEY, 'false');
    expect(await resolveArchiveEnabled(engine, { config: null })).toMatchObject({ enabled: false, source: 'explicit', offered: false });
  });

  test('an explicit on wins on a shared brain', async () => {
    await engine.setConfig('brain.audience', 'shared');
    await engine.setConfig(ARCHIVE_ENABLED_KEY, 'true');
    expect(await resolveArchiveEnabled(engine, { config: null })).toMatchObject({ enabled: true, source: 'explicit', offered: false });
  });

  test('a config read failure resolves off', async () => {
    const broken = { getConfig: async () => { throw new Error('connection lost'); } } as unknown as BrainEngine;
    expect(await resolveArchiveEnabled(broken, { config: null })).toMatchObject({ enabled: false, source: 'config_unreadable' });
    expect(await archiveEnabled(broken)).toBe(false);
  });

  test('a thin client and a remote caller resolve off, even with the switch on', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await engine.setConfig(ARCHIVE_ENABLED_KEY, 'true');
    expect(await resolveArchiveEnabled(engine, { config: { remote_mcp: { issuer_url: 'https://brain.example.invalid' } } as never })).toMatchObject({ enabled: false, source: 'thin_client' });
    expect(await resolveArchiveEnabled(engine, { config: null, remote: true })).toMatchObject({ enabled: false, source: 'remote' });
  });
});

describe('a keyless default-on run', () => {
  test('writes the day and makes no network call', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('network call from a keyless archive run'); }) as never);
    try {
      const result = await runTranscriptArchive(engine, {
        mode: 'run', now: new Date('2026-11-10T09:00:00Z'),
        readers: [staticReader('codex', [conversation('codex', 'codex-session-default', [['user', '2026-11-10T08:00:00.000Z', 'hello from alice-example']])])],
      });
      expect(result.enabled).toBe(true);
      expect(result.written).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 60_000);
});
