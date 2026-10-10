/**
 * Fix wave 4 recovery journeys (DX-O13): each journey starts from a real
 * failure, then runs the commands the product prints, verbatim and in order,
 * through the same command entry points the CLI dispatches to, and asserts how
 * many commands it took. PGLite here; PostgreSQL through
 * test/e2e/fix-wave-4-integration.test.ts.
 *
 *  (a) a held Gmail item: sources status, retry-held, sync --source, sources status (<= 4);
 *  (b) each new repair kind: the finding, the preview, the apply, the finding clear (<= 4);
 *  (c) a checkpoint timeout on a current schema with a dropped index: the refusal,
 *      the printed rebuild, the printed retry (<= 3);
 *  (d) deactivate on a brain with markers from a real activation: dry run, the printed
 *      deactivate, status classic.
 *
 * Only the network is simulated (synthetic Gmail and GitHub providers behind
 * `fetch`), plus the checkpoint-validation statement timeout that PGLite cannot
 * raise. Wall time per journey is printed for the PR body, not asserted.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { INCOMPLETE_SYNC_RECEIPT_SQL } from '../src/core/persistence/checkpoint-validation.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { createConnectorFixture, withGoogleAccount } from './helpers/connector-fixture.ts';
import { addThread, fakeGitHub, fakeGmail, githubHoldsFetch, gmailFetch } from './helpers/connector-holds-fixture.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

/** The embedding provider, simulated like the network: the printed sync commands run as on a brain with a working key. */
const embedStub = () => __setEmbedTransportForTests((async (args: { values: unknown[] }) =>
  ({ embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)) })) as never);

const fixture = createConnectorFixture();
const { engines, source, home } = fixture;
const env = fixture.env;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);
afterEach(() => __setEmbedTransportForTests(null));

class CliExit extends Error { constructor(readonly code: number) { super(`process.exit(${code})`); } }

/** Runs one `gbrain ...` line through the entry point the CLI dispatches it to; returns everything it printed. */
async function gbrain(engine: BrainEngine, line: string): Promise<{ text: string; exit: number }> {
  const argv = line.trim().split(/\s+/);
  expect(argv[0]).toBe('gbrain');
  const [command, ...args] = argv.slice(1);
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  const ewrite = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new CliExit(code ?? 0); }) as never);
  setCliExitVerdict(0);
  let code = 0;
  try {
    if (command === 'sync') await runSync(engine, args);
    else if (command === 'sources' && args[0] === 'writer') {
      // The CLI's own argument parser and operation; the CLI prints the result as JSON through a raw fd write this capture cannot see.
      const parsed = parsePersistenceAdminArgs('writer', args.slice(1));
      out.push(JSON.stringify(await runPersistenceAdministration(engine, parsed.operation, parsed.params)));
    }
    else if (command === 'sources') await runSources(engine, args);
    else if (command === 'repair') await runRepairCommand(engine, args);
    else if (command === 'doctor') await runDoctor(engine, args);
    else throw new Error(`journey dispatcher has no route for: ${line}`);
    code = currentExitCode();
  } catch (caught) {
    if (caught instanceof CliExit) code = caught.code;
    else {
      const e = caught as { message?: string; suggestion?: string; code?: string };
      out.push(`${e.code ?? 'error'}: ${e.message ?? String(caught)}${e.suggestion ? `\n${e.suggestion}` : ''}`);
      code = 1;
    }
  } finally {
    log.mockRestore(); error.mockRestore(); write.mockRestore(); ewrite.mockRestore(); exit.mockRestore();
    setCliExitVerdict(0);
    await disposePersistenceConsumer(engine);
  }
  return { text: out.join('\n'), exit: code };
}

/** The first command in `text` that starts with `prefix`, as printed (up to the end of its clause). */
function printed(text: string, prefix: string): string {
  const at = text.indexOf(prefix);
  if (at < 0) throw new Error(`expected the output to print a command starting with "${prefix}":\n${text}`);
  const rest = text.slice(at);
  const end = rest.search(/\n|`|"|'| — |, then |; |\. (?=[A-Z])|\.$|\)$/);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/[.,)]+$/, '').trim();
}

/** Counts the commands a journey ran and reports its wall time. */
function journey(name: string) {
  const started = performance.now();
  const lines: string[] = [];
  return {
    async run(engine: BrainEngine, line: string) { lines.push(line); return gbrain(engine, line); },
    finish(max: number) {
      console.info(`[journey] ${name} (${engines.length > 1 ? 'both engines' : 'one engine'}): ${lines.length} command(s), ${Math.round(performance.now() - started)} ms`);
      expect(lines.length).toBeLessThanOrEqual(max);
      return lines;
    },
  };
}

function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => impl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
  return run().finally(() => { globalThis.fetch = real; });
}

const account = 'reader@example.com';
const gmailConfig = { kind: 'google', g_account: account, g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const githubConfig = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };

test('journey (a): a held Gmail thread is cleared with the four commands the product prints', async () => withEnv(env, async () => {
  embedStub();
  for (const engine of engines) {
    const f = await source(engine, gmailConfig);
    const fx = fakeGmail(account);
    addThread(fx, 'a1b2c3d4e5f60101', Date.now() - 2 * 3_600_000);
    addThread(fx, 'a1b2c3d4e5f60202', Date.now() - 3 * 3_600_000);
    fx.failThreads.set('a1b2c3d4e5f60202', 400);
    const provider = withGoogleAccount(gmailFetch(fx), account);
    // The failure: three syncs in a row fail the same thread, so it is held and the sync summary points at the source.
    let summary = '';
    for (let i = 0; i < 3; i++) summary = (await withFetch(provider, () => gbrain(engine, `gbrain sync --source ${f.id}`))).text;
    fx.failThreads.delete('a1b2c3d4e5f60202');
    expect(summary).toContain('held');

    const j = journey('held Gmail item');
    const status = await j.run(engine, printed(summary, `gbrain sources status ${f.id}`));
    expect(status.text).toContain('a1b2c3d4e5f60202');
    const retry = await j.run(engine, printed(status.text, `gbrain sources retry-held ${f.id}`));
    expect(retry.text).toContain('1 held item(s) scheduled');
    fx.fetched.length = 0;
    const sync = await withFetch(provider, () => j.run(engine, printed(retry.text, `gbrain sync --source ${f.id}`)));
    expect(sync.exit).toBe(0);
    expect(fx.fetched).toContain('a1b2c3d4e5f60202');
    const after = await j.run(engine, printed(retry.text, `gbrain sources status ${f.id}`));
    expect(after.text).not.toContain('a1b2c3d4e5f60202');
    expect(after.text).not.toContain('held item(s)');
    j.finish(4);
  }
}), 240_000);

test('journey (b): request-indexes, from the doctor finding to a clear finding, in four commands', async () => withEnv(env, async () => {
  embedStub();
  for (const engine of engines) {
    await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_run_committed');
    const j = journey('repair request-indexes');
    const doctor = await j.run(engine, 'gbrain doctor --json');
    const finding = JSON.parse(doctor.text.slice(doctor.text.indexOf('{'))).checks.find((c: { name: string }) => c.name === 'persistence_request_indexes');
    expect(finding).toMatchObject({ status: 'warn' });
    const apply = printed(finding.message, 'gbrain repair request-indexes');
    const preview = await j.run(engine, apply.replace(/ --apply$/, ''));
    expect(preview.text).toMatch(/request-indexes.*1/);
    expect((await j.run(engine, apply)).exit).toBe(0);
    const clear = await j.run(engine, 'gbrain doctor --json');
    expect(JSON.parse(clear.text.slice(clear.text.indexOf('{'))).checks.find((c: { name: string }) => c.name === 'persistence_request_indexes'))
      .toMatchObject({ status: 'ok' });
    j.finish(4);
  }
}), 240_000);

test('journey (b): orphan-bindings, from the doctor finding to a clear finding, in four commands', async () => withEnv(env, async () => {
  embedStub();
  for (const engine of engines) {
    // An old release's leftover: the binding of a source removed before #5732.
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const [old] = await engine.executeRaw<{ incarnation: string }>("INSERT INTO sources (id, name) VALUES ('journey-orphan', 'journey-orphan') RETURNING incarnation::text");
    const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
    await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
      ['journey-orphan', old.incarnation, worktree.id]);
    await engine.executeRaw("DELETE FROM sources WHERE id = 'journey-orphan'");
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const j = journey('repair orphan-bindings');
    const doctor = await j.run(engine, 'gbrain doctor --json');
    const finding = JSON.parse(doctor.text.slice(doctor.text.indexOf('{'))).checks.find((c: { name: string }) => c.name === 'orphan_persistence_bindings');
    expect(finding).toMatchObject({ status: 'warn' });
    expect((await j.run(engine, printed(finding.message, 'gbrain repair orphan-bindings'))).text).toContain('orphan-bindings');
    const apply = printed(finding.message, 'gbrain repair orphan-bindings --apply');
    expect((await j.run(engine, apply)).exit).toBe(0);
    const clear = await j.run(engine, 'gbrain doctor --json');
    expect(JSON.parse(clear.text.slice(clear.text.indexOf('{'))).checks.find((c: { name: string }) => c.name === 'orphan_persistence_bindings'))
      .toMatchObject({ status: 'ok' });
    j.finish(4);
  }
}), 240_000);

test('journey (b): connector-fences, from the sync refusal to a sync that carries the fence, in four commands', async () => withEnv(env, async () => {
  embedStub();
  const fence = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
    + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
    + '| 1 | Ships weekly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n<!--- gbrain:facts:end -->';
  for (const engine of engines) {
    const f = await source(engine, githubConfig);
    const fx = fakeGitHub();
    fx.issues = [{ number: 1, title: 'Synthetic issue 1', body: 'Body 1', updated_at: '2026-01-01T00:00:01Z' }];
    const provider = githubHoldsFetch(fx);
    expect((await withFetch(provider, () => gbrain(engine, `gbrain sync --source ${f.id}`))).exit).toBe(0);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`UPDATE pages SET timeline=COALESCE(timeline,'') || $2 WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id, `\n\n${fence}\n`]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    fx.issues[0] = { ...fx.issues[0], body: 'Body 1 edited upstream', updated_at: '2026-01-01T00:00:04Z' };

    const j = journey('repair connector-fences');
    const refused = await withFetch(provider, () => j.run(engine, `gbrain sync --source ${f.id}`));
    expect(refused.text).toContain('connector_fence_below_timeline');
    const preview = await j.run(engine, printed(refused.text, `gbrain repair connector-fences --source ${f.id}`).replace(/ --apply$/, ''));
    expect(preview.text).toContain('connector-fences');
    expect((await j.run(engine, `${printed(refused.text, `gbrain repair connector-fences --source ${f.id}`).replace(/ --apply$/, '')} --apply`)).exit).toBe(0);
    const synced = await withFetch(provider, () => j.run(engine, `gbrain sync --source ${f.id}`));
    expect(synced.exit).toBe(0);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='gh/acme-example/app/1'`, [f.id]);
    expect(page.compiled_truth).toContain('Body 1 edited upstream');
    expect(page.compiled_truth).toContain('Ships weekly');
    j.finish(4);
  }
}), 240_000);

/** The checkpoint-validation statement times out once (Postgres: a real 5 s statement timeout; PGLite: the same SQLSTATE injected). */
function timeoutOnce(engine: BrainEngine): () => void {
  const transaction = engine.transaction;
  let fired = false;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql !== INCOMPLETE_SYNC_RECEIPT_SQL || fired) return target.executeRaw(sql, params);
        fired = true;
        if (engine.kind === 'postgres') return target.executeRaw('SELECT pg_sleep(8)::text AS request_id');
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  return () => { engine.transaction = transaction; };
}

test('journey (c): a checkpoint timeout with a dropped index recovers with the refusal, the printed rebuild and the printed retry', async () => withEnv(env, async () => {
  embedStub();
  for (const engine of engines) {
    const id = `journey-ck-${engine.kind}`, root = join(home, id);
    mkdirSync(root);
    execFileSync('git', ['-C', root, 'init', '-q']);
    for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nObservation ${name} for the checkpoint.\n`);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content']);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw('DROP INDEX IF EXISTS persistence_requests_sync_run_committed');

    const j = journey('checkpoint timeout with a dropped index');
    const restore = timeoutOnce(engine);
    let refused: { text: string; exit: number };
    try {
      refused = await j.run(engine, `gbrain sync --source ${id} --no-pull --no-embed --no-extract`);
      // A real 5 s statement timeout outlasts the sync's own wait; the terminal refusal is then reported by the same command's receipt.
      for (let waited = 0; !refused.text.includes('checkpoint_validation_timeout') && waited < 30_000; waited += 500) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const [row] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint'", [id]);
        if (row?.state === 'failed') refused = await j.run(engine, `gbrain sync --source ${id} --no-pull --no-embed --no-extract`);
      }
    } finally { restore(); }
    expect(refused.text).toContain('checkpoint_validation_timeout');
    expect((await j.run(engine, printed(refused.text, 'gbrain repair request-indexes'))).exit).toBe(0);
    const retried = await j.run(engine, printed(refused.text, `gbrain sync --source ${id} --no-pull --retry-failed`));
    expect(retried.exit).toBe(0);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed' AND state<>'failed'", [id])).toEqual([]);
    expect((await engine.getPage('a', { sourceId: id }))?.title).toBe('a');
    j.finish(3);
  }
}), 240_000);

for (const backend of testBackends()) {
  test(`journey (d) ${backend}: deactivate a brain activated for real, with the printed commands`, () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'notes/one', 'Body one.');
    // Quiesce the writer first, as the runbook does: the owner finishes (and clears the recovery of) its last publication.
    await disposePersistenceConsumer(engine);
    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_effects SET state='committed'"); });
    for (let i = 0; i < 100 && (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE recovery IS NOT NULL OR state IN ('queued','running','recovering')")).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(existsSync(join(root, '.gbrain-managed'))).toBe(true);
    const j = journey(`deactivate (${backend})`);
    const dry = await j.run(engine, 'gbrain sources writer deactivate --dry-run');
    expect(JSON.parse(dry.text)).toMatchObject({ mode: 'managed', blockers: [] });
    const done = await j.run(engine, printed(dry.text, 'gbrain sources writer deactivate --admin-intent'));
    expect(JSON.parse(done.text)).toMatchObject({ mode: 'classic', deactivated: true });
    const status = await j.run(engine, 'gbrain sources writer status');
    expect(JSON.parse(status.text)).toMatchObject({ mode: 'classic' });
    expect(existsSync(join(root, '.gbrain-managed'))).toBe(false);
    j.finish(3);
  }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined }), 240_000);
}
