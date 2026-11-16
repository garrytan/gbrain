/**
 * #6825: atom_provenance_drift compared an atom's source_hash with the page's whole content_hash, so a
 * metadata-only frontmatter edit, or a gbrain fence write (takes or facts) that leaves the prose byte-identical, read
 * as an edited source.
 *
 * 1. Protects: when the edition the atom was extracted from is recoverable (a page_versions row whose content hash
 *    carries the atom's source_hash) and its body without the gbrain-managed fence sections equals the current one,
 *    the atom is not drift; a real prose edit, and an edit whose extraction edition cannot be found, still are.
 * 2. Fails when: the check counts every content_hash move as drift again, or hides an edit it cannot prove unchanged.
 * 3. Why existing coverage misses it: doctor-atom-provenance-drift.test.ts edits the prose in every drift case.
 * Real in-memory PGLite (canonical block); pages are written through importFromContent, which versions the page
 * before each write as the write paths do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const SOURCE = 'research/acme-example';
const PROSE = '# Acme Example\n\nAcme Example ships its widget every quarter and prices it per seat.\n';
const page = (frontmatter: string, body: string) => '---\ntitle: Acme Example\ntype: note\n' + frontmatter + '---\n\n' + body;
const write = (content: string) => importFromContent(engine, SOURCE, content, { noEmbed: true });
const TAKES = '## Takes\n\n' + TAKES_FENCE_BEGIN + '\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n'
  + '| 1 | Acme will raise prices | bet | world | 0.6 | 2026-07 | notes |\n' + TAKES_FENCE_END + '\n';

async function extractAtom(): Promise<void> {
  const [row] = await engine.executeRaw<{ h: string }>('SELECT substring(content_hash from 1 for 16) AS h FROM pages WHERE slug = $1', [SOURCE]);
  await engine.putPage('atoms/2026-01-01/acme-000000', { type: 'atom', title: 'Acme atom', compiled_truth: 'Acme ships quarterly.',
    frontmatter: { type: 'atom', source_slug: SOURCE, source_hash: row!.h, extracted_at: new Date().toISOString() } });
}

const details = async () => (await computeAtomProvenanceDriftCheck(engine)).details as Record<string, number>;

describe('#6825 atom_provenance_drift: an unchanged body is not drift', () => {
  test('a metadata-only frontmatter edit is not drift', async () => {
    await write(page('', PROSE));
    await extractAtom();
    await write(page('facts_backstop: false\n', PROSE));
    const d = await details();
    expect(d.drifted).toBe(0);
    expect(d.source_changed).toBe(0);
  });

  test('a takes fence written under the prose is not drift', async () => {
    await write(page('', PROSE));
    await extractAtom();
    await write(page('', PROSE + '\n' + TAKES));
    const d = await details();
    expect(d.drifted).toBe(0);
    expect(d.source_changed).toBe(0);
  });

  test('a prose edit is still drift', async () => {
    await write(page('', PROSE));
    await extractAtom();
    await write(page('facts_backstop: false\n', PROSE.replace('every quarter', 'every month') + '\n' + TAKES));
    const d = await details();
    expect(d.drifted).toBe(1);
    expect(d.source_changed).toBe(1);
  });

  test('a metadata-only edit whose extraction edition is gone is still drift', async () => {
    await write(page('', PROSE));
    await extractAtom();
    await write(page('facts_backstop: false\n', PROSE));
    await engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE slug = $1)', [SOURCE]);
    const d = await details();
    expect(d.drifted).toBe(1);
    expect(d.source_changed).toBe(1);
  });
});
