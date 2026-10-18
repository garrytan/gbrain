/**
 * #6904: a write that meets a missing relation or column (Postgres 42703 / 42P01) at publication is classified
 * `schema_missing`, never an owner exception `defect` with `upgrade` as its safe action.
 *
 * Protects: on a real PGLite brain whose `sources.purge_epoch` column is missing (the column the issue hit), a put_page
 * fails with `storage_error` whose detail records `reason: schema_missing`, the SQLSTATE and the missing column; the
 * write-request diagnosis is `schema_missing` / `storage` with the fix for the schema state now (at head: ask the user,
 * doctor's missing-tables check; behind: `gbrain apply-migrations --yes`); `gbrain sources writer failures` groups it under
 * the same category; and a receipt an older build recorded as an owner exception with errno 42703 reads the same way.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { databaseRefusal, publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { readTerminalFailures, readTerminalFailureSummary } from '../src/core/persistence/terminal-failures.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const SOURCE = 'schema-missing';
let engine: BrainEngine;
let dir: string;
let ctx: OperationContext;
let requestId: string;

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: join(dir, 'home') }, fn);
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;
async function diagnosis(): Promise<Record<string, any>> {
  const { operations } = await import('../src/core/operations.ts');
  const receipt = await operations.find(op => op.name === 'get_write_request')!.handler(ctx, { request_id: requestId }) as Record<string, any>;
  return receipt.diagnosis;
}

describe('#6904 a missing relation or column at publication is schema_missing', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-schema-missing-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const pglite = new PGLiteEngine();
    await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await inHome(() => claimWorktree(engine, SOURCE, root));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    ctx = { engine, sourceId: SOURCE, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
    await inHome(async () => {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/before', content: page('before'), request_id: randomUUID() } });
      await engine.executeRaw('ALTER TABLE sources DROP COLUMN purge_epoch');
      requestId = randomUUID();
      const error = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/after', content: page('after'), request_id: requestId } })
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(OperationError);
    });
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the receipt records storage_error with reason schema_missing, the SQLSTATE and the missing column', async () => {
    const [row] = await engine.executeRaw<{ state: string; error_code: string; error_message: string; error_detail: Record<string, unknown> }>(
      'SELECT state,error_code,error_message,error_detail FROM persistence_requests WHERE request_id=$1', [requestId]);
    expect(row).toMatchObject({ state: 'failed', error_code: 'storage_error', error_detail: { origin: 'database', reason: 'schema_missing', sqlstate: '42703', missing: 's.purge_epoch' } });
    expect(row!.error_message).toContain('s.purge_epoch');
    expect(publicFailureDetail(row!.error_detail)).toMatchObject({ origin: 'database', reason: 'schema_missing', sqlstate: '42703' });
  });

  test('a PL/pgSQL RAISE with SQLSTATE 42703 never puts its caller text into the failure', () => {
    const failure = databaseRefusal(Object.assign(new Error('column "acme-example-codename" does not exist'), { code: '42703', routine: 'exec_stmt_raise' }));
    expect(failure).toMatchObject({ code: 'storage_error', detail: { origin: 'database', sqlstate: '42703', reason: 'schema_missing' } });
    expect(failure!.detail).not.toHaveProperty('missing');
    expect(JSON.stringify(failure)).not.toContain('acme-example-codename');
    expect(failure!.message).toContain('has no relation or column (42703)');
  });

  test('at head the diagnosis is schema_missing / storage and asks the user, with the missing-tables check', () => inHome(async () => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const d = await diagnosis();
    expect(d).toMatchObject({ category: 'schema_missing', public_category: 'storage', class: 'systemic', safe_actions: ['repair'], needs_human: true });
    expect(d.human_reason).toContain('s.purge_epoch');
    expect(d.human_reason).toContain('schema_missing_tables');
    expect(d.human_reason).toContain('gbrain repair missing-tables');
    expect(d.fix).toMatchObject({ argv: ['gbrain', 'doctor', '--json'], next: 'ask_user' });
  }), 60_000);

  test('behind, the diagnosis fix is apply-migrations as the schema owner, then resubmit', () => inHome(async () => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION - 1));
    try {
      const d = await diagnosis();
      expect(d).toMatchObject({ category: 'schema_missing', public_category: 'storage', safe_actions: ['migrate'], needs_human: false });
      expect(d.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--yes'], next: 'run', verify: { argv: ['gbrain', 'doctor', '--json'] } });
      expect(d.fix.why).toContain('owns the gbrain tables');
    } finally { await engine.setConfig('version', String(LATEST_SCHEMA_VERSION)); }
  }), 60_000);

  test('sources writer failures groups the receipt under schema_missing, never as a defect', () => inHome(async () => {
    const listing = await readTerminalFailures(engine, { sourceId: SOURCE });
    expect(listing.status).not.toBe('unknown');
    const rows = (listing as { rows: Array<{ request_id: string; category: string }> }).rows;
    expect(rows.find(row => row.request_id === requestId)?.category).toBe('schema_missing');
    const summary = await readTerminalFailureSummary(engine, { sourceIds: [SOURCE] }) as { sources: Array<{ categories: Array<{ category: string }>; defects: unknown[] }> };
    expect(summary.sources[0]!.categories.map(entry => entry.category)).toContain('schema_missing');
    expect(summary.sources[0]!.defects).toEqual([]);
  }), 60_000);

  test('a 42P01 is schema_missing with the relation, and an older build\'s owner-exception receipt with errno 42703 reads the same way', () => {
    expect(databaseRefusal(Object.assign(new Error('relation "belief_ledger" does not exist'), { code: '42P01' })))
      .toMatchObject({ code: 'storage_error', detail: { origin: 'database', reason: 'schema_missing', sqlstate: '42P01', missing: 'belief_ledger' } });
    expect(databaseRefusal(Object.assign(new Error('syntax error at or near "x"'), { code: '42601' }))).toBeNull();
    const legacy = classifyTerminal({ source_id: SOURCE, slug: 'notes/after', operation: 'put_page', state: 'failed', error_code: 'storage_error',
      error_detail: { origin: 'owner_exception', error_class: 'PostgresError', errno: '42703' }, recovery: null, blocked_reason: null, compacted: false, schema_behind: true })!;
    expect(legacy).toMatchObject({ category: 'schema_missing', public_category: 'storage', safe_actions: ['migrate'], defect: false });
    expect(legacy.action.argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
    const unknown = classifyTerminal({ source_id: SOURCE, slug: 'notes/after', operation: 'put_page', state: 'failed', error_code: 'storage_error',
      error_detail: { origin: 'database', sqlstate: '42703', reason: 'schema_missing' }, recovery: null, blocked_reason: null, compacted: false })!;
    expect(unknown).toMatchObject({ category: 'schema_missing', safe_actions: ['none'], defect: false });
    expect(unknown.action.argv).toEqual(['gbrain', 'doctor', '--json']);
  });
});
