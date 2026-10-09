/**
 * Doc test for docs/guides/repair.md "Held files" (#5988). It builds the
 * walkthrough's fixture with the real CLI on a throwaway PGLite brain: a Git
 * source synced once, then three generator-written notes committed while
 * `sync.holds=fail` (the pre-upgrade fail-closed behavior) so the source is
 * blocked. Then it runs every `$ ` command in the section's console blocks, in
 * order, and checks that each output line the guide shows appears in the
 * real output (ids, hashes, times and the checkout path normalized), and that
 * every command exits 0. A changed message, command or flow fails here before
 * the guide can drift from the CLI.
 *
 * Protects: the documented recovery path (post-upgrade notice, in-place
 * conversion, sources status, two-pass hash-bound repair with --skip/--only,
 * clean sync, doctor). Serial: it spawns about twenty CLI processes.
 *
 * #6278: the second test walks a source holding a frontmatter hold, a fence
 * hold and a preparation-stalled hold at once through every hold surface in
 * process (sync result, sources status lines, doctor, retry-held, read
 * notices, the remote relay) and checks each routes the three kinds apart:
 * frontmatter repair, fence repair, and writer status then retry-held and the
 * option-preserving sync. Never frontmatter repair for a stalled hold.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { holdRepairSteps, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { coverageRoute, fileHeldField, heldFilesNotice, hostOperatorFix, readHeldCoverage, readHeldPages } from '../src/core/persistence/held-reads.ts';
import { gitHoldStatusLines, readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = join(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'gbrain-held-walkthrough-'));
const checkout = join(work, 'notes');
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && !['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID'].includes(key))) as Record<string, string>;
env.GBRAIN_HOME = join(work, 'home');

afterAll(() => rmSync(work, { recursive: true, force: true }));

// The mixed-holds test below shares this engine; the walkthrough spawns the CLI and needs none.
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

function run(argv: string[]): { out: string; status: number | null } {
  const [cmd, ...args] = argv[0] === 'gbrain' ? [process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), ...argv.slice(1)] : argv;
  const result = spawnSync(cmd!, args, { cwd: REPO, env, encoding: 'utf8', timeout: 120_000 });
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status };
}

function ok(argv: string[]): string {
  const result = run(argv);
  if (result.status !== 0) throw new Error(`${argv.join(' ')} exited ${result.status}:\n${result.out}`);
  return result.out;
}

const write = (files: Record<string, string>) => { for (const [path, content] of Object.entries(files)) writeFileSync(join(checkout, path), content); };
const commit = (message: string) => { ok(['git', '-C', checkout, 'add', '-A']); ok(['git', '-C', checkout, 'commit', '-qm', message]); };

/** The guide's placeholders for values that differ per run. */
function normalize(text: string): string {
  return text.split(checkout).join('~/brain/notes')
    .replace(/\b[0-9a-f]{64}\b/g, '<hash>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?Z?)?/g, '<time>');
}

/** `a "b c" d` -> [a, b c, d]; `\"` stays a literal quote outside the guide's simple commands. */
function tokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]!);
}

interface Step { command: string; expected: string[] }

function walkthrough(): Step[] {
  const guide = readFileSync(join(REPO, 'docs', 'guides', 'repair.md'), 'utf8');
  const section = guide.slice(guide.indexOf('<a id="held-files"></a>'), guide.indexOf('<a id="frontmatter"></a>'));
  const steps: Step[] = [];
  for (const block of section.matchAll(/```console\n([\s\S]*?)```/g)) {
    for (const raw of block[1]!.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('$ ')) steps.push({ command: line.slice(2), expected: [] });
      else steps.at(-1)!.expected.push(line);
    }
  }
  return steps;
}

test('docs/guides/repair.md "Held files": every command runs and prints every line the guide shows', () => {
  const steps = walkthrough();
  expect(steps.map(step => step.command.split(' ').slice(0, 3).join(' '))).toContain('gbrain repair frontmatter');
  expect(steps.length).toBeGreaterThanOrEqual(12);

  // A source synced once by the older gbrain.
  mkdirSync(join(checkout, 'notes'), { recursive: true });
  ok(['git', 'init', '-q', checkout]);
  ok(['git', '-C', checkout, 'config', 'user.name', 'Example']);
  ok(['git', '-C', checkout, 'config', 'user.email', 'example@example.invalid']);
  write({ 'notes/roadmap.md': '---\ntitle: Widget roadmap\n---\nThe quarterly widget roadmap.\n', 'notes/standup.md': '---\ntitle: Standup\n---\nDaily standup notes.\n' });
  commit('init');
  ok(['gbrain', 'init', '--pglite', '--no-embedding']);
  ok(['gbrain', 'config', 'set', 'self_upgrade.mode', 'off']);
  ok(['gbrain', 'sources', 'add', 'notes', '--path', checkout]);
  ok(['gbrain', 'sync', '--source', 'notes', '--no-pull']);

  // The generator's notes block the source under the pre-upgrade behavior.
  ok(['gbrain', 'config', 'set', 'sync.holds', 'fail']);
  write({
    'notes/standup.md': '---\ntitle: Standup with acme-example\nthe team agreed to ship on Friday\n---\nDaily standup notes.\n',
    'notes/digest.md': '---\ntitle: Weekly digest\ntags: [launch, widgets]\ntitle: Weekly digest (draft)\n---\nWhat shipped this week.\n',
    'notes/roundup.md': '---\ntitle: Payments roundup\nauthor: acme-example (citing fund-a) (original: https://example.com/post/1)\n---\nA roundup of payments news.\n',
  });
  commit('notes from the generator');
  const blocked = run(['gbrain', 'sync', '--source', 'notes', '--no-pull']);
  expect(blocked.status).not.toBe(0);
  expect(blocked.out).toContain('Sync BLOCKED');
  ok(['gbrain', 'config', 'unset', 'sync.holds']);

  let lastHash: string | undefined;
  for (const step of steps) {
    const argv = tokens(step.command).map(token => token === '<hash>' ? lastHash ?? '<no preview hash yet>' : token.replace('~/brain/notes', checkout));
    const out = ok(argv);
    lastHash = [...out.matchAll(/--expect ([0-9a-f]{64})/g)].at(-1)?.[1] ?? lastHash;
    const shown = normalize(out);
    for (const line of step.expected) {
      if (!shown.includes(line)) throw new Error(`"$ ${step.command}" no longer prints the guide's line:\n  ${line}\nActual output:\n${shown}`);
    }
  }
  expect(run(['git', '-C', checkout, 'status', '--porcelain']).out).toBe('');
}, 600_000);

test('#6278: a source holding frontmatter, fence and preparation-stalled files routes each kind apart on every surface', () => withEnv({ GBRAIN_HOME: join(work, 'mixed-home'), GBRAIN_SYNC_FAILURES_DIR: join(work, 'mixed-home') }, async () => {
  const id = `mixed-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(work, id);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
    const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
    writeFileSync(join(root, 'notes/clean.md'), '---\ntitle: Clean\n---\nA synthetic note.\n');
    writeFileSync(join(root, 'notes/frontmatter.md'), '---\ntitle: Standup with acme-example\nthe team agreed to ship on Friday\n---\nDaily standup notes.\n');
    writeFileSync(join(root, 'notes/fence.md'), `---\ntitle: Fence\n---\nA synthetic page.\n\n${T}\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | Synthetic take | take | Nobody Example | 0.7 | 2026-01 | chat |\n${TE}\n`);
    writeFileSync(join(root, 'notes/stalled.md'), '---\ntitle: Stalled\n---\nA synthetic note whose write stalls.\n');
    git('add', '-A'); git('commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:prepared' || detail.sourceId !== id || !detail.requestId) return;
      const [row] = await engine.executeRaw<{ path: string | null }>("SELECT intent->>'path' AS path FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (row?.path === 'notes/stalled.md') throw new OperationError('preparation_stalled', 'Preparation did not finish within its attempts (forced probe).', 'Inspect the writer.');
    });
    const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
    expect(result).toMatchObject({ status: 'first_sync', added: 1, held_count: 3, holds_outstanding: 3 });
    const byPath = new Map(result.held!.map(hold => [hold.path, hold]));
    expect(byPath.get('notes/frontmatter.md')).toMatchObject({ code: 'invalid_frontmatter', fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', id, '--include-ambiguous'] } });
    expect(byPath.get('notes/fence.md')).toMatchObject({ code: 'invalid_fence', fix: { argv: ['gbrain', 'repair', 'fences', '--source', id, '--only', 'notes/fence.md'] } });
    expect(byPath.get('notes/stalled.md')).toMatchObject({ code: 'preparation_stalled', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', id, '--json'],
      then: { argv: ['gbrain', 'sources', 'retry-held', id], then: { argv: ['gbrain', 'sync', '--source', id, '--no-pull', '--no-embed', '--no-extract'] } } } });
    expect(JSON.stringify(byPath.get('notes/stalled.md'))).not.toContain('repair frontmatter');
    // The source-level route names all three; its first command is the frontmatter preview (it covers the most holds), and the stalled step never is a repair.
    const coverage = (await readHeldCoverage(engine, { sourceId: id }))[0]!;
    expect(coverageRoute(coverage)).toEqual({ fences: 1, others: 1, stalled: 1 });
    const steps = holdRepairSteps(id, coverageRoute(coverage));
    expect(steps.commands).toEqual([`gbrain repair frontmatter --source ${id}`, `gbrain repair fences --source ${id}`, `gbrain sources writer status --source ${id} --json`,
      `gbrain sources status ${id} --json`, `gbrain sources retry-held ${id}`, `gbrain sync --source ${id} --no-pull`]);
    expect(steps.text).toContain('preparation-stalled hold(s) are not file problems and need no repair');
    expect(result.holds_fix!.why).toContain('the 1 preparation-stalled hold(s) are not file problems and need no repair');
    // sources status lists each hold with its own step.
    const status = (await readGitHoldStatuses(engine, [id])).get(id)!;
    const lines = gitHoldStatusLines(id, status).join('\n');
    expect(lines).toContain('notes/stalled.md');
    expect(lines).toContain(`gbrain sources writer status --source ${id} --json`);
    expect(status.items.find(item => item.path === 'notes/stalled.md')!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', id, '--json']);
    // doctor: one finding, three kinds, the stalled one routed to writer status.
    const check = await gitHeldFilesCheck(engine, [id]);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ held: 3, sources: [{ source_id: id, fences: 1, stalled: 1, held: 3 }] });
    expect(check.message).toContain(`gbrain sources writer status --source ${id} --json`);
    expect(check.message).toContain('gbrain repair fences');
    expect(check.message).toContain('gbrain repair frontmatter');
    // retry-held schedules all three and keeps the run's options on the follow-up sync.
    const retry = await retryHeld(engine, id);
    expect(retry.scheduled).toBe(3);
    expect(retry.fix!.argv).toEqual(['gbrain', 'sync', '--source', id, '--no-pull', '--no-embed', '--no-extract']);
    expect(retry.next_action).toContain('preparation-stalled hold(s) are not file problems');
    // Read notices: local and remote, no path for the remote relay, writer status named for the stalled kind.
    const notice = heldFilesNotice([coverage], false)!;
    expect(notice.fix!.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', id]);
    expect(notice.fix!.why).toContain('writer status');
    const relay = hostOperatorFix([{ source_id: id, route: coverageRoute(coverage) }], 'why');
    expect(relay.user_message).toContain(`'gbrain sources writer status --source ${id} --json'`);
    expect(relay.user_message).toContain('the files themselves are fine');
    expect(relay.user_message).not.toContain('notes/stalled.md');
    const held = [...(await readGitSourceHolds(engine, { sourceIds: [id] }))[0]!.holds];
    const stalled = held.find(record => record.code === 'preparation_stalled')!;
    expect(stalled.page_id).toBeNull();
    // A stale page's file_held field for a stalled hold (built from the record directly: the held file here is new, so no page carries it).
    const field = fileHeldField({ record: { ...stalled, page_id: 1 }, revision: 'r1' }, true);
    expect(field.fix.actor).toBe('host_admin');
    expect(JSON.stringify(field)).not.toContain('notes/stalled.md');
    expect(field.fix.user_message).toContain('writer status');
    expect(fileHeldField({ record: { ...stalled, page_id: 1 }, revision: 'r1' }, false).fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', id, '--json']);
    expect(await readHeldPages(engine, [1])).toBeInstanceOf(Map);
  } finally {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
  }
}), 180_000);
