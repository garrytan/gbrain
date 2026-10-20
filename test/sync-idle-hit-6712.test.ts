/**
 * #6712 PR 4b (design v3.2 §2.2, §11; ceo-native-2): the idle-hit gate as a deterministic test. A converged source runs
 * IDLE_TICKS no-change ticks with no obligation; at least 90% of them must be `kind: 'idle'` (read from the pass row's telemetry).
 * The full-round limits are pinned so the window holds no forced full round: `passes_since_full` starts at 0 and
 * `last_full_at` at the window's start, and the test asserts the window ends inside both limits. Then each disqualifier, from
 * an idle tick, flips the next tick off idle: a new commit, a re-screen-due hold (`hold_only`), a parser change, keep_db
 * writes the previous pass deferred, a withheld mass delete with the valve open, and the configured full-round limits
 * (passes and wall clock). PGLite here; Postgres through test/e2e/sync-idle-hit-6712-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { SYNC_FULL_ROUND_MAX_MS, SYNC_FULL_ROUND_MAX_PASSES } from '../src/core/persistence/sync-classify.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const IDLE_TICKS = 25;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};

type Row = { telemetry: { kind: string; outcome: string }; obligations: { converged?: { passes_since_full: number; last_full_at: string } } };
const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: Row }>(
  "SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'='default'", [MANAGED_SYNC_PASS_OP]))[0]!.value;
/** One tick, and the kind its pass row recorded. */
const tick = async (engine: BrainEngine) => { await performManagedSync(engine, OPTS); return (await passRow(engine)).telemetry.kind; };
/** Sets one jsonb path of the pass row (`path` is a Postgres text[] literal under completed_keys->0). */
const setRow = (engine: BrainEngine, path: string, value: unknown) => engine.executeRaw(
  "UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,$2::text[],$3::text::jsonb) WHERE op=$1 AND completed_keys->0->>'source_id'='default'",
  [MANAGED_SYNC_PASS_OP, `{0,${path}}`, JSON.stringify(value)]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b idle-hit gate (${backend})`, () => {
    test(`at least 90% of ${IDLE_TICKS} no-change ticks with no obligation run idle, inside the configured full-round limits`, () => brain(async ({ engine }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const start = new Date().toISOString();
      await setRow(engine, 'obligations,converged,passes_since_full', 0);
      await setRow(engine, 'obligations,converged,last_full_at', start);
      const kinds: string[] = [];
      for (let i = 0; i < IDLE_TICKS; i++) kinds.push(await tick(engine));
      // The window never reached a forced full round: both configured limits are still ahead of it.
      const converged = (await passRow(engine)).obligations.converged!;
      expect(converged.passes_since_full).toBeLessThan(SYNC_FULL_ROUND_MAX_PASSES);
      expect(Date.now() - Date.parse(converged.last_full_at)).toBeLessThan(SYNC_FULL_ROUND_MAX_MS);
      const idle = kinds.filter(kind => kind === 'idle').length;
      expect({ ticks: kinds.length, idle_at_least_90_percent: idle >= Math.ceil(0.9 * IDLE_TICKS) }).toEqual({ ticks: IDLE_TICKS, idle_at_least_90_percent: true });
    }), 300_000);

    test('each disqualifier turns the next tick off idle, and the tick after it is idle again', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      expect(await tick(engine)).toBe('idle');
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      const kinds: Record<string, [string, string]> = {};
      const flip = async (name: string, disqualify: () => Promise<unknown>, env: Record<string, string | undefined> = {}) => {
        await disqualify();
        const first = await withEnv(env, () => tick(engine));
        kinds[name] = [first, await tick(engine)];
      };

      await flip('new commit', async () => { writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A new commit.')); commit(root, 'edit a'); });
      await flip('re-screen-due hold', async () => {
        const page = (await engine.readPageSnapshot('notes/b', { sourceId: 'default' }))!;
        await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/b.md', source_path: 'notes/b.md', slug: 'notes/b', page_id: Number(page.page.id),
          code: 'frontmatter_slug_conflict', message: 'Synthetic frontmatter_slug_conflict hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
          meta: { recovery_version: RECOVERY_VERSION, blob_oid: git(root, 'rev-parse', 'HEAD:notes/b.md'), page_revision: page.revision } } as never));
      });
      await flip('parser change', () => setRow(engine, 'obligations,converged,parser_fp', 'an-older-parser'));
      await flip('owed keep_db writes', () => setRow(engine, 'telemetry,classes', { keep_db_pending: { count: 1, action: 'owner' } }));
      // A withheld mass delete keeps the tick idle until the owner host opens the valve.
      await setRow(engine, 'obligations,deletes_withheld', 'f'.repeat(64));
      await flip('withheld delete, valve closed', async () => {}, { GBRAIN_ALLOW_MASS_RECONCILE: undefined });
      await flip('withheld delete, valve open', async () => {}, { GBRAIN_ALLOW_MASS_RECONCILE: '1' });
      await flip('passes since full at the limit', () => setRow(engine, 'obligations,converged,passes_since_full', SYNC_FULL_ROUND_MAX_PASSES));
      await flip('last full round past the wall-clock limit', () => setRow(engine, 'obligations,converged,last_full_at', new Date(Date.now() - SYNC_FULL_ROUND_MAX_MS - 60_000).toISOString()));

      expect(kinds).toEqual({
        'new commit': ['full', 'idle'],
        're-screen-due hold': ['hold_only', 'idle'],
        'parser change': ['full', 'idle'],
        'owed keep_db writes': ['full', 'idle'],
        'withheld delete, valve closed': ['idle', 'idle'],
        'withheld delete, valve open': ['full', 'idle'],
        'passes since full at the limit': ['full', 'idle'],
        'last full round past the wall-clock limit': ['full', 'idle'],
      });
    }), 300_000);
  });
}
