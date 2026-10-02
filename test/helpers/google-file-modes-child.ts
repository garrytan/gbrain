/**
 * Child process for test/google-file-modes.test.ts. File-mode assertions need
 * umask 0000, which is process-global, so every scenario runs here instead of
 * in the test process. The scenario writes one `FILE_MODES <json>` line with
 * the observed modes; the parent asserts on it.
 *
 * Synthetic data only: example.invalid addresses, hex thread ids.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { atomicWriteFileSync } from '../../src/core/atomic-write.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import { googleStateFile, parseGoogleSourceConfig, readGoogleState, runGoogleAttachmentBackfill, runGoogleSync } from '../../src/core/google/google-source.ts';
import { withConnectorSync } from '../../src/core/persistence/connector-sync.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation, recoverPublication } from '../../src/core/persistence/coordinator.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { withGoogleAccount } from './connector-fixture.ts';

process.umask(0);
const input = JSON.parse(process.env.GBRAIN_TEST_FILE_MODES!) as { scenario: string; base: string; requestId?: string };
const base = input.base;
const mode = (path: string) => lstatSync(path).mode & 0o7777;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const report = (value: unknown) => process.stdout.write(`FILE_MODES ${JSON.stringify(value)}\n`);
const ACCOUNT = 'owner@example.invalid';
const googleConfig = (services: string) => ({ kind: 'google', g_account: ACCOUNT, g_services: services, g_history_days: 90, g_access: 'env', g_token_env: 'FILE_MODES_TOKEN' });

function tree(root: string): { files: Record<string, number>; dirs: Record<string, number> } {
  const files: Record<string, number> = {};
  const dirs: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) { dirs[relative(root, path)] = mode(path); walk(path); }
      else files[relative(root, path)] = mode(path);
    }
  };
  walk(root);
  return { files, dirs };
}

const T_A = '17aa00000000a001';
const NOW = Math.floor(Date.now() / 1000) * 1000;
const message = (id: string, ms: number, body: string) => ({
  id, threadId: T_A, labelIds: [], internalDate: String(ms),
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Charlie Example <charlie@example.invalid>' },
    { name: 'To', value: ACCOUNT }, { name: 'Subject', value: 'Zephyr roadmap' }], body: { data: Buffer.from(body).toString('base64url') } },
});

function googleFetch(fx: { messages: ReturnType<typeof message>[]; history: string[][] }) {
  return withGoogleAccount(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: ACCOUNT, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/messages')) return json({ messages: fx.messages.map(m => ({ id: m.id, threadId: m.threadId })) });
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1001', history: fx.history.map(ids => ({ messages: ids.map(threadId => ({ threadId })) })) });
    if (u.pathname.endsWith(`/users/me/threads/${T_A}`)) return json({ id: T_A, messages: fx.messages });
    if (/\/calendars\/[^/]+\/events/.test(u.pathname)) return json({ items: [{ id: 'evt00000000000001', status: 'confirmed', summary: 'Zephyr sync',
      start: { dateTime: new Date(NOW - 86_400_000).toISOString() }, end: { dateTime: new Date(NOW - 82_800_000).toISOString() },
      organizer: { email: ACCOUNT } }], nextSyncToken: 'cal-1' });
    if (u.pathname.includes('/people/me/connections')) return json({ connections: [{ resourceName: 'people/c000000001',
      names: [{ displayName: 'Alice Example' }], emailAddresses: [{ value: 'alice@example.invalid' }] }], nextSyncToken: 'ppl-1' });
    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  }, ACCOUNT);
}

async function legacy(engine: BrainEngine) {
  const out: Record<string, unknown> = {};

  const atomicDir = join(base, 'atomic');
  mkdirSync(atomicDir);
  atomicWriteFileSync(join(atomicDir, 'requested'), 'x', { mode: 0o600 });
  writeFileSync(join(atomicDir, 'legacy'), 'x');
  chmodSync(join(atomicDir, 'legacy'), 0o644);
  atomicWriteFileSync(join(atomicDir, 'legacy'), 'y', { mode: 0o600 });
  atomicWriteFileSync(join(atomicDir, 'omitted'), 'x');
  writeFileSync(join(atomicDir, 'preserved'), 'x');
  chmodSync(join(atomicDir, 'preserved'), 0o640);
  atomicWriteFileSync(join(atomicDir, 'preserved'), 'y');
  out.atomic = tree(atomicDir).files;

  const added = join(base, 'missing-parent', 'added');
  await addSource(engine, { id: 'gadded', google: { account: ACCOUNT, services: ['contacts'], historyDays: 90, dir: added, access: 'env', tokenEnv: 'FILE_MODES_TOKEN' } });
  const chosen = join(base, 'chosen');
  mkdirSync(chosen);
  chmodSync(chosen, 0o755);
  await addSource(engine, { id: 'gchosen', google: { account: ACCOUNT, services: ['contacts'], historyDays: 90, dir: chosen, access: 'env', tokenEnv: 'FILE_MODES_TOKEN' } });
  out.sourcesAdd = { parent: mode(dirname(added)), added: mode(added), chosen: mode(chosen) };

  const root = join(base, 'custom-dir');
  mkdirSync(root);
  chmodSync(root, 0o755);
  const config = googleConfig('gmail,calendar,contacts');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', ['gsrc', root, JSON.stringify(config)]);
  const cfg = parseGoogleSourceConfig(config, root);
  const fx = { messages: [message('18c2f4a9b3d21e01', NOW - 2 * 86_400_000, 'Sharing the zephyr roadmap draft.')], history: [] as string[][] };
  const sync = () => runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, googleFetch(fx));
  const fresh = await sync();
  out.fresh = { status: fresh.status, root: mode(root), ...tree(root) };

  const page = Object.keys(tree(root).files).find(path => path.startsWith('emails/'))!;
  for (const path of Object.keys(tree(root).files)) chmodSync(join(root, path), 0o644);
  writeFileSync(join(root, `${page}.tmp`), 'stale bytes from a crashed sweep');
  chmodSync(join(root, `${page}.tmp`), 0o644);
  fx.messages.push(message('18c2f4a9b3d21e02', NOW - 86_400_000, 'Following up on the roadmap.'));
  fx.history = [[T_A]];
  const delta = await sync();
  out.delta = { status: delta.status, page, pageMode: mode(join(root, page)), state: mode(googleStateFile(root)), staleTmp: existsSync(join(root, `${page}.tmp`)) };

  mkdirSync(join(root, `${page}.tmp`));
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let staleDir;
  try { staleDir = await sync(); } finally { process.stderr.write = write; }
  out.staleDir = { status: staleDir.status, stderr: stderr.join(''), tmpPath: join(root, `${page}.tmp`) };

  writeFileSync(googleStateFile(root), '{ not json');
  chmodSync(googleStateFile(root), 0o644);
  const state = readGoogleState(root);
  out.quarantine = { mode: mode(`${googleStateFile(root)}.corrupt`), emptyState: state.gmail_history_id === null && state.contacts_sync_token === null };
  return out;
}

async function enablePersistence(engine: BrainEngine, enabled: boolean) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
}

/** A worktree-bound source; managed persistence stays off unless `managed` (direct coordinator fixtures write pages themselves). */
async function boundSource(engine: BrainEngine, root: string, config: Record<string, unknown> | null, managed: boolean) {
  await disposePersistenceConsumer(engine);
  await enablePersistence(engine, false);
  const id = `modes-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config ?? {})]);
  const binding = await claimWorktree(engine, id, root);
  if (managed) await enablePersistence(engine, true);
  return { id, binding };
}

const context = (engine: BrainEngine, sourceId: string): OperationContext =>
  ({ engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } } as OperationContext);

async function coordinatedRequest(engine: BrainEngine, sourceId: string, binding: Awaited<ReturnType<typeof claimWorktree>>, slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const authority = await submissionAuthority(context(engine, sourceId), 'put_page', sourceId, binding.source_incarnation, slug);
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content: 'fixture' }, intent: { content: 'fixture' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  if (row.id !== admitted.id) throw new Error('fixture claimed an unexpected request');
  return { row, snapshot };
}

const page = (body: string) => ({ type: 'note' as const, title: 'Fixture', compiled_truth: body, timeline: '', frontmatter: {} });

async function managed(engine: BrainEngine) {
  const out: Record<string, unknown> = {};
  await registerLocalWriter(engine, 'cli');

  const root = join(base, 'coordinator');
  mkdirSync(root);
  chmodSync(root, 0o755);
  const { id, binding } = await boundSource(engine, root, null, false);
  const slug = 'emails/2026/09/fixture';
  await engine.putPage(slug, page('Before'), { sourceId: id });
  const file = join(root, `${slug}.md`);
  const created = await coordinatedRequest(engine, id, binding, slug);
  const publish = (row: WriteRequest, observedRevision: string, content: string) => publishMutation(engine, row, { observedRevision,
    file: { path: file, root, content, publishMode: 0o600 },
    apply: async tx => { await tx.putPage(slug, page(content), { sourceId: id }); return {}; } });
  const first = await publish(created.row, created.snapshot.revision, 'Created');
  out.coordinatorNew = { state: first.state, file: mode(file), root: mode(root), ...tree(root) };
  chmodSync(file, 0o644);
  const rewrite = await coordinatedRequest(engine, id, binding, slug);
  const second = await publish(rewrite.row, rewrite.snapshot.revision, 'Rewritten');
  out.coordinatorRewrite = { state: second.state, file: mode(file) };

  const groot = join(base, 'google-bound');
  mkdirSync(groot);
  chmodSync(groot, 0o755);
  const gconfig = googleConfig('gmail');
  const g = await boundSource(engine, groot, gconfig, true);
  const cfg = parseGoogleSourceConfig(gconfig, groot);
  const gslug = 'emails/2026/09/thread-1';
  const content = `---\ntype: email\ntitle: Synthetic thread\nthread_id: thread1\naccount: ${ACCOUNT}\nmessage_ids: [message0000000001]\nvisibility: private\n---\nSynthetic body.\n`;
  await withConnectorSync(engine, g.id, 'google', cfg, { noEmbed: true, noExtract: true, noSchemaPack: true }, async session => {
    await session!.importMarkdown(`${gslug}.md`, content);
  });
  const gfile = join(groot, `${gslug}.md`);
  const [importRow] = await engine.executeRaw<WriteRequest>(
    "SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY sequence LIMIT 1", [g.id]);
  out.googleImport = { file: mode(gfile), root: mode(groot), ...tree(groot), intentKeys: Object.keys(importRow.intent!).sort(),
    intentText: JSON.stringify(importRow.intent) };
  chmodSync(gfile, 0o644);
  await disposePersistenceConsumer(engine);
  const backfill = await runGoogleAttachmentBackfill(engine, g.id, cfg, {}, async (url: string) => {
    if (url.includes('/profile')) return json({ emailAddress: ACCOUNT, historyId: '100' });
    return json({ id: 'thread1', messages: [{ id: 'message0000000001', payload: { mimeType: 'multipart/mixed', parts: [
      { partId: '1', filename: 'fixture.pdf', mimeType: 'application/pdf', body: { attachmentId: 'opaque', size: 17 } }] } }] });
  });
  out.googleReceipts = { status: backfill.status, file: mode(gfile) };
  await disposePersistenceConsumer(engine);
  return out;
}

async function restoreCrash(engine: BrainEngine) {
  await registerLocalWriter(engine, 'cli');
  const root = join(base, 'restore');
  mkdirSync(root);
  const { id, binding } = await boundSource(engine, root, null, false);
  const slug = 'emails/2026/09/private';
  await engine.putPage(slug, page('Private'), { sourceId: id });
  const file = join(root, `${slug}.md`);
  const created = await coordinatedRequest(engine, id, binding, slug);
  await publishMutation(engine, created.row, { observedRevision: created.snapshot.revision, file: { path: file, root, content: 'Private', publishMode: 0o600 },
    apply: async () => ({}) });
  const before = mode(file);
  const deletion = await coordinatedRequest(engine, id, binding, slug);
  report({ requestId: deletion.row.id, root, file, before });
  await publishMutation(engine, deletion.row, { observedRevision: deletion.snapshot.revision, file: { path: file, root, content: null },
    apply: async () => ({}) }, localHostId(), { boundary: async name => {
    if (name === 'after_publication') { process.stdout.write('FILE_MODES_CRASH\n'); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); }
  } });
}

async function restoreObserve(engine: BrainEngine) {
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [input.requestId]);
  const stage = (row.recovery as { staging?: { restoration?: { path: string } } }).staging?.restoration?.path;
  await recoverPublication(engine, row.id, localHostId(), false, undefined, false, { fileBoundary: name => {
    if (name !== 'restoration_staging_flushed' || !stage) return;
    report({ stage, stageMode: mode(stage) });
    process.kill(process.pid, 'SIGKILL');
  } });
}

async function restoreFinish(engine: BrainEngine) {
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [input.requestId]);
  const file = (row.recovery as { path: string }).path;
  const after = await recoverPublication(engine, row.id, localHostId());
  report({ state: after.state, recovery: after.recovery, file: existsSync(file) ? mode(file) : null });
}

const disk = input.scenario.startsWith('restore');
const engine = new PGLiteEngine();
await engine.connect(disk ? { database_path: join(base, 'database') } : {});
await engine.initSchema();
try {
  if (input.scenario === 'legacy') report(await legacy(engine));
  else if (input.scenario === 'managed') report(await managed(engine));
  else if (input.scenario === 'restore-crash') await restoreCrash(engine);
  else if (input.scenario === 'restore-observe') await restoreObserve(engine);
  else if (input.scenario === 'restore-finish') await restoreFinish(engine);
  else throw new Error(`unknown scenario ${input.scenario}`);
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
