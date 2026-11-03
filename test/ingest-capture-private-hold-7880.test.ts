/**
 * #7880: on a brain without managed persistence, `ingest_capture` (the webhook POST /ingest and ingestion-daemon
 * writer) called `importFromContent` directly, whose screen did not hold a private request page privacy does not read.
 * An event whose frontmatter said `Visibility: Private` (another case, a block scalar, a list, a flow mapping, a merge
 * key) was stored world-readable, while a managed brain refused it through put_page (`visibility_not_applied`).
 *
 * Protects, on a repo-less brain (a plain directory, no Git) and on the default source:
 * - every such spelling refuses `visibility_not_applied` with put_page's message, trusted and untrusted (remote) payloads
 *   alike; nothing is stored, and an existing world page keeps its revision;
 * - the real worker dead-letters the job on its first attempt (job_outcome `refused`), never retrying it;
 * - `visibility: private` still stores a private page and content that does not ask for private still stores;
 * - a managed brain refuses the same event with the same code and message.
 *
 * PGLite here; Postgres through test/e2e/ingest-capture-private-hold-7880-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeContentHash, type IngestionEvent } from '../src/core/ingestion/types.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { jobRefusal } from '../src/core/minions/refusal.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const page = (extra = '') => `---\ntitle: Captured example\ntype: note\n${extra}---\nNotes from alice-example about acme-example.\n`;
const SPELLINGS = [['Visibility: private', 'Visibility: private\n'], ['visibility: Private', 'visibility: Private\n'], ['a block scalar', 'visibility: |\n  private\n'],
  ['a flow list', 'visibility: [private]\n'], ['a merge key', 'base: &base\n  Visibility: Private\n<<: *base\n']] as const;

function event(content: string, untrusted: boolean): IngestionEvent {
  return { source_id: 'source-a', source_kind: 'webhook', source_uri: 'mcp-webhook:client-example:1', received_at: new Date('2026-10-28T12:00:00Z').toISOString(),
    content_type: 'text/markdown', content, content_hash: computeContentHash(content), untrusted_payload: untrusted };
}
const job = (data: Record<string, unknown>): MinionJobContext => ({ id: 1, name: 'ingest_capture', data, attempts_made: 0, signal: new AbortController().signal,
  deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
  isActive: async () => true, readInbox: async () => [] });
type Outcome = { status?: string; thrown?: unknown; code?: string; message?: string };
async function capture(engine: BrainEngine, data: Record<string, unknown>): Promise<Outcome> {
  try { return { status: (await makeIngestCaptureHandler(engine)(job(data))).status }; } catch (thrown) {
    const e = thrown as { code?: string; message?: string };
    return { thrown, code: e.code, message: e.message };
  }
}
const stored = (engine: BrainEngine, slug: string, sourceId: string) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });

/** A source rooted at a plain directory (no Git), unmanaged; `managed` adds a Git checkout and turns managed persistence on. */
async function brain(engine: BrainEngine, managed: boolean, run: (sourceId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-7880-'));
  const root = join(dir, 'brain');
  mkdirSync(root);
  const sourceId = `source-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      if (managed) { writeFileSync(join(root, '.gitignore'), 'tmp/\n'); durableGitRepo(root, ['.gitignore']); }
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      if (managed) {
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
      await run(sourceId);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const backend of backends) describe(`[${backend}] repo-less brain: ingest_capture of a private request page privacy does not read (#7880)`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;

  for (const [label, extra] of SPELLINGS) {
    test(`${label}: refused visibility_not_applied, terminal for the worker, nothing stored (trusted and untrusted payloads)`, async () => {
      await brain(engine(), false, async sourceId => {
        for (const untrusted of [false, true]) {
          const slug = `inbox/held-${untrusted ? 'remote' : 'local'}`;
          const result = await capture(engine(), { event: event(page(extra), untrusted), slug, sourceId });
          expect(result.code).toBe('visibility_not_applied');
          expect(result.message).toBe(`The write asks for visibility: private, but page ${slug} would stay world-readable, so nothing was written (noncanonical_value). `
            + 'Write visibility: private on its own frontmatter line, lowercase, and submit again.');
          expect(jobRefusal(result.thrown)).toMatchObject({ code: 'visibility_not_applied', reason: 'noncanonical_value' });
          expect(await stored(engine(), slug, sourceId)).toBeNull();
        }
      });
    }, 120_000);
  }

  test('a flow-mapping frontmatter block that spells Visibility: Private is refused on the default source, and nothing is stored', async () => {
    const content = '---\n{title: Captured example, type: note, Visibility: Private}\n---\nNotes from alice-example.\n';
    const result = await capture(engine(), { event: event(content, true), slug: 'inbox/flow-mapping-7880' });
    expect(result.code).toBe('visibility_not_applied');
    expect(jobRefusal(result.thrown)?.code).toBe('visibility_not_applied');
    expect(await stored(engine(), 'inbox/flow-mapping-7880', 'default')).toBeNull();
  }, 120_000);

  test('an existing world page captured again as Visibility: Private is refused and keeps its revision and frontmatter', async () => {
    await brain(engine(), false, async sourceId => {
      expect((await capture(engine(), { event: event(page(), false), slug: 'inbox/existing', sourceId })).status).toBe('imported');
      const before = (await stored(engine(), 'inbox/existing', sourceId))!;
      expect(isPrivatePage(before.page)).toBe(false);
      expect((await capture(engine(), { event: event(page('Visibility: Private\n'), true), slug: 'inbox/existing', sourceId })).code).toBe('visibility_not_applied');
      const after = (await stored(engine(), 'inbox/existing', sourceId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.page.frontmatter).toEqual(before.page.frontmatter);
    });
  }, 120_000);

  test('the worker dead-letters the job on its first attempt with the refusal, and stores nothing', async () => {
    await brain(engine(), false, async sourceId => {
      const queue = new MinionQueue(engine());
      const queued = await queue.add('ingest_capture', { event: event(page('Visibility: Private\n'), true), slug: 'inbox/worker-held', sourceId }, { max_attempts: 3 });
      const worker = new MinionWorker(engine(), { concurrency: 1, pollInterval: 20, healthCheckInterval: 0, stalledInterval: 60_000 });
      worker.register('ingest_capture', makeIngestCaptureHandler(engine()));
      const running = worker.start();
      try {
        await waitFor(async () => ['completed', 'dead', 'failed', 'delayed'].includes((await queue.getJob(queued.id))?.status ?? ''), { timeoutMs: 60_000, label: 'ingest_capture settled' });
      } finally { worker.stop(); await running; }
      const done = (await queue.getJob(queued.id))!;
      expect(done.status).toBe('dead');
      expect(done.attempts_made).toBe(1);
      expect(done.result).toMatchObject({ job_outcome: 'refused', refusal: { code: 'visibility_not_applied', reason: 'noncanonical_value' } });
      expect(await stored(engine(), 'inbox/worker-held', sourceId)).toBeNull();
    });
  }, 120_000);

  test('visibility: private stores a private page, and content that does not ask for private stores world-readable', async () => {
    await brain(engine(), false, async sourceId => {
      for (const untrusted of [false, true]) {
        const privateSlug = `inbox/private-${untrusted ? 'remote' : 'local'}`, worldSlug = `inbox/world-${untrusted ? 'remote' : 'local'}`;
        expect((await capture(engine(), { event: event(page('visibility: private\n'), untrusted), slug: privateSlug, sourceId })).status).toBe('imported');
        const kept = (await stored(engine(), privateSlug, sourceId))!;
        expect(kept.page.frontmatter.visibility).toBe('private');
        expect(isPrivatePage(kept.page)).toBe(true);
        expect((await capture(engine(), { event: event(page('visibility: public\n'), untrusted), slug: worldSlug, sourceId })).status).toBe('imported');
        expect(isPrivatePage((await stored(engine(), worldSlug, sourceId))!.page)).toBe(false);
      }
    });
  }, 120_000);

  test('a managed brain refuses the same event with the same code and message', async () => {
    const outcomes: Outcome[] = [];
    for (const managed of [false, true]) {
      await brain(engine(), managed, async sourceId => {
        outcomes.push(await capture(engine(), { event: event(page('visibility: Private\n'), true), slug: 'inbox/parity', sourceId }));
        expect(await stored(engine(), 'inbox/parity', sourceId)).toBeNull();
      });
    }
    expect(outcomes.map(outcome => outcome.code)).toEqual(['visibility_not_applied', 'visibility_not_applied']);
    expect(outcomes[0]!.message).toBe(outcomes[1]!.message!);
  }, 180_000);
});
