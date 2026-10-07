/**
 * Foundations 1 (F1c) write attribution on unmanaged brains: the legacy
 * transactional writers that have no journal request stamp the local
 * maintenance principal (write_request_id NULL).
 *
 * Protects: direct markdown, code and image imports (pages.revision_* and the
 * page_versions row an edit archives), the unmanaged extract_facts page
 * reconcile, extract-takes and `gbrain repair stale-atoms --apply`. Fails if
 * one of those transactions stops entering maintenanceTransaction. Also pins the
 * attributed and "unattributed" lists in docs/architecture/system-of-record.md
 * against a grep of src, so a new direct writer cannot fall out silently.
 * Runs on PGLite, and on Postgres (direct and transaction-mode PgBouncer)
 * through test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent, importFromFile, importImageFile } from '../src/core/import-file.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-legacy-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

type Actor = { request: string | null; kind: string | null; id: string | null };
interface Brain { engine: BrainEngine; sourceId: string; maintenance: Actor }
/** An unmanaged brain whose installation has a local CLI registration: maintenance writes name it. */
async function unmanagedBrain(engine: BrainEngine): Promise<Brain> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const sourceId = `legacy-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  return { engine, sourceId, maintenance: { request: null, kind: 'local_cli', id: (await readLocalWriter(engine, 'cli')).id } };
}
async function revisionActor(brain: Brain, slug: string): Promise<Actor | undefined> {
  return (await brain.engine.executeRaw<Actor>(`SELECT revision_write_request_id::text AS request,revision_principal_kind AS kind,revision_principal_id AS id
    FROM pages WHERE source_id=$1 AND slug=$2`, [brain.sourceId, slug]))[0];
}
async function versionActors(brain: Brain, slug: string) {
  return brain.engine.executeRaw<{ write: Actor; archived: Actor }>(`SELECT
      jsonb_build_object('request',v.write_request_id::text,'kind',v.write_principal_kind,'id',v.write_principal_id) AS write,
      jsonb_build_object('request',v.archived_write_request_id::text,'kind',v.archived_principal_kind,'id',v.archived_principal_id) AS archived
    FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id`, [brain.sourceId, slug]);
}
const ROW_ACTORS = `jsonb_build_object('request',write_request_id::text,'kind',write_principal_kind,'id',write_principal_id) AS created,
  jsonb_build_object('request',last_write_request_id::text,'kind',last_write_principal_kind,'id',last_write_principal_id) AS last`;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
const PNG = (shade: string) => Buffer.from(shade, 'base64');

describe('write attribution on an unmanaged brain', () => {
  test('direct markdown, code and image imports stamp the local maintenance principal on the revision and the archived version', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'notes/direct-import-example';
      await importFromContent(engine, slug, page('Direct', 'First body'), { sourceId: brain.sourceId, noEmbed: true });
      await importFromContent(engine, slug, page('Direct', 'Second body'), { sourceId: brain.sourceId, noEmbed: true });
      expect(await revisionActor(brain, slug)).toEqual(brain.maintenance);
      expect(await versionActors(brain, slug)).toEqual([{ write: brain.maintenance, archived: brain.maintenance }]);

      const root = join(scratch, brain.sourceId);
      mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'photos'), { recursive: true });
      const code = join(root, 'src/example.ts');
      writeFileSync(code, 'export const answer = 1;\n');
      const first = await importFromFile(engine, code, 'src/example.ts', { sourceId: brain.sourceId, noEmbed: true });
      writeFileSync(code, 'export const answer = 2;\n');
      await importFromFile(engine, code, 'src/example.ts', { sourceId: brain.sourceId, noEmbed: true });
      expect(await revisionActor(brain, first.slug)).toEqual(brain.maintenance);
      expect(await versionActors(brain, first.slug)).toEqual([{ write: brain.maintenance, archived: brain.maintenance }]);

      const image = join(root, 'photos/board.png');
      writeFileSync(image, PNG('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9kAAAAASUVORK5CYII='));
      const pictured = await importImageFile(engine, image, 'photos/board.png', { sourceId: brain.sourceId, noEmbed: true });
      writeFileSync(image, PNG('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII='));
      await importImageFile(engine, image, 'photos/board.png', { sourceId: brain.sourceId, noEmbed: true });
      expect(await revisionActor(brain, pictured.slug)).toEqual(brain.maintenance);
      expect(await versionActors(brain, pictured.slug)).toEqual([{ write: brain.maintenance, archived: brain.maintenance }]);
    }
  }, 120_000);

  test('an unmanaged extract_facts cycle stamps the facts it reconciles', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'people/alice-example';
      const facts = renderFactsTable([
        { rowNum: 1, claim: 'Prefers written updates', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true },
      ] as never);
      await engine.putPage(slug, { type: 'person', title: 'Alice', compiled_truth: `Profile\n\n${facts}` }, { sourceId: brain.sourceId });
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [brain.sourceId])).toEqual([]);
      await runExtractFacts(engine, { sourceId: brain.sourceId });
      const rows = await engine.executeRaw<{ created: Actor; last: Actor }>(`SELECT ${ROW_ACTORS} FROM facts WHERE source_id=$1`, [brain.sourceId]);
      expect(rows).toEqual([{ created: brain.maintenance, last: brain.maintenance }]);
    }
  }, 120_000);

  test('extract-takes stamps the takes it upserts', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = `people/charlie-example-${brain.sourceId}`;
      const takes = renderTakesFence([{ rowNum: 1, claim: 'Ships carefully', kind: 'take', holder: 'world', weight: 0.6, active: true }] as never);
      const stored = await engine.putPage(slug, { type: 'person', title: 'Charlie', compiled_truth: `Profile\n\n${takes}` }, { sourceId: brain.sourceId });
      await engine.executeRaw('DELETE FROM takes WHERE page_id=$1', [stored.id]);
      expect((await extractTakes(engine, { source: 'db', slugs: [slug] })).takesUpserted).toBe(1);
      const rows = await engine.executeRaw<{ created: Actor; last: Actor }>(`SELECT ${ROW_ACTORS} FROM takes WHERE page_id=$1`, [stored.id]);
      expect(rows).toEqual([{ created: brain.maintenance, last: brain.maintenance }]);
    }
  }, 120_000);

  test('gbrain repair stale-atoms --apply stamps the retirement on the atom revision and its archived version', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const atom = 'atoms/2026-01-01/gone-example';
      await engine.putPage('notes/gone-example', { type: 'note', title: 'Gone', compiled_truth: 'A page the user deleted.' }, { sourceId: brain.sourceId });
      await engine.putPage(atom, { type: 'atom', title: atom, compiled_truth: 'A claim.',
        frontmatter: { type: 'atom', source_slug: 'notes/gone-example', source_hash: 'cccccccccccccccc' } }, { sourceId: brain.sourceId });
      await engine.softDeletePage('notes/gone-example', { sourceId: brain.sourceId });
      const repair = async (args: string[]) => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try { await runRepairCommand(engine, ['stale-atoms', '--source', brain.sourceId, ...args, '--json']); } finally { console.log = original; }
        return JSON.parse(lines.join('\n')).results[0] as { apply_command: string; outcomes?: Record<string, number> };
      };
      const hash = (await repair([])).apply_command.match(/--expect ([0-9a-f]+)/)![1];
      expect((await repair(['--apply', '--expect', hash])).outcomes).toEqual({ retired: 1 });
      const [retired] = await engine.executeRaw<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, atom]);
      expect(retired.deleted).toBe(true);
      expect(await revisionActor(brain, atom)).toEqual(brain.maintenance);
      expect((await versionActors(brain, atom)).map(row => row.archived)).toEqual([brain.maintenance]);
    }
  }, 120_000);
});

describe('write attribution inventory', () => {
  /**
   * Every src file that writes a content row (facts, takes, timeline_entries),
   * a page version or a page revision directly, outside the engine and schema
   * layers. Comment lines are skipped. The count per file is the number of
   * writer references this grep finds, so a new writer in a listed file moves
   * it too.
   */
  const WRITER_METHODS = 'putPage|refreshPageBody|softDeletePage|softDeletePages|restorePage|createVersion|revertToVersion|addTag|removeTag|updateSlug|'
    + 'addTimelineEntry|addTimelineEntriesBatch|addTakesBatch|updateTake|supersedeTake|resolveTake|insertFact|insertFacts|expireFact|consolidateFact|migrateFactsToCanonical';
  const WRITER = new RegExp(`\\.(?:${WRITER_METHODS})\\s*(?:\\?\\.)?\\s*\\(`
    + '|\\b(?:INSERT\\s+INTO|UPDATE)\\s+(?:page_versions|facts|takes|timeline_entries)\\b'
    + '|\\bUPDATE\\s+pages\\s+(?:\\w+\\s+)?SET\\s+(?:\\w+\\.)?(?:frontmatter|compiled_truth|timeline|title|type|deleted_at|slug|content_hash)\\b', 'gi');
  const LAYER = /^src\/(?:eval\/|core\/engine-sql\/|core\/schema-migrations\/|commands\/migrations\/)|(?:^|\/)(?:engine|pglite-engine|postgres-engine)\.ts$|(?:^|[/-])schema\.ts$|\.generated\.ts$/;
  const root = join(import.meta.dir, '..');
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
  }
  function directWriters(): Record<string, number> {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(join(root, 'src'))) {
      const path = relative(root, file);
      if (LAYER.test(path)) continue;
      // test-reads-source-ok[structural]: the attribution inventory is a source-text tripwire by design, like the canonical writer census.
      const body = readFileSync(file, 'utf8').split('\n').map(line => /^\s*(?:\/\/|\/?\*)/.test(line) ? '' : line).join('\n');
      const count = [...body.matchAll(WRITER)].length;
      if (count) found[path] = count;
    }
    return found;
  }
  function documentedList(marker: string): Record<string, number> {
    const doc = readFileSync(join(root, 'docs/architecture/system-of-record.md'), 'utf8');
    const section = doc.split(`<!-- ${marker}:start -->`)[1]?.split(`<!-- ${marker}:end -->`)[0];
    if (section === undefined) throw new Error(`system-of-record.md is missing the ${marker} list`);
    return Object.fromEntries([...section.matchAll(/^- `([^`]+)` \((\d+)\)/gm)].map(match => [match[1], Number(match[2])]));
  }

  test('every direct writer is either attributed or listed as unattributed until Foundations 2', () => {
    const unattributed = documentedList('write-attribution-unattributed');
    const attributed = documentedList('write-attribution-covered');
    expect(Object.keys(unattributed).filter(path => path in attributed)).toEqual([]);
    expect({ ...attributed, ...unattributed }, 'A direct writer moved. Run it in maintenanceTransaction (or route it through the coordinator) and list it under '
      + '"attributed" with its new count, or list it under "unattributed" in docs/architecture/system-of-record.md.')
      .toEqual(directWriters());
  });
});
