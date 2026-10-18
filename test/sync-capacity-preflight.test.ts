/**
 * #6696 (A7): a managed sync checks its remaining manifest (one request id
 * per entry and the admission reservation estimator over each file's size) against the capacity left
 * under its line (the cap for an operator's run, the background pause line
 * otherwise) before its first admission, and refuses `write_quota_insufficient`
 * with the config raise, admitting nothing. A run that passed the preflight
 * and is then refused by a cap a competing writer filled stops resumable
 * (`capacity_paused`), never as a failure, and the same command resumes it.
 * Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { drainManagedSync, drainNext, runDrain } from '../src/core/persistence/sync-drain.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const base: SyncResult = { status: 'partial', reason: 'writer_yield', fromCommit: 'a', toCommit: 'b', added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0,
  pagesAffected: [], managedCursor: { index: 1, total: 3 } };
const RESUME = 'gbrain sync --source s --no-pull';
const exhausted = () => {
  const error = new OperationError('write_quota_exhausted', 'Write capacity exhausted: principal permanent request IDs (5 used of 5).', 'raise it');
  Object.assign(error, { reason: 'lifetime_ids', detail: 'principal_lifetime_ids',
    fix: { argv: ['gbrain', 'config', 'set', 'persistence.limits.principal_lifetime_ids', '100'], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'raise' } });
  return error;
};

describe('capacity_paused in the drain', () => {
  test('a cap refusal after the preflight stops resumable with the refusal and the raise; a preflight refusal is rethrown', async () => {
    let passes = 0;
    const result = await runDrain({ backoffMs: 5, pass: async () => { if (++passes === 1) return base; throw exhausted(); } });
    expect(result).toMatchObject({ added: 1, drain: { outcome: 'resumable', stop_reason: 'capacity_paused', remaining: 2,
      capacity_pause: { code: 'write_quota_exhausted', reason: 'lifetime_ids', fix: { argv: ['gbrain', 'config', 'set', 'persistence.limits.principal_lifetime_ids', '100'], actor: 'host_admin' } } } });
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: RESUME, code: 'capacity_paused', docs: ERROR_CATALOGUE.sync_drain_capacity_paused.docs });
    expect(next.why).toContain('gbrain config set persistence.limits.principal_lifetime_ids 100');
    expect(next.why).toContain('Request ids never free');
    const preflight = Object.assign(exhausted(), { capacityPreflight: true });
    await expect(runDrain({ backoffMs: 5, pass: async () => { throw preflight; } })).rejects.toBe(preflight);
  });
});

describe('forced probe: a real managed sync against a cap', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-preflight-'));
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.(); rmSync(home, { recursive: true, force: true });
  });

  test('the preflight refuses before any admission; a competing writer mid-run pauses it resumable; the rerun finishes', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const id = `pre-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const write = (name: string) => writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\nA synthetic observation about ${name}.\n`);
      const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
      mkdirSync(join(root, 'notes'), { recursive: true });
      git('init', '-q'); write('a'); commit('fixture');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
      const requests = async () => Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests WHERE source_id=$1', [id]))[0]!.n);
      const ids = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'"))[0]!.n);
      const operator = <T>(fn: () => Promise<T>) => withAdmissionOrigin('interactive', fn);
      try {
        expect((await operator(() => drainManagedSync(engine, opts, false))).drain).toMatchObject({ outcome: 'synced', written: 1 });
        // Three new files, room for two more ids: the operator's run refuses up front.
        write('b'); write('c'); write('d'); commit('three more');
        const before = await requests();
        await engine.setConfig('persistence.limits.principal_lifetime_ids', String(await ids() + 2));
        const refusal = await operator(() => drainManagedSync(engine, opts, false)).then(() => null, error => error);
        expect(refusal).toMatchObject({ code: 'write_quota_insufficient', reason: 'lifetime_ids', fix: { actor: 'host_admin',
          argv: ['gbrain', 'config', 'set', 'persistence.limits.principal_lifetime_ids', expect.stringMatching(/^\d+$/)] } });
        expect(await requests()).toBe(before);
        // Enough room for the run: the first pass admits one page, then a competing writer fills the cap.
        await engine.setConfig('persistence.limits.principal_lifetime_ids', String(await ids() + 3));
        let passes = 0;
        const paused = await operator(() => runDrain({ announce: false, backoffMs: 10, pass: async (signal, onProgress) => {
          const { performManagedSync } = await import('../src/core/persistence/sync-run.ts');
          if (++passes === 2) await engine.executeRaw("UPDATE persistence_counters SET lifetime_ids=(SELECT value::bigint FROM config WHERE key='persistence.limits.principal_lifetime_ids') WHERE key LIKE 'principal:local_cli:%'");
          return performManagedSync(engine, { ...opts, signal, onProgress, drainStartedAt: Date.now(), capacityPreflight: passes === 1 }, { maxPages: 1, maxMs: 60_000 });
        } }));
        expect(paused.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'capacity_paused', capacity_pause: { code: 'write_quota_exhausted', reason: 'lifetime_ids' } });
        expect(await engine.getPage('notes/d', { sourceId: id })).toBeNull();
        await engine.unsetConfig('persistence.limits.principal_lifetime_ids');
        expect((await operator(() => drainManagedSync(engine, opts, false))).drain).toMatchObject({ outcome: 'synced' });
        for (const name of ['b', 'c', 'd']) expect(await engine.getPage(`notes/${name}`, { sourceId: id })).not.toBeNull();
        // A ~300 KB file reserves its size, not the 16 KiB floor: 100 KB of byte room refuses up front.
        writeFileSync(join(root, 'notes', 'large.md'), `---\ntitle: large\n---\n${'A synthetic line of prose.\n'.repeat(11_000)}`); commit('large');
        const bytes = Number((await engine.executeRaw<{ n: string }>("SELECT terminal_bytes::text AS n FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'"))[0]!.n);
        await engine.setConfig('persistence.limits.principal_terminal_bytes', String(bytes + 100_000));
        const large = await operator(() => drainManagedSync(engine, opts, false)).then(() => null, error => error);
        expect(large).toMatchObject({ code: 'write_quota_insufficient', reason: 'terminal_bytes' });
        expect(await engine.getPage('notes/large', { sourceId: id })).toBeNull();
        await engine.unsetConfig('persistence.limits.principal_terminal_bytes');
      } finally { await engine.unsetConfig('persistence.limits.principal_lifetime_ids'); await engine.unsetConfig('persistence.limits.principal_terminal_bytes'); await disposePersistenceConsumer(engine); }
    }
  }), 180_000);
});
