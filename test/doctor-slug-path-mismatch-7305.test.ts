/**
 * #7305 `slug_path_mismatch` doctor check: live file-backed pages whose slug their recorded file path does not derive
 * (a hyphen run the path rule folds). A file stamped with the page's `slug:` line keeps the page and is ok; a file
 * without it would import as the folded slug and fork a twin, so it warns with a sample and the read-only
 * `gbrain repair frontmatter --source <id>` preview as the fix. Read-only: no row or file changes.
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { slugPathMismatchEntry } from '../src/commands/doctor/checks/slug-path-mismatch.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

for (const backend of testBackends()) describe(`[${backend}] #7305 doctor slug_path_mismatch`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const home = mkdtempSync(join(tmpdir(), `gbrain-7305-doctor-${backend}-`));

  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  /** A source with a checkout of its own; each test reads only its source. */
  async function source(id: string): Promise<string> {
    const root = join(home, id);
    mkdirSync(root, { recursive: true });
    await engine.executeRaw("INSERT INTO sources(id, name, local_path, config) VALUES ($1, $1, $2, '{}')", [id, root]);
    return root;
  }
  /** A live page recording `<slug>.md`, written with or without the slug: stamp (null: no file). */
  async function page(sourceId: string, root: string, slug: string, file: 'stamped' | 'unstamped' | null) {
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
      tx.putPage(slug, { type: 'note', title: 'Example', compiled_truth: 'example body', timeline: '' }, { sourceId }), TEST_WRITE_ATTRIBUTION));
    await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [sourceId, slug, `${slug}.md`]);
    if (!file) return;
    mkdirSync(dirname(join(root, `${slug}.md`)), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), `---\ntype: note\ntitle: Example${file === 'stamped' ? `\nslug: ${slug}` : ''}\n---\n\nexample body\n`);
  }
  const run = async (sourceId: string) => ((await slugPathMismatchEntry.run({ engine, sourceIds: [sourceId] } as unknown as DoctorContext)) as Check[])[0]!;

  test('is registered, categorized, and ok when every page slug is the one its file path derives', async () => {
    expect(DOCTOR_CHECK_REGISTRY).toContain(slugPathMismatchEntry);
    expect(categorizeCheck('slug_path_mismatch')).toBe('brain');
    const root = await source('source-clean');
    await page('source-clean', root, 'notes/x-example', 'unstamped');
    await page('source-clean', root, 'notes/v1.0.0', 'unstamped');
    const check = await run('source-clean');
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ count: 0 });
  });

  test('a hyphen-run page whose file carries its slug: stamp is ok, and is counted', async () => {
    const root = await source('source-stamped');
    await page('source-stamped', root, 'notes/x-1900---2000-ab', 'stamped');
    const check = await run('source-stamped');
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ count: 1, files: { stamped: 1, unstamped: 0 } });
  });

  test('a hyphen-run page whose file lacks the stamp warns with a bounded sample and the read-only repair preview; nothing is written', async () => {
    const root = await source('source-a');
    for (let i = 0; i < 7; i++) await page('source-a', root, `notes/x-${i}---example-`, 'unstamped');
    await page('source-a', root, 'notes/y--example', null);
    const before = readFileSync(join(root, 'notes/x-0---example-.md'), 'utf8');
    const pagesBefore = await engine.executeRaw('SELECT slug, source_path, knowledge_revision::text AS r FROM pages WHERE source_id=$1 ORDER BY id', ['source-a']);
    const check = await run('source-a');
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ count: 8, files: { unstamped: 7, file_missing: 1, stamped: 0 }, sources: ['source-a'] });
    const samples = (check.details as { samples: Array<Record<string, unknown>> }).samples;
    expect(samples).toHaveLength(5);
    expect(samples[0]).toEqual({ source_id: 'source-a', slug: 'notes/x-0---example-', imports_as: 'notes/x-0-example', source_path: 'notes/x-0---example-.md', file: 'unstamped' });
    expect(check.message).toContain('source-a:notes/x-0---example- imports as notes/x-0-example');
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'repair', 'frontmatter', '--source', 'source-a', '--json'] });
    expect(readFileSync(join(root, 'notes/x-0---example-.md'), 'utf8')).toBe(before);
    expect(await engine.executeRaw('SELECT slug, source_path, knowledge_revision::text AS r FROM pages WHERE source_id=$1 ORDER BY id', ['source-a'])).toEqual(pagesBefore);
  });

  test('a remote caller sees slugs but no file paths', async () => {
    const check = ((await slugPathMismatchEntry.run({ engine, sourceIds: ['source-a'], remote: true } as unknown as DoctorContext)) as Check[])[0]!;
    expect((check.details as { samples: Array<Record<string, unknown>> }).samples[0]).not.toHaveProperty('source_path');
  });
});
