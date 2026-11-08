/**
 * GST-1601 part 2: a remember, capture or add_timeline_entry onto a page whose canonical file holds a one-sided local
 * edit (git HEAD and the database agree, only the worktree file moved) adopts that edit, then applies on top.
 *
 * Protects: with `persistence.adopt_local_edits` on for the page's source, the edit is published first as its own
 * owner-internal write (`managed_file_repair` carrying `adoptLocalEdit`): one commit of only that file, subject
 * `gbrain: adopt local edit to <path>`, trailers `gbrain-adopted:` and `gbrain-author: unknown`, a commit-ledger line,
 * page_versions keeping the replaced revision with change_reason `adopted_local_edit`; then the caller's write is
 * prepared again and lands as its own commit, its receipt naming `adopted`. Everything else keeps today's
 * `source_changed` / `file_database_drift` refusal and writes nothing: protected frontmatter drift, a file that does not
 * parse, a two-sided edit (HEAD differs from the database), put_page, the flag off, the flag on for another source. A
 * file still changing waits out `persistence.adopt_quiet_ms` (bounded), a file changed between the adoption's
 * preparation and publication ends `raw_file_changed` with nothing written, a repo-less brain adopts into the database
 * alone, and doctor `local_edit_adoptions` reports the adoption.
 * Seams: the refresh fixture (one clone, sources alpha and beta), managedBrain for the repo-less case, the effect
 * worker run in-process, `localEditAdoptionSeams.beforePublish`.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readLedger } from '../src/core/git/commit-ledger.ts';
import { isTerminal, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
afterEach(async () => {
  const adoption = await import('../src/core/persistence/local-edit-adoption.ts').catch(() => null);
  if (adoption) adoption.localEditAdoptionSeams.beforePublish = undefined;
});

const setConfig = (engine: BrainEngine, key: string, value: string) => engine.executeRaw(
  'INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
const clearConfig = (engine: BrainEngine) => engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.adopt%'");

/** The fixture with Git durability on, a Git identity, and adoption on for `on` (alpha by default) with no quiet window. */
const each = (fn: (f: RefreshFixture) => Promise<void>, opts: { on?: 'alpha' | 'beta' | 'none'; quietMs?: number } = {}) => (async () => {
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid'); git(f.root, 'config', 'commit.gpgsign', 'false');
    await f.engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    await clearConfig(f.engine);
    const on = opts.on ?? 'alpha';
    if (on !== 'none') await setConfig(f.engine, `persistence.adopt_local_edits.source.${on === 'alpha' ? f.alpha : f.beta}`, 'true');
    await setConfig(f.engine, 'persistence.adopt_quiet_ms', String(opts.quietMs ?? 0));
    try { await fn(f); } finally { await clearConfig(f.engine); }
  });
})();

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
/** A local CLI write; its receipt whether it settled or was left pending. */
async function local(f: RefreshFixture, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<Record<string, any>> {
  try { return await submitPageMutation(f.ctx(f.alpha), { operation, params: { request_id: randomUUID(), ...params } }) as Record<string, any>; }
  catch (error) {
    const e = error as { code?: string; writeError?: string; writeRequest?: Record<string, any> };
    if ((e.code === 'write_pending' || e.writeError === 'write_pending') && e.writeRequest) return e.writeRequest;
    throw error;
  }
}
/** The engine is shared across tests: rows are scoped to the fixture's sources (or the repo-less brain's `default`). */
type Scope = { engine: BrainEngine; alpha?: string; beta?: string };
const sources = (s: Scope) => s.alpha ? [s.alpha, s.beta!] : ['default'];
const lastRow = async (s: Scope, operation: string) => (await s.engine.executeRaw<WriteRequest>(
  "SELECT * FROM persistence_requests WHERE operation=$1 AND source_id=ANY($2::text[]) AND COALESCE(intent->>'kind','')<>'managed_file_repair' ORDER BY sequence DESC LIMIT 1", [operation, sources(s)]))[0]!;
const adoptionRows = (s: Scope) => s.engine.executeRaw<WriteRequest>(
  "SELECT * FROM persistence_requests WHERE source_id=ANY($1::text[]) AND intent->>'kind'='managed_file_repair' AND intent ? 'adoptLocalEdit' ORDER BY sequence", [sources(s)]);
/** The request's final row: waits for it while the resident consumer works. */
async function settled(engine: BrainEngine, row: WriteRequest): Promise<WriteRequest> {
  const current = (await getWriteRequestById(engine, row.id))!;
  return isTerminal(current) ? current : waitForWrite(engine, current, { engine: engine.kind } as never, 30_000);
}
const file = (f: RefreshFixture, rel: string) => readFileSync(join(f.root, 'alpha', rel), 'utf8');
const LOCAL = 'A local edit nobody committed.';
const EDITED = page('Alpha one', `The first alpha observation.\n\n${LOCAL}`);
const blobOf = (f: RefreshFixture, rel: string) => git(f.root, 'hash-object', '--', `alpha/${rel}`);
const revision = async (f: RefreshFixture, slug: string) => (await f.engine.readPageSnapshot(slug, { sourceId: f.alpha }))!.revision;
const head = (f: RefreshFixture) => git(f.root, 'rev-parse', 'HEAD');

/** Runs the effect worker until request `id`'s Git effect has committed. */
async function gitEffectDone(f: RefreshFixture, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(f.engine, { engine: f.engine.kind } as never, { hostId: localHostId() });
    const [effect] = await f.engine.executeRaw<{ state: string }>("SELECT state FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [id]);
    if (effect?.state === 'committed') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the Git effect of request ${id} did not commit`);
}

/** Every observable of one adoption followed by the caller's write. */
/** `replaces`: the caller's write replaces the page body (a capture), so the edit survives in the adopt commit and history only. */
async function expectAdopted(f: RefreshFixture, done: WriteRequest, rel: string, slug: string, blob: string, replaced: string, callerText: string, replaces = false) {
  expect(done).toMatchObject({ state: 'committed' });
  expect((done.outcome as { adopted?: unknown }).adopted).toEqual({ path: rel, blob, replaced_revision: replaced });
  const content = file(f, rel);
  if (!replaces) expect(content).toContain(LOCAL);
  expect(content).toContain(callerText);
  await gitEffectDone(f, done.id);
  const [caller, adopt] = git(f.root, 'log', '-2', '--format=%H', '--', `alpha/${rel}`).split('\n');
  const message = git(f.root, 'log', '-1', '--format=%B', adopt!);
  expect(message.split('\n')[0]).toBe(`gbrain: adopt local edit to ${rel}`);
  const note = `${rel}: worktree blob ${blob} over revision ${replaced}`;
  expect(message).toContain(`gbrain-adopted: ${note}`);
  expect(message).toContain('gbrain-author: unknown');
  expect(message).not.toContain(done.principal_id);
  expect(git(f.root, 'show', '--name-only', '--format=', adopt!).split('\n').filter(Boolean)).toEqual([`alpha/${rel}`]);
  expect(git(f.root, 'show', `${adopt}:alpha/${rel}`)).toContain(LOCAL);
  expect(git(f.root, 'show', `${adopt}:alpha/${rel}`)).not.toContain(callerText);
  expect(git(f.root, 'log', '-1', '--format=%s', caller!)).not.toContain('adopt local edit');
  expect(git(f.root, 'show', `${caller}:alpha/${rel}`)).toContain(callerText);
  const line = readLedger(join(f.root, '.git')).find(r => r.e === 'commit' && r.sha === adopt) as { adopted?: string[] } | undefined;
  expect(line?.adopted).toEqual([note]);
  const [adoption] = await adoptionRows(f);
  expect(adoption).toMatchObject({ state: 'committed', principal_kind: 'local_cli' });
  expect(adoption!.id).not.toBe(done.id);
  const versions = await f.engine.executeRaw<{ compiled_truth: string; change_reason: string | null }>(
    'SELECT v.compiled_truth, v.change_reason FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id', [f.alpha, slug]);
  const replacedVersion = versions.find(v => v.change_reason === 'adopted_local_edit');
  expect(replacedVersion).toBeDefined();
  expect(replacedVersion!.compiled_truth).not.toContain(LOCAL);
}

test('an add_timeline_entry onto an uncommitted body edit adopts the edit in its own commit, then lands on top', () => each(async f => {
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const blob = blobOf(f, 'one.md'), replaced = await revision(f, 'one');
  const out = await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry added onto the local edit.' });
  expect(out.isError).toBe(false);
  const done = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(done.principal_kind).toBe('local_stdio');
  await expectAdopted(f, done, 'one.md', 'one', blob, replaced, 'Entry added onto the local edit.');
}), 180_000);

test('a capture onto an uncommitted body edit adopts the edit, then lands on top', () => each(async f => {
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const blob = blobOf(f, 'one.md'), replaced = await revision(f, 'one');
  await local(f, 'capture', { slug: 'one', content: 'Captured onto the local edit.', force: true });
  const done = await settled(f.engine, await lastRow(f, 'capture'));
  await expectAdopted(f, done, 'one.md', 'one', blob, replaced, 'Captured onto the local edit.', true);
}), 180_000);

const PERSON = '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n';

test('a remember onto an uncommitted body edit adopts the edit, then lands on top', () => each(async f => {
  commitFile(f.root, 'alpha/people/alice-example.md', PERSON, 'person page');
  await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true });
  writeFileSync(join(f.root, 'alpha', 'people', 'alice-example.md'), PERSON.replace('Alice is a person.', `Alice is a person.\n\n${LOCAL}`));
  const blob = blobOf(f, 'people/alice-example.md'), replaced = await revision(f, 'people/alice-example');
  const out = await call(f, 'remember', { fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' });
  expect(out.isError).toBe(false);
  const done = await settled(f.engine, await lastRow(f, 'remember'));
  await expectAdopted(f, done, 'people/alice-example.md', 'people/alice-example', blob, replaced, 'alice-example likes tea');
}), 180_000);

/** A write onto `content` that must keep today's refusal and write nothing. */
async function expectRefused(f: RefreshFixture, content: string, run: () => Promise<unknown>, operation: string) {
  writeFileSync(join(f.root, 'alpha', 'one.md'), content);
  const before = { head: head(f), revision: await revision(f, 'one') };
  await run().catch(() => undefined);
  const row = await settled(f.engine, await lastRow(f, operation));
  expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((row.error_detail as { origin?: string } | null)?.origin).toBe('file_database_drift');
  expect(file(f, 'one.md')).toBe(content);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
  expect(await adoptionRows(f)).toEqual([]);
}
const timeline = (f: RefreshFixture) => () => call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Must not land.' });

test('protected frontmatter drift keeps the refusal', () => each(async f => {
  await expectRefused(f, page('Alpha renamed', `The first alpha observation.\n\n${LOCAL}`), timeline(f), 'add_timeline_entry');
  await expectRefused(f, EDITED.replace('type: note\n', 'type: note\nreadable_by: [alice-example]\n'), timeline(f), 'add_timeline_entry');
}), 180_000);

test('a file that does not parse keeps the refusal', () => each(async f => {
  await expectRefused(f, `---\ntitle: Alpha one\ntype: note\nbroken: [unclosed\n---\nThe first alpha observation.\n\n${LOCAL}\n`, timeline(f), 'add_timeline_entry');
}), 180_000);

test('a two-sided edit (HEAD moved past the database) keeps the refusal', () => each(async f => {
  commitFile(f.root, 'alpha/one.md', page('Alpha one', 'The first alpha observation.\n\nCommitted but not imported.'), 'another writer');
  await expectRefused(f, page('Alpha one', `The first alpha observation.\n\nCommitted but not imported.\n\n${LOCAL}`), timeline(f), 'add_timeline_entry');
}), 180_000);

test('put_page keeps the refusal, blind and with expected_revision', () => each(async f => {
  await expectRefused(f, EDITED, () => local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Replaced.'), force: true }), 'put_page');
  const seen = await revision(f, 'one');
  await expectRefused(f, EDITED, () => call(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Replaced.'), expected_revision: seen }), 'put_page');
}), 180_000);

test('with the flag off the refusal is unchanged', () => each(async f => {
  await expectRefused(f, EDITED, timeline(f), 'add_timeline_entry');
}, { on: 'none' }), 180_000);

test('with the flag on for another source only the refusal is unchanged', () => each(async f => {
  await expectRefused(f, EDITED, timeline(f), 'add_timeline_entry');
}, { on: 'beta' }), 180_000);

test('a file still changing is not adopted until it settles, then lands', () => each(async f => {
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const pending = call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry after the edits settled.' });
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(await adoptionRows(f)).toEqual([]);
  writeFileSync(join(f.root, 'alpha', 'one.md'), page('Alpha one', `The first alpha observation.\n\n${LOCAL}\n\nA second local edit.`));
  const blob = blobOf(f, 'one.md');
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(await adoptionRows(f)).toEqual([]);
  await pending;
  const done = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(done.state).toBe('committed');
  expect((done.outcome as { adopted?: { blob?: string } }).adopted?.blob).toBe(blob);
  expect(file(f, 'one.md')).toContain('A second local edit.');
  expect(file(f, 'one.md')).toContain('Entry after the edits settled.');
}, { quietMs: 1500 }), 180_000);

test('a file that never settles within the bound keeps the refusal', () => each(async f => {
  let n = 0;
  const touch = () => writeFileSync(join(f.root, 'alpha', 'one.md'), page('Alpha one', `The first alpha observation.\n\n${LOCAL} ${n++}`));
  touch();
  const timer = setInterval(touch, 100);
  try {
    await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Must not land.' });
    const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
    expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
    expect((row.error_detail as { origin?: string } | null)?.origin).toBe('file_database_drift');
  } finally { clearInterval(timer); }
  expect(await adoptionRows(f)).toEqual([]);
}, { quietMs: 300 }), 180_000);

test('a file changed between the adoption\'s preparation and publication ends raw_file_changed with nothing written', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = { head: head(f), revision: await revision(f, 'one') };
  const RACED = page('Alpha one', 'The first alpha observation.\n\nA third writer raced the adoption.');
  localEditAdoptionSeams.beforePublish = path => { writeFileSync(path, RACED); };
  await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Must not land.' });
  const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((row.error_detail as { origin?: string } | null)?.origin).toBe('raw_file_changed');
  const [adoption] = await adoptionRows(f);
  expect(adoption).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((adoption!.error_detail as { origin?: string } | null)?.origin).toBe('raw_file_changed');
  expect(file(f, 'one.md')).toBe(RACED);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
}), 180_000);

test('a local edit that is not valid UTF-8 keeps the refusal and its exact bytes', () => each(async f => {
  const bytes = Buffer.concat([Buffer.from(EDITED.replace(LOCAL, 'Bytes no decoder reads: ')), Buffer.from([0xff, 0xfe, 0x0a])]);
  writeFileSync(join(f.root, 'alpha', 'one.md'), bytes);
  const before = { head: head(f), revision: await revision(f, 'one') };
  await timeline(f)().catch(() => undefined);
  const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect(readFileSync(join(f.root, 'alpha', 'one.md')).equals(bytes)).toBe(true);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
  expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
}), 180_000);

test('an adoption still blocked on the worktree lock when the caller gives up is cancelled, never published later', () => each(async f => {
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = { head: head(f), revision: await revision(f, 'one') };
  const lock = (await acquireWorktree((await getWorktreeBinding(f.engine, f.alpha))!, 0, undefined, f.engine))!;
  expect(lock).not.toBeNull();
  try {
    await timeline(f)().catch(() => undefined);
    const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
    expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  } finally { await lock.release(); }
  await new Promise(resolve => setTimeout(resolve, 2000));
  const adoptions = await adoptionRows(f);
  expect(adoptions.length).toBe(1);
  expect(adoptions[0]!.state).toBe('cancelled');
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
}), 180_000);

test('a commit that moves HEAD past the database before the adoption publishes keeps the refusal and the newer commit', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = await revision(f, 'one');
  const NEWER = page('Alpha one', 'The first alpha observation.\n\nA newer commit nobody imported yet.');
  let newer = '';
  localEditAdoptionSeams.beforePublish = path => { newer = commitFile(f.root, 'alpha/one.md', NEWER); writeFileSync(path, EDITED); };
  await timeline(f)().catch(() => undefined);
  const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
  expect(head(f)).toBe(newer);
  expect(git(f.root, 'show', 'HEAD:alpha/one.md')).toContain('A newer commit nobody imported yet.');
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(await revision(f, 'one')).toBe(before);
}), 180_000);

test('a checkout whose HEAD git cannot read keeps the refusal instead of adopting as if it had no repository', () => each(async f => {
  commitFile(f.root, 'alpha/one.md', page('Alpha one', 'The first alpha observation.\n\nA commit the database never imported.'));
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = await revision(f, 'one');
  const branch = git(f.root, 'symbolic-ref', 'HEAD');
  git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/missing-example');
  try {
    await timeline(f)().catch(() => undefined);
    const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
    expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  } finally { git(f.root, 'symbolic-ref', 'HEAD', branch); }
  expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(await revision(f, 'one')).toBe(before);
}), 180_000);

test('a caller cancelled while its adoption waits for the file to settle has nothing adopted', () => each(async f => {
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = { head: head(f), revision: await revision(f, 'one') };
  const pending = timeline(f)().catch(() => undefined);
  let caller: WriteRequest | undefined;
  for (let i = 0; i < 100 && !caller; i++) {
    const [row] = await f.engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE operation='add_timeline_entry' AND source_id=$1 AND state='running' ORDER BY sequence DESC LIMIT 1", [f.alpha]);
    if (row) caller = row; else await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(caller).toBeDefined();
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await cancelWriteRequest(f.engine, requestPrincipal(caller!), caller!.request_id))?.state).toBe('cancelled');
  await pending;
  await new Promise(resolve => setTimeout(resolve, 4000));
  expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
}, { quietMs: 2000 }), 180_000);

test('doctor local_edit_adoptions reports the adoptions of the last 24 h per source', () => each(async f => {
  const { localEditAdoptionsEntry } = await import('../src/commands/doctor/checks/local-edit-adoptions.ts');
  const run = async () => (await localEditAdoptionsEntry.run({ engine: f.engine, progress: { heartbeat() {} } } as never) as Array<{ name: string; status: string; message: string; details?: any }>)[0]!;
  expect(await run()).toMatchObject({ name: 'local_edit_adoptions', status: 'ok' });
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry for the doctor.' });
  expect((await settled(f.engine, await lastRow(f, 'add_timeline_entry'))).state).toBe('committed');
  const check = await run();
  expect(check).toMatchObject({ name: 'local_edit_adoptions', status: 'ok' });
  expect(check.details.sources.filter((s: { source_id: string }) => s.source_id === f.alpha || s.source_id === f.beta)).toEqual([{ source_id: f.alpha, adoptions: 1, paths: ['one.md'] }]);
  expect(check.message).toContain(f.alpha);
}), 180_000);

const SLUG = 'people/owner-example';
test('a repo-less brain adopts the edit into the database alone', async () => {
  for (const backend of backends) await managedBrain(async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: '---\ntype: person\ntitle: Owner\n---\n\nBody.\n' } });
    await setConfig(engine, 'persistence.adopt_local_edits.source.default', 'true');
    await setConfig(engine, 'persistence.adopt_quiet_ms', '0');
    const path = join(root, `${SLUG}.md`);
    const edited = readFileSync(path, 'utf8').replace('Body.', `Body.\n\n${LOCAL}`);
    writeFileSync(path, edited);
    const replaced = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
    await submitRememberMutation(ctx, { fact: 'Owner prefers async updates', entity: SLUG, provenance: 'test', visibility: 'world' }).catch(() => undefined);
    const done = await settled(engine, await lastRow({ engine }, 'remember'));
    expect(done.state).toBe('committed');
    const bytes = Buffer.from(edited);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    expect((done.outcome as { adopted?: unknown }).adopted).toEqual({ path: `${SLUG}.md`, blob, replaced_revision: replaced });
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(LOCAL);
    expect(content).toContain('Owner prefers async updates');
    const versions = await engine.executeRaw<{ change_reason: string | null }>(
      "SELECT v.change_reason FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id='default' AND p.slug=$1", [SLUG]);
    expect(versions.some(v => v.change_reason === 'adopted_local_edit')).toBe(true);
  }, backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {});
}, 180_000);

// ── #8755 hardening ─────────────────────────────────────────────────────────

test('#8755 a: a write to another page on the same worktree is not held for the full quiet bound behind an adoption whose file never settles', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  localEditAdoptionSeams.maxWaitMs = 1500;
  let n = 0;
  const touch = () => writeFileSync(join(f.root, 'alpha', 'one.md'), page('Alpha one', `The first alpha observation.\n\n${LOCAL} ${n++}`));
  touch();
  const timer = setInterval(touch, 100);
  try {
    const pending = timeline(f)().catch(() => undefined);
    for (let i = 0; i < 100 && !(await f.engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='add_timeline_entry' AND source_id=$1 AND state='running'", [f.alpha])).length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now();
    const other = await local(f, 'put_page', { slug: 'two', content: page('Alpha two', 'Another page on the same worktree.') });
    let row: WriteRequest | undefined;
    for (let i = 0; i < 150; i++) {
      [row] = await f.engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE request_id=$1::uuid", [other.request_id]);
      if (row && isTerminal(row)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(row?.state).toBe('committed');
    expect(Date.now() - started).toBeLessThan(15_000);
    await pending;
  } finally { clearInterval(timer); localEditAdoptionSeams.maxWaitMs = undefined; }
  expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
}, { quietMs: 60_000 }), 180_000);

test('#8755 b: a publication that fails after the adoption\'s commit is recovered: the adoption commits once and the caller lands', () => each(async f => {
  const { installFaultHook } = await import('../src/core/persistence/fault-points.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const blob = blobOf(f, 'one.md'), replaced = await revision(f, 'one');
  let fired = 0;
  installFaultHook((point, detail) => {
    if (point === 'publication:before_commit' && detail.operation === 'put_page' && detail.sourceId === f.alpha && fired++ === 0) {
      throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
    }
  });
  try { await timeline(f)().catch(() => undefined); } finally { installFaultHook(undefined); }
  expect(fired).toBeGreaterThan(0);
  const done = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  await expectAdopted(f, done, 'one.md', 'one', blob, replaced, 'Must not land.');
  expect(git(f.root, 'log', '--format=%s', '--', 'alpha/one.md').split('\n').filter(s => s.includes('adopt local edit'))).toHaveLength(1);
  const [adoption] = await adoptionRows(f);
  expect((adoption!.outcome as { persistence?: { git_commit?: string } }).persistence?.git_commit).toBeTruthy();
}), 180_000);

test('#8755 c: conflict markers keep the refusal: an unmerged path, and a merge in progress', () => each(async f => {
  const MARKERS = page('Alpha one', `The first alpha observation.\n\n<<<<<<< HEAD\nours\n=======\n${LOCAL}\n>>>>>>> side`);
  const base = git(f.root, 'rev-parse', 'HEAD:alpha/one.md');
  writeFileSync(join(f.root, 'theirs.tmp'), page('Alpha one', `The first alpha observation.\n\n${LOCAL}`));
  const theirs = git(f.root, 'hash-object', '-w', 'theirs.tmp');
  git(f.root, 'update-index', '--force-remove', 'alpha/one.md');
  execFileSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: `100644 ${base} 1\talpha/one.md\n100644 ${base} 2\talpha/one.md\n100644 ${theirs} 3\talpha/one.md\n` });
  await expectRefused(f, MARKERS, timeline(f), 'add_timeline_entry');
  git(f.root, 'update-index', '--add', '--cacheinfo', `100644,${base},alpha/one.md`);
  writeFileSync(join(f.root, '.git', 'MERGE_HEAD'), `${head(f)}\n`);
  try { await expectRefused(f, EDITED, timeline(f), 'add_timeline_entry'); } finally { rmSync(join(f.root, '.git', 'MERGE_HEAD'), { force: true }); }
}), 180_000);

test('#8755 d: a stale editor save keeps the refusal: the earlier revision as it was, and one missing the row gbrain added', () => each(async f => {
  const before = file(f, 'one.md');
  const out = await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry gbrain added.' });
  expect(out.isError).toBe(false);
  const added = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(added.state).toBe('committed');
  await gitEffectDone(f, added.id);
  expect(git(f.root, 'show', 'HEAD:alpha/one.md')).toContain('Entry gbrain added.');
  await expectRefused(f, before, timeline(f), 'add_timeline_entry');
  await expectRefused(f, before.replace('The first alpha observation.', `The first alpha observation.\n\n${LOCAL}`), timeline(f), 'add_timeline_entry');
}), 180_000);

test('#8755 e: a file over the page size limit keeps the refusal, and the adoption never reads it', () => each(async f => {
  const { PAGE_MAX_BYTES } = await import('../src/core/page-size-policy.ts');
  const read = fs.readFileSync, target = join(f.root, 'alpha', 'one.md');
  let adoptionReads = 0;
  const reads = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(path) === target && String(new Error().stack).includes('adoptionIntent')) adoptionReads++;
    return (read as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  try {
    await expectRefused(f, page('Alpha one', `The first alpha observation.\n\n${'x'.repeat(PAGE_MAX_BYTES + 1)}`), timeline(f), 'add_timeline_entry');
  } finally { reads.mockRestore(); }
  expect(adoptionReads).toBe(0);
}), 180_000);

test('#8755 j: an empty persistence.adopt_quiet_ms reads as the default window, not as no wait', () => each(async f => {
  await setConfig(f.engine, 'persistence.adopt_quiet_ms', '');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const written = Date.now();
  await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry after the default window.' });
  const done = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(done.state).toBe('committed');
  const [adoption] = await adoptionRows(f);
  expect(new Date(adoption!.created_at as unknown as string).getTime() - written).toBeGreaterThanOrEqual(4_000);
}), 180_000);

test('#8755 l: doctor local_edit_adoptions still counts an adoption whose receipt was compacted', () => each(async f => {
  const { localEditAdoptionsEntry } = await import('../src/commands/doctor/checks/local-edit-adoptions.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry for the doctor.' });
  expect((await settled(f.engine, await lastRow(f, 'add_timeline_entry'))).state).toBe('committed');
  const [adoption] = await adoptionRows(f);
  await f.engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    await tx.executeRaw('UPDATE persistence_requests SET intent=NULL,compacted=true WHERE id=$1::uuid', [adoption!.id]);
  });
  const check = (await localEditAdoptionsEntry.run({ engine: f.engine, progress: { heartbeat() {} } } as never) as Array<{ details?: any }>)[0]!;
  expect(check.details.sources.filter((s: { source_id: string }) => s.source_id === f.alpha)).toEqual([{ source_id: f.alpha, adoptions: 1, paths: ['one.md'] }]);
}), 180_000);

test('#8755 k: a repo-less-looking source inside an enclosing repository whose HEAD git cannot read keeps the refusal', async () => {
  for (const backend of backends) await managedBrain(async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: '---\ntype: person\ntitle: Owner\n---\n\nBody.\n' } });
    await setConfig(engine, 'persistence.adopt_local_edits.source.default', 'true');
    await setConfig(engine, 'persistence.adopt_quiet_ms', '0');
    const path = join(root, `${SLUG}.md`);
    const edited = readFileSync(path, 'utf8').replace('Body.', `Body.\n\n${LOCAL}`);
    execFileSync('git', ['init', '-q', '-b', 'main', join(root, '..')]);
    writeFileSync(path, edited);
    const before = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
    await submitRememberMutation(ctx, { fact: 'Owner prefers async updates', entity: SLUG, provenance: 'test', visibility: 'world' }).catch(() => undefined);
    const done = await settled(engine, await lastRow({ engine }, 'remember'));
    expect(done.state).not.toBe('committed');
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision).toBe(before);
    expect((await adoptionRows({ engine })).filter(r => r.state === 'committed')).toEqual([]);
  }, backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {});
}, 180_000);


test('#8755 h: an adoption names its caller\'s claim, and one whose caller no longer holds it publishes nothing', () => each(async f => {
  const { assertAdoptionCaller } = await import('../src/core/persistence/local-edit-adoption.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  await timeline(f)().catch(() => undefined);
  const done = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
  expect(done.state).toBe('committed');
  const [adoption] = await adoptionRows(f);
  const caller = (adoption!.intent as { adoptLocalEdit?: { caller?: { id: string; token: string } } }).adoptLocalEdit?.caller;
  expect(caller?.id).toBe(done.id);
  expect(caller?.token).toBeTruthy();
  const refused = await assertAdoptionCaller(f.engine, adoption!, caller).then(() => null, (e: { code?: string }) => e);
  expect(refused?.code).toBe('write_claim_lost');
}), 180_000);


test('#8755 m: a caller cancelled after its adoption prepared has nothing adopted', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = { head: head(f), revision: await revision(f, 'one') };
  let cancelled: string | undefined;
  localEditAdoptionSeams.beforePublish = async () => {
    const [caller] = await f.engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE operation='add_timeline_entry' AND source_id=$1 AND state='running' ORDER BY sequence DESC LIMIT 1", [f.alpha]);
    cancelled = (await cancelWriteRequest(f.engine, requestPrincipal(caller!), caller!.request_id))?.state;
  };
  await timeline(f)().catch(() => undefined);
  expect(cancelled).toBe('cancelled');
  const [adoption] = await adoptionRows(f);
  expect(adoption).toMatchObject({ state: 'failed', error_code: 'write_claim_lost' });
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
}), 180_000);

test('#8755 n: a conflict or a merge that starts after the adoption prepared keeps the refusal and the index', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  const base = git(f.root, 'rev-parse', 'HEAD:alpha/one.md');
  writeFileSync(join(f.root, 'theirs.tmp'), EDITED);
  const theirs = git(f.root, 'hash-object', '-w', 'theirs.tmp');
  const stages = `100644 ${base} 1\talpha/one.md\n100644 ${base} 2\talpha/one.md\n100644 ${theirs} 3\talpha/one.md\n`;
  const refused = async () => {
    const before = { head: head(f), revision: await revision(f, 'one') };
    await timeline(f)().catch(() => undefined);
    const row = await settled(f.engine, await lastRow(f, 'add_timeline_entry'));
    expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
    expect((await adoptionRows(f)).filter(r => r.state === 'committed')).toEqual([]);
    expect(file(f, 'one.md')).toBe(EDITED);
    expect(head(f)).toBe(before.head);
    expect(await revision(f, 'one')).toBe(before.revision);
  };
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  localEditAdoptionSeams.beforePublish = () => {
    git(f.root, 'update-index', '--force-remove', 'alpha/one.md');
    execFileSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: stages });
  };
  await refused();
  expect(git(f.root, 'ls-files', '-u', '--', 'alpha/one.md').split('\n')).toHaveLength(3);
  git(f.root, 'update-index', '--force-remove', 'alpha/one.md');
  git(f.root, 'update-index', '--add', '--cacheinfo', `100644,${base},alpha/one.md`);
  localEditAdoptionSeams.beforePublish = () => { writeFileSync(join(f.root, '.git', 'MERGE_HEAD'), `${head(f)}\n`); };
  try { await refused(); } finally { rmSync(join(f.root, '.git', 'MERGE_HEAD'), { force: true }); }
}), 180_000);

test('#8755 o: an adoption whose caller names no claim token ends write_claim_lost, not a database error', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  writeFileSync(join(f.root, 'alpha', 'one.md'), EDITED);
  const before = { head: head(f), revision: await revision(f, 'one') };
  let calls = 0;
  localEditAdoptionSeams.beforePublish = async () => {
    if (calls++) return;
    await f.engine.executeRaw("UPDATE persistence_requests SET intent=jsonb_set(intent, '{adoptLocalEdit,caller,token}', 'null'::jsonb) WHERE source_id=$1 AND intent ? 'adoptLocalEdit'", [f.alpha]);
    throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
  };
  await timeline(f)().catch(() => undefined);
  expect(calls).toBe(1);
  const [adoption] = await adoptionRows(f);
  expect(adoption).toMatchObject({ state: 'failed', error_code: 'write_claim_lost' });
  expect(file(f, 'one.md')).toBe(EDITED);
  expect(head(f)).toBe(before.head);
  expect(await revision(f, 'one')).toBe(before.revision);
}), 180_000);

test('#8755 p: a stale editor save matches an earlier revision whose edges hold whitespace beyond space, tab and newline', () => each(async f => {
  const { localEditAdoptionSeams } = await import('../src/core/persistence/local-edit-adoption.ts');
  let published = 0;
  localEditAdoptionSeams.beforePublish = () => { published++; };
  const EARLIER = 'An earlier body a stale editor buffer still held.';
  await f.engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, frontmatter)
    SELECT id, $1, timeline, frontmatter FROM pages WHERE source_id=$2 AND slug='one'`, [`\u00a0\ufeff${EARLIER}\u3000\u2028`, f.alpha]);
  await expectRefused(f, page('Alpha one', EARLIER), timeline(f), 'add_timeline_entry');
  expect(published).toBe(0);
}), 180_000);
