/**
 * #6904: a managed write is refused `migrations_pending` (reason `schema_behind`) while the brain's schema is behind
 * this build, before a request id is admitted.
 *
 * Protects: with `config.version` one step behind `LATEST_SCHEMA_VERSION`, put_page refuses with the protocol fix
 * (`gbrain apply-migrations --yes`, verify `gbrain doctor --json`) and admits nothing; the same request id commits once
 * the schema is at head again; a replay of an id accepted before the schema fell behind still reconciles; and a write
 * made while this process holds the apply-migrations orchestration lock is admitted. A real PGLite brain with a managed,
 * claimed canonical worktree.
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
import { submitPageBatch } from '../src/core/persistence/page-batch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { acquireMigrationOrchestrationLock } from '../src/core/migration-orchestration-lock.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
let engine: BrainEngine;
let dir: string;
let ctx: OperationContext;
const SOURCE = 'schema-behind';

const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;
const put = (slug: string, requestId: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug), request_id: requestId } });
const requests = async (requestId: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1', [requestId])).map(row => row.state);
const live = async (slug: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [SOURCE, slug]))[0]!.n === 1;
const behind = () => engine.setConfig('version', String(LATEST_SCHEMA_VERSION - 1));
const atHead = () => engine.setConfig('version', String(LATEST_SCHEMA_VERSION));

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: join(dir, 'home') }, fn);

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

describe('#6904 writes refused while the schema is behind', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-schema-behind-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const pglite = new PGLiteEngine();
    await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await inHome(() => claimWorktree(engine, SOURCE, root));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    ctx = { engine, sourceId: SOURCE, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('put_page refuses migrations_pending/schema_behind with the apply-migrations fix, admits nothing, and the same request id commits after migrating', () => inHome(async () => {
    await atHead();
    const requestId = randomUUID();
    await behind();
    try {
      const error = await refusal(() => put('notes/behind', requestId));
      expect(error.code).toBe('migrations_pending');
      expect(error.reason).toBe('schema_behind');
      expect(error.message).toContain(`v${LATEST_SCHEMA_VERSION - 1}`);
      expect(error.suggestion).toContain('the same request_id commits');
      expect(error.fix).toMatchObject({ argv: ['gbrain', 'apply-migrations', '--yes'], actor: 'agent', requires_exclusive: true, verify: { argv: ['gbrain', 'doctor', '--json'] } });
      expect(await requests(requestId)).toEqual([]);
      expect(await live('notes/behind')).toBe(false);
    } finally { await atHead(); }
    await put('notes/behind', requestId);
    expect(await requests(requestId)).toEqual(['committed']);
    expect(await live('notes/behind')).toBe(true);
  }), 60_000);

  test('a replay of a request id accepted before the schema fell behind still reconciles', () => inHome(async () => {
    await atHead();
    const requestId = randomUUID();
    await put('notes/replayed', requestId);
    await behind();
    try {
      await put('notes/replayed', requestId);
      expect(await requests(requestId)).toEqual(['committed']);
      expect((await refusal(() => put('notes/fresh', randomUUID()))).code).toBe('migrations_pending');
    } finally { await atHead(); }
  }), 60_000);

  test('put_pages (group admission) refuses the same way and admits nothing; a replayed batch still reconciles', () => inHome(async () => {
    await atHead();
    const batch = (requestId: string, prefix: string) => submitPageBatch(ctx, { request_id: requestId,
      pages: [{ slug: `notes/${prefix}-a`, content: page(`${prefix}-a`) }, { slug: `notes/${prefix}-b`, content: page(`${prefix}-b`) }], wait_ms: 5000 });
    const accepted = randomUUID();
    await batch(accepted, 'batch-accepted');
    const before = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0]!.n;
    await behind();
    try {
      const error = await refusal(() => batch(randomUUID(), 'batch-behind'));
      expect(error.code).toBe('migrations_pending');
      expect(error.reason).toBe('schema_behind');
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0]!.n).toBe(before);
      expect(await live('notes/batch-behind-a')).toBe(false);
      await batch(accepted, 'batch-accepted');
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0]!.n).toBe(before);
    } finally { await atHead(); }
  }), 60_000);

  test('a write made while this process holds the apply-migrations orchestration lock is admitted', () => inHome(async () => {
    await behind();
    try {
      const lock = (await acquireMigrationOrchestrationLock({ engine: 'pglite' } as never))!;
      const requestId = randomUUID();
      try {
        await put('notes/orchestrator', requestId);
      } finally { await lock.release(); }
      expect(await requests(requestId)).toEqual(['committed']);
      expect((await refusal(() => put('notes/after-release', randomUUID()))).code).toBe('migrations_pending');
    } finally { await atHead(); }
  }), 60_000);
});
