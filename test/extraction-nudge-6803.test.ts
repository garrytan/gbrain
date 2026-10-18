/**
 * #6803 part 6: the extraction nudge matches doctor and names the command that finishes.
 *
 * Protects: doctor's links_extraction_lag and the end-of-sync nudge share one predicate (attendance-blocked pages
 * excluded) and one threshold; the warn carries a default fix (plain \`gbrain extract --stale\`) plus both routes with an
 * estimate, and a fix expected to outlast an agent tool call renders tell_user_to_run; extract's routing flag is
 * --source-id, so rendered fixes never pin \`--source <id>\` (extract's fs|db mode selector); \`extract --stale --source <id>\`
 * refuses with invalid_params instead of running brain-wide; \`--source db\` is ambiguous when a source is named db;
 * \`extract --stale\` JSON splits actionable / attendance_blocked / mention_due; the per-source sync line counts only the
 * sync's underived imports.
 * Seams: none. PGLite always, Postgres when DATABASE_URL is set (test/e2e/extraction-nudge-6803-postgres.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';
import { maybeExtractionNudge } from '../src/commands/sync/report.ts';
import { runExtract } from '../src/commands/extract.ts';
import { printManagedSyncNotes } from '../src/commands/sync-diagnostics.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { pinRouting } from '../src/core/fix-routing.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { runCli } from './helpers/cli-spawn.ts';

async function captured<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write.bind(process.stdout) };
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { result: await fn(), stdout: out.join('\n'), stderr: err.join('\n') }; }
  catch (error) { return { error, stdout: out.join('\n'), stderr: err.join('\n') }; }
  finally { console.log = orig.log; console.error = orig.error; console.warn = orig.warn; process.stdout.write = orig.write; }
}

const teambrain = { brain: 'teambrain', source: 'wiki' };
const cli = (routing?: { brain?: string; source?: string }) => cliRenderContext({ routing });

for (const backend of testBackends()) {
  describe(`${backend}: #6803 extraction lag, nudge and extract --stale`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engine = pg.engine; close = pg.close;
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({}); await pglite.initSchema();
        engine = pglite; close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close(); }, 60_000);
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
    });

    async function seed(n: number, opts: { prefix?: string; sourceId?: string; blocked?: boolean; fresh?: boolean } = {}): Promise<void> {
      const prefix = opts.prefix ?? 'p', sourceId = opts.sourceId ?? 'default';
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
         SELECT $1 || '/' || g, $2, 'concept', 'T' || g, '', '', '{}'::jsonb, $1 || 'h' || g, now() - interval '1 day', now() - interval '1 day'
           FROM generate_series(1, $3::int) g`, [prefix, sourceId, n]);
      if (opts.blocked) await engine.executeRaw(`UPDATE pages SET links_attendance_blocked_revision = knowledge_revision WHERE slug LIKE $1 || '/%'`, [prefix]);
      if (opts.fresh) await engine.executeRaw(`UPDATE pages SET links_extracted_at = now() WHERE slug LIKE $1 || '/%'`, [prefix]);
    }

    test('an attendance-blocked majority: doctor ok and the sync nudge silent', async () => {
      await seed(100, { prefix: 'm', blocked: true });
      await seed(20, { prefix: 'p', fresh: true });
      const check = await checkLinksExtractionLag(engine);
      expect(check.status).toBe('ok');
      expect((check.details as Record<string, unknown>).attendance_blocked).toBe(100);
      const nudge = await captured(() => maybeExtractionNudge(engine));
      expect(nudge.stderr).not.toContain('un-extracted edges');
    });

    test('a real backlog: doctor warns with the plain-route fix and both routes; the nudge prints the same count and both commands', async () => {
      await seed(120);
      const check = await checkLinksExtractionLag(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('gbrain extract --stale');
      expect(check.message).toContain('gbrain extract --stale --catch-up');
      const fix = renderAction(check.fix as Action, cli({ brain: 'teambrain' }));
      expect(fix.argv).toEqual(['gbrain', 'extract', '--stale', '--brain', 'teambrain']);
      expect(fix.verify?.argv).toEqual(['gbrain', 'extract', '--stale', '--dry-run', '--json', '--brain', 'teambrain']);
      expect(fix.next).toBe('run');
      const routes = (check.details as { routes: Array<{ id: string; argv: string[]; label: string }> }).routes;
      expect(routes.map(r => r.id)).toEqual(['plain', 'catch_up']);
      expect(routes[1]!.argv).toContain('--catch-up');
      expect(routes[1]!.label).toContain('estimate at 10 ms RTT; measure your pooler RTT');

      const nudge = await captured(() => maybeExtractionNudge(engine, 'default'));
      expect(nudge.stderr).toContain('120 page(s) have un-extracted edges');
      expect(nudge.stderr).toContain('gbrain extract --stale --source-id default');
      expect(nudge.stderr).toContain('gbrain extract --stale --catch-up --source-id default');
      expect(nudge.stderr).toContain('each run resumes where the last stopped');
      expect(nudge.stderr).not.toMatch(/--source default/);
    });

    test('an estimate over AGENT_TOOL_LIMIT_MS makes the fix the user\'s (tell_user_to_run); host_admin on a remote brain', async () => {
      await seed(2_000);
      const check = await checkLinksExtractionLag(engine);
      expect(check.status).toBe('warn');
      expect(renderAction(check.fix as Action, cli()).next).toBe('tell_user_to_run');
      expect((check.fix as Action).actor).toBe('user');
      expect((check.fix as Action).user_message).toContain('--catch-up');
      const remote = await checkLinksExtractionLag(engine, { remote: true } as { sourceId?: string });
      expect((remote.fix as Action).actor).toBe('host_admin');
    });

    test('a scoped fix and verify pin --source-id and the selected brain, never --source <id>', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('wiki', 'wiki')");
      await seed(30, { sourceId: 'wiki' });
      const check = await checkLinksExtractionLag(engine, { sourceId: 'wiki' });
      expect(check.status).toBe('warn');
      const fix = renderAction(check.fix as Action, cli(teambrain));
      expect(fix.argv).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'wiki', '--brain', 'teambrain']);
      expect(fix.verify?.argv).toEqual(['gbrain', 'extract', '--stale', '--dry-run', '--json', '--source-id', 'wiki', '--brain', 'teambrain']);
    });

    test('extract --stale --source <id> refuses with invalid_params naming --source-id instead of running brain-wide', async () => {
      await seed(3);
      const run = await captured(() => runExtract(engine, ['--stale', '--source', 'wiki', '--json']));
      expect((run.error as { code?: string })?.code).toBe('invalid_params');
      expect((run.error as { fix?: Action }).fix?.argv).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'wiki', '--json']);
      expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE links_extracted_at IS NOT NULL'))[0]!.n)).toBe(0);
    });

    test('--source db is the read mode, and ambiguous once a source is named db', async () => {
      await seed(3);
      const plain = await captured(() => runExtract(engine, ['--stale', '--source', 'db', '--dry-run', '--json']));
      expect(plain.error).toBeUndefined();
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('db', 'db')");
      const ambiguous = await captured(() => runExtract(engine, ['--stale', '--source', 'db', '--dry-run', '--json']));
      expect((ambiguous.error as { code?: string })?.code).toBe('invalid_params');
      expect((ambiguous.error as Error).message).toContain('ambiguous');
      expect((ambiguous.error as { fix?: Action }).fix?.argv).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'db', '--dry-run', '--json']);
    });

    test('extract --stale dry-run and completion JSON split actionable, attendance_blocked and mention_due', async () => {
      await seed(4, { prefix: 'm', blocked: true });
      await seed(3, { prefix: 'p' });
      const dry = await captured(() => runExtract(engine, ['--stale', '--dry-run', '--json']));
      const preview = JSON.parse(dry.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()!);
      expect(preview).toMatchObject({ action: 'extract_stale_dry_run', actionable: 3, attendance_blocked: 4, complete: false });
      expect('mention_due' in preview).toBe(true);
      const done = await captured(() => runExtract(engine, ['--stale', '--json']));
      const report = JSON.parse(done.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()!);
      expect(report.action).toBe('extract_stale_done');
      expect(report.actionable).toBe(0);
      expect(typeof report.attendance_blocked).toBe('number');
      expect('mention_due' in report && 'complete' in report).toBe(true);
    });
  });
}

describe('#6803 routing and reporting (engine-free)', () => {
  test('extract routes --source-id: a brain-wide fix gets --source-id, a --source mode selector does not block it, --source is never pinned', () => {
    expect(pinRouting(['gbrain', 'extract', '--stale'], teambrain)).toEqual(['gbrain', 'extract', '--stale', '--brain', 'teambrain', '--source-id', 'wiki']);
    expect(pinRouting(['gbrain', 'extract', 'links', '--source', 'db'], teambrain)).toEqual(['gbrain', 'extract', 'links', '--source', 'db', '--brain', 'teambrain', '--source-id', 'wiki']);
    expect(pinRouting(['gbrain', 'extract', '--stale', '--source-id', 'other'], teambrain)).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'other', '--brain', 'teambrain']);
    expect(pinRouting(['gbrain', 'sync', '--no-pull'], teambrain)).toEqual(['gbrain', 'sync', '--no-pull', '--brain', 'teambrain', '--source', 'wiki']);
  });

  test("the per-source sync line counts this sync's underived imports, not the source's whole stale backlog", () => {
    const lines: string[] = [];
    printManagedSyncNotes({ status: 'synced', links: { pages: 2, created: 1, removed: 0, timeline: 0, skipped: 0, remaining: 500 },
      tail: { status: 'truncated', runs: 1, statistics: 'not_needed', underived: 3 } } as unknown as SyncResult, line => lines.push(line));
    const line = lines.find(l => l.includes('Links:'))!;
    expect(line).toContain('3 page(s) this sync imported still owe extraction');
    expect(line).not.toContain('500');
  });

  test('real CLI: extract --stale --source <id> exits 2 invalid_params with the --source-id command, before any brain opens', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-6803-extract-'));
    try {
      const run = await runCli(['extract', '--stale', '--source', 'wiki', '--json'], { home });
      expect(run.exitCode, run.stderr).toBe(2);
      const env = JSON.parse(run.stdout);
      expect(env.code).toBe('invalid_params');
      expect(env.fix.argv.slice(0, 5)).toEqual(['gbrain', 'extract', '--stale', '--source-id', 'wiki']);
      const fs = await runCli(['extract', '--stale', '--source', 'fs', '--json'], { home });
      expect(fs.exitCode, fs.stderr).toBe(2);
      expect(JSON.parse(fs.stdout).code).toBe('invalid_params');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
