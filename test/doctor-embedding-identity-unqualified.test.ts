/**
 * #6113: doctor `embedding_identity_unqualified` names the one supported
 * repair for a bare legacy `embedding_model` DB row: a read-only
 * `gbrain migrate embeddings --to <provider:model> --dry-run`, filled from the
 * model configured outside the database, with an `inputs` entry only when none
 * is configured. Real PGLite (DB plane), throwaway GBRAIN_HOME (file plane).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_model'`); });

function home(file: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-embedding-identity-'));
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain.pglite'), ...file }));
  return dir;
}

async function run(row: string | null, file: Record<string, unknown> = {}): Promise<Check> {
  if (row !== null) await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_model', $1)`, [row]);
  const entry = DOCTOR_CHECK_REGISTRY.find(e => e.emits.includes('embedding_identity_unqualified'));
  expect(entry).toBeDefined();
  const ctx = { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
  return withEnv({ GBRAIN_HOME: home(file), GBRAIN_EMBEDDING_MODEL: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const checks = await entry!.run(ctx) as Check[];
    return checks.find(c => c.name === 'embedding_identity_unqualified')!;
  });
}

describe('doctor embedding_identity_unqualified (#6113)', () => {
  test('a bare legacy row warns with a copy-paste preview filled from the configured model', async () => {
    const check = await run('text-embedding-3-small', { embedding_model: 'openai:text-embedding-3-small' });
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ code: 'embedding_identity_unqualified', stored_model: 'text-embedding-3-small', target_model: 'openai:text-embedding-3-small', target_differs: false });
    expect(check.fix?.argv).toEqual(['gbrain', 'migrate', 'embeddings', '--to', 'openai:text-embedding-3-small', '--dry-run']);
    expect(check.fix?.inputs).toBeUndefined();
    expect(check.fix?.consent).toEqual([]);
    expect(check.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'embedding_identity_unqualified', '--json']);
    expect(check.message).toContain('gbrain migrate embeddings --to openai:text-embedding-3-small --dry-run');
    expect(categorizeCheck('embedding_identity_unqualified')).toBe('brain');
  });

  test('with no provider-qualified model configured the fix asks for one through inputs', async () => {
    const check = await run('text-embedding-3-small', { embedding_model: 'text-embedding-3-small' });
    expect(check.status).toBe('warn');
    expect(check.fix?.argv).toEqual(['gbrain', 'migrate', 'embeddings', '--to', '<PROVIDER_MODEL>', '--dry-run']);
    expect(check.fix?.inputs?.map(i => i.name)).toEqual(['PROVIDER_MODEL']);
    expect(check.details?.target_model).toBeNull();
  });

  test('a configured model with another name is filled in and called out as a model switch', async () => {
    const check = await run('text-embedding-3-small', { embedding_model: 'voyage:voyage-4-lite' });
    expect(check.fix?.argv?.[4]).toBe('voyage:voyage-4-lite');
    expect(check.details?.target_differs).toBe(true);
    expect(check.message).toContain('switches models');
  });

  test('a provider-qualified row and a missing row are ok', async () => {
    expect((await run('openai:text-embedding-3-small')).status).toBe('ok');
    expect((await run(null)).status).toBe('ok');
  });
});
