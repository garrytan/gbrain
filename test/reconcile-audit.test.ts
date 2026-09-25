import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { auditCanonicalSource, runReconcileAudit } from '../src/core/persistence/reconcile-audit.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let version: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  version = (await engine.getConfig('version'))!;
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function fixture(run: (root: string, source: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-audit-'));
  const root = join(home, 'canonical');
  mkdirSync(root);
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
      await resetPgliteState(engine);
      await engine.setConfig('version', version);
      const source = `audit-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      const content = '---\ntitle: Example\ntype: note\n---\nA synthetic observation.\n';
      for (const slug of ['a', 'b', 'c']) {
        const parsed = parseMarkdown(content, slug);
        await engine.putPage(slug, { ...parsed, source_path: `${slug}.md`, frontmatter: slug === 'b'
          ? { ...parsed.frontmatter, atoms_scan_hash: '0123456789abcdef', private_marker: 'fixture-value-not-in-output' } : parsed.frontmatter }, { sourceId: source });
        if (slug !== 'c') writeFileSync(join(root, `${slug}.md`), content);
      }
      await claimWorktree(engine, source, root);
      await registerLocalWriter(engine, 'cli');
      await run(root, source);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('bounded audit detects metadata drift and missing files without changing canonical state', () => fixture(async (root, source) => {
  const snapshot = await engine.readPageSnapshot('b', { sourceId: source });
  const bytes = readFileSync(join(root, 'b.md'), 'utf8');
  const before = await engine.executeRaw('SELECT last_commit,last_sync_at,incarnation FROM sources WHERE id=$1', [source]);
  const report = await runReconcileAudit(engine, { source_id: source });
  expect(report).toMatchObject({ source_id: source, inspected: 3, drifted: 2, errors: 0, complete: true, next_after: null, snapshot_only: true });
  expect(report.findings.map(row => row.slug)).toEqual(['b', 'c']);
  expect(JSON.stringify(report)).not.toContain('fixture-value-not-in-output');
  expect(JSON.stringify(report)).not.toContain(root);
  expect(await engine.readPageSnapshot('b', { sourceId: source })).toEqual(snapshot);
  expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe(bytes);
  expect(await engine.executeRaw('SELECT last_commit,last_sync_at,incarnation FROM sources WHERE id=$1', [source])).toEqual(before);
  expect(await engine.executeRaw('SELECT request_id FROM persistence_requests')).toEqual([]);
}), 60_000);

test('audit reports DB-only pages separately instead of counting them as unrepairable drift', () => fixture(async (_root, source) => {
  await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,content_hash,source_path)
    VALUES($1,'d','note','Example','A synthetic DB-only observation.','','{}'::jsonb,'synthetic-dbonly-hash',NULL)`, [source]);
  const report = await runReconcileAudit(engine, { source_id: source });
  expect(report).toMatchObject({ inspected: 4, drifted: 2, errors: 0, database_only: 1 });
  const dbOnly = report.findings.find((row) => row.slug === 'd');
  expect(dbOnly).toMatchObject({ reason: 'database_only' });
  expect(dbOnly!.suggestion).not.toContain('sources reconcile');
}), 60_000);

test('audit cursor is bounded, explicit and not a source checkpoint', () => fixture(async (_root, source) => {
  const first = await runReconcileAudit(engine, { source_id: source, limit: 1 });
  expect(first).toMatchObject({ inspected: 1, drifted: 0, next_after: 'a', complete: false });
  const second = await runReconcileAudit(engine, { source_id: source, limit: 1, after: first.next_after });
  expect(second).toMatchObject({ inspected: 1, drifted: 1, next_after: 'b', complete: false });
  const third = await runReconcileAudit(engine, { source_id: source, limit: 1, after: second.next_after });
  expect(third).toMatchObject({ inspected: 1, drifted: 1, next_after: null, complete: true });
  await expect(runReconcileAudit(engine, { source_id: source, limit: 101 })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runReconcileAudit(engine, { source_id: source, after: '../escape' })).rejects.toMatchObject({ code: 'invalid_params' });
}), 60_000);

test('activation dry-run reports drift without enabling or changing the source', () => fixture(async (_root, source) => {
  const report = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true });
  expect(report).toMatchObject({ enabled: false, activated: false, drift_audit: { complete: true, snapshot_only: true } });
  expect(report.drift_audit?.sources).toEqual([expect.objectContaining({ source_id: source, drifted: 2 })]);
  expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled: false }]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await runReconcileAudit(engine, { source_id: source })).toMatchObject({ drifted: 2, errors: 0 });
}), 60_000);

test('audit refuses source and operation grant restrictions before disclosing a page', () => fixture(async (_root, source) => {
  await registerLocalWriter(engine, 'cli', { sourceIds: [source], scopes: ['read', 'write'], operations: ['get_page'], slugPrefixes: null }, true);
  await expect(runReconcileAudit(engine, { source_id: source })).rejects.toMatchObject({ code: 'permission_denied' });
  await registerLocalWriter(engine, 'cli', { sourceIds: [source], scopes: ['read', 'write'], operations: ['put_page'], slugPrefixes: ['a'] }, true);
  await expect(runReconcileAudit(engine, { source_id: source })).rejects.toMatchObject({ code: 'permission_denied' });
  await registerLocalWriter(engine, 'cli', { sourceIds: ['default'], scopes: ['read', 'write'], operations: ['put_page'], slugPrefixes: null }, true);
  await expect(runReconcileAudit(engine, { source_id: source })).rejects.toMatchObject({ code: 'permission_denied' });
}), 60_000);

test('revocation during audit prevents returning the result', () => fixture(async (_root, source) => {
  const registration = await registerLocalWriter(engine, 'cli');
  let revoked = false;
  const proxy = new Proxy(engine, { get(target, property) {
    if (property === 'readPageSnapshot') return async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
      const snapshot = await target.readPageSnapshot(...args);
      if (!revoked) { revoked = true; await revokeLocalWriter(engine, registration.id); }
      return snapshot;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  await expect(runReconcileAudit(proxy, { source_id: source })).rejects.toMatchObject({ code: 'permission_denied' });
}), 60_000);

test('audit never claims an owner for an unbound source', () => fixture(async (_root, source) => {
  await expect(auditCanonicalSource(engine, 'default')).rejects.toMatchObject({ code: 'owner_unavailable' });
  expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings ORDER BY source_id')).toEqual([{ source_id: source }]);
}), 60_000);

test('audit without an existing host identity refuses without creating private state', () => fixture(async (_root, source) => {
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-read-only-'));
  try {
    await withEnv({ GBRAIN_HOME: otherHome }, async () => {
      await expect(auditCanonicalSource(engine, source)).rejects.toMatchObject({ code: 'owner_unavailable' });
      expect(existsSync(join(otherHome, '.gbrain'))).toBe(false);
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}), 60_000);

test('large sources remain bounded to one requested audit page without canonical churn', () => fixture(async (root, source) => {
  for (const count of [1600, 6400]) {
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,content_hash,source_path)
      SELECT $1,'scale-'||lpad(n::text,5,'0'),'note','Example','A synthetic scale observation.','','{}'::jsonb,
        'synthetic-scale-hash','scale-'||lpad(n::text,5,'0')||'.md'
      FROM generate_series(1,$2::integer) AS n ON CONFLICT(source_id,slug) DO NOTHING`, [source, count]);
    for (let index = 1; index <= 25; index++) {
      writeFileSync(join(root, `scale-${String(index).padStart(5, '0')}.md`), '---\ntitle: Example\ntype: note\n---\nA synthetic scale observation.\n');
    }
    let reads = 0;
    const proxy = new Proxy(engine, { get(target, property) {
      if (property === 'readPageSnapshot') return async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
        reads++;
        return target.readPageSnapshot(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine;
    const before = await engine.executeRaw('SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY slug', [source]);
    const report = await runReconcileAudit(proxy, { source_id: source, limit: 25, after: 'c' });
    expect(report).toMatchObject({ inspected: 25, drifted: 0, errors: 0, next_after: 'scale-00025', complete: false });
    expect(reads).toBe(25);
    expect(await engine.executeRaw('SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY slug', [source])).toEqual(before);
    expect(await engine.executeRaw('SELECT request_id FROM persistence_requests')).toEqual([]);
  }
}), 60_000);
