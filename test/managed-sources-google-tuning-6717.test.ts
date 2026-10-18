/**
 * #6717: managed `sources add --kind google` keeps the per-source tuning flags
 * (--contacts-dir, --future-days, --loops-exclude-labels, --calendar-id). The
 * managed intent builder writes the same google config as the legacy
 * (unmanaged) add path, which serializes them through googleTuningConfig.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { googleTuningConfig } from '../src/core/google/source-config.ts';
import { addSource, type AddSourceOpts } from '../src/core/sources-ops.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
});
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

const tuning = { calendarId: 'team@example.invalid', contactsDir: 'contacts', futureDays: 30, loopsExcludeLabels: ['a', 'b'] };
const googleOpts = (id: string, dir: string): AddSourceOpts => ({
  id,
  google: { account: 'user@example.invalid', services: ['contacts', 'calendar'], historyDays: 90, dir,
    access: 'command', tokenCommand: 'example-token-command', ...tuning },
} as AddSourceOpts);

describe('managed google source add keeps the tuning config (#6717)', () => {
  test('managedSourceAddInput writes every googleTuningConfig key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6717-'));
    const { config } = managedSourceAddInput(googleOpts('g-managed', dir));
    expect(googleTuningConfig(tuning)).toEqual({ g_calendar_id: 'team@example.invalid', g_contacts_dir: 'contacts', g_future_days: 30, g_loops_exclude_labels: 'a,b' });
    expect(config).toEqual({
      kind: 'google', g_account: 'user@example.invalid', g_services: 'contacts,calendar', g_history_days: 90,
      ...googleTuningConfig(tuning),
      g_access: 'command', g_token_command: 'example-token-command', g_managed: false, federated: true,
    });
  });

  test('the managed intent config equals what the legacy add path stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6717-legacy-'));
    await addSource(engine, googleOpts('g-legacy', dir));
    const [row] = await engine.executeRaw<{ config: unknown }>(`SELECT config FROM sources WHERE id = 'g-legacy'`);
    const stored = typeof row!.config === 'string' ? JSON.parse(row!.config) : row!.config;
    expect(managedSourceAddInput(googleOpts('g-legacy', dir)).config).toEqual(stored as Record<string, unknown>);
  });
});
