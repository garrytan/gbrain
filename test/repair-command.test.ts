/**
 * `gbrain repair` core: dry run by default, --apply writes through coordinated
 * page writes, --limit + resume, the shared scope resolver, the 90% capacity
 * stop, the thin-client refusal, and the timeline_history doctor signal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { timelineRepair } from '../src/core/repair/timeline.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { timelineHistoryCheck } from '../src/commands/doctor/checks/timeline-history.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { runCli } from './helpers/cli-spawn.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-repair-'));

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
  rmSync(dataDir, { recursive: true, force: true });
});

const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
  dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as never;
const page = (body: string) => `---\ntype: note\ntitle: Example\n---\n${body}\n`;

async function brain(run: (engine: BrainEngine, sources: string[]) => Promise<void>, sourceCount = 1) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const sources = Array.from({ length: sourceCount }, () => `repair-${randomUUID().slice(0, 8)}`);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
        await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%'");
        await engine.executeRaw('UPDATE sources SET archived=true WHERE archived IS NOT TRUE');
        for (const id of sources) {
          const root = join(dir, id); mkdirSync(root);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
          await claimWorktree(engine, id, root);
        }
        await run(engine, sources);
      });
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }
}

async function pageWithHistory(engine: BrainEngine, sourceId: string, slug: string) {
  await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug, content: page(`Body of ${slug}.`), request_id: randomUUID() } });
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
    `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-07-01','legacy',$3,'' FROM pages WHERE source_id=$1 AND slug=$2`,
    [sourceId, slug, `History of ${slug}`])));
}

const markedPages = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id=$1 AND timeline LIKE '%gbrain:materialized%' ORDER BY slug`, [sourceId])).map(r => r.slug);

describe('gbrain repair timeline', () => {
  test('previews without writing, applies, and a second apply changes nothing', async () => {
    await brain(async (engine, [source]) => {
      await pageWithHistory(engine, source, 'notes/a');
      const scope = await resolveRepairScope(engine);
      expect(scope.source_ids).toEqual([source]);
      const preview = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: false });
      expect(preview).toMatchObject({ mode: 'dry_run', affected: 1, sample: [`${source}:notes/a`], cost: { lifetime_ids: 1, receipt_bytes: 16_384 },
        apply_command: 'gbrain repair timeline --apply' });
      expect(await markedPages(engine, source)).toEqual([]);
      const applied = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(applied).toMatchObject({ applied: 1, complete: true });
      expect(await markedPages(engine, source)).toEqual(['notes/a']);
      const again = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(again).toMatchObject({ affected: 0, applied: 0, complete: true });
    });
  }, 120_000);

  test('--limit stops after n items and a rerun resumes from the scope-bound checkpoint', async () => {
    await brain(async (engine, [source]) => {
      for (const slug of ['notes/a', 'notes/b', 'notes/c']) await pageWithHistory(engine, source, slug);
      const scope = await resolveRepairScope(engine);
      const first = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true, limit: 1 });
      expect(first).toMatchObject({ affected: 3, applied: 1, complete: false });
      expect(await markedPages(engine, source)).toEqual(['notes/a']);
      const second = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(second.resumed_from).not.toBeNull();
      expect(second).toMatchObject({ affected: 2, applied: 2, complete: true });
      expect(await markedPages(engine, source)).toEqual(['notes/a', 'notes/b', 'notes/c']);
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='repair'")).toEqual([]);
    });
  }, 120_000);

  test('preview and apply on a two-source brain with identical slugs report and touch the same scope', async () => {
    await brain(async (engine, [a, b]) => {
      await pageWithHistory(engine, a, 'notes/same');
      await pageWithHistory(engine, b, 'notes/same');
      const scope = await resolveRepairScope(engine, a);
      expect(scope.source_ids).toEqual([a]);
      const preview = await runRepair(ctxFor(engine, a), timelineRepair, scope, { apply: false, sourceFlag: a });
      expect(preview).toMatchObject({ affected: 1, sample: [`${a}:notes/same`], apply_command: `gbrain repair timeline --source ${a} --apply` });
      await runRepair(ctxFor(engine, a), timelineRepair, scope, { apply: true, sourceFlag: a });
      expect(await markedPages(engine, a)).toEqual(['notes/same']);
      expect(await markedPages(engine, b)).toEqual([]);
      await expect(resolveRepairScope(engine, 'no-such-source')).rejects.toMatchObject({ code: 'invalid_params' });
    }, 2);
  }, 120_000);

  test('an applying run stops before crossing 90% of a cumulative cap, prints the config command, and resumes after it is raised', async () => {
    await brain(async (engine, [source]) => {
      for (const slug of ['notes/a', 'notes/b']) await pageWithHistory(engine, source, slug);
      const [{ used }] = await engine.executeRaw<{ used: string }>("SELECT lifetime_ids::text AS used FROM persistence_counters WHERE key='brain'");
      await engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.limits.brain_lifetime_ids',$1)", [String(Number(used) + 2)]);
      const scope = await resolveRepairScope(engine);
      const stopped = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(stopped.applied).toBe(0);
      expect(stopped.stopped?.reason).toBe('capacity');
      expect(stopped.stopped?.message).toMatch(/gbrain config set persistence\.limits\.brain_lifetime_ids \d+/);
      const needed = stopped.stopped!.message.match(/brain_lifetime_ids (\d+)/)![1];
      await engine.executeRaw("UPDATE config SET value=$1 WHERE key='persistence.limits.brain_lifetime_ids'", [needed]);
      const resumed = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(resumed).toMatchObject({ applied: 2, complete: true });
    });
  }, 120_000);

  test('a terminal failure does not block the retry once its cause is fixed', async () => {
    await brain(async (engine, [source]) => {
      await pageWithHistory(engine, source, 'notes/a');
      const [{ local_path }] = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [source]);
      const file = join(local_path, 'notes/a.md');
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, `${original}\nAn uncoordinated local edit.\n`);
      const scope = await resolveRepairScope(engine);
      await expect(runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true })).rejects.toBeDefined();
      writeFileSync(file, original);
      const retried = await runRepair(ctxFor(engine, source), timelineRepair, scope, { apply: true });
      expect(retried).toMatchObject({ applied: 1, complete: true });
      expect(await markedPages(engine, source)).toEqual(['notes/a']);
    });
  }, 120_000);

  test('the command prints the resolved scope, refuses --yes and unknown kinds, and previews every kind by default', async () => {
    await brain(async (engine, [source]) => {
      await pageWithHistory(engine, source, 'notes/a');
      const out: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
      try {
        await runRepairCommand(engine, ['--json']);
        await runRepairCommand(engine, ['timeline']);
      } finally { console.log = log; }
      const json = JSON.parse(out[0]);
      expect(json.scope.source_ids).toEqual([source]);
      expect(json.results.map((r: { kind: string }) => r.kind)).toEqual(['timeline', 'visibility', 'safe-chunks', 'contextual-mode', 'connector-checkpoints']);
      expect(json.results[0]).toMatchObject({ mode: 'dry_run', affected: 1 });
      expect(out[1]).toContain(`Scope: brain `);
      expect(out[1]).toContain(`sources ${source}`);
      await expect(runRepairCommand(engine, ['timeline', '--yes'])).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(runRepairCommand(engine, ['bogus'])).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(runRepairCommand(engine, ['--apply'])).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await markedPages(engine, source)).toEqual([]);
    });
  }, 120_000);
});

describe('timeline_history doctor check', () => {
  test('exact counts on a seeded brain, a lower bound when the scan is capped, and ok after the repair', async () => {
    await brain(async (engine, [source]) => {
      await pageWithHistory(engine, source, 'notes/a');
      await pageWithHistory(engine, source, 'notes/b');
      await engine.transaction(tx => withCoordinatedWrite(tx, [source], () => tx.executeRaw(
        `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-07-02','','No source row','' FROM pages WHERE source_id=$1 AND slug='notes/a'`, [source])));
      const full = await timelineHistoryCheck(engine, source);
      expect(full.status).toBe("warn");
      expect(full.details).toMatchObject({ materializable_rows: 2, kept_unrenderable_rows: 1, pages_affected: 2, count: 'exact', truncated: false });
      expect(full.message).toContain('gbrain repair timeline');
      const capped = await timelineHistoryCheck(engine, source, { pageCap: 1 });
      expect(capped.status).toBe('warn');
      expect(capped.details).toMatchObject({ materializable_rows: 1, count: 'lower_bound', truncated: true });
      expect(capped.message).toContain('at least');
      await runRepair(ctxFor(engine, source), timelineRepair, await resolveRepairScope(engine), { apply: true });
      const after = await timelineHistoryCheck(engine, source);
      expect(after.status).toBe('ok');
      expect(after.details).toMatchObject({ materializable_rows: 0, kept_unrenderable_rows: 1, count: 'exact' });
    });
  }, 120_000);
});

describe('thin clients', () => {
  test('gbrain repair refuses with a run-on-the-brain-host hint', async () => {
    const home = mkdtempSync(join(dataDir, 'thin-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
      issuer_url: 'https://brain-host.example', mcp_url: 'https://brain-host.example/mcp', oauth_client_id: 'cid', oauth_client_secret: 'csecret' } }));
    const result = await runCli(['repair', 'timeline'], { home, env: { GBRAIN_REMOTE_CLIENT_SECRET: undefined } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Run `gbrain repair` on the brain host');
  }, 60_000);
});
