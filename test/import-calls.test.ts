/**
 * GST-2731 (GBRA-529 PR 3): `gbrain import <dir> --calls` (src/commands/import-calls.ts), the opt-in text mode for
 * exported call and meeting transcripts.
 *
 * Authoring gate:
 *  1. Protects: each .txt/.md call file becomes one page named from its date and title, its words kept, every
 *     credential redacted by the archive's transcript redaction before anything is stored, no readable_by of its
 *     own, keyword-only and out of the facts backstop; a rerun writes nothing again.
 *  2. Fails on: a planted credential in a stored page, a call imported twice, a changed file overwriting its page,
 *     a --prefix value read as the import folder, a page written under conversations/.
 *  3. A new mode on an existing command; test/setup-brain-layout.test.ts covers it through gbrain setup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { callPageFor, callRootId, listCallFiles, runCallImport } from '../src/commands/import-calls.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { listBudgetLimitedPages, planPageEmbedding } from '../src/core/page-embedding-budget.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
const plantedToken = (): string => 'github' + '_pat_' + randomBytes(24).toString('hex');
const MTIME = new Date(2026, 0, 15, 12).getTime();
/** A put_page wait short enough that a write held behind the worktree lock answers pending at once. */
const SHORT_WRITE_WAIT_MS = 200;

describe('call pages', () => {
  test('date and title come from a dated file name, else the first line, else the modified day', () => {
    const named = callPageFor('2026-03-04 acme-example renewal.txt', 'Alice: hello\n', MTIME, 'company/calls', []);
    expect(named).toMatchObject({ slug: 'company/calls/2026-03-04-acme-example-renewal', title: 'acme example renewal', date: '2026-03-04', date_from: 'file_name' });
    const line = callPageFor('q1/notes.md', '# Weekly sync 2026-02-01\n\nAlice: hi\n', MTIME, 'company/calls', []);
    expect(line).toMatchObject({ slug: 'company/calls/2026-02-01-weekly-sync', title: 'Weekly sync', date: '2026-02-01', date_from: 'first_line' });
    const neither = callPageFor('kickoff.txt', 'Kickoff with acme-example\nBob: hi\n', MTIME, 'calls', []);
    expect(neither).toMatchObject({ slug: 'calls/2026-01-15-kickoff-with-acme-example', date: '2026-01-15', date_from: 'modified' });
    expect(callPageFor('2026-13-45 odd.txt', 'Odd call\n', MTIME, 'calls', []).date_from).toBe('modified');
    const fm = callPageFor('call.md', '---\nfrom: export\n---\nStandup 2026-05-06\nhi\n', MTIME, 'calls', []);
    expect(fm).toMatchObject({ date: '2026-05-06', title: 'Standup' });
  });

  test('the words are kept, credentials are redacted, structure lines are neutral, and the page names no readers', () => {
    const token = plantedToken();
    const page = callPageFor('2026-03-04 sync.txt', `Alice: we agreed on annual billing.\nBob: my key is ${token} ok\n## Timeline\n`, MTIME, 'calls', []);
    expect(page.content).toContain('Alice: we agreed on annual billing.');
    expect(page.content).not.toContain(token);
    expect(page.content).toContain('Bob: my key is <REDACTED:github_pat> ok');
    expect(page.redactions).toBe(1);
    expect(page.content).toContain('\n\\## Timeline');
    expect(page.content).toContain('\nfacts_backstop: false\n');
    expect(page.content).toContain('\ntype: meeting\n');
    expect(page.content).not.toContain('readable_by');
    expect(callPageFor('2026-03-04 sync.txt', `Alice: we agreed on annual billing.\nBob: my key is ${token} ok\n## Timeline\n`, MTIME, 'calls', []).hash).toBe(page.hash);
  });

  test('a credential in a file name stays redacted in the title, though the title turns separators into spaces', () => {
    const token = plantedToken();
    const page = callPageFor(`2026-03-04 ${token}.txt`, 'Alice: hi\n', MTIME, 'calls', []);
    const payload = token.slice('github_pat_'.length);
    expect(page.content).not.toContain(payload);
    expect(page.title).not.toContain(payload);
    expect(page.slug).not.toContain(payload);
    expect(page.title).toContain('<REDACTED:github_pat>');
  });

  test('a digits-only folder id and content hash read back as the same strings', () => {
    const page = callPageFor('2026-03-04 sync.txt', 'Alice: hi\n', MTIME, 'calls', [], '012345678901');
    const ci = parseMarkdown(page.content).frontmatter.call_import as { root: unknown; hash: unknown };
    expect(ci.root).toBe('012345678901');
    expect(ci.hash).toBe(page.hash);
  });

  test('only .txt and .md files are listed; dot entries and symlinks are skipped', () => {
    const dir = temp('gbrain-calls-list-');
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, '.hidden'));
    for (const f of ['a.txt', 'sub/b.md', '.hidden/c.txt', '.d.txt', 'e.pdf']) writeFileSync(join(dir, f), 'x\n');
    symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt'));
    expect(listCallFiles(dir)).toEqual([join(dir, 'a.txt'), join(dir, 'sub', 'b.md')]);
  });
});

describe('operations filter guard', () => {
  test('accepts the call importer as a local put_page caller', () => {
    const guard = spawnSync('bash', [join(import.meta.dir, '..', 'scripts/check-operations-filter-bypass.sh')], { encoding: 'utf8' });
    expect(guard.stderr + guard.stdout).not.toContain('src/commands/import-calls.ts');
    expect(guard.status).toBe(0);
  });
});

describe('gbrain import --calls', () => {
  test('imports each call once, never overwrites a changed one, and reads --prefix before the folder', async () => {
    const root = temp('gbrain-calls-cli-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    const calls = join(root, 'calls');
    mkdirSync(calls);
    const token = plantedToken();
    const renewal = join(calls, '2026-03-04 acme-example renewal.txt');
    writeFileSync(renewal, `Alice: annual billing.\nBob: key ${token}\n`);
    const kickoff = join(calls, 'kickoff.txt');
    writeFileSync(kickoff, 'Kickoff with acme-example\nBob: onboarding first.\n');
    utimesSync(kickoff, new Date(MTIME), new Date(MTIME));
    const run = async () => {
      const r = await runCli(['import', '--calls', '--prefix', 'company/calls', calls, '--no-embed', '--json'], { env });
      return { ...r, doc: JSON.parse(r.stdout) };
    };
    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.doc).toMatchObject({ mode: 'calls', source_id: 'default', prefix: 'company/calls', total_files: 2, imported: 2, errors: 0, redactions: 1 });
    expect(first.doc.pages.map((p: any) => p.slug).sort()).toEqual(['company/calls/2026-01-15-kickoff-with-acme-example', 'company/calls/2026-03-04-acme-example-renewal']);
    const stored = await runCli(['get', 'company/calls/2026-03-04-acme-example-renewal'], { env });
    expect(stored.stdout).toContain('Alice: annual billing.');
    expect(stored.stdout).toContain('<REDACTED:github_pat>');
    expect(stored.stdout).not.toContain(token);

    const second = await run();
    expect(second.doc).toMatchObject({ imported: 0, unchanged: 2, kept: 0, errors: 0 });

    writeFileSync(renewal, 'Alice: a corrected export.\n');
    const third = await run();
    expect(third.doc).toMatchObject({ imported: 0, unchanged: 1, kept: 1, errors: 0 });
    expect((await runCli(['get', 'company/calls/2026-03-04-acme-example-renewal'], { env })).stdout).toContain('Alice: annual billing.');
    const listed = JSON.parse((await runCli(['list', '--json'], { env })).stdout) as Array<{ slug: string }>;
    expect(listed.some((p) => p.slug.startsWith('conversations/'))).toBe(false);
  }, 240_000);

  test('a rerun finds each file by its path: a new modified day or a mixed-case prefix imports nothing twice', async () => {
    const root = temp('gbrain-calls-rerun-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    const calls = join(root, 'calls');
    mkdirSync(calls);
    const kickoff = join(calls, 'kickoff.txt');
    writeFileSync(kickoff, 'Kickoff with acme-example\nBob: onboarding first.\n');
    utimesSync(kickoff, new Date(MTIME), new Date(MTIME));
    writeFileSync(join(calls, '2026-03-04 Renewal.txt'), 'Alice: hi\n');
    const run = async () => JSON.parse((await runCli(['import', calls, '--calls', '--prefix', 'Company/Calls', '--no-embed', '--json'], { env })).stdout);
    const first = await run();
    expect(first).toMatchObject({ prefix: 'company/calls', imported: 2, errors: 0 });
    expect(first.pages.map((p: any) => p.slug).sort()).toEqual(['company/calls/2026-01-15-kickoff-with-acme-example', 'company/calls/2026-03-04-renewal']);

    const later = MTIME + 36 * 86_400_000;
    utimesSync(kickoff, new Date(later), new Date(later));
    expect(await run()).toMatchObject({ imported: 0, unchanged: 2, kept: 0, errors: 0 });
    writeFileSync(kickoff, 'Kickoff with acme-example\nBob: an edited export.\n');
    utimesSync(kickoff, new Date(later), new Date(later));
    const edited = await run();
    expect(edited).toMatchObject({ imported: 0, unchanged: 1, kept: 1, errors: 0 });
    expect(edited.pages.find((p: any) => p.file === 'kickoff.txt').slug).toBe('company/calls/2026-01-15-kickoff-with-acme-example');
    const listed = JSON.parse((await runCli(['list', '--json'], { env })).stdout) as Array<{ slug: string }>;
    expect(listed.filter((p) => p.slug.startsWith('company/calls/')).length).toBe(2);
  }, 240_000);

  test('a credential in a file name is never stored or printed, and two folders with the same file name both import', async () => {
    const root = temp('gbrain-calls-paths-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    const token = plantedToken();
    const a = join(root, 'a');
    mkdirSync(join(a, `key ${token}`), { recursive: true });
    writeFileSync(join(a, `key ${token}`, 'standup.txt'), 'Standup 2026-04-01\nAlice: hi\n');
    writeFileSync(join(a, 'notes.txt'), 'Planning 2026-04-02\nAlice: plan.\n');
    const b = join(root, 'b');
    mkdirSync(b);
    writeFileSync(join(b, 'notes.txt'), 'Retro 2026-04-03\nBob: retro.\n');
    const imp = async (dir: string) => runCli(['import', dir, '--calls', '--no-embed', '--json'], { env });
    const first = await imp(a);
    expect(first.stdout).not.toContain(token);
    expect(JSON.parse(first.stdout)).toMatchObject({ imported: 2, errors: 0 });
    const stored = await runCli(['get', 'calls/2026-04-01-standup'], { env });
    expect(stored.stdout).toContain('Alice: hi');
    expect(stored.stdout).not.toContain(token);
    expect(stored.stdout).toContain('<REDACTED:github_pat>');
    expect(JSON.parse((await imp(b)).stdout)).toMatchObject({ imported: 1, kept: 0, errors: 0 });
    expect((await runCli(['get', 'calls/2026-04-03-retro'], { env })).stdout).toContain('Bob: retro.');
  }, 240_000);

  test('two files a redaction pattern names alike both import, and neither name is stored or printed', async () => {
    const root = temp('gbrain-calls-alike-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    writeFileSync(join(home, '.gbrain', 'harvest-private-patterns.txt'), 'acme-example-[0-9]+\n');
    const calls = join(root, 'calls');
    mkdirSync(calls);
    writeFileSync(join(calls, 'acme-example-1.txt'), 'Kickoff 2026-04-01\nAlice: one.\n');
    const run = async () => {
      const r = await runCli(['import', calls, '--calls', '--no-embed', '--json'], { env });
      expect(r.stdout).not.toMatch(/acme-example-\d/);
      return JSON.parse(r.stdout);
    };
    expect(await run()).toMatchObject({ imported: 1, errors: 0 });
    writeFileSync(join(calls, 'acme-example-2.txt'), 'Review 2026-04-02\nAlice: two.\n');
    const second = await run();
    expect(second).toMatchObject({ imported: 1, unchanged: 1, kept: 0, errors: 0 });
    expect(second.pages.map((p: any) => p.slug).sort()).toEqual(['calls/2026-04-01-kickoff', 'calls/2026-04-02-review']);
    expect(await run()).toMatchObject({ imported: 0, unchanged: 2, kept: 0, errors: 0 });
    const stored = await runCli(['get', 'calls/2026-04-02-review'], { env });
    expect(stored.stdout).toContain('Alice: two.');
    expect(stored.stdout).not.toMatch(/acme-example-\d/);
  }, 240_000);

  test('a single call file imports, a later folder import finds it, and a file of another kind is an error', async () => {
    const root = temp('gbrain-calls-single-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    const calls = join(root, 'calls');
    mkdirSync(calls);
    writeFileSync(join(calls, '2026-04-05 planning.txt'), 'Alice: plan.\n');
    writeFileSync(join(calls, 'agenda.pdf'), 'x\n');
    const imp = async (target: string) => {
      const r = await runCli(['import', target, '--calls', '--no-embed', '--json'], { env });
      return { code: r.exitCode, doc: JSON.parse(r.stdout) };
    };
    const single = await imp(join(calls, '2026-04-05 planning.txt'));
    expect(single.doc).toMatchObject({ total_files: 1, imported: 1, errors: 0 });
    expect(single.doc.pages[0]).toMatchObject({ file: '2026-04-05 planning.txt', slug: 'calls/2026-04-05-planning' });
    expect((await runCli(['get', 'calls/2026-04-05-planning'], { env })).stdout).toContain('Alice: plan.');
    expect((await imp(calls)).doc).toMatchObject({ total_files: 1, imported: 0, unchanged: 1, errors: 0 });
    const other = await imp(join(calls, 'agenda.pdf'));
    expect(other.code).toBe(1);
    expect(other.doc).toMatchObject({ imported: 0, errors: 1 });
  }, 240_000);
});

describe('call page embedding', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('an imported call page is held from embedding until the owner approves it, at any size', async () => {
    const page = callPageFor('2026-03-04 sync.txt', 'Alice: short call.\n', MTIME, 'calls', []);
    const parsed = parseMarkdown(page.content);
    await engine.putPage(page.slug, { type: 'meeting', title: page.title, compiled_truth: parsed.compiled_truth, frontmatter: parsed.frontmatter });
    const stored = await engine.getPage(page.slug);
    const plan = await planPageEmbedding(engine, { id: stored!.id, compiled_truth: parsed.compiled_truth, timeline: '' }, [{ chunk_index: 0, chunk_text: 'Alice: short call.' }], { signature: null });
    expect(plan).toEqual({ kind: 'held', reason: 'call_import' });
    const held = await listBudgetLimitedPages(engine, { state: 'held' });
    expect(held.map(h => [h.slug, h.reason])).toContainEqual([page.slug, 'call_import']);
  });
});

describe('call import, in process', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => mock.restore());

  test('a page imported before call_import.path was stored is still found by its file after its modified day moved', async () => {
    const dir = realpathSync(temp('gbrain-calls-legacy-'));
    writeFileSync(join(dir, 'legacy.txt'), 'Legacy sync\nAlice: legacy.\n');
    const page = callPageFor('legacy.txt', 'Legacy sync\nAlice: legacy.\n', MTIME, 'legacy', [], callRootId(dir));
    expect(page.content).not.toContain('  path:');
    const parsed = parseMarkdown(page.content);
    await engine.putPage(page.slug, { type: 'meeting', title: page.title, compiled_truth: parsed.compiled_truth, frontmatter: parsed.frontmatter });
    spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCallImport(engine, dir, ['--calls', '--prefix', 'legacy'], { json: false })).toMatchObject({ imported: 0, errors: 0 });
  });

  test('a write still pending is reported pending, not as an error, and exits 10', async () => {
    const dir = realpathSync(temp('gbrain-calls-pending-'));
    writeFileSync(join(dir, '2026-05-02 pending.txt'), 'Alice: pending.\n');
    const requestId = '7a1c0d2e-0000-4000-8000-00000000ca11';
    spyOn(operations.find(op => op.name === 'put_page')!, 'handler').mockImplementation((async () => {
      const error = new OperationError('write_pending', 'The page write was accepted and is still running.', 'Poll the receipt.');
      error.writeRequest = { request_id: requestId, state: 'queued', retry_after_ms: 500 } as never;
      throw error;
    }) as never);
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const result = await runCallImport(engine, dir, ['--calls', '--prefix', 'pending'], { json: false });
    expect(result).toMatchObject({ imported: 0, errors: 0, failures: [] });
    expect(currentExitCode()).toBe(10);
    expect(lines.join('\n')).toContain('1 pending');
    expect(lines.join('\n')).toContain(`gbrain write-request -- ${requestId}`);
  });
});

describe('call import finds the same file across import roots and pending writes', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => mock.restore());

  const callPages = (prefix: string) => engine.executeRaw<{ slug: string }>(
    "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL AND starts_with(slug, $1) ORDER BY slug", [`${prefix}/`]);

  test('a file in a subfolder of an imported folder is found by a single-file import, and the other way round', async () => {
    const calls = realpathSync(temp('gbrain-calls-nested-'));
    mkdirSync(join(calls, 'team-a'));
    mkdirSync(join(calls, 'team-b'));
    writeFileSync(join(calls, 'team-a', 'Kickoff call.txt'), 'Kickoff call\nAlice: kickoff.\n');
    writeFileSync(join(calls, 'team-b', 'Review call.txt'), 'Review call\nAlice: review.\n');
    for (const f of ['team-a/Kickoff call.txt', 'team-b/Review call.txt']) utimesSync(join(calls, f), MTIME / 1000, MTIME / 1000);
    spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCallImport(engine, join(calls, 'team-b', 'Review call.txt'), ['--calls', '--prefix', 'nested'], { json: false })).toMatchObject({ imported: 1, errors: 0 });
    expect(await runCallImport(engine, calls, ['--calls', '--prefix', 'nested'], { json: false })).toMatchObject({ imported: 1, errors: 0 });
    expect(await runCallImport(engine, join(calls, 'team-a', 'Kickoff call.txt'), ['--calls', '--prefix', 'nested'], { json: false })).toMatchObject({ imported: 0, errors: 0 });
    expect(await runCallImport(engine, join(calls, 'team-a'), ['--calls', '--prefix', 'nested'], { json: false })).toMatchObject({ imported: 0, errors: 0 });
    expect((await callPages('nested')).map(p => p.slug)).toEqual(['nested/2026-01-15-kickoff-call', 'nested/2026-01-15-review-call']);
  });

  test('a rerun while the first write is still pending finds the pending request and writes nothing', async () => {
    const fixture = realpathSync(temp('gbrain-calls-pending-rerun-'));
    const calls = join(fixture, 'calls');
    mkdirSync(join(fixture, 'brain'));
    mkdirSync(calls);
    const managed = new PGLiteEngine();
    await managed.connect({});
    await managed.initSchema();
    await managed.setConfig('sync.repo_path', join(fixture, 'brain'));
    await withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
      spyOn(console, 'log').mockImplementation(() => {});
      startPersistenceConsumer(managed, { engine: 'pglite' });
      writeFileSync(join(calls, 'Seed call.txt'), 'Seed call\nAlice: seed.\n');
      expect(await runCallImport(managed, calls, ['--calls', '--prefix', 'held'], { json: false })).toMatchObject({ imported: 1, errors: 0 });
      const put = operations.find(op => op.name === 'put_page')!;
      const handler = put.handler;
      spyOn(put, 'handler').mockImplementation(((ctx: Parameters<typeof handler>[0], params: Parameters<typeof handler>[1]) => handler({ ...ctx, writeWaitMs: SHORT_WRITE_WAIT_MS }, params)) as never);
      const file = join(calls, 'Pending call.txt');
      writeFileSync(file, 'Pending call\nAlice: pending.\n');
      utimesSync(file, MTIME / 1000, MTIME / 1000);
      const requests = () => managed.executeRaw<{ slug: string; request_id: string }>(
        "SELECT slug, request_id::text AS request_id FROM persistence_requests WHERE source_id='default' AND operation='put_page' AND slug LIKE 'held/%pending-call' ORDER BY sequence");
      const lock = (await acquireWorktree((await getWorktreeBinding(managed, 'default'))!))!;
      try {
        expect(await runCallImport(managed, calls, ['--calls', '--prefix', 'held'], { json: false })).toMatchObject({ imported: 0, errors: 0 });
        expect(currentExitCode()).toBe(10);
        const [pending] = await requests();
        expect(pending).toBeDefined();
        utimesSync(file, MTIME / 1000 + 3 * 86_400, MTIME / 1000 + 3 * 86_400);
        _resetCliExitVerdictForTests();
        const lines: string[] = [];
        spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
        expect(await runCallImport(managed, calls, ['--calls', '--prefix', 'held'], { json: false })).toMatchObject({ imported: 0, errors: 0 });
        expect(currentExitCode()).toBe(10);
        expect(await requests()).toEqual([pending!]);
        expect(lines.join('\n')).toContain(`gbrain write-request -- ${pending!.request_id}`);
      } finally { await lock.release(); }
    }).finally(async () => { await disposePersistenceConsumer(managed); await managed.disconnect(); });
  }, 120_000);
});
