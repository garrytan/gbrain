/**
 * #6377 `gbrain repair content` (src/commands/repair-content.ts), the
 * content-repair lane as one command.
 *
 * Protects: `content` is parsed like a kind but is a lane, never a RepairKind
 * (its flags are the lane's: --only/--skip, --no-llm, --max-usd, --expect with
 * one hash per kind, --apply, --json; --slug, --yes and --all refuse); the
 * preview runs every lane kind read-only over the same selection and prints
 * each kind's own hash plus the exact apply command; `--apply --expect <hash>`
 * applies exactly that set through the real `fences` kind on a managed source
 * (the held file is repaired, committed through the Git effect and its hold
 * cleared); a hash count that does not match the lane refuses before any kind
 * runs; the exit verdict follows a kind's stop. Sentinel text never reaches an
 * output line. The two-kind contract (allowance flow, per-kind hashes, the
 * time-budget stop) is pinned in test/cycle-content-repair.test.ts with stub
 * kinds, since the CLI runs the registered lane.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { CONTENT_LANE, parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { RepairResult } from '../src/core/repair/core.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-content-'));
let engine: BrainEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_FENCE_REPAIR_SCAN_MS: '60000', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const HOLDER = 'Alice Example', MCLAIM = 'Sentinelmanualrc77 opens an office';
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const md = (title: string, body: string) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${body}`;
const holder = () => `${T}\n${TH}\n| 1 | Synthetic take | take | ${HOLDER} | 0.7 | 2026-01 | chat |\n${TE}\n`;
const manual = () => `${FB}\n${FH}\n| 1 | ${MCLAIM} | fact | 0.9 | sideways | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;
/** Claim text never reaches an output; the preview's per-file diff shows the holder cell to the operator by design (D14), so the holder is checked on the apply result only. */
const expectNoSecrets = (text: string, secrets: string[] = ['Sentinelmanualrc77', HOLDER]) => { for (const secret of secrets) expect(text).not.toContain(secret); };

async function fixture(files: Record<string, string>) {
  const id = `rc-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}

async function cli(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await runRepairCommand(engine, args); } finally { console.log = log; }
  return out.join('\n');
}

interface LaneJson { lane: string; mode: string; kinds: string[]; results: RepairResult[]; preview_hashes: Record<string, string | null>; cost: { llm_usd: number; llm_allowance_remaining_usd: number | null }; stopped: unknown[]; apply_command: string }

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
beforeEach(() => { _resetCliExitVerdictForTests(); });
afterAll(async () => { await withEnv(env, async () => { await disposePersistenceConsumer(engine); }); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('content parses like a kind but is a lane: its flags are accepted, the kind-only ones refuse', () => {
  expect(CONTENT_LANE).toBe('content');
  const parsed = parseRepairArgs(['content', '--source', 'notes', '--only', 'a.md', '--skip', 'b.md', '--no-llm', '--max-usd', '0.5', '--apply', '--expect', 'h1,h2', '--json', '--diff']);
  expect(parsed).toMatchObject({ kind: 'content', source: 'notes', only: ['a.md'], skip: ['b.md'], noLlm: true, maxUsd: 0.5, apply: true, expect: 'h1,h2', json: true, diff: true });
  expect(() => parseRepairArgs(['content', '--slug', 'people/a'])).toThrow(/--slug applies only to gbrain repair fences/);
  expect(() => parseRepairArgs(['content', '--yes'])).toThrow(/--yes/);
  expect(() => parseRepairArgs(['content', '--include-ambiguous'])).toThrow(/--include-ambiguous applies only/);
  expect(() => parseRepairArgs(['content', 'fences'])).toThrow(/at most one kind/);
});

test('preview runs the lane read-only and prints each kind\'s hash; --apply --expect <hash> repairs the held file through the fences kind and clears its hold; a wrong hash count refuses', async () => withEnv(env, async () => {
  const f = await fixture({ 'people/alice-example.md': md('Alice Example', 'A synthetic person.\n'), 'notes/a.md': md('A', 'Plain.\n') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'people/holder.md'), md('Holder', holder()));
  writeFileSync(join(f.root, 'people/manual.md'), md('Manual', manual()));
  commit(f.root, 'two malformed fences');
  expect((await performManagedSync(engine, f.opts)).held?.map(hold => hold.path).sort()).toEqual(['people/holder.md', 'people/manual.md']);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);

  await expect(cli(['content', '--all'])).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(cli(['content', '--source', f.id, '--apply', '--expect', 'h1,h2,h3'])).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await readGitHold(engine, f.id, source.incarnation, 'people/holder.md')).not.toBeNull();

  const preview = JSON.parse(await cli(['content', '--source', f.id, '--json'])) as LaneJson;
  expect(preview).toMatchObject({ lane: 'content', mode: 'dry_run', kinds: ['fences', 'slug-conflicts'], stopped: [] });
  const hash = preview.preview_hashes.fences!;
  const slugHash = preview.preview_hashes['slug-conflicts']!;
  expect(hash).toMatch(/^[0-9a-f]{16,}$/);
  expect(slugHash).toMatch(/^[0-9a-f]{16,}$/);
  expect(preview.results[1]).toMatchObject({ kind: 'slug-conflicts', mode: 'dry_run', affected: 0, listing: [] });
  const both = `${hash},${slugHash}`;
  const fences = preview.results[0]!;
  expect(fences.kind).toBe('fences');
  expect(fences.preview_hash).toBe(hash);
  expect(fences.listing!.map(entry => [entry.item, entry.class]).sort()).toEqual([[`${f.id}:people/holder.md`, 'resolver'], [`${f.id}:people/manual.md`, 'enum_unmapped']]);
  expect(preview.apply_command).toBe(`gbrain repair content --source ${f.id} --apply --expect ${both}`);
  expect(fences.apply_command).toBe(`gbrain repair fences --source ${f.id} --apply --expect ${hash}`);
  expect(currentExitCode()).toBe(0);

  const human = await cli(['content', '--source', f.id]);
  expect(human).toContain(`lane content (fences, slug-conflicts)`);
  expect(human).toContain(`preview hashes: fences=${hash}`);
  expect(human).toContain(`slug-conflicts=${slugHash}`);
  expect(human).toContain(`apply: gbrain repair content --source ${f.id} --apply --expect ${both}`);
  expectNoSecrets(human, ['Sentinelmanualrc77']);

  const applied = JSON.parse(await cli(['content', '--source', f.id, '--apply', '--expect', both, '--json'])) as LaneJson;
  expect(applied).toMatchObject({ mode: 'apply', kinds: ['fences', 'slug-conflicts'], preview_hashes: { fences: hash, 'slug-conflicts': slugHash }, stopped: [] });
  expect(applied.results[0]).toMatchObject({ mode: 'apply', applied: 1, outcomes: { repaired: 1 } });
  expect(applied.results[0]!.outcome_items![0]).toMatchObject({ outcome: 'repaired', detail: { tier: 'resolver', path: 'people/holder.md', hold_cleared: true } });
  expect(await readGitHold(engine, f.id, source.incarnation, 'people/holder.md')).toBeNull();
  expect(await readGitHold(engine, f.id, source.incarnation, 'people/manual.md')).not.toBeNull();
  expect(readFileSync(join(f.root, 'people/holder.md'), 'utf8')).toContain('people/alice-example');
  expectNoSecrets(JSON.stringify(applied));

  // The hash is spent: the same apply is preview_changed; a bare apply finds nothing left to repair but the manual hold.
  await expect(cli(['content', '--source', f.id, '--apply', '--expect', both, '--json'])).rejects.toMatchObject({ code: 'preview_changed' });
  const again = JSON.parse(await cli(['content', '--source', f.id, '--apply', '--json'])) as LaneJson;
  expect(again.results[0]).toMatchObject({ mode: 'apply', applied: 0, residuals: { enum_unmapped: 1 } });
}), 180_000);
