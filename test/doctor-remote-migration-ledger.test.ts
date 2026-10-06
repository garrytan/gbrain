/**
 * C-NEW-2/C-NEW-3 on the remote doctor report: the brain host's
 * minions_migration row reads the ledger the way get_health and
 * apply-migrations do. Authoring gate: (1) protects the retry-marker reset
 * and the never-run report on doctorReportRemote; (2) fails when a forced
 * retry still reads as wedged or a skipped host migration stays silent;
 * (3) test/doctor-minions-check.test.ts covers only the local doctor;
 * (4) no production seam (real PGLite engine, isolated GBRAIN_HOME).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { doctorReportRemote } from '../src/commands/doctor/report-remote.ts';
import { MIGRATION_VERSIONS } from '../src/core/migration-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

function homeWithLedger(entries: Array<Record<string, unknown>>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-remote-ledger-'));
  mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return home;
}

async function ledgerRow(entries: Array<Record<string, unknown>>) {
  return withEnv({ GBRAIN_HOME: homeWithLedger(entries), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () =>
    (await doctorReportRemote(engine, { remote: true })).checks.find(c => c.name === 'minions_migration'));
}

describe('remote doctor migration ledger row', () => {
  test('after --force-retry the version is pending, not wedged', async () => {
    const row = await ledgerRow(['partial', 'partial', 'partial', 'retry'].map(status => ({ version: '0.53.0', status })));
    expect(row?.status).toBe('warn');
    expect(row?.message).toBe('1 host migration(s) not run yet on brain host: 0.53.0. Run on the host: gbrain apply-migrations --yes');
  }, 60_000);

  test('a host migration a newer one skipped past is reported as never run', async () => {
    const row = await ledgerRow(MIGRATION_VERSIONS.filter(v => v !== '0.53.0').map(version => ({ version, status: 'complete' })));
    expect(row?.status).toBe('warn');
    expect(row?.message).toContain('not run yet on brain host: 0.53.0');
  }, 60_000);
});
